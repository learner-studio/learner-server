import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { simBlockOpenStep, takeSimLookStep } from '@learner/server/functions/learning/learning-sim-experiment.function.js'
import { LearnerWorkflowService } from '../src/transport.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * Core 0.12.156 releases a queued child step's lease once its child starts; a replay of the parent then re-dispatches
 * the step (left `scheduled`, or `running` with no lease) and the framework's claim starts a SECOND child. A parallel
 * fan-out replays on every sibling that settles, so this happened to every still-waiting child. Learner's claim
 * (transport.ts) refuses a step whose child run is live and delivers a completed child's result; a failed or
 * cancelled child, and a step with no child, stay the framework's. Each case also runs the framework's own claim on
 * an identical row, which shows the behaviour the override removes.
 */
const url = await ownTestDatabaseUrl('claim')
describe.skipIf(!url)('the step claim never starts a second child (learner_claim_test_<checkout>)', () => {
  const runtime = bootRuntime({ schemaPrefix: 'learner_boss_claim_', databaseUrl: url! })
  afterAll(() => runtime.stop())
  const STEP = 'Run one learner', CHILD = 'learningSimLearnerWorkflow'

  /** A parent wave run with one step; the step's child run (if any) in `child` status. */
  async function row(step: { status: string; leaseMs?: number; retry?: boolean }, child?: { status: string; output?: unknown }) {
    const { db } = await runtime.booted
    const parent = randomUUID(), childId = child ? randomUUID() : null
    await db.query(`INSERT INTO learner_workflow_runs(workflow_run_id, workflow, status, input) VALUES($1, 'learningSimWaveWorkflow', 'running', '{}')`, [parent])
    if (child) await db.query(`INSERT INTO learner_workflow_runs(workflow_run_id, workflow, status, input, output, created_at) VALUES($1, $2, $3, '{}', $4, now() - interval '1 minute')`,
      [childId, CHILD, child.status, child.output === undefined ? null : JSON.stringify(child.output)])
    const { stepId } = (await db.query<{ stepId: string }>(`INSERT INTO learner_workflow_steps(workflow_run_id, step_name, rpc_name, data, status, retries, current_attempt, child_run_id, lease_expires_at)
      VALUES($1, $2, $3, '{}', $4, 2, $5, $6, $7) RETURNING workflow_step_id AS "stepId"`, [parent, STEP, childId ? CHILD : 'simActionStep', step.status, step.retry ? 2 : 1, childId, step.leaseMs ? Date.now() + step.leaseMs : null])).rows[0]!
    // A retry is a new attempt, begun after its predecessor's child (createRetryAttempt / reclaimStepAttempt history).
    if (step.retry) await db.query(`INSERT INTO learner_workflow_step_history(history_id, workflow_step_id, status, attempt, created_at) VALUES($1, $2, $3, 2, now())`, [randomUUID(), stepId, step.status])
    // A child names its parent step in its wire, as the framework's child step writes it.
    if (child) await db.query(`UPDATE learner_workflow_runs SET wire = $2 WHERE workflow_run_id = $1`, [childId, JSON.stringify({ type: 'workflow', parentRunId: parent, parentStepId: stepId })])
    fixtures.push(parent)
    return parent
  }
  // Hand-made parents have no real input: once a case is done they are cancelled, so a later recovery pass leaves them.
  const fixtures: string[] = []
  afterEach(async () => {
    if (fixtures.length) await (await runtime.booted).db.query(`UPDATE learner_workflow_runs SET status = 'cancelled' WHERE workflow_run_id = ANY($1::text[]) AND status = 'running'`, [fixtures.splice(0)])
  })
  const state = async (parent: string) => (await (await runtime.booted).db.query<{ status: string; attempt: number; result: string | null }>(
    `SELECT status, current_attempt AS attempt, result FROM learner_workflow_steps WHERE workflow_run_id = $1`, [parent])).rows[0]!
  type Claim = (runId: string, stepName: string, rpcName: string, leaseMs: number) => Promise<unknown>
  const ours = async (parent: string, rpc = CHILD) => ((await runtime.booted).workflowService as unknown as { claimStepForExecution: Claim }).claimStepForExecution(parent, STEP, rpc, 60_000)
  const framework = async (parent: string, rpc = CHILD) => (Object.getPrototypeOf(LearnerWorkflowService.prototype).claimStepForExecution as Claim)
    .call((await runtime.booted).workflowService, parent, STEP, rpc, 60_000)

  // The replay marks the waiting step `scheduled` and queues it; the framework claims a `scheduled` step and starts
  // its child. (A `running` step with no lease the framework already leaves alone: its reclaim needs a lapsed lease.)
  test('a step re-armed while its child runs (a sibling settled and the wave replayed) is not claimed', async () => {
    expect(await framework(await row({ status: 'scheduled' }, { status: 'running' }))).not.toBeNull()
    const parent = await row({ status: 'scheduled' }, { status: 'running' })
    expect(await ours(parent)).toBeNull()
    expect(await state(parent)).toMatchObject({ status: 'scheduled', attempt: 1 })
  })

  test('a child that completed before its step was written: the claim delivers its result, no second child', async () => {
    expect(await framework(await row({ status: 'scheduled' }, { status: 'completed', output: { learner: 'l1' } }))).not.toBeNull()
    const parent = await row({ status: 'scheduled' }, { status: 'completed', output: { learner: 'l1' } })
    expect(await ours(parent)).toBeNull()
    const after = await state(parent)
    expect({ status: after.status, result: JSON.parse(after.result!) }).toEqual({ status: 'succeeded', result: { learner: 'l1' } })
  })

  for (const status of ['failed', 'cancelled']) {
    test(`a ${status} child of an earlier attempt (a retry re-armed the step, childRunId kept) goes to the framework's retry`, async () => {
      const parent = await row({ status: 'scheduled', retry: true }, { status })
      expect(await ours(parent)).not.toBeNull()
      expect((await state(parent)).status).toBe('running')
    })
  }

  test('a failed child of the current attempt that never told its step: the claim fails the step (one attempt spent), no second child', async () => {
    const parent = await row({ status: 'scheduled' }, { status: 'failed' })
    expect(await ours(parent)).toBeNull()
    expect(await state(parent)).toMatchObject({ status: 'failed', attempt: 1 })
  })

  test('a function step (no child) is the framework\'s: claimed when free, refused while its lease is held', async () => {
    expect(await ours(await row({ status: 'scheduled' }), 'simActionStep')).not.toBeNull()
    expect(await ours(await row({ status: 'running', leaseMs: 60_000 }), 'simActionStep')).toBeNull()
  })

  /**
   * The real block -> wave workflows on the worker runtime: the gate and look steps answer at once and the wave has no
   * learners, so the wave child settles in milliseconds and no model is called. The child's status write and the
   * parent step's write are two writes; each case leaves the state a failure between them leaves and needs Pikku's
   * recovery (worker.ts startRecovery) to settle the run as the child would have, with one child. "Run one wave" has no
   * retries, so a failed wave fails its block, by design (learning-sim-learner.workflow.ts).
   */
  describe('a parent whose child settled without telling it is told by Pikku\'s recovery', () => {
    const gate = simBlockOpenStep as { func: unknown }, look = takeSimLookStep as { func: unknown }
    const original = [gate.func, look.func]
    gate.func = async () => ({ open: true })
    look.func = async () => ({ decision: null })
    afterAll(() => { [gate.func, look.func] = original })
    const WAVE = 'Run one wave'
    const block = () => ({ runId: randomUUID(), index: 0, blocks: 1, waves: [{ learners: [] }] })
    const waveStep = async (parent: string) => (await (await runtime.booted).db.query<{ id: string; child: string | null }>(
      `SELECT workflow_step_id AS id, child_run_id AS child FROM learner_workflow_steps WHERE workflow_run_id = $1 AND step_name = $2`, [parent, WAVE])).rows[0]!
    const waveRuns = async (stepId: string) => Number((await (await runtime.booted).db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM learner_workflow_runs WHERE workflow = 'learningSimWaveWorkflow' AND wire::jsonb->>'parentStepId' = $1`, [stepId])).rows[0]!.n)
    /**
     * Run a block to completion, then put its rows back into the state a failure between the two writes leaves.
     * `unrecorded`: killed before `setStepChildRunId` (the lease lapsed, no child recorded). `wireless`: the child's
     * wire has no `parentStepId` (Pikku's own hooks would then do nothing). `retry`: the step is attempt 2, begun after
     * its child, which therefore belongs to attempt 1 (`lease`: the attempt's lease, ms from now).
     */
    async function interrupted(stepStatus: string, child: string, o: { unrecorded?: boolean; wireless?: boolean; retry?: boolean; lease?: number; noHistory?: boolean } = {}) {
      const { db } = await runtime.booted
      const parent = await runtime.start('learningSimBlockWorkflow', block())
      expect((await runtime.awaitRun(parent, 60_000))?.status).toBe('completed')
      const step = await waveStep(parent)
      await db.query(`UPDATE learner_workflow_runs SET status = 'running', output = NULL WHERE workflow_run_id = $1`, [parent])
      await db.query(`UPDATE learner_workflow_steps SET status = $2, result = NULL, lease_expires_at = $3, child_run_id = $4, current_attempt = $5 WHERE workflow_step_id = $1`,
        [step.id, stepStatus, o.lease !== undefined ? Date.now() + o.lease : o.unrecorded ? Date.now() - 1000 : null, o.unrecorded ? null : step.child, o.retry ? 2 : 1])
      await db.query(`UPDATE learner_workflow_runs SET status = $2${o.wireless ? `, wire = (wire::jsonb - 'parentStepId')::text` : ''}${o.retry ? `, created_at = created_at - interval '1 minute'` : ''} WHERE workflow_run_id = $1`, [step.child, child])
      if (o.retry && !o.noHistory) await db.query(`INSERT INTO learner_workflow_step_history(history_id, workflow_step_id, status, attempt, created_at) VALUES($1, $2, 'running', 2, now() - interval '30 seconds')`, [randomUUID(), step.id])
      fixtures.push(parent)
      return { parent, step: step.id, child: step.child! }
    }
    const state2 = async (parent: string) => (await (await runtime.booted).db.query<{ run: string; step: string }>(
      `SELECT r.status AS run, s.status AS step FROM learner_workflow_runs r JOIN learner_workflow_steps s ON s.workflow_run_id = r.workflow_run_id AND s.step_name = $2 WHERE r.workflow_run_id = $1`, [parent, WAVE])).rows[0]!
    const svc = async () => (await runtime.booted).workflowService as LearnerWorkflowService

    // A failed or cancelled wave fails its block: "Run one wave" has no retries.
    for (const [stepStatus, child, wireless] of [['running', 'completed'], ['scheduled', 'completed'], ['pending', 'completed'], ['running', 'completed', true],
      ['running', 'failed'], ['scheduled', 'failed'], ['running', 'cancelled']] as const) {
      test(`killed between the writes (child ${child}, step ${stepStatus}${wireless ? ', no parentStepId in the child\'s wire' : ''}): the next worker's startup recovery settles the run as the child would have, no second child`, async () => {
        const { parent, step } = await interrupted(stepStatus, child, { wireless })
        await (await svc()).recoverWorkflows({ startup: true })
        expect((await runtime.awaitRun(parent, 60_000))?.status).toBe(child === 'completed' ? 'completed' : 'failed')
        // Counted by `wire.parentStepId`: the wireless child is not counted, so any count there is a second child.
        expect(await waveRuns(step)).toBe(wireless ? 0 : 1)
      }, 150_000)
    }

    // `noHistory`: review-sim's hand-built P2 and P3, with no history row for attempt 2 (Pikku always writes one).
    for (const noHistory of [false, true]) test(`a retry killed between starting its child and recording it (the step still names the earlier attempt's failed child${noHistory ? ', no history row for the attempt' : ''}): it adopts the retry's child, no third`, async () => {
      const { db } = await runtime.booted
      const { parent, step, child } = await interrupted('running', 'failed', { retry: true, lease: -1000, noHistory })
      // The retry's own child, started (and completed) by the killed worker; created after the attempt began.
      const second = randomUUID()
      await db.query(`INSERT INTO learner_workflow_runs(workflow_run_id, workflow, status, input, output, wire)
        SELECT $2, workflow, 'completed', input, $3, wire FROM learner_workflow_runs WHERE workflow_run_id = $1`, [child, second, JSON.stringify({ learners: 0 })])
      await (await svc()).recoverWorkflows({ startup: true })
      expect((await runtime.awaitRun(parent, 60_000))?.status).toBe('completed')
      expect(await waveRuns(step)).toBe(2)
      expect((await waveStep(parent)).child).toBe(second)
    }, 150_000)

    for (const [child, noHistory] of [['failed', false], ['completed', false], ['failed', true]] as const) test(`an earlier attempt's ${child} child never settles the current attempt (a retry holding its lease, its child not yet recorded${noHistory ? ', no history row for the attempt' : ''})`, async () => {
      const { parent } = await interrupted('running', child, { retry: true, lease: 600_000, noHistory })
      await (await svc()).recoverWorkflows({ startup: true })
      await Bun.sleep(2_000)
      expect((await state2(parent))).toEqual({ run: 'running', step: 'running' })
    }, 150_000)

    // Core 0.12.157: when the parent's write throws inside the child's completion, the pass's failOrUnwind rewrites the
    // completed child to `failed` with that error (its output is dropped) and nobody tells the parent. The periodic
    // pass tells it, so the block fails with the error on record instead of waiting for good (upstream draft, item 3).
    test('one failed write of the parent step, no restart: Pikku\'s periodic recovery pass settles the run', async () => {
      const svc = (await runtime.booted).workflowService as LearnerWorkflowService & { setStepResult: (...a: unknown[]) => Promise<void> }
      const write = svc.setStepResult.bind(svc)
      let thrown = 0
      svc.setStepResult = async (...a: unknown[]) => {
        if (!thrown && (a[1] as { learners?: number } | undefined)?.learners === 0) { thrown++; throw new Error('one lost write of the parent step') }
        return write(...a)
      }
      try {
        const parent = await runtime.start('learningSimBlockWorkflow', block())
        // The worker's 30 s tick, run here by hand (stalledAfterMs 0 instead of 30 s) until the run settles.
        let run = await svc.getRun(parent)
        for (const deadline = Date.now() + 120_000; run?.status === 'running' && Date.now() < deadline; run = await svc.getRun(parent)) {
          await Bun.sleep(1_000)
          await svc.recoverWorkflows({ stalledAfterMs: 0 })
        }
        expect(thrown).toBe(1)
        // Usually failed with the error on record. When the pass tells the step in the moment between the child's
        // `completed` and failOrUnwind's rewrite, the block completes with the child's output: either way, settled
        // with one wave (review-sim saw 1 in 4).
        if (run?.status === 'failed') expect(run.error?.message).toBe('one lost write of the parent step')
        else expect(run?.status).toBe('completed')
        expect(await waveRuns((await waveStep(parent)).id)).toBe(1)
      } finally { svc.setStepResult = write }
    }, 150_000)

    test('killed between starting the child and recording it: the step adopts that child, no second one', async () => {
      const svc = (await runtime.booted).workflowService as LearnerWorkflowService
      const { parent, step } = await interrupted('running', 'completed', true)
      await svc.recoverWorkflows({ startup: true })
      expect((await runtime.awaitRun(parent, 60_000))?.status).toBe('completed')
      expect(await waveRuns(step)).toBe(1)
    }, 150_000)
  })
})
