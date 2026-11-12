import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attemptFilesKey, attemptOwner, claimAttempt, driveAttempt, MAX_ATTEMPT_TAKEOVERS, type LeaseRow } from './llm-attempt-lease.js'
import { memoryLeaseStore } from './testing/memory-lease-store.js'
import { withCliTelemetry } from '@learner/llm/lib/cli/cli-telemetry.js'

// The claim rules of a reserved model attempt (docs/operations/restart-safety.md): wait for a live owner, finish
// for a provably dead one on a repeat-free backend, refuse a metered one, stop after the takeover budget.
const saved = { ...process.env }
let root = ''
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lease-test-'))
  Object.assign(process.env, { LEARNER_LLM_ATTEMPT_DIR: root, LEARNER_ATTEMPT_POLL_MS: '5', LEARNER_ATTEMPT_HEARTBEAT_MS: '5', LEARNER_ATTEMPT_LEASE_MS: '60000' })
  delete process.env.LEARNER_METERED_BACKENDS
})
afterAll(() => { process.env = saved; rmSync(root, { recursive: true, force: true }) })

const OTHER = 'elsewhere:1:x'
const seeded = (row: Partial<LeaseRow & { heartbeatAt: number }> = {}) => {
  const store = memoryLeaseStore()
  store.state.leases.set('k', { owner: OTHER, repeatFree: true, takeovers: 0, stale: false, heartbeatAt: Date.now(), ...row })
  return store
}
const old = new Date(Date.now() - 3_600_000)

test('a fresh reservation is owned at once, with no takeover counted', async () => {
  const store = memoryLeaseStore()
  expect(await claimAttempt(store, 'k', { backend: 'codex', fresh: true, reservedAt: new Date() })).toEqual({ kind: 'own', takeover: false })
  expect(store.state.leases.get('k')).toMatchObject({ owner: attemptOwner(), takeovers: 0 })
  expect(store.state.audit).toEqual([])
})

test('a live owner is waited for, whatever the backend', async () => {
  for (const backend of ['codex', 'typesafe']) {
    expect((await claimAttempt(seeded(), 'k', { backend, reservedAt: old })).kind).toBe('busy')
  }
})

test('a provably dead owner on a repeat-free backend is taken over once and audited', async () => {
  const store = seeded()
  store.state.dead.add(OTHER)
  expect(await claimAttempt(store, 'k', { backend: 'codex', reservedAt: old })).toEqual({ kind: 'own', takeover: true })
  expect(store.state.leases.get('k')).toMatchObject({ owner: attemptOwner(), takeovers: 1 })
  expect(store.state.audit).toEqual([{ key: 'k', action: 'takeover' }])
})

test('a stale heartbeat counts as dead (a stuck process), a fresh one does not', async () => {
  expect((await claimAttempt(seeded({ heartbeatAt: Date.now() - 120_000 }), 'k', { backend: 'codex', reservedAt: old })).kind).toBe('own')
  expect((await claimAttempt(seeded({ heartbeatAt: Date.now() - 1_000 }), 'k', { backend: 'codex', reservedAt: old })).kind).toBe('busy')
})

test('a metered backend never repeats an unknown outcome, even for a dead owner', async () => {
  const store = seeded({ repeatFree: false })
  store.state.dead.add(OTHER)
  expect((await claimAttempt(store, 'k', { backend: 'typesafe', reservedAt: old })).kind).toBe('refused')
  // The lease records how it was started: a backend made metered since is not repeated, and neither is one made free since.
  const was = seeded({ repeatFree: false }); was.state.dead.add(OTHER)
  expect((await claimAttempt(was, 'k', { backend: 'codex', reservedAt: old })).kind).toBe('refused')
  process.env.LEARNER_METERED_BACKENDS = 'codex'
  try {
    const now = seeded(); now.state.dead.add(OTHER)
    expect((await claimAttempt(now, 'k', { backend: 'codex', reservedAt: old })).kind).toBe('refused')
  } finally { delete process.env.LEARNER_METERED_BACKENDS }
  expect(store.state.leases.get('k')).toMatchObject({ owner: OTHER, takeovers: 0 })
})

test('the takeover budget stops a call that keeps killing its worker', async () => {
  const store = seeded({ takeovers: MAX_ATTEMPT_TAKEOVERS - 1 })
  store.state.dead.add(OTHER)
  expect((await claimAttempt(store, 'k', { backend: 'codex', reservedAt: old })).kind).toBe('own')
  const spent = seeded({ takeovers: MAX_ATTEMPT_TAKEOVERS })
  spent.state.dead.add(OTHER)
  expect(await claimAttempt(spent, 'k', { backend: 'codex', reservedAt: old })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('stopped for review') })
})

test('a reservation without a lease: busy inside the insert grace, taken over after it, refused when metered', async () => {
  expect((await claimAttempt(memoryLeaseStore(), 'k', { backend: 'codex', reservedAt: new Date() })).kind).toBe('busy')
  const orphan = memoryLeaseStore()
  expect(await claimAttempt(orphan, 'k', { backend: 'codex', reservedAt: old })).toEqual({ kind: 'own', takeover: true })
  expect(orphan.state.leases.get('k')).toMatchObject({ takeovers: 1 })
  expect(orphan.state.audit).toEqual([{ key: 'k', action: 'takeover' }])
  expect((await claimAttempt(memoryLeaseStore(), 'k', { backend: 'typesafe', reservedAt: old })).kind).toBe('refused')
})

test('driveAttempt: a settled attempt is never worked; a finished one is recorded exactly once', async () => {
  const store = memoryLeaseStore()
  let worked = 0
  const recorded: string[] = []
  const drive = () => driveAttempt(store, { key: 'k', backend: 'codex', fresh: true, reservedAt: new Date(),
    settled: async () => recorded.length > 0, work: async () => { worked++; return 'v' }, record: async (v) => { recorded.push(v) } })
  expect(await drive()).toEqual({ kind: 'recorded', value: 'v' })
  expect(await drive()).toEqual({ kind: 'settled' })
  expect([worked, recorded]).toEqual([1, ['v']])
})

test('driveAttempt: two deliveries in one process run the work once; the second waits and sees it settled', async () => {
  const store = memoryLeaseStore()
  let worked = 0
  const recorded: string[] = []
  let finish!: () => void
  const gate = new Promise<void>((r) => { finish = r })
  const input = { key: 'k', backend: 'codex', reservedAt: new Date(), settled: async () => recorded.length > 0,
    work: async () => { worked++; await gate; return 'v' }, record: async (v: string) => { recorded.push(v) } }
  const first = driveAttempt(store, { ...input, fresh: true })
  await Bun.sleep(20)
  const second = driveAttempt(store, input)
  await Bun.sleep(30)
  finish()
  expect(await first).toEqual({ kind: 'recorded', value: 'v' })
  expect(await second).toEqual({ kind: 'settled' })
  expect(worked).toBe(1)
})

test('driveAttempt: a thrown error releases the lease at once, so the replay finishes it without waiting a lease period', async () => {
  const store = memoryLeaseStore()
  const recorded: string[] = []
  let calls = 0
  const input = { key: 'k', backend: 'codex', reservedAt: new Date(), settled: async () => recorded.length > 0,
    work: async () => { if (++calls === 1) throw new Error('child died'); return 'v' }, record: async (v: string) => { recorded.push(v) } }
  await expect(driveAttempt(store, { ...input, fresh: true })).rejects.toThrow('child died')
  // Another process (its owner lock still held by this live one) may take it over at once: the heartbeat is gone.
  const peer = memoryLeaseStore({ ...store.state, leases: new Map([...store.state.leases].map(([k, v]) => [k, { ...v }])) })
  expect((await claimAttempt(peer, 'k', { backend: 'codex', reservedAt: new Date(), owner: OTHER })).kind).toBe('own')
  expect(await driveAttempt(store, input)).toEqual({ kind: 'recorded', value: 'v' })
  expect([calls, recorded]).toEqual([2, ['v']])
})

test('driveAttempt: an owner whose lease was taken over while it ran does not record; it waits for the new owner', async () => {
  const store = memoryLeaseStore()
  const recorded: string[] = []
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  const run = driveAttempt(store, { key: 'k', backend: 'codex', fresh: true, reservedAt: new Date(), settled: async () => recorded.length > 0,
    work: async () => { await gate; return 'mine' }, record: async (v) => { recorded.push(v) } })
  await Bun.sleep(20)
  const lease = store.state.leases.get('k')!
  lease.owner = OTHER; lease.takeovers++ // another process took it over (we looked dead to it)
  await Bun.sleep(20) // a heartbeat sees the lease lost
  release()
  await Bun.sleep(30)
  expect(recorded).toEqual([])
  recorded.push('theirs') // the new owner records
  expect(await run).toEqual({ kind: 'settled' })
  expect(recorded).toEqual(['theirs'])
})

test('driveAttempt: throws inside one live process are retried without spending the restart takeover budget', async () => {
  const store = memoryLeaseStore()
  const recorded: string[] = []
  let calls = 0
  const input = { key: 'k', backend: 'codex', reservedAt: new Date(), settled: async () => recorded.length > 0,
    work: async () => { if (++calls <= MAX_ATTEMPT_TAKEOVERS + 2) throw new Error('ENOSPC'); return 'v' }, record: async (v: string) => { recorded.push(v) } }
  for (let i = 0; i < MAX_ATTEMPT_TAKEOVERS + 2; i++) await expect(driveAttempt(store, { ...input, fresh: i === 0 })).rejects.toThrow('ENOSPC')
  expect(await driveAttempt(store, input)).toEqual({ kind: 'recorded', value: 'v' })
  expect(store.state.leases.get('k')).toMatchObject({ owner: attemptOwner(), takeovers: 0 })
  expect(store.state.audit).toEqual([])
  // A metered call that threw may have been paid: this process does not repeat it either.
  const metered = memoryLeaseStore()
  await expect(driveAttempt(metered, { ...input, backend: 'typesafe', fresh: true, settled: async () => false, work: async () => { throw new Error('x') } })).rejects.toThrow('x')
  expect((await claimAttempt(metered, 'k', { backend: 'typesafe', reservedAt: new Date() })).kind).toBe('refused')
})

test('call files are per database: a copy of the data never shares the live worker\'s attempt directory', () => {
  expect(attemptFilesKey('drift:u:1:w', 'postgres://u:p@h:5432/learner')).not.toBe(attemptFilesKey('drift:u:1:w', 'postgres://u:p@h:5432/learner_copy'))
  expect(attemptFilesKey('k', 'postgres://u:secret@h/db')).not.toContain('secret')
})

test('driveAttempt: a CLI wrapper that dies every time (OOM) spends the takeover budget in-process and ends refused, never loops', async () => {
  const store = memoryLeaseStore()
  let calls = 0
  const input = { key: 'k', backend: 'codex', reservedAt: new Date(), settled: async () => false,
    work: async (plan: { lost: boolean }) => { calls++; plan.lost = true; return 'error receipt' }, record: async () => { throw new Error('a lost call must never be recorded') } }
  for (let i = 0; i < MAX_ATTEMPT_TAKEOVERS; i++) await expect(driveAttempt(store, { ...input, fresh: i === 0 })).rejects.toThrow('died without a result')
  expect(await driveAttempt(store, input)).toMatchObject({ kind: 'refused' })
  expect(calls).toBe(MAX_ATTEMPT_TAKEOVERS)
  // The refusal is recorded too: the caller answers 'uncertain' with no receipt, so this row says why.
  expect(store.state.audit.map((a) => a.action)).toEqual([...Array(MAX_ATTEMPT_TAKEOVERS).fill('wrapper-lost'), 'refused'])
})

test('driveAttempt: a best-effort lease write that fails logs why (its kind, never its text), then carries on', async () => {
  const store = memoryLeaseStore()
  const down = Object.assign(new Error('pool exhausted'), { code: '53300' })
  Object.assign(store, { heartbeat: async () => { throw down }, release: async () => { throw down } })
  const warned: Array<Record<string, unknown>> = []
  const work = async () => { await new Promise((resolve) => setTimeout(resolve, 30)); throw new Error('model failed') }
  await expect(withCliTelemetry({ label: 'stepFn', jobId: 'run-1', logger: { info: () => {}, warn: (e: Record<string, unknown>) => warned.push(e) } as any },
    () => driveAttempt(store, { key: 'k', backend: 'codex', fresh: true, reservedAt: new Date(), settled: async () => false, work, record: async () => {} }))).rejects.toThrow('model failed')
  expect(new Set(warned.map((e) => e.op))).toEqual(new Set(['heartbeat', 'release']))
  expect(warned[0]).toMatchObject({ event: 'llm-attempt-fail-open', attemptKey: 'k', runId: 'run-1', stepName: 'stepFn', errorType: 'Error', errorCode: '53300' })
})
