import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { factBudget, SIM_DAY_GAP, stratifiedHoldout, williamsRow } from '@learner/core/lib/learning/learning-sim-design.js'
import { prepareSimLearnerStep, simProbesStep } from '@learner/server/functions/learning/learning-sim-experiment.function.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * Core 0.12.156 unwinds a failed parent through every child-workflow step that has a child run: a COMPLETED child is
 * failed and its output erased. Learner's child steps opt out (`compensate: false`), so a parent that fails after a
 * child finished leaves that child completed, with its output. The real learningSimLearnerWorkflow on the worker
 * runtime, its first step swapped for a one-session plan with no work (so the session child completes at once) and
 * the step after the sessions swapped for one that always fails.
 */
const url = await ownTestDatabaseUrl('child')
describe.skipIf(!url)('a failed parent keeps its completed child runs (learner_child_test_<checkout>)', () => {
  const choice = { model: 'stub', effort: 'low', timeoutSec: 60 }
  const config = SimLearnerConfig.parse({
    runId: randomUUID(), learnerId: 'l901', arm: 'off', lane: 'fast', sessions: 1, turns: 2, transport: 'stub',
    learnerModel: choice, agentModel: choice, scorerModel: choice,
    heldOut: stratifiedHoldout(0, 'child'), taskOrder: williamsRow(0).slice(0, 1), factBudget: factBudget('fast'), dayGap: SIM_DAY_GAP,
  })
  const steps = prepareSimLearnerStep as { func: unknown }, probes = simProbesStep as { func: unknown }
  const original = [steps.func, probes.func]
  steps.func = async () => ({ sessions: [{ config, session: 1, actions: [], grades: [] }] })
  probes.func = async () => { throw new Error('the step after the child fails') }
  const runtime = bootRuntime({ schemaPrefix: 'learner_boss_child_', databaseUrl: url! })
  afterAll(async () => {
    [steps.func, probes.func] = original
    await runtime.stop()
  })

  test('the parent fails; the session child it already finished stays completed with its output', async () => {
    const services = await runtime.booted
    const parent = await runtime.awaitRun(await runtime.start('learningSimLearnerWorkflow', config), 120_000)
    expect(parent?.status).toBe('failed')
    const rows = (await services.db.query<{ step: string; child: string | null }>(
      'SELECT step_name AS step, child_run_id AS child FROM learner_workflow_steps WHERE workflow_run_id = $1', [parent!.id])).rows
    const child = await services.workflowRunService.getRun(rows.find((r) => r.child)!.child!)
    expect({ workflow: child?.workflow, status: child?.status, output: child?.output })
      .toEqual({ workflow: 'learningSimSessionWorkflow', status: 'completed', output: { session: 1, grades: 0 } })
    expect(rows.filter((r) => r.step.endsWith(':compensate'))).toEqual([])
  }, 150_000)
})
