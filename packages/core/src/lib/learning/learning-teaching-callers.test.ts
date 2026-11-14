import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LearningPolicySettings, DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import { LEARNING_CURRICULA } from '../../functions/learning/computer-science-seed.js'
import { LIVE } from './learning-live-catalog.js'
import { LIVE_HELD_OUT } from './learning-live-turn.js'
import { HALYARD, HALYARD_CATALOG } from './learning-sim-halyard.js'
import { heldOutConcepts } from './learning-concept-holdout.js'
import { prerequisitePolicy } from './learning-prerequisite-selection.js'
import { NO_READING_LINE, taskTeachingContext, TASK_TEACHING_DEFAULT } from './learning-teaching-default.js'

/**
 * Review B7, "only-behaviour-change": the agent-visible output of `taskTeachingContext` for the input shape of every
 * caller of its one product caller, `submitLiveTurnFeedback` (pikku graph: the RPC `submitLearningTurnFeedback`, the
 * spaced-repetition experiment's `runSpacedRepetitionCaseStep`, and the simulated learner's turn step). The golden file
 * was written by this test from origin/main's code (ec710e1) before the honest no-reading fallback, and is never
 * rewritten after it: a fixture with a reading must stay byte-identical, and one with no reading may differ only by
 * `NO_READING_LINE`. Inputs are built the way
 * `submitLiveTurnFeedback` builds them (learning-live-turn.ts), from a policy, a catalog and a holdout.
 * The golden file was written by commit 1be7523's version of this test (WRITE_TEACHING_GOLDEN=1); that mode is gone.
 */
const GOLDEN = join(import.meta.dir, 'learning-teaching-callers.golden.json')
const now = new Date('2026-11-01T00:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000)
const ready = (conceptId: string, understandingPercent: number) => ({ conceptId, status: 'ready' as const, assessedAt: null, runId: 'r',
  assessment: { conceptId, nodeVersion: 'a'.repeat(64), understandingPercent, confidence: 'medium', demonstrated: [], gaps: [], nextCheck: 'Explain it.', needsReview: false } as never })
type Input = Parameters<typeof taskTeachingContext>[0]

/** What submitLiveTurnFeedback passes, for one policy. */
const shaped = (o: { policy: LearningPolicySettings; catalog: ReadonlyArray<{ id: string; title: string }>; edges: Input['edges']; heldOut: ReadonlySet<string>; ids: string[];
  scores: Record<string, number>; gaps?: Input['gaps']; exposures?: Record<string, number>; turnId?: string }): Input => ({
  ids: o.ids, catalog: [...o.catalog], assessments: Object.entries(o.scores).map(([id, p]) => ready(id, p)), suppressed: new Set(), gaps: o.gaps ?? [], edges: o.edges,
  foundationFirst: true, prerequisites: prerequisitePolicy(o.policy), heldOut: new Set(o.heldOut),
  spacedRepetition: o.policy.spacedRepetition ? { hops: o.policy.reviewHops, now, history: { exposures: new Map(Object.entries(o.exposures ?? {}).map(([id, d]) => [id, daysAgo(d)])), offered: new Set() } } : null,
  probe: o.policy.blindProbes ? { turnId: o.turnId ?? '7b0c4e2a-1f3d-4c5b-9a8e-2d6f0b1c3e4a', rate: o.policy.probeRate, hops: o.policy.probeHops } : null,
})

const liveEdges = LEARNING_CURRICULA.flatMap((g) => g.edges)
const live = { catalog: LIVE.concepts, edges: liveEdges, heldOut: LIVE_HELD_OUT }
const flex = 'web-flexbox--flex-space-distribution'
const flexPre = ['web-layout-flow--block-and-inline', 'web-box-model--intrinsic-sizing', 'web-box-model--css-box-model']
const sim = { catalog: HALYARD_CATALOG.concepts, edges: HALYARD.edges, heldOut: heldOutConcepts(HALYARD_CATALOG.concepts) }
const h = (slug: string) => `halyard-core--${slug}`

/** Each case: a name, the caller it stands for, and its input. A "read" case delivers at least one node with a reading. */
const CALLER_CASES: Array<{ name: string; caller: string; read: boolean; input: Input }> = [
  // submitLearningTurnFeedback (the live hook RPC) under the stored default policy, and under a stored policy with
  // spaced repetition and blind probes on.
  { name: 'rpc-default-one-reading', caller: 'submitLearningTurnFeedback', read: true, input: shaped({ ...live, policy: DEFAULT_LEARNING_POLICY, ids: [flex], scores: { [flexPre[0]!]: 30 } }) },
  { name: 'rpc-default-all-read', caller: 'submitLearningTurnFeedback', read: true, input: shaped({ ...live, policy: DEFAULT_LEARNING_POLICY, ids: [flex], scores: { [flex]: 50, [flexPre[0]!]: 30, [flexPre[1]!]: 70, [flexPre[2]!]: 20 } }) },
  { name: 'rpc-default-target-read-gap', caller: 'submitLearningTurnFeedback', read: true, input: shaped({ ...live, policy: DEFAULT_LEARNING_POLICY, ids: [flex, 'web-box-model--box-sizing'], scores: { [flex]: 40 }, gaps: [{ conceptId: flex, remainingGap: 'How free space is shared by flex-grow.' }] }) },
  { name: 'rpc-default-no-reading', caller: 'submitLearningTurnFeedback', read: false, input: shaped({ ...live, policy: DEFAULT_LEARNING_POLICY, ids: [flex], scores: {} }) },
  { name: 'rpc-sr-probes-one-reading', caller: 'submitLearningTurnFeedback', read: true, input: shaped({ ...live, policy: LearningPolicySettings.parse({ spacedRepetition: true, blindProbes: true, probeRate: 100 }), ids: [flex], scores: { [flexPre[0]!]: 45 }, exposures: { 'web-flexbox--flex-container': 9 } }) },
  // A reading the packet does not deliver (intrinsic sizing is not selected): no delivered node has a reading.
  { name: 'rpc-sr-probes-reading-not-delivered', caller: 'submitLearningTurnFeedback', read: false, input: shaped({ ...live, policy: LearningPolicySettings.parse({ spacedRepetition: true, blindProbes: true, probeRate: 100 }), ids: [flex], scores: { [flexPre[1]!]: 60 }, exposures: { 'web-flexbox--flex-container': 9 } }) },
  { name: 'rpc-sr-probes-no-reading', caller: 'submitLearningTurnFeedback', read: false, input: shaped({ ...live, policy: LearningPolicySettings.parse({ spacedRepetition: true, blindProbes: true, probeRate: 100 }), ids: [flex], scores: {}, exposures: { 'web-flexbox--flex-container': 9 } }) },
  // runSpacedRepetitionCaseStep: the case policy (spaced repetition on), no holdout (it passes new Set()).
  { name: 'sr-experiment-one-reading', caller: 'runSpacedRepetitionCaseStep', read: true, input: shaped({ ...live, heldOut: new Set(), policy: LearningPolicySettings.parse({ spacedRepetition: true }), ids: ['web-box-model--box-sizing'], scores: { 'web-box-model--padding': 25 }, exposures: { 'web-box-model--margin': 6 } }) },
  { name: 'sr-experiment-no-reading', caller: 'runSpacedRepetitionCaseStep', read: false, input: shaped({ ...live, heldOut: new Set(), policy: LearningPolicySettings.parse({ spacedRepetition: true }), ids: ['web-box-model--box-sizing'], scores: {}, exposures: { 'web-box-model--margin': 6 } }) },
  // The simulated learner's turn (learning-sim-experiment.ts): Halyard, the shipped default policy and revision 9's
  // spaced-repetition one, the oracle arm's readings and the blind arm's none.
  { name: 'sim-default-oracle', caller: 'simulated learner', read: true, input: shaped({ ...sim, policy: LearningPolicySettings.parse({}), ids: [h('slack-window')], scores: { [h('rebraid')]: 20, [h('beat')]: 60, [h('slack-window')]: 10 } }) },
  { name: 'sim-default-blind', caller: 'simulated learner', read: false, input: shaped({ ...sim, policy: LearningPolicySettings.parse({}), ids: [h('slack-window')], scores: {} }) },
  { name: 'sim-rev9-oracle', caller: 'simulated learner', read: true, input: shaped({ ...sim, policy: LearningPolicySettings.parse({ spacedRepetition: true }), ids: [h('squall')], scores: { [h('beat')]: 35 }, exposures: { [h('mooring')]: 7 } }) },
  { name: 'sim-rev9-blind', caller: 'simulated learner', read: false, input: shaped({ ...sim, policy: LearningPolicySettings.parse({ spacedRepetition: true }), ids: [h('squall')], scores: {}, exposures: { [h('mooring')]: 7 } }) },
]

/** The output as the golden file stores it: the fixed policy text abbreviated (it is the same in every case). */
const goldenOf = (input: Input) => {
  const out = taskTeachingContext(input)
  return { ...out, context: out.context.replace(TASK_TEACHING_DEFAULT, '<TASK_TEACHING_DEFAULT>') }
}
const readGolden = (): Record<string, ReturnType<typeof goldenOf>> => JSON.parse(readFileSync(GOLDEN, 'utf8'))

test('every caller shape has a case with a reading and one without', () => {
  for (const caller of new Set(CALLER_CASES.map((c) => c.caller))) {
    expect(CALLER_CASES.some((c) => c.caller === caller && c.read)).toBe(true)
    expect(CALLER_CASES.some((c) => c.caller === caller && !c.read)).toBe(true)
  }
  // Each case delivers nodes, so the fallback condition is decided on a real packet; "read" is the fallback's own condition.
  for (const c of CALLER_CASES) {
    const nodes = JSON.parse(taskTeachingContext(c.input).context.split('remainingGap): ')[1]!.split('\nPrerequisite selection:')[0]!) as Array<{ understandingPercent: number | null }>
    expect([c.name, nodes.length > 0, nodes.some((n) => n.understandingPercent !== null)]).toEqual([c.name, true, c.read])
  }
})

test('cases with a reading: output byte-identical to origin/main (golden written before the fallback)', () => {
  const now = Object.fromEntries(CALLER_CASES.map((c) => [c.name, goldenOf(c.input)]))
  const golden = readGolden()
  expect(Object.keys(golden).sort()).toEqual(CALLER_CASES.map((c) => c.name).sort())
  for (const c of CALLER_CASES.filter((x) => x.read)) expect([c.name, now[c.name]]).toEqual([c.name, golden[c.name]!])
})

test('cases with no reading: only the fallback line differs from origin/main, and it is there', () => {
  const golden = readGolden()
  for (const c of CALLER_CASES.filter((x) => !x.read)) {
    const out = goldenOf(c.input)
    expect([c.name, out.context]).toEqual([c.name, golden[c.name]!.context.replace('<TASK_TEACHING_DEFAULT>\n', `<TASK_TEACHING_DEFAULT>\n${NO_READING_LINE}\n`)])
    expect({ ...out, context: '' }).toEqual({ ...golden[c.name]!, context: '' })
  }
})
