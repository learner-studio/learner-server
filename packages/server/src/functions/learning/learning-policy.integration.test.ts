import { afterAll, describe, expect, test } from 'bun:test'
import { getKysely } from '@learner/core/db.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { LearningCurriculumStore } from '@learner/core/services/learning-curriculum-store.js'
import { LIVE_CATALOG, LIVE_CATALOG_VERSION } from '@learner/core/lib/learning/learning-live-feedback.js'
import { INJECTION_DRAW_SALT, injectionCoin, NO_INTERVENTION_CONTEXT, turnDrawSql } from '@learner/core/lib/learning/learning-intervention-policy.js'
import { LIVE_HELD_OUT } from '@learner/core/lib/learning/learning-live-turn.js'
import { PROBE_ARM_SALT, probeArm, probeCandidates } from '@learner/core/lib/learning/learning-blind-probes.js'
import { readReviewHistory } from '@learner/core/lib/learning/learning-spaced-repetition.js'
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

  test('blind probes: off stores nothing; on, every decision is stored with its arm, counts and reason, and a delivered probe is never a teaching target', async () => {
    const { target } = await chain()
    scores = new Map()
    const probeLine = (context: string) => { const line = context.split('\nBlind probe: ')[1]?.split('\n')[0]; return line ? JSON.parse(line) as { conceptId: string; hops: number } : null }
    const probeIn = (context: string) => probeLine(context)?.conceptId ?? null
    type StoredProbe = { probe_concept_id: string | null; probe_outcome: string | null; probe_arm: string | null; probe_held_out_candidates: number | null; probe_taught_candidates: number | null; probe_rate: number | null; probe_hops: number | null; probe_concept_hops: number | null; sql_arm: string }
    const storedProbe = async (sessionId: string, turnId: string) => (await metaDbQuery<StoredProbe>(
      `SELECT probe_concept_id, probe_outcome, probe_arm, probe_held_out_candidates, probe_taught_candidates, probe_rate, probe_hops, probe_concept_hops,
              CASE WHEN ${turnDrawSql(PROBE_ARM_SALT, 'turn_id')} < 50 THEN 'held_out' ELSE 'taught' END AS sql_arm
       FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`, [userId, sessionId, turnId])).rows[0]!
    await save({ injectionRate: 100 })
    const offSession = `policy-probe-off-${crypto.randomUUID()}`
    const off = await turn(offSession, target)
    expect([off.guidance.decision, probeIn(off.guidance.context)]).toEqual(['influence', null])
    expect(await storedProbe(offSession, off.turnId)).toMatchObject({ probe_concept_id: null, probe_outcome: null, probe_arm: null, probe_held_out_candidates: null, probe_taught_candidates: null, probe_rate: null, probe_hops: null, probe_concept_hops: null })

    await save({ injectionRate: 100, blindProbes: true, probeRate: 100, probeHops: 5 })
    const sessionId = `policy-probe-on-${crypto.randomUUID()}`
    const delivered: Array<{ id: string; arm: string }> = []
    for (let i = 0; i < 24; i++) {
      const t = await turn(sessionId, target)
      const probe = probeIn(t.guidance.context)
      const row = await storedProbe(sessionId, t.turnId)
      // The shipped graph connects the target to both arms, so every drawn turn is probed, in the coin's arm.
      expect(row).toMatchObject({ probe_concept_id: probe, probe_outcome: 'delivered', probe_arm: probeArm(t.turnId), sql_arm: probeArm(t.turnId), probe_rate: 100, probe_hops: 5, probe_concept_hops: probeLine(t.guidance.context)!.hops })
      expect(row.probe_concept_hops).toBeGreaterThanOrEqual(1)
      expect(row.probe_held_out_candidates! > 0 && row.probe_taught_candidates! > 0).toBe(true)
      expect(LIVE_HELD_OUT.has(probe!)).toBe(row.probe_arm === 'held_out')
      delivered.push({ id: probe!, arm: row.probe_arm! })
      // The teaching targets are the turn's own without probes, minus the probe when it was about to be taught.
      expect(t.guidance.conceptIds).not.toContain(probe)
      expect(t.guidance.conceptIds).toEqual(off.guidance.conceptIds.filter((id) => id !== probe))
      // The targets the agent was given are stored on the turn, for the arm-inference sensitivity query.
      expect((await metaDbQuery<{ ids: string[] }>(`SELECT guidance_concept_ids AS ids FROM learning_live_feedback_turns WHERE user_id=$1 AND turn_id=$2`, [userId, t.turnId])).rows[0]!.ids).toEqual(t.guidance.conceptIds)
    }
    expect(new Set(delivered.map((d) => d.arm))).toEqual(new Set(['held_out', 'taught']))

    // Rate 0: the turn is stored as not drawn, with no arm and no counts.
    await save({ injectionRate: 100, blindProbes: true, probeRate: 0, probeHops: 5 })
    const undrawn = `policy-probe-undrawn-${crypto.randomUUID()}`
    const none = await turn(undrawn, target)
    expect(probeIn(none.guidance.context)).toBeNull()
    expect(await storedProbe(undrawn, none.turnId)).toMatchObject({ probe_concept_id: null, probe_outcome: 'not_drawn', probe_arm: null, probe_held_out_candidates: null, probe_rate: 0 })

    // A turn the policy leaves alone delivers no probe; the draw, the arm and the counts are still stored.
    await save({ injectionRate: 0, blindProbes: true, probeRate: 100, probeHops: 5 })
    const quiet = `policy-probe-quiet-${crypto.randomUUID()}`
    const skipped = await turn(quiet, target)
    expect([skipped.guidance.decision, probeIn(skipped.guidance.context)]).toEqual(['no_context', null])
    const quietRow = await storedProbe(quiet, skipped.turnId)
    expect(quietRow).toMatchObject({ probe_concept_id: null, probe_concept_hops: null, probe_outcome: 'not_injected', probe_arm: probeArm(skipped.turnId) })
    expect(quietRow.probe_held_out_candidates! > 0 && quietRow.probe_taught_candidates! > 0).toBe(true)

    // A failed lookup with probes on is stored as such: it must not look like a turn decided with probes off.
    const failing = async (blindProbes: boolean) => {
      await save({ injectionRate: 100, blindProbes, probeRate: 60, probeHops: 3 })
      const sessionId = `policy-probe-failopen-${crypto.randomUUID()}`, turnId = crypto.randomUUID()
      const broken = { ...(await services()), learningVectorTurns: { lookupAssessments: async () => { throw new Error('lookup down') } } } as any
      await beginLearningFeedbackTurn.func(broken, { sessionId, turnId, message: `Please help me with ${target} in this code.`, foundationFirst: true }, context)
      const submit = { sessionId, turnId, catalogVersion: LIVE_CATALOG_VERSION, taughtConceptIds: [], matches: [{ conceptId: target, quote: target, relationship: 'task_context' as const, outcome: 'not_assessed' as const, reason: 'The task is about it.' }] }
      expect((await submitLearningTurnFeedback.func(broken, submit, context)).guidance.decision).toBe('fail_open')
      return { sessionId, turnId, submit }
    }
    const failedOff = await failing(false)
    expect(await storedProbe(failedOff.sessionId, failedOff.turnId)).toMatchObject({ probe_outcome: null, probe_rate: null, probe_hops: null })
    const failedOn = await failing(true)
    expect(await storedProbe(failedOn.sessionId, failedOn.turnId)).toMatchObject({ probe_concept_id: null, probe_outcome: 'fail_open', probe_arm: null, probe_held_out_candidates: null, probe_rate: 60, probe_hops: 3 })
    // The hook retries: the real decision replaces the placeholder.
    await submitLearningTurnFeedback.func(await services() as any, failedOn.submit, context)
    const retried = await storedProbe(failedOn.sessionId, failedOn.turnId)
    expect(retried.probe_outcome).not.toBe('fail_open')
    expect(retried.probe_outcome === 'not_drawn' || retried.probe_arm === probeArm(failedOn.turnId)).toBe(true)
  })

  test('an answered probe does not suppress teaching, open a gap, count as a review exposure or reach the agent\'s recent feedback', async () => {
    const { target } = await chain()
    scores = new Map()
    const graphs = await (await services()).learningCurriculumStore.listGraphs()
    const candidates = probeCandidates({ turnId: crypto.randomUUID(), hops: 1, turnConceptIds: [target], edges: graphs.flatMap((g) => g.edges), catalogIds: LIVE_CATALOG.map((c) => c.id), heldOut: LIVE_HELD_OUT })
    const probed = candidates.taught[0]!.conceptId
    const answer = async (sessionId: string, conceptId: string, outcome: 'demonstrated' | 'partial') => {
      const s = await services() as any, turnId = crypto.randomUUID(), message = `I think ${conceptId} means this.`
      await beginLearningFeedbackTurn.func(s, { sessionId, turnId, message, foundationFirst: true }, context)
      return submitLearningTurnFeedback.func(s, { sessionId, turnId, catalogVersion: LIVE_CATALOG_VERSION, taughtConceptIds: [],
        matches: [{ conceptId, quote: conceptId, relationship: 'learner_evidence' as const, outcome, reason: 'The learner explained it.', ...(outcome === 'partial' ? { remainingGap: 'the rest of it' } : {}) },
          { conceptId: target, quote: 'this', relationship: 'task_context' as const, outcome: 'not_assessed' as const, reason: 'Still the task.' }] }, context)
    }
    /** The session's next turn is ABOUT the answered concept: is it taught, and does a gap follow it? */
    const next = async (sessionId: string, conceptId: string) => { const t = await turn(sessionId, conceptId); return { taught: (t.guidance.conceptIds as string[]).includes(conceptId), gap: t.guidance.context.includes('the rest of it') } }
    /** What the begin packet of the session's next turn tells the agent about the concept. */
    const shownToAgent = async (sessionId: string, conceptId: string) => {
      const begun = await beginLearningFeedbackTurn.func(await services() as any, { sessionId, turnId: crypto.randomUUID(), message: 'And now?', foundationFirst: true }, context)
      return begun.recentFeedback.some((f: { matches: Array<{ conceptId: string }> }) => f.matches.some((m) => m.conceptId === conceptId))
    }
    const exposed = async (conceptId: string) => (await readReviewHistory(metaDbQuery, userId)).exposures.has(conceptId)
    const mark = (sessionId: string, turnId: string, conceptId: string) => metaDbQuery<{ turn_id: string }>(`UPDATE learning_live_feedback_turns SET probe_concept_id=$4, probe_outcome='delivered' WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`, [userId, sessionId, turnId, conceptId])
    await save({ injectionRate: 100 })
    expect(await exposed(probed)).toBe(false)

    // Control: the same answers with no probe before them suppress the concept, open a gap, and count as an exposure.
    const plain = `policy-probe-effect-plain-${crypto.randomUUID()}`
    await turn(plain, target)
    await answer(plain, probed, 'demonstrated')
    expect(await next(plain, probed)).toEqual({ taught: false, gap: false })
    expect([await shownToAgent(plain, probed), await shownToAgent(plain, target)]).toEqual([true, true])
    expect(await exposed(probed)).toBe(true)
    await metaDbQuery(`DELETE FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2`, [userId, plain])

    // The same answers after a probe of that concept: the next turn teaches it as if nothing had been said.
    for (const outcome of ['demonstrated', 'partial'] as const) {
      const sessionId = `policy-probe-effect-${outcome}-${crypto.randomUUID()}`
      const probeTurn = await turn(sessionId, target)
      await mark(sessionId, probeTurn.turnId, probed)
      await answer(sessionId, probed, outcome)
      expect(await exposed(probed)).toBe(false)
      // The agent is not told about the answer either; the rest of the turn's feedback is still there.
      expect([await shownToAgent(sessionId, probed), await shownToAgent(sessionId, target)]).toEqual([false, true])
      expect(await next(sessionId, probed)).toEqual({ taught: true, gap: false })
      // Only the answer is hidden: that later turn about the concept is ordinary feedback, shown and counted.
      expect([await shownToAgent(sessionId, probed), await exposed(probed)]).toEqual([true, true])
      await metaDbQuery(`DELETE FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2`, [userId, sessionId])
    }
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
