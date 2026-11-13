import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { bindDatabase, createDatabase } from '../../db/handle.js'
import { ownTestDatabaseUrl } from '../../db/own-test-database.js'
import { canon, pinSimLearner, SimLearnerConfig } from './learning-sim-experiment.js'
import { factBudget, SIM_DAY_GAP, stratifiedHoldout, williamsRow } from './learning-sim-design.js'

/**
 * pinSimLearner writes the learner row, then reads it back and compares. jsonb stores object keys sorted by length,
 * then bytes, and run.perArm is a record (zod keeps its input order), so a multi-lane design not given in that order
 * came back "different" from its own write and the run failed in its first step. The comparison is key-order blind;
 * a real difference is still refused.
 */
const url = await ownTestDatabaseUrl('simpin')
if (url) bindDatabase(createDatabase(url, { max: 2, applicationName: 'learner-test-simpin' }))
describe.skipIf(!url)('pinning a sim learner (learner_simpin_test_<checkout>)', () => {
  const runId = randomUUID()
  afterAll(async () => { await q('DELETE FROM learning_sim_learners WHERE run_id=$1', [runId]) })
  const choice = { model: 'stub', effort: 'low', timeoutSec: 60 }
  const counts = { off: 1, on: 0, oracle: 0 }
  // Lanes and arms in the order the CLI takes them; jsonb returns fast,none,slow,medium and on,off,oracle.
  const config = SimLearnerConfig.parse({
    runId, learnerId: 'l001', arm: 'off', lane: 'slow', sessions: 1, turns: 2, transport: 'stub',
    learnerModel: choice, agentModel: choice, scorerModel: choice,
    heldOut: stratifiedHoldout(0, 'simpin'), taskOrder: williamsRow(0).slice(0, 1), factBudget: factBudget('slow'), dayGap: SIM_DAY_GAP,
    run: { commit: 'test', maxCalls: 990, gradingReplicates: 1, sequential: false, arms: ['off', 'on', 'oracle'], lanes: ['none', 'slow', 'medium', 'fast'],
      perArm: { none: counts, slow: counts, medium: counts, fast: counts }, looks: [] },
  })

  test('a learner pinned with perArm keys out of jsonb order equals its own row, on the first pin and on a repeat', async () => {
    await pinSimLearner(config)
    const stored = (await q<{ config: SimLearnerConfig }>('SELECT config FROM learning_sim_learners WHERE run_id=$1', [runId])).rows[0]!.config
    // The premise: the row really does come back reordered, so the old raw comparison would have failed.
    expect(JSON.stringify(stored.run!.perArm)).not.toBe(JSON.stringify(config.run!.perArm))
    expect(canon(stored)).toBe(canon(config))
    await pinSimLearner(config)
  })

  test('a different configuration of the same learner is still refused', async () => {
    await expect(pinSimLearner({ ...config, turns: 3 })).rejects.toThrow('with a different configuration')
    await expect(pinSimLearner({ ...config, run: { ...config.run!, perArm: { ...config.run!.perArm, fast: { off: 2, on: 0, oracle: 0 } } } }))
      .rejects.toThrow('with a different configuration')
  })
})
