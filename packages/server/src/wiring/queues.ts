import { rollingQueueConfig } from '@learner/core/lib/workflow/rolling-queue.js'

/**
 * Queue workers and schedules, carried over from the previous host's wirings
 * (names, handlers and worker settings unchanged). The worker process drains
 * these; the API only enqueues.
 */
/** Worker settings, in the units the previous host declared them. */
export interface WorkerConfig {
  /** Parallel single-job pollers. */
  batchSize?: number
  prefetch?: number
  pollInterval?: number
  groupConcurrency?: number | { default: number; tiers?: Record<string, number> }
  [k: string]: unknown
}
export interface QueueWiring { queue: string; func: string; config: WorkerConfig }
export interface ScheduleWiring { name: string; cron: string; func: string }

/** Durable workflow runs are dispatched here and executed by the worker. */
export const WORKFLOW_QUEUE = 'learner.workflow'
/**
 * Queue-level policy, applied by whichever process creates the queue first.
 * The heartbeat lets pg-boss retry a job whose worker died; the run itself is
 * protected by the engine's lease, so a retried job never runs a step twice.
 */
export const WORKFLOW_QUEUE_OPTIONS = { retryLimit: 10, retryDelay: 15, heartbeatSeconds: 30, expireInSeconds: 6 * 3600 }
export const WORKFLOW_QUEUE_CONFIG: WorkerConfig = { batchSize: Number(process.env.LEARNER_WORKFLOW_CONCURRENCY ?? 8), pollInterval: 1000 }

export const QUEUES: readonly QueueWiring[] = [
  { queue: 'learning.concept-tag-audit', func: 'exportLearningConceptTagStep', config: { batchSize: 4, pollInterval: 1000 } },
  { queue: 'learning.concept-tag', func: 'learningConceptTagQueue', config: rollingQueueConfig(5) },
  { queue: 'learning.incremental-grading-luna', func: 'learningIncGradingLunaQueue', config: rollingQueueConfig(6) },
  { queue: 'learning.incremental-grading-opus', func: 'learningIncGradingOpusQueue', config: rollingQueueConfig(3) },
  { queue: 'learning.maintenance', func: 'learningMaintenanceQueue', config: { batchSize: 1 } },
  { queue: 'learning.mastery-ab-reference', func: 'learningMasteryAbReferenceQueue', config: rollingQueueConfig(3) },
  { queue: 'learning.mastery-ab-flash', func: 'learningMasteryAbFlashQueue', config: rollingQueueConfig(3) },
  { queue: 'learning.mastery-ab-jev', func: 'learningMasteryAbJevQueue', config: rollingQueueConfig(10) },
  { queue: 'learning.prompt-ab-audit', func: 'exportLearningPromptAbStep', config: { batchSize: 4, pollInterval: 1000 } },
  { queue: 'learning.prompt-ab', func: 'learningPromptAbQueue', config: rollingQueueConfig(9) },
  { queue: 'learning.vector-concepts', func: 'learningVectorConceptQueue', config: rollingQueueConfig(9) },
  { queue: 'learning.exposure-drain', func: 'learningExposureDrainQueue', config: { batchSize: 2, prefetch: 2 } },
  { queue: 'learning.hook-ingest', func: 'learningHookIngestQueue', config: { batchSize: 1, prefetch: 1 } },
  { queue: 'telemetry.outbox', func: 'telemetryOutboxQueue', config: { batchSize: 2 } },
]

export const SCHEDULES: readonly ScheduleWiring[] = [
  { name: 'learning-archive-coalescing-recovery', cron: '* * * * *', func: 'scheduledLearningArchiveAdmission' },
  { name: 'learning-feedback-langfuse-export', cron: '* * * * *', func: 'scheduledLearningFeedbackTraces' },
  { name: 'learning-exposure-drain-reconcile', cron: '* * * * *', func: 'scheduledLearningExposureDrain' },
  { name: 'learning-lossless-archive-sweep', cron: '* * * * *', func: 'scheduledLearningLosslessArchiveSweep' },
  { name: 'learningReactiveConsolidation', cron: '*/1 * * * *', func: 'recoverLearningReactiveConsolidation' },
  { name: 'learning-canonical-semantic-index', cron: '*/2 * * * *', func: 'scheduledLearningSemanticIndex' },
  { name: 'telemetry-outbox-recovery', cron: '* * * * *', func: 'scheduledTelemetryOutboxRecovery' },
  { name: 'learning-transcript-archive-sweep', cron: '*/5 * * * *', func: 'scheduledLearningTranscriptArchiveSweep' },
  { name: 'learning-transcript-archive-daily-sweep', cron: '17 3 * * *', func: 'scheduledLearningTranscriptArchiveDailySweep' },
]
