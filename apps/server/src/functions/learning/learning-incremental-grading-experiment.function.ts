import { defineFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { metaDbQuery as q } from '@learner/core/lib/db-metadata/_shared.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import type { Services as SingletonServices } from '../../services.js'
import { DEFAULT_CONTEXT_ALLOWANCE_BYTES, defaultIncrementalVariant, incrementalVariant } from '@learner/core/lib/learning/learning-incremental-assessment.js'
import { DEFAULT_HISTORY_BYTES, GOLDEN_CANDIDATE, INCREMENTAL_GRADING_CONCURRENCY, INCREMENTAL_GRADING_KIND, INCREMENTAL_GRADING_MODELS, INCREMENTAL_GRADING_QUEUES, LABEL_STATUS, BLIND_LABEL_STATUS, FEEDBACK_CALL_KEY, sameRequest, type GradingLane } from '@learner/core/lib/learning/learning-incremental-grading-experiment.js'
import {
  callRow, callRunId, executeIncrementCall, executeReviewCall, freezeIncrementalGrading, gradingExperiment, prepareFeedback, prepareGoldenReview, prepareIncrement,
  type GradingArm, type GradingManifest, type GradingRequest,
} from '@learner/core/lib/learning/learning-incremental-grading-store.js'
import { BASELINE_ARM, feedbackInput, finalizeIncrementalGrading, recordFeedbackCandidate, setupIncrementalGradingDataset, writeGoldenLabels } from '@learner/core/lib/learning/learning-incremental-grading-langfuse.js'

const ArmName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/).refine(name => name !== BASELINE_ARM, 'reserved arm name')
export const IncGradingArmInput = z.object({ name: ArmName, contextAllowanceBytes: z.number().int().min(0).max(DEFAULT_HISTORY_BYTES).optional(),
  // A candidate is an earlier round's Opus proposal; naming it runs its instructions (and allowance, unless overridden).
  candidateRunId: z.string().uuid().optional(),
  // A hand-written candidate (e.g. an Opus revision outside a round): its complete instruction list and where it came from.
  instructions: z.array(z.string().min(1).max(4_000)).min(4).max(40).optional(), source: z.string().min(1).max(200).optional(),
  // cold = no prior (every round before this field); warm = the published grade at freeze.
  prior: z.enum(['cold', 'warm']).optional() }).refine(arm => !(arm.instructions && arm.candidateRunId), 'An arm takes instructions or a candidateRunId, not both')
export const IncGradingRun = z.object({ runId: z.string().uuid() })
export const IncGradingStart = IncGradingRun.extend({
  seed: z.string().min(1).max(100), sampleSize: z.number().int().min(1).max(60).default(50), increments: z.number().int().min(1).max(10).default(5),
  historyBytes: z.number().int().min(10_000).max(DEFAULT_HISTORY_BYTES).default(DEFAULT_HISTORY_BYTES),
  // Probe slice: grade exactly these concepts instead of the stratified sample.
  conceptIds: z.array(z.string().min(1)).min(1).max(60).optional(),
  // Reuse an earlier round's frozen sample, v5 baseline and golden set; only the arms run (and pay).
  sampleRunId: z.string().uuid().optional(),
  // Holdout: freeze a fresh sample that excludes every concept these rounds sampled.
  holdoutFrom: z.array(z.string().uuid()).min(1).max(4).optional(),
  // TUNE: pool these rounds' frozen samples (histories and v5 baselines reused); this round labels its own golden.
  sampleFrom: z.array(z.string().uuid()).min(1).max(4).optional(),
  // review = Opus reviews the v5 grade (rounds 1-3); blind = Opus grades without seeing it.
  golden: z.enum(['review', 'blind']).optional(),
  // Opus-vs-Opus ceiling: a second blind grade on this many band-stratified concepts.
  ceilingSize: z.number().int().min(1).max(30).optional(),
  arms: z.array(IncGradingArmInput).min(1).max(6).default([{ name: 'v6-ctx160k', contextAllowanceBytes: DEFAULT_CONTEXT_ALLOWANCE_BYTES }]),
  feedback: z.boolean().default(true), refinalize: z.boolean().default(false),
})
export const IncGradingIncrement = IncGradingRun.extend({ increment: z.number().int().min(0).max(9) })
export const IncGradingWork = IncGradingRun.extend({ lane: z.enum(['luna', 'opus']), callRunId: z.string().uuid() })
export const IncGradingJobs = z.object({ jobIds: z.array(z.string()) })
export const IncGradingWait = IncGradingJobs.extend({ runId: z.string().uuid() })
export const IncGradingAny = z.record(z.string(), z.unknown())
export const IncGradingFrozen = z.object({ items: z.number(), increments: z.array(z.number()), arms: z.array(z.string()), sampleRunId: z.string() })

async function resolveArms(arms: z.infer<typeof IncGradingArmInput>[], userId: string): Promise<GradingArm[]> {
  if (new Set(arms.map(a => a.name)).size !== arms.length) throw new Error('Arm names must be unique')
  return Promise.all(arms.map(async arm => {
    const prior = arm.prior ? { prior: arm.prior } : {}
    if (arm.instructions) return { name: arm.name, contextAllowanceBytes: arm.contextAllowanceBytes ?? DEFAULT_CONTEXT_ALLOWANCE_BYTES, candidate: null, ...prior, ...(arm.source ? { source: arm.source } : {}), ...incrementalVariant(arm.instructions) }
    if (!arm.candidateRunId) return { name: arm.name, contextAllowanceBytes: arm.contextAllowanceBytes ?? DEFAULT_CONTEXT_ALLOWANCE_BYTES, candidate: null, ...prior, ...defaultIncrementalVariant() }
    const source = await gradingExperiment(arm.candidateRunId)
    const candidate = source.summary?.feedback?.candidate
    if (source.user_id !== userId || !candidate) throw new Error(`Round ${arm.candidateRunId} has no recorded candidate`)
    return { name: arm.name, contextAllowanceBytes: arm.contextAllowanceBytes ?? candidate.contextAllowanceBytes, candidate: { candidateId: candidate.candidateId, sourceRunId: arm.candidateRunId }, ...prior, ...incrementalVariant(candidate.instructions) }
  }))
}

export const startLearningIncrementalGradingExperiment = defineFunction({ title: 'Start an incremental-grading optimization round (v5 baseline, Opus golden review, v6 arms, Opus feedback)', expose: true, scopes: ['admin'], input: IncGradingStart, output: IncGradingAny,
  func: async ({ locks, workflowService }, data, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    return locks.withLock('learning-incremental-grading', data.runId, async () => {
      const { runId, refinalize: _, ...request } = data
      const existing = (await q<{ user_id: string; manifest: GradingManifest }>('SELECT user_id,manifest FROM learning_consolidator_prompt_experiments WHERE run_id=$1', [runId])).rows[0]
      if (existing && (existing.user_id !== session.userId || existing.manifest?.kind !== INCREMENTAL_GRADING_KIND || !sameRequest(existing.manifest.request, request))) throw new Error('Experiment identity conflict')
      if (!existing) {
        const manifest: Omit<GradingManifest, 'code'> = { kind: INCREMENTAL_GRADING_KIND, name: `Incremental grading · ${runId}`, request: request as GradingRequest, frozen: false, sampleRunId: request.sampleRunId ?? runId, increments: request.increments,
          description: `Seed ${request.seed}. Each concept's matching explicit turns replay in ${request.increments} chronological increments per arm (prompt revision × context allowance); final grade = last completed increment. Baseline = v5 one-pass read of the same history. ${request.golden === 'blind' ? 'Golden = Claude Opus 5.5 grading the full history blind (the v5 grade is not shown).' : 'Golden = Claude Opus 5.5 reviewing the baseline grade (agree → candidate, else Opus\'s own).'} No mastery writes.`,
          arms: await resolveArms(request.arms, session.userId), models: INCREMENTAL_GRADING_MODELS, concurrency: INCREMENTAL_GRADING_CONCURRENCY, labelStatus: request.golden === 'blind' ? BLIND_LABEL_STATUS : LABEL_STATUS, goldenCandidate: request.golden === 'blind' ? 'none (blind grade)' : GOLDEN_CANDIDATE, items: [], skipped: [] }
        await q('INSERT INTO learning_consolidator_prompt_experiments(run_id,user_id,seed,manifest,status) VALUES($1,$2,$3,$4::jsonb,$5)', [runId, session.userId, request.seed, JSON.stringify(manifest), 'created'])
      }
      const previous = (await q<{ status: string }>("SELECT status FROM learner_workflow_runs WHERE workflow='learningIncrementalGradingWorkflow' AND input::jsonb->>'runId'=$1", [runId])).rows.map(r => r.status)
      const live = previous.some(s => !['failed', 'cancelled', 'completed'].includes(s)), done = previous.includes('completed')
      if (!live && done && data.refinalize) await q("UPDATE learning_consolidator_prompt_experiments SET status='refinalizing' WHERE run_id=$1", [runId])
      if (!live && (!done || data.refinalize)) await workflowService.startWorkflow('learningIncrementalGradingWorkflow', { runId }, { type: 'http', userId: session.userId }, rpc)
      return { runId, status: 'started' }
    })
  },
})

export const getLearningIncrementalGradingExperiment = defineFunction({ title: 'Read an incremental-grading round: manifest, every call and the scored summary', expose: true, readonly: true, scopes: ['admin'], input: IncGradingRun, output: IncGradingAny,
  func: async ({}, { runId }, { session }) => {
    const row = await gradingExperiment(runId, false)
    if (row.user_id !== session.userId) throw new Error('Incremental grading experiment not found')
    const calls = (await q(`SELECT r.run_id,r.concept_id,r.snapshot->>'callKind' AS kind,r.snapshot->>'arm' AS arm,(r.snapshot->>'increment')::int AS increment,r.snapshot->'plan' AS plan,
      t.receipt->>'status' AS status,(t.receipt#>>'{assessment,understandingPercent}')::int AS percent,t.receipt->'result' AS result,(t.receipt->>'durationMs')::int AS duration_ms,
      (t.receipt->>'inputTokens')::int AS input_tokens,(t.receipt->>'outputTokens')::int AS output_tokens,t.receipt->>'error' AS error,a.reserved_at
      FROM learning_concept_assessment_runs r LEFT JOIN learning_concept_assessment_receipts t USING(run_id) LEFT JOIN learning_concept_assessment_attempts a USING(run_id)
      WHERE r.snapshot->>'experimentId'=$1 ORDER BY r.concept_id,r.snapshot->>'arm',(r.snapshot->>'increment')::int`, [runId])).rows
    const { files: _, ...code } = row.manifest.code ?? { gitRevision: null, sourceHash: null }
    return { runId, status: row.status, datasetId: row.dataset_id, manifest: { ...row.manifest, code }, summary: row.summary, calls }
  },
})

export const freezeIncGradingStep = defineSessionlessFunction({ input: IncGradingRun, output: IncGradingFrozen,
  func: async ({ learningVectorTurns, learningCurriculumStore }, { runId }) => freezeIncrementalGrading(runId, { vectors: learningVectorTurns, curricula: learningCurriculumStore }) })
export const setupIncGradingStep = defineSessionlessFunction({ input: IncGradingRun, output: IncGradingAny, func: async ({}, { runId }) => setupIncrementalGradingDataset(runId) })
export const labelIncGradingGoldenStep = defineSessionlessFunction({ input: IncGradingRun, output: IncGradingAny, func: async ({}, { runId }) => writeGoldenLabels(runId) })
export const finalizeIncGradingStep = defineSessionlessFunction({ input: IncGradingRun, output: IncGradingAny, func: async ({}, { runId }) => finalizeIncrementalGrading(runId) })

type QueueDeps = Pick<SingletonServices, 'queueService' | 'queueCancellationService' | 'locks'>
async function enqueue({ queueService, queueCancellationService, locks }: QueueDeps, runId: string, lane: GradingLane, callRunIds: string[]) {
  const queue = INCREMENTAL_GRADING_QUEUES[lane], ids: string[] = []
  for (const id of callRunIds) {
    const jobKey = `${runId}:${id}`
    ids.push(await locks.withLock('learning-incremental-grading-enqueue', jobKey, async () => {
      const old = await queueCancellationService.findByKey(queue, jobKey)
      if (old.length > 1) throw new Error('Duplicate incremental grading jobs')
      return old[0]?.id ?? queueService.add(queue, { runId, lane, callRunId: id }, { jobId: jobKey, attempts: 2, backoff: { type: 'fixed', delay: 1000 }, group: { id: `${runId}:${lane}`, tier: String(INCREMENTAL_GRADING_CONCURRENCY[lane]) } })
    }))
  }
  return ids
}
async function waitAll(queueService: QueueDeps['queueService'], lane: GradingLane, jobIds: string[]) {
  const statuses: string[] = []
  for (const jobId of jobIds) {
    const job = await queueService.getJob(INCREMENTAL_GRADING_QUEUES[lane], jobId)
    if (!job?.waitForCompletion) throw new Error('Native job observer unavailable')
    try { await job.waitForCompletion(21_600_000); statuses.push('completed') } catch (error) { if (await job.status() !== 'failed') throw error; statuses.push('failed') }
  }
  return statuses
}
/** A job that died before writing a receipt leaves the chain stuck; once the job is terminal, the call is closed as failed. */
async function settle(callRunIds: string[]) {
  for (const id of callRunIds) {
    const call = await callRow(id)
    if (!call || call.receipt) continue
    await q('INSERT INTO learning_concept_assessment_receipts(run_id,receipt) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [id, JSON.stringify({ status: call.reserved_at ? 'uncertain' : 'failed', assessment: null, raw: '',
      error: call.reserved_at ? 'Queue job ended after reserving the paid call without a receipt.' : 'Queue job ended before any paid call.', durationMs: 0, inputTokens: null, outputTokens: null, completedAt: new Date().toISOString(), masteryWrites: 0 })])
  }
}

/** The v5 baseline: one call per concept over the whole frozen history. Only the round that froze the sample pays for it. */
export const runIncGradingBaselineStep = defineSessionlessFunction({ input: IncGradingRun, output: IncGradingAny,
  func: async ({ queueService, queueCancellationService, locks }, { runId }) => {
    const row = await gradingExperiment(runId)
    if (row.manifest.sampleRunId !== runId) return { reused: row.manifest.sampleRunId }
    // A pooled round's baselines were paid for, and keep their receipts, in the rounds that froze them.
    if (row.manifest.request.sampleFrom?.length) return { reused: row.manifest.request.sampleFrom }
    const ids = row.manifest.items.map(i => i.baselineRunId)
    await q("UPDATE learning_consolidator_prompt_experiments SET status='running_baseline' WHERE run_id=$1", [runId])
    const statuses = await waitAll(queueService, 'luna', await enqueue({ queueService, queueCancellationService, locks }, runId, 'luna', ids))
    await settle(ids)
    return { statuses }
  } })
/** Opus reviews start as soon as the baselines exist and run beside the increment waves. */
export const enqueueIncGradingReviewsStep = defineSessionlessFunction({ input: IncGradingRun, output: IncGradingJobs,
  func: async ({ queueService, queueCancellationService, locks }, { runId }) => {
    const row = await gradingExperiment(runId)
    if (row.manifest.sampleRunId !== runId || row.manifest.golden) return { jobIds: [] }
    const ids: string[] = []
    for (const item of row.manifest.items) ids.push(await prepareGoldenReview(runId, item.conceptId))
    for (const item of row.manifest.items) if (item.ceilingRunId) ids.push(await prepareGoldenReview(runId, item.conceptId, true))
    return { jobIds: await enqueue({ queueService, queueCancellationService, locks }, runId, 'opus', ids) }
  } })
export const waitIncGradingReviewsStep = defineSessionlessFunction({ input: IncGradingWait, output: IncGradingAny,
  func: async ({ queueService }, { runId, jobIds }) => {
    const statuses = await waitAll(queueService, 'opus', jobIds)
    const row = await gradingExperiment(runId)
    if (row.manifest.sampleRunId === runId) await settle(row.manifest.items.flatMap(i => [i.reviewRunId, ...(i.ceilingRunId ? [i.ceilingRunId] : [])]))
    return { statuses }
  } })
/** One wave = increment i of every concept in every arm. Each call is prepared only now, because its prior is the previous wave's receipt. */
export const runIncGradingWaveStep = defineSessionlessFunction({ input: IncGradingIncrement, output: IncGradingAny,
  func: async ({ queueService, queueCancellationService, locks }, { runId, increment }) => {
    const row = await gradingExperiment(runId)
    const ids: string[] = []
    for (const item of row.manifest.items) for (const arm of row.manifest.arms) ids.push(await prepareIncrement(runId, item.conceptId, arm.name, increment))
    await q('UPDATE learning_consolidator_prompt_experiments SET status=$2 WHERE run_id=$1', [runId, `running_increment_${increment}`])
    const statuses = await waitAll(queueService, 'luna', await enqueue({ queueService, queueCancellationService, locks }, runId, 'luna', ids))
    await settle(ids)
    return { increment, statuses }
  } })
export const runIncGradingFeedbackStep = defineSessionlessFunction({ input: IncGradingRun, output: IncGradingAny,
  func: async ({ queueService, queueCancellationService, locks }, { runId }) => {
    const row = await gradingExperiment(runId)
    if (!row.manifest.request.feedback) return { skipped: 'feedback disabled' }
    const existing = await callRow(callRunId(runId, FEEDBACK_CALL_KEY))
    const input = existing ? null : await feedbackInput(runId)
    if (!existing && !input) return { skipped: 'no disagreements to learn from' }
    const id = existing?.run_id ?? await prepareFeedback(runId, input!.prompt, input!.context)
    const statuses = await waitAll(queueService, 'opus', await enqueue({ queueService, queueCancellationService, locks }, runId, 'opus', [id]))
    await settle([id])
    return { statuses }
  } })
export const recordIncGradingCandidateStep = defineSessionlessFunction({ input: IncGradingRun, output: IncGradingAny,
  func: async ({}, { runId }) => {
    const feedback = await recordFeedbackCandidate(runId)
    const row = await gradingExperiment(runId)
    await q('UPDATE learning_consolidator_prompt_experiments SET status=$2,completed_at=now() WHERE run_id=$1', [runId, Number(row.summary?.failures ?? 0) ? 'completed_with_failures' : 'completed'])
    return { feedback }
  } })

/** Single-shot workers. Luna calls go through the replay-safe assessment executor; Opus calls through the same fence in the store. */
async function owned(data: z.infer<typeof IncGradingWork>) {
  const call = await callRow(data.callRunId)
  const kind = call?.snapshot.callKind
  if (!call || call.snapshot.experimentId !== data.runId) throw new Error('Call does not belong to this round')
  if ((data.lane === 'luna') !== ['baseline', 'increment'].includes(kind)) throw new Error('Job lane does not match the call')
  return call
}
export const learningIncGradingLunaQueue = defineSessionlessFunction({ input: IncGradingWork, output: IncGradingAny,
  // Increments take the experiment executor (quotation retry); the v5 baseline stays on the production service, unchanged.
  func: async ({ learningConceptAssessment, llmService }, data) => (await owned(data)).snapshot.callKind === 'increment' ? executeIncrementCall(data.callRunId, llmService) : learningConceptAssessment.execute(data.callRunId) })
export const learningIncGradingOpusQueue = defineSessionlessFunction({ input: IncGradingWork, output: IncGradingAny,
  func: async ({ llmService }, data) => { await owned(data); return executeReviewCall(data.callRunId, llmService) } })

