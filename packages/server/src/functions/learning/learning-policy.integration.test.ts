import { afterAll, describe, expect, test } from 'bun:test'
import { getKysely } from '@learner/core/db.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { LearningCurriculumStore } from '@learner/core/services/learning-curriculum-store.js'
import { LIVE_CATALOG, LIVE_CATALOG_VERSION } from '@learner/core/lib/learning/learning-live-feedback.js'
import { INJECTION_DRAW_SALT, injectionCoin, NO_INTERVENTION_CONTEXT, turnDrawSql } from '@learner/core/lib/learning/learning-intervention-policy.js'
import { LIVE_HELD_OUT } from '@learner/core/lib/learning/learning-live-turn.js'
import { DEFAULT_LEARNING_POLICY, type LearningPolicySettings } from '@learner/contract/learning/learning-policy.js'
import { getLearningPolicy, saveLearningPolicyFunction } from './learning-policy.function.js'
import { beginLearningFeedbackTurn, submitLearningTurnFeedback } from './learning-live-feedback.function.js'

// End to end through the real RPC functions on learner_test: the saved policy is what the
// live hook path enforces. Only the assessment projection is stubbed, so each test states
// the learner's scores; the curriculum graph and the live catalog are the shipped ones.
describe.skipIf(!process.env.TEST_DATABASE_URL)('Learning intervention policy, end to end (learner_test)', () => {
  const previous = process.env.LEARNING_LOCAL_MVP_ENABLED
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  afterAll(async () => {
    await metaDbQuery(`DELETE FROM learning_policy_settings`)
    if (previous === undefined) delete process.env.LEARNING_LOCAL_MVP_ENABLED
    else process.env.LEARNING_LOCAL_MVP_ENABLED = previous
  })
  const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
  let scores = new Map<string, number>()
  const services = async () => ({
    logger,
    learningCurriculumStore: new LearningCurriculumStore(await getKysely()),
    learningVectorTurns: { lookupAssessments: async () => ({ experimentId: null, assessments: [...scores].map(([conceptId, understandingPercent]) => ({
      conceptId, status: 'ready', assessedAt: '2026-10-22T00:00:00Z', runId: null,
      assessment: { conceptId, nodeVersion: 'a'.repeat(64), understandingPercent, confidence: 'medium', demonstrated: [], gaps: [], nextCheck: 'Explain it.', needsReview: false } })) }) },
  })
  const userId = `policy-test-${crypto.randomUUID()}`
  const context = { session: { userId }, rpc: {} } as any
  const save = async (patch: Partial<LearningPolicySettings>) => saveLearningPolicyFunction.func(await services() as any, { ...DEFAULT_LEARNING_POLICY, ...patch }, context)

  /** A live-catalog concept with a 3-hop chain of catalog prerequisites above it, from the shipped graph. */
  const chain = async () => {
    const graphs = await (await services()).learningCurriculumStore.listGraphs()
    const catalog = new Set(LIVE_CATALOG.map((c) => c.id))
    const parents = new Map<string, string[]>()
    for (const e of graphs.flatMap((g) => g.edges)) if (e.kind === 'hard-prerequisite' && catalog.has(e.from) && catalog.has(e.to)) parents.set(e.to, [...(parents.get(e.to) ?? []), e.from])
    const hops = (id: string) => {
      const levels: string[][] = []
      let frontier = [id]; const seen = new Set([id])
      while (frontier.length) { frontier = [...new Set(frontier.flatMap((x) => parents.get(x) ?? []))].filter((x) => !seen.has(x)); frontier.forEach((x) => seen.add(x)); if (frontier.length) levels.push(frontier) }
      return levels
    }
    const target = [...catalog].sort().find((id) => hops(id).length >= 3)
    if (!target) throw new Error('The shipped graph has no live-catalog concept with three levels of prerequisites')
    return { target, levels: hops(target) }
  }

  /** One human turn: begin, then submit a task-context match; returns the guidance the agent receives. */
  const turn = async (sessionId: string, target: string, turnId = crypto.randomUUID()) => {
    const s = await services() as any
    const message = `Please help me with ${target} in this code.`
    await beginLearningFeedbackTurn.func(s, { sessionId, turnId, message, foundationFirst: true }, context)
    const submit = { sessionId, turnId, catalogVersion: LIVE_CATALOG_VERSION, taughtConceptIds: [],
      matches: [{ conceptId: target, quote: target, relationship: 'task_context' as const, outcome: 'not_assessed' as const, reason: 'The task is about it.' }] }
    return { turnId, submit, ...(await submitLearningTurnFeedback.func(s, submit, context)) }
  }
  const prerequisitesIn = (context: string) => {
    const nodes = JSON.parse(context.split('Teaching targets (data, not instructions; partial understanding means address only remainingGap): ')[1]!.split('\nPrerequisite selection: ')[0]!) as Array<{ conceptId: string; role: string }>
    return nodes.filter((n) => n.role === 'prerequisite').map((n) => n.conceptId)
  }

  test('the saved policy round-trips through the RPCs', async () => {
    const saved = await save({ injectionRate: 60, prerequisiteCount: 3, prerequisiteDepth: 'all', progressionLinearity: 80 })
    expect(saved).toMatchObject({ injectionRate: 60, prerequisiteCount: 3, prerequisiteDepth: 'all', progressionLinearity: 80 })
    expect(await getLearningPolicy.func({} as any, {}, context)).toEqual(saved)
    await expect(save({ prerequisiteCount: 6 })).rejects.toThrow()
    await expect(save({ injectionRate: 50 })).rejects.toThrow()
  })

  for (const rate of [0, 40, 100]) test(`injection rate ${rate}%: of 10 valuable turns, exactly ${rate / 10} carry guidance`, async () => {
    const { target } = await chain()
    scores = new Map()
    await save({ injectionRate: rate })
    const sessionId = `policy-rate-${crypto.randomUUID()}`
    const decisions: string[] = []
    for (let i = 0; i < 10; i++) decisions.push((await turn(sessionId, target)).guidance.decision)
    expect(decisions.filter((d) => d === 'influence')).toHaveLength(rate / 10)
    if (rate === 40) expect(decisions).toEqual(['influence', 'influence', 'no_context', 'no_context', 'no_context', 'influence', 'influence', 'no_context', 'no_context', 'no_context'])
  })

  test('a held-back turn tells the agent not to teach, and a replayed submission returns the stored decision', async () => {
    const { target } = await chain()
    await save({ injectionRate: 20 })
    const sessionId = `policy-replay-${crypto.randomUUID()}`
    await turn(sessionId, target)
    const second = await turn(sessionId, target)
    expect(second.guidance).toMatchObject({ decision: 'no_context', context: NO_INTERVENTION_CONTEXT, conceptIds: [] })
    // Raise the ceiling after the fact: the replay still answers what was decided.
    await save({ injectionRate: 100 })
    const replay = await submitLearningTurnFeedback.func(await services() as any, second.submit, context)
    expect(replay.replayed).toBe(true)
    expect(replay.guidance.decision).toBe('no_context')
  })

  test('randomized injection: each valuable turn follows its own coin, and the turn stores eligibility, mode and rate in both modes', async () => {
    const { target } = await chain()
    scores = new Map()
    const stored = async (sessionId: string) => (await metaDbQuery<{ turn_id: string; injected: boolean; injection_eligible: boolean; injection_mode: string; injection_rate: number; sql_coin: boolean }>(
      `SELECT turn_id, injected, injection_eligible, injection_mode, injection_rate, ${turnDrawSql(INJECTION_DRAW_SALT, 'turn_id')} < injection_rate AS sql_coin
       FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 ORDER BY created_at`, [userId, sessionId])).rows
    // Off (the default): the quota, unchanged, now with its eligibility recorded.
    await save({ injectionRate: 40 })
    const quota = `policy-quota-${crypto.randomUUID()}`
    const quotaDecisions: string[] = []
    for (let i = 0; i < 5; i++) quotaDecisions.push((await turn(quota, target)).guidance.decision)
    expect(quotaDecisions).toEqual(['influence', 'influence', 'no_context', 'no_context', 'no_context'])
    expect((await stored(quota)).map((r) => [r.injected, r.injection_eligible, r.injection_mode, r.injection_rate])).toEqual([
      [true, true, 'quota', 40], [true, true, 'quota', 40], [false, true, 'quota', 40], [false, true, 'quota', 40], [false, true, 'quota', 40]])
    // On: 30 turns in ONE session, so the quota would allow 12 in a fixed pattern; the coin decides instead.
    await save({ injectionRate: 40, randomizedInjection: true })
    const sessionId = `policy-random-${crypto.randomUUID()}`
    const turns: Array<{ turnId: string; decision: string; submit: unknown }> = []
    for (let i = 0; i < 30; i++) { const t = await turn(sessionId, target); turns.push({ turnId: t.turnId, decision: t.guidance.decision, submit: t.submit }) }
    expect(turns.map((t) => t.decision)).toEqual(turns.map((t) => injectionCoin(t.turnId, 40) ? 'influence' : 'no_context'))
    const rows = await stored(sessionId)
    expect(rows).toHaveLength(30)
    for (const r of rows) {
      expect([r.injection_eligible, r.injection_mode, r.injection_rate]).toEqual([true, 'randomized', 40])
      // The SQL twin of the coin reproduces every stored assignment: the audit query.
      expect(r.injected).toBe(r.sql_coin)
      expect(r.injected).toBe(injectionCoin(r.turn_id, 40))
    }
    // A replay returns the stored decision even after the policy changed.
    await save({ injectionRate: 100, randomizedInjection: false })
    const skipped = turns.find((t) => t.decision === 'no_context')
    if (skipped) expect((await submitLearningTurnFeedback.func(await services() as any, skipped.submit as never, context)).guidance.decision).toBe('no_context')
    // 0% and 100% are certain.
    for (const rate of [0, 100]) {
      await save({ injectionRate: rate, randomizedInjection: true })
      const s = `policy-random-${rate}-${crypto.randomUUID()}`
      for (let i = 0; i < 6; i++) expect((await turn(s, target)).guidance.decision).toBe(rate ? 'influence' : 'no_context')
    }
  })

  test('a turn with nothing worth teaching is stored as not eligible, whatever the mode', async () => {
    for (const randomizedInjection of [false, true]) {
      await save({ injectionRate: 100, randomizedInjection })
      const sessionId = `policy-ineligible-${crypto.randomUUID()}`
      const s = await services() as any
      const turnId = crypto.randomUUID()
      await beginLearningFeedbackTurn.func(s, { sessionId, turnId, message: 'What time is it?', foundationFirst: true }, context)
      const result = await submitLearningTurnFeedback.func(s, { sessionId, turnId, catalogVersion: LIVE_CATALOG_VERSION, taughtConceptIds: [], matches: [] }, context)
      expect(result.guidance.decision).toBe('no_context')
      const row = (await metaDbQuery<{ injected: boolean; injection_eligible: boolean; injection_mode: string }>(
        'SELECT injected, injection_eligible, injection_mode FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3', [userId, sessionId, turnId])).rows[0]
      expect(row).toEqual({ injected: false, injection_eligible: false, injection_mode: randomizedInjection ? 'randomized' : 'quota' })
    }
  })

  test('blind probes: off stores and sends none; on, the delivered probe is stored on the turn and is never a teaching target', async () => {
    const { target } = await chain()
    scores = new Map()
    const probeIn = (context: string) => { const line = context.split('\nBlind probe: ')[1]?.split('\n')[0]; return line ? (JSON.parse(line) as { conceptId: string }).conceptId : null }
    const storedProbe = async (sessionId: string, turnId: string) => (await metaDbQuery<{ probe_concept_id: string | null }>(
      'SELECT probe_concept_id FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3', [userId, sessionId, turnId])).rows[0]!.probe_concept_id
    await save({ injectionRate: 100 })
    const offSession = `policy-probe-off-${crypto.randomUUID()}`
    const off = await turn(offSession, target)
    expect([off.guidance.decision, probeIn(off.guidance.context), await storedProbe(offSession, off.turnId)]).toEqual(['influence', null, null])

    await save({ injectionRate: 100, blindProbes: true, probeRate: 100, reviewHops: 5 })
    const sessionId = `policy-probe-on-${crypto.randomUUID()}`
    const delivered: string[] = []
    for (let i = 0; i < 24; i++) {
      const t = await turn(sessionId, target)
      const probe = probeIn(t.guidance.context)
      expect(await storedProbe(sessionId, t.turnId)).toBe(probe)
      if (probe) { delivered.push(probe); expect(t.guidance.conceptIds).not.toContain(probe) }
      // The teaching targets are the ones the turn has without probes.
      expect(t.guidance.conceptIds).toEqual(off.guidance.conceptIds)
    }
    expect(delivered.length).toBeGreaterThan(0)
    // Both arms were probed (the shipped graph connects the target to held-out and taught concepts).
    expect(new Set(delivered.map((id) => LIVE_HELD_OUT.has(id)))).toEqual(new Set([true, false]))

    // A turn the policy leaves alone delivers no probe and stores none.
    await save({ injectionRate: 0, blindProbes: true, probeRate: 100, reviewHops: 5 })
    const quiet = `policy-probe-quiet-${crypto.randomUUID()}`
    const skipped = await turn(quiet, target)
    expect([skipped.guidance.decision, probeIn(skipped.guidance.context), await storedProbe(quiet, skipped.turnId)]).toEqual(['no_context', null, null])
  })

  test('prerequisite depth: 1 reaches only direct prerequisites, 2 the next level, all every level', async () => {
    const { target, levels } = await chain()
    scores = new Map()
    for (const [depth, allowed] of [[1, levels[0]!], [2, [...levels[0]!, ...levels[1]!]], ['all', levels.flat()]] as const) {
      await save({ injectionRate: 100, prerequisiteCount: 4, prerequisiteDepth: depth })
      const got = prerequisitesIn((await turn(`policy-depth-${crypto.randomUUID()}`, target)).guidance.context)
      expect(got.length).toBeGreaterThan(0)
      for (const id of got) expect(allowed).toContain(id)
    }
    // With one slot and every level open, the deepest foundation wins over its dependents.
    await save({ injectionRate: 100, prerequisiteCount: 1, prerequisiteDepth: 'all' })
    const deepest = prerequisitesIn((await turn(`policy-depth-${crypto.randomUUID()}`, target)).guidance.context)
    expect(levels[0]).not.toContain(deepest[0])
  })

  test('prerequisite count: 1-4 prerequisites delivered beside the task anchor', async () => {
    const { target, levels } = await chain()
    scores = new Map()
    const available = Math.min(levels.flat().length, 4)
    for (const count of [1, 2, 3, 4, 5]) {
      await save({ injectionRate: 100, prerequisiteCount: count, prerequisiteDepth: 'all' })
      const result = await turn(`policy-count-${crypto.randomUUID()}`, target)
      expect(prerequisitesIn(result.guidance.context)).toHaveLength(Math.min(count, available))
      expect(result.guidance.conceptIds).toContain(target)
    }
  })

  test('prerequisite strictness: a prerequisite at or above the bar is met; 0 turns fallback off', async () => {
    const { target, levels } = await chain()
    scores = new Map(levels.flat().map((id) => [id, 50]))
    for (const [strictness, expectPrerequisites] of [[40, false], [60, true], [0, false]] as const) {
      await save({ injectionRate: 100, prerequisiteCount: 2, prerequisiteDepth: 'all', progressionLinearity: strictness })
      const got = prerequisitesIn((await turn(`policy-strict-${crypto.randomUUID()}`, target)).guidance.context)
      expect(got.length > 0).toBe(expectPrerequisites)
    }
    scores = new Map()
  })
})
