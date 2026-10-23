import { z } from 'zod'
import { LearningPolicySettings } from '@learner/contract/learning/learning-policy.js'
import { flushLangfuseWrites, learningExperimentApi as api } from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { conceptFromGraphs } from '../../services/learning-concept-assessment.js'
import type { LearningGraph } from '../../functions/learning/learning-seed.js'
import { conceptVersion } from './learning-concept-assessment.js'
import { LIVE_INCREMENTAL_REVISION } from './learning-live-incremental-variant.js'
import { promptAbHash, promptAbId } from './learning-prompt-ab.js'
import fixtureJson from './fixtures/spaced-repetition-cases.json' with { type: 'json' }

/**
 * The spaced-repetition experiment: real prompts, concepts, exposure history and mastery from the
 * `learner` DB, frozen in fixtures/spaced-repetition-cases.json. Each case seeds a clearly marked
 * fixture user (`sr-experiment-<run>-<case>`) on the database the workflow runs on, sends the turn
 * through the live path and compares the guidance with the fixture's independently computed
 * expectation. It writes fixture assessment runs, which are immutable, so it belongs on learner_test.
 */
const SessionTurn = z.object({
  hoursAgo: z.number(), sameSession: z.boolean(), matches: z.array(z.record(z.string(), z.unknown())).optional(),
  taughtConceptIds: z.array(z.string()).optional(), injected: z.boolean().optional(), reviewConceptId: z.string().optional(),
})
export const SpacedRepetitionCase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/), condition: z.string(), sourceTurnId: z.string().uuid(), message: z.string().min(1),
  matches: z.array(z.object({ conceptId: z.string() }).passthrough()), policy: z.record(z.string(), z.unknown()),
  setup: z.object({ exposures: z.record(z.string(), z.number().nullable()), mastery: z.record(z.string(), z.number().nullable()), sessionTurns: z.array(SessionTurn) }),
  expect: z.object({
    decision: z.enum(['influence', 'no_context']), review: z.string().nullable(), reviewHops: z.number().nullable(),
    srSection: z.boolean().optional(), reviewIntervalDays: z.number().optional(), conceptIds: z.literal('review-only').optional(),
    conceptCount: z.number().optional(), prerequisites: z.number().optional(), maxContext: z.number().optional(),
    /** Related due concepts before trimming: proves a review was chosen even when the size limit then removed it. */
    relatedAtLeast: z.number().optional(),
  }),
})
export type SpacedRepetitionCase = z.infer<typeof SpacedRepetitionCase>
export const SpacedRepetitionFixture = z.object({
  description: z.string(), source: z.record(z.string(), z.unknown()), referenceTime: z.string().datetime(),
  history: z.record(z.string(), z.string().datetime()),
  mastery: z.record(z.string(), z.object({ understandingPercent: z.number().int().min(0).max(100), confidence: z.enum(['low', 'medium', 'high']) })),
  cases: z.array(SpacedRepetitionCase).min(20).max(30),
})
export const SPACED_REPETITION_FIXTURE = SpacedRepetitionFixture.parse(fixtureJson)
export const SPACED_REPETITION_FIXTURE_HASH = promptAbHash(SPACED_REPETITION_FIXTURE).slice(0, 12)

export const experimentUserId = (runId: string, caseId: string) => `sr-experiment-${runId}-${caseId}`
export const experimentTurnId = (runId: string, caseId: string) => promptAbId('spaced-repetition-turn', runId, caseId)
export const EXPERIMENT_SESSION = 'sr-experiment'
export const caseById = (caseId: string) => {
  const found = SPACED_REPETITION_FIXTURE.cases.find((c) => c.id === caseId)
  if (!found) throw new Error(`Unknown spaced-repetition case ${caseId}`)
  return found
}
export const casePolicy = (c: SpacedRepetitionCase) => LearningPolicySettings.parse(c.policy)

/** Replace the case user's rows with the fixture: real history shifted to `now`, real mastery, then the case's overrides. */
export async function seedSpacedRepetitionCase(runId: string, c: SpacedRepetitionCase, graphs: LearningGraph[], now: Date) {
  const userId = experimentUserId(runId, c.id)
  await q('DELETE FROM learning_live_feedback_turns WHERE user_id=$1', [userId])
  await q('DELETE FROM learning_concept_assessment_cache WHERE user_id=$1', [userId])
  const shift = now.getTime() - Date.parse(SPACED_REPETITION_FIXTURE.referenceTime)
  const exposures = new Map(Object.entries(SPACED_REPETITION_FIXTURE.history).map(([id, at]) => [id, new Date(Date.parse(at) + shift)]))
  for (const [id, hoursAgo] of Object.entries(c.setup.exposures)) hoursAgo === null ? exposures.delete(id) : exposures.set(id, new Date(now.getTime() - hoursAgo * 3_600_000))
  const history = [...exposures]
  await q(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,submitted_at,injected)
    SELECT $1,'sr-history',gen_random_uuid(),'fixture exposure',true,'fixture',jsonb_build_object('matches','[]'::jsonb,'taughtConceptIds',jsonb_build_array(id)),at,at,false
      FROM unnest($2::text[],$3::timestamptz[]) AS h(id,at)`, [userId, history.map(([id]) => id), history.map(([, at]) => at.toISOString())])
  for (const t of c.setup.sessionTurns) {
    const at = new Date(now.getTime() - t.hoursAgo * 3_600_000).toISOString()
    await q(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,submitted_at,injected,review_concept_id)
      VALUES($1,$2,gen_random_uuid(),'fixture session turn',true,'fixture',$3::jsonb,$4,$4,$5,$6)`,
    [userId, t.sameSession ? EXPERIMENT_SESSION : 'sr-other', JSON.stringify({ matches: t.matches ?? [], taughtConceptIds: t.taughtConceptIds ?? [] }), at, t.injected ?? false, t.injected ? t.reviewConceptId ?? null : null])
  }
  const mastery = new Map<string, { understandingPercent: number; confidence: string }>(Object.entries(SPACED_REPETITION_FIXTURE.mastery))
  for (const [id, percent] of Object.entries(c.setup.mastery)) percent === null ? mastery.delete(id) : mastery.set(id, { understandingPercent: percent, confidence: 'medium' })
  for (const [conceptId, score] of mastery) {
    const nodeVersion = conceptVersion(conceptFromGraphs(graphs, conceptId))
    // One immutable fixture run per concept version, shared by every case and run.
    const runRowId = promptAbId('spaced-repetition-fixture-run', conceptId, nodeVersion)
    await q(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot) VALUES($1,'sr-fixture',$1,$2,$3,$3,$4::jsonb) ON CONFLICT DO NOTHING`,
      [runRowId, conceptId, nodeVersion, JSON.stringify({ promptRevision: LIVE_INCREMENTAL_REVISION, fixture: 'spaced-repetition', evidence: [] })])
    const assessment = { conceptId, nodeVersion, understandingPercent: score.understandingPercent, confidence: score.confidence, demonstrated: [], gaps: [], nextCheck: 'fixture', needsReview: true }
    await q(`INSERT INTO learning_concept_assessment_cache(user_id,concept_id,node_version,input_hash,run_id,assessment) VALUES($1,$2,$3,$3,$4,$5::jsonb)`, [userId, conceptId, nodeVersion, runRowId, JSON.stringify(assessment)])
  }
  return { userId, exposures: history.length, scored: mastery.size, sessionTurns: c.setup.sessionTurns.length }
}

type Guidance = { decision: string; context: string; conceptIds: string[] }
type Node = { conceptId: string; role: string; hops?: number; intervalDays?: number }
/** The teaching targets the guidance carries, read back out of the context the agent receives. */
export function guidanceNodes(context: string): Node[] {
  const start = context.indexOf('remainingGap): ')
  const end = context.indexOf('\nPrerequisite selection:')
  if (start < 0 || end < 0) return []
  return JSON.parse(context.slice(start + 'remainingGap): '.length, end)) as Node[]
}

export type SpacedRepetitionResult = z.infer<typeof SpacedRepetitionResult>
export const SpacedRepetitionResult = z.object({
  caseId: z.string(), condition: z.string(), pass: z.boolean(), mismatches: z.array(z.string()), durationMs: z.number(),
  expected: z.record(z.string(), z.unknown()),
  actual: z.object({ decision: z.string(), review: z.string().nullable(), reviewHops: z.number().nullable(), reviewIntervalDays: z.number().nullable(), storedReview: z.string().nullable(),
    conceptIds: z.array(z.string()), prerequisites: z.number(), contextLength: z.number(), srSection: z.boolean(), spacedRepetition: z.unknown() }),
  context: z.string(),
})

/** Compare one case's delivered guidance (and the review stored on its turn) with the expectation. */
export function evaluateSpacedRepetitionCase(c: SpacedRepetitionCase, guidance: Guidance, storedReview: string | null, durationMs: number): SpacedRepetitionResult {
  const nodes = guidanceNodes(guidance.context)
  const review = nodes.find((n) => n.role === 'review') ?? null
  const srLine = guidance.context.match(/\nSpaced repetition: (\{.*\})/)?.[1]
  const actual = {
    decision: guidance.decision, review: review?.conceptId ?? null, reviewHops: review?.hops ?? null, reviewIntervalDays: review?.intervalDays ?? null, storedReview,
    conceptIds: guidance.conceptIds, prerequisites: nodes.filter((n) => n.role === 'prerequisite').length, contextLength: guidance.context.length,
    srSection: srLine !== undefined, spacedRepetition: srLine ? JSON.parse(srLine) : null,
  }
  const e = c.expect
  const mismatches: string[] = []
  const check = (name: string, ok: boolean, detail: unknown) => { if (!ok) mismatches.push(`${name}: ${JSON.stringify(detail)}`) }
  check('decision', actual.decision === e.decision, actual.decision)
  check('review', actual.review === e.review, actual.review)
  if (e.reviewHops !== null) check('reviewHops', actual.reviewHops === e.reviewHops, actual.reviewHops)
  check('storedReview', actual.storedReview === (actual.decision === 'influence' ? actual.review : null), actual.storedReview)
  check('contextLength', actual.contextLength <= (e.maxContext ?? 4000), actual.contextLength)
  check('conceptIdsCarryReview', actual.review === null || actual.conceptIds.includes(actual.review), actual.conceptIds)
  if (actual.decision === 'influence') check('srSection', actual.srSection === (e.srSection ?? casePolicy(c).spacedRepetition), actual.srSection)
  if (e.reviewIntervalDays !== undefined) check('reviewIntervalDays', actual.reviewIntervalDays === e.reviewIntervalDays, actual.reviewIntervalDays)
  if (e.conceptIds === 'review-only') check('conceptIds', JSON.stringify(actual.conceptIds) === JSON.stringify(e.review ? [e.review] : []), actual.conceptIds)
  if (e.conceptCount !== undefined) check('conceptCount', actual.conceptIds.length === e.conceptCount, actual.conceptIds)
  if (e.prerequisites !== undefined) check('prerequisites', actual.prerequisites === e.prerequisites, actual.prerequisites)
  if (e.relatedAtLeast !== undefined) check('relatedAtLeast', ((actual.spacedRepetition as { related?: number } | null)?.related ?? 0) >= e.relatedAtLeast, actual.spacedRepetition)
  return { caseId: c.id, condition: c.condition, pass: mismatches.length === 0, mismatches, durationMs, expected: e, actual, context: guidance.context }
}

/** Remove every fixture user row of a run (assessment runs are immutable and stay, shared across runs). */
export async function cleanupSpacedRepetitionExperiment(runId: string) {
  const like = `${experimentUserId(runId, '')}%`
  const turns = await q('DELETE FROM learning_live_feedback_turns WHERE user_id LIKE $1', [like])
  const cache = await q('DELETE FROM learning_concept_assessment_cache WHERE user_id LIKE $1', [like])
  return { turns: turns.rowCount, cache: cache.rowCount }
}

export function summarizeSpacedRepetition(runId: string, results: SpacedRepetitionResult[]) {
  const selectedHops: Record<string, number> = {}
  for (const r of results) if (r.actual.reviewHops !== null) selectedHops[String(r.actual.reviewHops)] = (selectedHops[String(r.actual.reviewHops)] ?? 0) + 1
  return { runId, fixture: SPACED_REPETITION_FIXTURE_HASH, cases: results.length, passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).map((r) => ({ caseId: r.caseId, mismatches: r.mismatches })), selectedHops,
    maxContextLength: Math.max(...results.map((r) => r.actual.contextLength)), meanDurationMs: Math.round(results.reduce((n, r) => n + r.durationMs, 0) / Math.max(1, results.length)) }
}

export type SpacedRepetitionSummary = ReturnType<typeof summarizeSpacedRepetition> & { removed: { turns: number | null; cache: number | null }; langfuse?: { sessionId: string; traces: number } }

/** What a completed run must show, whichever runtime ran it: every prompt passed, reviews were selected at
 * every hop distance the setting distinguishes and one beyond, and the fixture rows were removed. */
export function spacedRepetitionRunProblems(summary: SpacedRepetitionSummary, options: { exported: boolean }): string[] {
  const problems: string[] = []
  const total = SPACED_REPETITION_FIXTURE.cases.length
  if (summary.failed.length) problems.push(`failed cases: ${JSON.stringify(summary.failed)}`)
  if (summary.passed !== total) problems.push(`passed ${summary.passed} of ${total}`)
  const hops = Object.keys(summary.selectedHops).map(Number)
  const missing = [1, 2, 3, 4, 5].filter((h) => !hops.includes(h))
  if (missing.length) problems.push(`no review selected at hops ${missing.join(', ')}`)
  if (!hops.some((h) => h > 5)) problems.push('no review selected beyond 5 hops')
  if (!(Number(summary.removed.turns) > 0)) problems.push('no fixture turns removed')
  if (options.exported && summary.langfuse?.traces !== total) problems.push(`langfuse traces ${summary.langfuse?.traces} of ${total}`)
  return problems
}

// ---------------------------------------------------------------- Langfuse

const DATASET = 'learner-spaced-repetition'
const TAGS = ['learning', 'spaced-repetition']
const attr = (key: string, value: unknown) => ({ key, value: typeof value === 'number' ? { doubleValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } })
export const spacedRepetitionIds = (runId: string, caseId: string) => ({
  datasetItemId: promptAbId('spaced-repetition-item', SPACED_REPETITION_FIXTURE_HASH, caseId),
  experimentId: promptAbId('spaced-repetition-experiment', runId).replaceAll('-', '').slice(0, 16),
  traceId: promptAbId('spaced-repetition-trace', runId, caseId).replaceAll('-', ''),
  spanId: promptAbId('spaced-repetition-span', runId, caseId).replaceAll('-', '').slice(0, 16),
  scoreId: promptAbId('spaced-repetition-score', runId, caseId),
})
const caseInput = (c: SpacedRepetitionCase) => ({ message: c.message, matches: c.matches, policy: casePolicy(c), setup: c.setup, sourceTurnId: c.sourceTurnId })

/** OTLP span for one case: a Langfuse experiment item, in the run's session. */
export function spacedRepetitionSpan(runId: string, datasetId: string, result: SpacedRepetitionResult, endedAt: Date) {
  const c = caseById(result.caseId), ids = spacedRepetitionIds(runId, c.id)
  const name = `Spaced repetition · ${runId.slice(0, 8)}`
  const output = { ...result.actual, context: result.context }
  const metadata = { runId, caseId: c.id, condition: c.condition, pass: result.pass, mismatches: result.mismatches, expected: result.expected, fixture: SPACED_REPETITION_FIXTURE_HASH }
  const attributes = [attr('langfuse.observation.type', 'span'), attr('langfuse.trace.name', `${name} · ${c.id}`), attr('langfuse.trace.tags', [...TAGS, runId, c.id]),
    attr('langfuse.environment', 'learning-dev'), attr('session.id', runId), attr('langfuse.observation.input', caseInput(c)), attr('langfuse.observation.output', output),
    attr('langfuse.observation.metadata', metadata), attr('langfuse.experiment.id', ids.experimentId), attr('langfuse.experiment.name', name),
    attr('langfuse.experiment.description', 'Live hook path (beginLearningFeedbackTurn + submit) per prompt with the case policy; pass = guidance matches the fixture expectation.'),
    attr('langfuse.experiment.dataset.id', datasetId), attr('langfuse.experiment.item.id', ids.datasetItemId), attr('langfuse.experiment.item.root_observation_id', ids.spanId)]
  const end = BigInt(endedAt.getTime()) * 1_000_000n
  return { ids, payload: { resourceSpans: [{ resource: { attributes: [attr('service.name', 'learner-spaced-repetition')] }, scopeSpans: [{ scope: { name: 'learner-spaced-repetition', version: '1' },
    spans: [{ traceId: ids.traceId, spanId: ids.spanId, name: `${c.id}: ${c.condition}`.slice(0, 200), kind: 1, startTimeUnixNano: String(end - BigInt(Math.round(result.durationMs)) * 1_000_000n), endTimeUnixNano: String(end), attributes, status: { code: result.pass ? 1 : 2 } }] }] }] } }
}

/** Dataset (one item per prompt, expected output = the fixture expectation), one trace per prompt in the
 * run's session, a pass score per trace; then read the session back and check every trace arrived. */
export async function exportSpacedRepetitionExperiment(runId: string, results: SpacedRepetitionResult[]) {
  let dataset: Record<string, any>
  try { dataset = await api(`/api/public/v2/datasets/${encodeURIComponent(DATASET)}`) }
  catch (error) {
    if (!(error instanceof Error) || !error.message.endsWith('(404)')) throw error
    dataset = await api('/api/public/v2/datasets', 'POST', { name: DATASET, description: SPACED_REPETITION_FIXTURE.description, metadata: { tags: TAGS, privacy: 'owner-only' } })
  }
  for (const c of SPACED_REPETITION_FIXTURE.cases) await api('/api/public/dataset-items', 'POST', { id: spacedRepetitionIds(runId, c.id).datasetItemId, datasetName: DATASET, input: caseInput(c), expectedOutput: c.expect, metadata: { caseId: c.id, condition: c.condition, fixture: SPACED_REPETITION_FIXTURE_HASH } })
  const writes: string[] = []
  const ended = new Date()
  for (const result of results) {
    const span = spacedRepetitionSpan(runId, dataset.id, result, ended)
    writes.push((await api('/api/public/otel/v1/traces', 'POST', span.payload)).id as string)
    writes.push((await api('/api/public/scores', 'POST', { id: span.ids.scoreId, traceId: span.ids.traceId, observationId: span.ids.spanId, name: 'spaced_repetition.pass', value: result.pass ? 1 : 0, dataType: 'NUMERIC', comment: result.mismatches.join('; ') || 'matches the fixture expectation', environment: 'learning-dev' })).id as string)
  }
  await flushLangfuseWrites(writes)
  return { datasetName: DATASET, datasetId: dataset.id as string, sessionId: runId, traceIds: results.map((r) => spacedRepetitionIds(runId, r.caseId).traceId) }
}

/** Langfuse ingests asynchronously: count the session's traces (may need a retry). */
export async function verifySpacedRepetitionExport(runId: string, expected: number) {
  // This Langfuse serves no /api/public/traces; v2 observations filter by session and carry traceId.
  const observations = await api(`/api/public/v2/observations?sessionId=${encodeURIComponent(runId)}&limit=100&fields=core`)
  const found = new Set((observations.data ?? []).map((o: { traceId: string }) => o.traceId)).size
  if (found !== expected) throw new Error(`Langfuse session ${runId} has ${found} of ${expected} traces; read-back may be retried`)
  return { sessionId: runId, traces: found }
}

