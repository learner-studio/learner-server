import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { Client } from 'pg'
import { repeatIsFree as isRepeatFree } from '@learner/llm/lib/llm/backend-cost.js'
import { discardAttempt, durableCallPlan, type DurableCallPlan } from '@learner/llm/lib/cli/durable-cli-call.js'
import { currentCliContext } from '@learner/llm/lib/cli/cli-telemetry.js'
import { metaDbQuery, type MetaPgQueryFn } from '../db-metadata/_shared.js'
import { errorKind } from '../error-message.js'
import { resolveDatabaseUrl } from '../../db.js'
import { isDatabaseBound } from '../../db/handle.js'

/**
 * Who is executing a reserved model attempt right now (docs/operations/restart-safety.md).
 *
 * A reservation (learning_concept_assessment_attempts, learning_concept_assessment_replicates,
 * learning_drift_panel_regrades) says "this attempt was started" and is immutable or one-shot. Beside it,
 * learning_llm_attempt_leases says who holds it: an owner (one per process), a heartbeat, and how many times it
 * was taken over. A reservation with no outcome is then one of:
 *   - owned by a LIVE process          -> wait for it;
 *   - owned by a DEAD process, repeat-free backend, takeovers left -> take it over and finish it (adopting the
 *     detached child's result from disk when there is one: durable-cli-call.ts);
 *   - anything else (a metered backend, the takeover budget spent) -> refused: the caller keeps the old
 *     "uncertain, never paid twice" rule.
 *
 * "Dead" is proved, not guessed: every owner holds a session-level Postgres advisory lock for its life, so a
 * process that exits or is killed releases it with its connection; a probe that can take the lock proves the
 * owner gone. A heartbeat older than the lease is the second test (a process alive but stuck). A false "dead"
 * costs a duplicate free call, never a duplicate effect: every outcome is recorded insert-once.
 */
export const ATTEMPT_LEASE_MS = () => Number(process.env.LEARNER_ATTEMPT_LEASE_MS ?? 120_000)
const ATTEMPT_HEARTBEAT_MS = () => Number(process.env.LEARNER_ATTEMPT_HEARTBEAT_MS ?? 15_000)
const ATTEMPT_POLL_MS = () => Number(process.env.LEARNER_ATTEMPT_POLL_MS ?? 1_000)
/** Takeovers allowed per attempt. A call that kills its own worker every time (OOM) stops here for a person. */
export const MAX_ATTEMPT_TAKEOVERS = 3
/**
 * A reservation with no lease row. The writer inserts its lease right after its reservation, so past this grace the
 * row is either from before leases existed or its writer died between the two inserts; either way nobody probe-able
 * owns it. A pre-lease call that is still running can only be in a process the deploy did not restart (the old code
 * ran every call in-process under ASSESSMENT_MODEL.killMs); finishing it again is free on a repeat-free backend and
 * its outcome is recorded insert-once, so the cost of being wrong is one duplicate call, never a duplicate effect.
 */
const UNLEASED_RESERVATION_GRACE_MS = () => Number(process.env.LEARNER_UNLEASED_GRACE_MS ?? 30_000)

const OWNER = `${hostname()}:${process.pid}:${randomUUID()}`
export const attemptOwner = () => OWNER
/** An attempt's call files are per database: a lane or test on a copy of the data never adopts or discards the live worker's. */
export const attemptFilesKey = (key: string, databaseUrl = isDatabaseBound() ? resolveDatabaseUrl() : null) => {
  const url = databaseUrl ? new URL(databaseUrl) : null // null: a unit test on a fake query function
  return `${url ? url.host + url.pathname : 'unbound'}|${key}`
}
const ownerLockSql = (param: string) => `hashtextextended('learner-llm-owner:'||${param},0)`

let ownerLock: Promise<void> | undefined
/** Take this process's owner lock (once; again if its connection dropped). */
async function holdOwnerLock() {
  if (!ownerLock) {
    ownerLock = (async () => {
      const client = new Client({ connectionString: resolveDatabaseUrl(), application_name: 'learner-llm-owner' })
      const drop = () => { ownerLock = undefined }
      client.on('error', drop); client.on('end', drop)
      await client.connect()
      await client.query(`SELECT pg_advisory_lock(${ownerLockSql('$1')})`, [OWNER])
      // Never keeps the process alive on its own.
      ;(client as unknown as { connection?: { stream?: { unref?: () => void } } }).connection?.stream?.unref?.()
    })().catch((error) => { ownerLock = undefined; throw error })
  }
  return ownerLock
}

/**
 * Who is asking, from the Pikku call scope (runtime-pikku/src/adapt.ts): the workflow run and the step's function,
 * written on lease and reclaim rows, and the invocation's logger. Empty outside a Pikku function (unit tests).
 */
const caller = () => {
  const c = currentCliContext()
  return { runId: c.jobId ?? null, stepName: c.label ?? null, logger: c.logger }
}

/** `runId`: the workflow run holding it, kept in a takeover's audit row (the takeover overwrites the lease's). */
export type LeaseRow = { owner: string; repeatFree: boolean; takeovers: number; stale: boolean; runId?: string | null }
/**
 * The storage half of a lease: Postgres in the app (pgLeaseStore), in memory for a unit test whose query
 * function is a fake (testing/memory-lease-store.ts). The claim rules below are the same for both.
 */
export interface LeaseStore {
  /** Make this process's ownership probe-able (Postgres: take the owner's advisory lock). */
  holdOwner(): Promise<void>
  get(key: string): Promise<LeaseRow | null>
  insert(key: string, row: { backend: string; repeatFree: boolean; owner: string; takeovers: number }): Promise<boolean>
  /** Compare-and-set takeover: only when the lease still has `from`'s owner and takeover count. */
  takeOver(key: string, from: { owner: string; takeovers: number }, owner: string): Promise<number | null>
  heartbeat(key: string, owner: string): Promise<boolean>
  release(key: string, owner: string): Promise<void>
  finish(key: string): Promise<void>
  ownerIsDead(owner: string): Promise<boolean>
  audit(key: string, action: string, detail: Record<string, unknown>): Promise<void>
}

export function pgLeaseStore(q: MetaPgQueryFn = metaDbQuery): LeaseStore {
  return {
    holdOwner: holdOwnerLock,
    async get(key) {
      const r = (await q<{ owner: string; repeat_free: boolean; takeovers: number; stale: boolean; workflow_run_id: string | null }>(`SELECT owner, repeat_free, takeovers, workflow_run_id,
        heartbeat_at < now() - make_interval(secs => $2::double precision / 1000) AS stale FROM learning_llm_attempt_leases WHERE attempt_key=$1`, [key, ATTEMPT_LEASE_MS()])).rows[0]
      return r ? { owner: r.owner, repeatFree: r.repeat_free, takeovers: r.takeovers, stale: r.stale, runId: r.workflow_run_id } : null
    },
    async insert(key, row) {
      const { runId, stepName } = caller()
      return ((await q(`INSERT INTO learning_llm_attempt_leases(attempt_key,backend,repeat_free,owner,takeovers,workflow_run_id,step_name) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING attempt_key`,
        [key, row.backend, row.repeatFree, row.owner, row.takeovers, runId, stepName])).rowCount ?? 0) > 0
    },
    async takeOver(key, from, owner) {
      const { runId, stepName } = caller()
      const r = await q<{ takeovers: number }>(`UPDATE learning_llm_attempt_leases SET owner=$2, heartbeat_at=now(), takeovers=takeovers+1, finished_at=NULL,
        workflow_run_id=$5, step_name=$6 WHERE attempt_key=$1 AND owner=$3 AND takeovers=$4 RETURNING takeovers`, [key, owner, from.owner, from.takeovers, runId, stepName])
      return r.rows[0]?.takeovers ?? null
    },
    async heartbeat(key, owner) { return ((await q('UPDATE learning_llm_attempt_leases SET heartbeat_at=now() WHERE attempt_key=$1 AND owner=$2', [key, owner])).rowCount ?? 0) > 0 },
    async release(key, owner) { await q(`UPDATE learning_llm_attempt_leases SET heartbeat_at='-infinity' WHERE attempt_key=$1 AND owner=$2`, [key, owner]) },
    async finish(key) { await q('UPDATE learning_llm_attempt_leases SET finished_at=now(), heartbeat_at=now() WHERE attempt_key=$1', [key]) },
    // Gone when its advisory lock is free: take and release it in ONE statement (one session).
    async ownerIsDead(owner) {
      return (await q<{ dead: boolean }>(`SELECT CASE WHEN pg_try_advisory_lock(${ownerLockSql('$1')}) THEN pg_advisory_unlock(${ownerLockSql('$1')}) ELSE false END AS dead`, [owner])).rows[0]?.dead === true
    },
    async audit(key, action, detail) {
      const { runId, stepName } = caller()
      await q('INSERT INTO learning_llm_attempt_reclaims(attempt_key,action,detail,workflow_run_id,step_name) VALUES($1,$2,$3::jsonb,$4,$5)', [key, action, JSON.stringify(detail), runId, stepName])
    },
  }
}

type AttemptClaim = { kind: 'own'; takeover: boolean } | { kind: 'busy'; owner: string } | { kind: 'refused'; reason: string }
const metered = (backend: string) => ({ kind: 'refused' as const, reason: `backend ${backend} is metered: an unreceipted call is never repeated` })

/**
 * Claim the right to execute attempt `key`. `fresh`: the caller has just written the reservation itself (so no
 * lease means "not yet written", not "orphaned"). `reservedAt`: when the reservation was written.
 */
export async function claimAttempt(store: LeaseStore, key: string, input: { backend: string; fresh?: boolean; reservedAt: Date | null; owner?: string }): Promise<AttemptClaim> {
  const repeatIsFree = isRepeatFree(input.backend)
  const me = input.owner ?? OWNER
  await store.holdOwner()
  // Each turn re-reads after a lost race; a store that keeps contradicting itself must fail, not spin.
  for (let turn = 0; ; turn++) {
    if (turn > 20) throw new Error(`Attempt lease ${key}: store kept losing the claim race`)
    const lease = await store.get(key)
    if (!lease) {
      const unleasedDead = !input.reservedAt || Date.now() - input.reservedAt.getTime() > UNLEASED_RESERVATION_GRACE_MS()
      if (!input.fresh) {
        if (!repeatIsFree) return metered(input.backend)
        if (!unleasedDead) return { kind: 'busy', owner: 'unknown (reservation without a lease yet)' }
      }
      if (!await store.insert(key, { backend: input.backend, repeatFree: repeatIsFree, owner: me, takeovers: input.fresh ? 0 : 1 })) continue
      if (!input.fresh) await store.audit(key, 'takeover', { previousOwner: null, reason: 'reservation without a lease past the insert grace', reservedAt: input.reservedAt })
      return { kind: 'own', takeover: !input.fresh }
    }
    // This process is driving it right now (a duplicate delivery): wait, never run it twice side by side.
    if (lease.owner === me && driving.has(key)) return { kind: 'busy', owner: lease.owner }
    // Ours but not driven any more (its work threw, and the step retries it here): an ordinary throw counts no
    // takeover (the step's retry limit bounds it); a dead wrapper did count one (driveAttempt), so the budget applies.
    const mine = lease.owner === me
    if (!mine && !(lease.stale || await store.ownerIsDead(lease.owner))) return { kind: 'busy', owner: lease.owner }
    if (!(repeatIsFree && lease.repeatFree)) return metered(input.backend)
    if (lease.takeovers >= MAX_ATTEMPT_TAKEOVERS) return { kind: 'refused', reason: `taken over ${lease.takeovers} times without an outcome; stopped for review` }
    if (mine) {
      if (await store.heartbeat(key, me)) return { kind: 'own', takeover: false }
      continue
    }
    const takeovers = await store.takeOver(key, lease, me)
    if (takeovers === null) continue
    await store.audit(key, 'takeover', { previousOwner: lease.owner, previousRunId: lease.runId ?? null, stale: lease.stale, takeovers })
    return { kind: 'own', takeover: true }
  }
}

const LOST = Symbol('lease lost')
/** Attempts this process is executing now. */
const driving = new Set<string>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type DriveOutcome<T> = { kind: 'recorded'; value: T } | { kind: 'settled' } | { kind: 'refused'; reason: string }
/**
 * Drive one reserved attempt to an outcome: claim it, wait while a live owner works, take it over when the owner is
 * dead and the backend is repeat-free, run `work` with the attempt's durable call plan (adopting a detached
 * child's finished result), and `record` the outcome insert-once. `settled()` is read first on every turn.
 */
export async function driveAttempt<T>(store: LeaseStore, input: {
  key: string; backend: string; fresh?: boolean; reservedAt: Date | null
  settled(): Promise<boolean>; work(durable: DurableCallPlan): Promise<T>; record(value: T): Promise<void>
}): Promise<DriveOutcome<T>> {
  let fresh = input.fresh
  // Ids and reasons only. A wait logs once per owner, not once per poll.
  const log = (level: 'info' | 'warn', event: string, detail: Record<string, unknown> = {}) => {
    const { runId, stepName, logger } = caller()
    logger?.[level]({ event: `llm-attempt-${event}`, attemptKey: input.key, runId, stepName, owner: OWNER, ...detail })
  }
  // A best-effort lease write that fails leaves its reason, then the attempt carries on (fails open).
  const failOpen = (op: string) => (error: unknown) => { log('warn', 'fail-open', { op, ...errorKind(error) }); return null }
  let waitingFor: string | null = null
  for (;;) {
    if (await input.settled()) return { kind: 'settled' }
    const claim = await claimAttempt(store, input.key, { backend: input.backend, fresh, reservedAt: input.reservedAt })
    fresh = false
    // Durable as well as logged: the caller answers 'uncertain' and writes no receipt, so this row is the reason.
    if (claim.kind === 'refused') { log('warn', 'refused', { reason: claim.reason }); await store.audit(input.key, 'refused', { reason: claim.reason }); return claim }
    if (claim.kind === 'busy') {
      if (waitingFor !== claim.owner) log('info', 'busy', { holder: claim.owner })
      waitingFor = claim.owner
      await sleep(ATTEMPT_POLL_MS()); continue
    }
    log('info', claim.takeover ? 'takeover' : 'claim')
    driving.add(input.key)
    let lost = false
    const beat = setInterval(() => { store.heartbeat(input.key, OWNER).then((held) => { if (!held) lost = true }).catch(failOpen('heartbeat')) }, ATTEMPT_HEARTBEAT_MS())
    let value: T | typeof LOST
    const plan = durableCallPlan(attemptFilesKey(input.key))
    try {
      value = await input.work(plan)
      if (lost) value = LOST
      // The CLI child died with no result: `value` records an error for an UNKNOWN outcome (the caller turns any
      // failure into a receipt). Never record it: give the attempt up so the step's retry, or the next worker,
      // takes it over and runs it again (repeat-free), within the takeover budget.
      if (plan.lost) throw new Error(`Attempt ${input.key}: the durable CLI call died without a result; released for a takeover`)
    } catch (error) {
      // A dead wrapper is an unknown outcome like a restart's: it spends the takeover budget even in this process,
      // so a call whose wrapper dies every time (OOM) ends refused for a person, not looping on step retries.
      if (plan.lost) {
        log('warn', 'lost', { cause: 'wrapper died without a result' })
        const lease = await store.get(input.key).catch(failOpen('get'))
        if (lease?.owner === OWNER && await store.takeOver(input.key, lease, OWNER).catch(failOpen('takeOver')) !== null)
          await store.audit(input.key, 'wrapper-lost', { takeovers: lease.takeovers + 1 }).catch(failOpen('audit'))
      }
      // Give the attempt up at once: a live process that cannot finish must not hold it for a lease period.
      await store.release(input.key, OWNER).catch(failOpen('release'))
      throw error
    } finally { clearInterval(beat); driving.delete(input.key) }
    if (value === LOST) { log('warn', 'lost', { cause: 'taken over while running' }); continue } // the new owner records; we wait for it
    await input.record(value)
    await store.finish(input.key)
    discardAttempt(attemptFilesKey(input.key))
    return { kind: 'recorded', value }
  }
}

/**
 * A reserved run of learning_concept_assessment_runs (the reactive grading, and every experiment call stored there)
 * driven to its receipt: `driveAttempt` under the run's key, the receipt recorded insert-once. The stored receipt
 * answers (an insert-once write may lose to a concurrent one); a refused claim (metered backend with an unknown
 * outcome, or the takeover budget spent) writes no receipt (its reason is a 'refused' reclaim row) and answers 'uncertain'. The caller wrote the reservation
 * (`fresh`: a moment ago, in this call).
 */
export async function driveAssessmentRun<R extends { status: string }>(q: MetaPgQueryFn, store: LeaseStore, input: {
  runId: string; backend: string; fresh?: boolean; reservedAt: Date | null
  storedStatus(): Promise<string | undefined>; work(durable: DurableCallPlan): Promise<R>
}): Promise<{ runId: string; status: string }> {
  const outcome = await driveAttempt(store, {
    key: assessmentAttemptKey(input.runId), backend: input.backend, fresh: input.fresh, reservedAt: input.reservedAt,
    settled: async () => !!(await input.storedStatus()), work: input.work,
    // If this write fails the lease lapses and the attempt is finished again (free) or stays unknown (metered).
    record: async (receipt) => { await q('INSERT INTO learning_concept_assessment_receipts(run_id,receipt) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [input.runId, JSON.stringify(receipt)]) },
  })
  if (outcome.kind === 'refused') return { runId: input.runId, status: 'uncertain' }
  return { runId: input.runId, status: (await input.storedStatus()) ?? (outcome.kind === 'recorded' ? outcome.value.status : 'uncertain') }
}

export const assessmentAttemptKey = (runId: string) => `assessment:${runId}`
export const replicateAttemptKey = (runId: string, replicate: number) => `replicate:${runId}:${replicate}`
export const driftAttemptKey = (userId: string, item: number, week: string) => `drift:${userId}:${item}:${week}`
