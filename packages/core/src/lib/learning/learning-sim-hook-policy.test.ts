import { describe, expect, setSystemTime, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { liveFeedbackContext } from '@learner/contract/learning/learning-live-hook.js'
import { LearningPolicySettings } from '@learner/contract/learning/learning-policy.js'
import { SIM_POLICY } from './learning-sim-experiment.js'
import { HALYARD, HALYARD_CATALOG } from './learning-sim-halyard.js'
import { hookExtra } from './learning-sim-prompts.js'
import { prerequisitePolicy } from './learning-prerequisite-selection.js'
import { taskTeachingContext } from './learning-teaching-default.js'
import { beginLiveTurn, submitLiveTurnFeedback } from './learning-live-turn.js'

const ids = HALYARD_CATALOG.concepts.map((c) => c.id)
const ready = (conceptId: string, understandingPercent: number) => ({ conceptId, status: 'ready' as const, assessedAt: null, runId: 'r',
  assessment: { conceptId, nodeVersion: 'a'.repeat(64), understandingPercent, confidence: 'medium', demonstrated: [], gaps: [], nextCheck: 'Explain it.', needsReview: false } as never })
/** Upstream hops from `from` to `to` along hard-prerequisite edges, or null. */
const hops = (from: string, to: string): number | null => {
  let frontier = [from]
  for (let d = 1; d <= ids.length; d++) {
    frontier = HALYARD.edges.filter((e) => e.kind === 'hard-prerequisite' && frontier.includes(e.from)).map((e) => e.to)
    if (frontier.includes(to)) return d
    if (!frontier.length) return null
  }
  return null
}

describe('simulated learner, arm on (revision 10, design B): the shipped default policy', () => {
  test('SIM_POLICY is exactly what a new install stores', () => {
    expect(SIM_POLICY).toEqual(LearningPolicySettings.parse({}))
    expect(SIM_POLICY).toMatchObject({ prerequisiteCount: 2, prerequisiteDepth: 2, spacedRepetition: false, blindProbes: false, progressionLinearity: 60 })
  })
  test('every Halyard target, read or not: at most 2 prerequisite nodes, each within 2 hops of a target, no review node', () => {
    let delivered = 0
    for (const target of ids) for (const assessments of [[], ids.map((id, i) => ready(id, (i * 37) % 100))]) {
      // As submitLiveTurnFeedback builds it under SIM_POLICY: spaced repetition and probes off, so neither is passed.
      const packet = taskTeachingContext({ ids: [target], catalog: [...HALYARD_CATALOG.concepts], assessments, suppressed: new Set(), gaps: [], edges: HALYARD.edges,
        foundationFirst: false, prerequisites: prerequisitePolicy(SIM_POLICY), spacedRepetition: null, heldOut: new Set(), probe: null })
      const nodes = packet.conceptIds.length ? JSON.parse(packet.context.split('remainingGap): ')[1]!.split('\nPrerequisite selection:')[0]!) as Array<{ conceptId: string; role: string }> : []
      const pre = nodes.filter((n) => n.role === 'prerequisite')
      expect(pre.length).toBeLessThanOrEqual(2)
      for (const n of pre) expect([target, n.conceptId, (hops(n.conceptId, target) ?? 99) <= 2]).toEqual([target, n.conceptId, true])
      expect(nodes.some((n) => n.role === 'review')).toBe(false)
      expect(packet.reviewConceptId).toBeNull()
      delivered += pre.length
    }
    expect(delivered).toBeGreaterThan(0) // the graph does put prerequisites in front of some targets
  })
})

// Re-review R2c/R2d, at the AGENT-VISIBLE TEXT layer: the same turn begun with foundationFirst true and false, submitted
// through the live submit path (stub assessment store and graph; the turn rows go to learner_test), and passed through
// hookExtra as the sim does. Decision: the flag stays in hookExtra (it shows what the transport returned). The two
// prompts must differ in exactly that JSON flag; any other difference would mean the flag changes target selection.
describe.skipIf(!process.env.TEST_DATABASE_URL)('foundationFirst at the agent-visible layer (learner_test)', () => {
  const services = (scores: Record<string, number>) => ({
    learningCurriculumStore: { listGraphs: async () => [HALYARD] },
    learningVectorTurns: { lookupAssessments: async () => ({ experimentId: null, assessments: Object.entries(scores).map(([id, p]) => ready(id, p)) }) as never },
  })
  const at = new Date('2026-11-02T10:00:00Z')
  const turn = async (userId: string, foundationFirst: boolean, scores: Record<string, number>, sessionId: string, turnId: string, message: string, conceptId: string) => {
    const packet = await beginLiveTurn(userId, { sessionId, turnId, message, foundationFirst }, HALYARD_CATALOG, at)
    const hookContext = liveFeedbackContext(packet, sessionId, { separateCatalog: false, submissionCommand: 'Submission: return the feedback JSON when asked; this harness delivers it to the Learning transport.' }).hookSpecificOutput.additionalContext
    const submitted = await submitLiveTurnFeedback(services(scores), userId, { sessionId, turnId, catalogVersion: HALYARD_CATALOG.version,
      matches: [{ conceptId, quote: message, relationship: 'task_context', outcome: 'not_assessed', reason: 'The learner asks about it.' }] as never, taughtConceptIds: [] }, async () => SIM_POLICY, new Set(), HALYARD_CATALOG, at)
    return { prompt: hookExtra(hookContext, submitted.guidance), guidance: submitted.guidance }
  }
  for (const [name, scores] of [['blind (no reading)', {}], ['oracle (readings)', { 'halyard-core--rebraid': 20, 'halyard-core--beat': 70, 'halyard-core--tessel': 40 }]] as const) {
    test(`${name}: the two prompts differ only in "foundationFirst"`, async () => {
      // durationMs is wall-clock time inside the submit; frozen so the guidance JSON is comparable.
      setSystemTime(at)
      try {
        const sessionId = `ff-${randomUUID()}`, turnId = randomUUID(), conceptId = 'halyard-core--slack-window'
        const message = 'Why does the slack window close before the rebraid finishes?'
        const on = await turn(`ff-on-${randomUUID()}`, true, scores, sessionId, turnId, message, conceptId)
        const off = await turn(`ff-off-${randomUUID()}`, false, scores, sessionId, turnId, message, conceptId)
        expect(on.guidance.decision).toBe('influence')
        expect(on.prompt).toContain('"durationMs":0') // the clock is frozen
        expect(on.guidance.conceptIds).toContain(conceptId)
        expect(on.prompt.split('"foundationFirst":true').length).toBe(2)
        expect(off.prompt.split('"foundationFirst":false').length).toBe(2)
        expect(on.prompt.replace('"foundationFirst":true', '"foundationFirst":false')).toBe(off.prompt)
      } finally {
        setSystemTime()
      }
    })
  }
})
