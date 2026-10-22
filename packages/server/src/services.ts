import { readFile } from 'node:fs/promises'
import type { Kysely } from 'kysely'
import type { DB } from '@learner/core/db/db.types.js'
import { bindDatabase, createDatabase, type DatabaseHandle } from '@learner/core/db/handle.js'
import type { Logger, QueueCancellationService, QueueService, VariablesService, WorkflowRunService, WorkflowService } from '@learner/core/runtime/index.js'
import { LEARNING_CURRICULA } from '@learner/core/functions/learning/computer-science-seed.js'
import { defaultLosslessArchiveInventory } from '@learner/core/lib/learning/lossless-archive-files.js'
import { transcriptUploadRoots } from '@learner/core/lib/learning/transcript-uploads.js'
import { desktopSpoolRoot } from '@learner/core/lib/learning/learner-desktop-transcripts.js'
import { LearnerDesktopHabitsStore } from '@learner/core/services/learner-desktop-habits-store.js'
import { hindsightRealtimeConsolidationConfig } from '@learner/core/lib/learning/hindsight-realtime-consolidation.js'
import { LearningSemanticIndexService } from '@learner/core/services/learning-semantic-index-service.js'
import { LearningCurriculumStore } from '@learner/core/services/learning-curriculum-store.js'
import { LearningCurriculumGenerationStore } from '@learner/core/services/learning-curriculum-generation-store.js'
import { LearningEpisodeStore } from '@learner/core/services/learning-episode-store.js'
import { LearningTranscriptArchiveService } from '@learner/core/services/learning-transcript-archive-service.js'
import { LearningHindsightConsolidationTriggerService } from '@learner/core/services/learning-hindsight-consolidation-trigger-service.js'
import { LearningLosslessArchiveService } from '@learner/core/services/learning-lossless-archive-service.js'
import { LearningExposureService } from '@learner/core/services/learning-exposure-service.js'
import { LearningExposureIngestService } from '@learner/core/services/learning-exposure-ingest-service.js'
import { LearningLosslessArchiveSyncService } from '@learner/core/services/learning-lossless-archive-sync-service.js'
import { LearningCliVectorE2EService } from '@learner/core/services/learning-cli-vector-e2e-service.js'
import { LearningConceptAssessmentService } from '@learner/core/services/learning-concept-assessment.js'
import { LearningVectorTurnService } from '@learner/core/services/learning-vector-turn-service.js'
import { TelemetryOutboxService } from '@learner/core/services/telemetry-outbox-service.js'
import { LLMService } from '@learner/llm/services/llm-service.js'
import { TypeSafeDecisionService } from '@learner/llm/services/typesafe-decision-service.js'
import { DEFAULT_DECISION_SELECTION } from '@learner/llm/lib/llm/model-catalog.js'
import { LangfuseTelemetryDestination, registerTelemetryOutbox } from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import { AdvisoryLockService } from './runtime/locks.js'
import { createLogger } from './runtime/logger.js'
import { EnvVariablesService } from './runtime/variables.js'
import { FirecrawlMarkdownReader, type MarkdownReader } from './runtime/markdown-reader.js'
import type { LearnerConfig } from './config.js'

/**
 * Every service a Learner function can receive, built once per process.
 *
 * Construction order and configuration mirror the previous host's bootstrap
 * for the Learning services; only the transport primitives (queue, locks,
 * workflows, logger) are Learner's own. Environment is read here and in
 * config.ts only; services receive plain values.
 */
export interface Services {
  config: LearnerConfig
  db: DatabaseHandle
  kysely: Kysely<DB>
  logger: Logger
  variables: VariablesService
  queueService: QueueService
  queueCancellationService: QueueCancellationService
  locks: AdvisoryLockService
  workflowService: WorkflowService
  workflowRunService: WorkflowRunService
  markdownReader: MarkdownReader
  llmService: LLMService
  typesafeDecision: TypeSafeDecisionService
  telemetryOutbox: TelemetryOutboxService
  learningSemanticIndex: LearningSemanticIndexService
  learningCurriculumStore: LearningCurriculumStore
  learningCurriculumGenerationStore: LearningCurriculumGenerationStore
  learningEpisodeStore: LearningEpisodeStore
  learningTranscriptArchiveService: LearningTranscriptArchiveService
  learningHindsightConsolidationTriggerService: LearningHindsightConsolidationTriggerService
  learningLosslessArchiveService: LearningLosslessArchiveService
  learningExposureService: LearningExposureService
  learningExposureIngestService: LearningExposureIngestService
  learningLosslessArchiveSyncService: LearningLosslessArchiveSyncService
  learningCliVectorE2E: LearningCliVectorE2EService
  learningConceptAssessment: LearningConceptAssessmentService
  learningVectorTurns: LearningVectorTurnService
  /** learner-desktop's writer into the `habits` database; throws when LEARNER_HABITS_DATABASE_URL is unset. */
  learnerDesktopHabits: () => LearnerDesktopHabitsStore
  close(): Promise<void>
}
/**
 * What a runtime supplies: queues and durable workflows are the runtime's own
 * (pg-boss + the standalone engine, or the framework adapter's services).
 * Everything else is built here the same way for both.
 */
export interface Transport {
  queueService: QueueService
  queueCancellationService: QueueCancellationService
  workflowService: WorkflowService
  workflowRunService: WorkflowRunService
  close?(): Promise<void>
}

/** The name the ported functions use for the service bag. */
export type WiredServices = Services

/** Optional credential file of KEY=VALUE lines; absent means "not configured". */
async function readEnvFile(path: string): Promise<Record<string, string>> {
  const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e })
  return Object.fromEntries(text.split('\n').map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2')]))
}

export interface CoreHandles { db: DatabaseHandle; logger: Logger; variables: VariablesService }

/** The database pool, logger and variables, which a runtime needs before its transport exists. */
export function createCoreHandles(config: LearnerConfig): CoreHandles {
  const db = bindDatabase(createDatabase(config.databaseUrl, { max: config.poolMax, applicationName: `learner-${config.role}` }))
  return { db, logger: createLogger(), variables: new EnvVariablesService() }
}

export async function createServices(config: LearnerConfig, handles: CoreHandles, transport: Transport, options: { seedCurricula?: boolean } = {}): Promise<Services> {
  const env = process.env
  const { db, logger, variables } = handles
  const kysely = db.kysely
  const { queueService } = transport
  const locks = new AdvisoryLockService({ connectionString: config.databaseUrl })

  const typeSafeKey = (await readEnvFile(config.typesafeEnvFile)).TYPESAFE_API_KEY
  const typesafeDecision = new TypeSafeDecisionService(typeSafeKey || undefined, fetch, {
    provider: env.DECISION_MODEL_PROVIDER ?? DEFAULT_DECISION_SELECTION.provider,
    model: env.DECISION_MODEL ?? DEFAULT_DECISION_SELECTION.model,
  })
  const telemetryOutbox = new TelemetryOutboxService(db.query, { langfuse: new LangfuseTelemetryDestination() },
    () => queueService.add('telemetry.outbox', {}, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }))
  registerTelemetryOutbox(telemetryOutbox)

  const learningSemanticIndex = new LearningSemanticIndexService(kysely, {
    enabled: env.LEARNING_SEMANTIC_INDEX_ENABLED === 'true',
    scheduleEnabled: env.LEARNING_SEMANTIC_INDEX_SCHEDULE_ENABLED === 'true',
  })
  const learningCurriculumStore = new LearningCurriculumStore(kysely)
  const learningCurriculumGenerationStore = new LearningCurriculumGenerationStore(kysely)
  if (options.seedCurricula !== false) await learningCurriculumStore.syncSeeds(LEARNING_CURRICULA)
  const learningEpisodeStore = new LearningEpisodeStore(kysely)
  const uploadRoots = transcriptUploadRoots(config.transcriptUploadRoot)
  const learningTranscriptArchiveService = LearningTranscriptArchiveService.local(kysely, {
    ...(env.LEARNING_OPENAI_SESSION_ROOT ? { openaiRoot: env.LEARNING_OPENAI_SESSION_ROOT } : {}),
    ...(env.LEARNING_ANTHROPIC_LOG_ROOT ? { anthropicRoot: env.LEARNING_ANTHROPIC_LOG_ROOT } : {}),
    ...(env.LEARNING_GOOGLE_CONVERSATION_ROOT ? { googleRoot: env.LEARNING_GOOGLE_CONVERSATION_ROOT } : {}),
    extraRoots: [{ provider: 'anthropic', root: uploadRoots.claude }, { provider: 'openai', root: uploadRoots.codex }],
  })
  const learningHindsightConsolidationTriggerService = new LearningHindsightConsolidationTriggerService(kysely, hindsightRealtimeConsolidationConfig())
  const learningLosslessArchiveService = new LearningLosslessArchiveService(kysely)
  const learningExposureService = new LearningExposureService(kysely)
  const learningExposureIngestService = new LearningExposureIngestService(kysely, learningLosslessArchiveService, learningExposureService, {
    enabled: env.LEARNING_EXPOSURE_ENABLED === 'true',
    spoolRoot: env.LEARNING_OPENCLAW_ARCHIVE_SPOOL ?? '/root/.openclaw/learning-archive',
    drainEnabled: env.LEARNING_EXPOSURE_DRAIN_ENABLED === 'true',
    ...(env.LEARNING_OPENCLAW_HISTORY_DATABASE ? { historyDatabasePath: env.LEARNING_OPENCLAW_HISTORY_DATABASE } : {}),
    confirmedHumanSenderIds: (env.LEARNING_OPENCLAW_HUMAN_SENDER_IDS ?? '').split(',').filter(Boolean),
  })
  const losslessArchiveInventory = defaultLosslessArchiveInventory()
  const losslessRootOverrides: Record<string, string | undefined> = {
    'codex-sessions': env.LEARNING_OPENAI_SESSION_ROOT,
    'claude-projects': env.LEARNING_ANTHROPIC_LOG_ROOT,
    'antigravity-conversations': env.LEARNING_GOOGLE_CONVERSATION_ROOT,
    'codex-lane-journals': env.LEARNING_CODEX_LANE_ROOT,
    'claude-lane-journals': env.LEARNING_CLAUDE_LANE_ROOT,
    'agy-lane-journals': env.LEARNING_AGY_LANE_ROOT,
  }
  // Per-lane executor journals: optional roots, one lane directory deep, event
  // journals only (a lane directory also holds working trees and pid files).
  const laneJournalMatch = String.raw`^[^/]+/events(\.\d{6})?\.jsonl$`
  losslessArchiveInventory.roots.push(
    { id: 'codex-lane-journals', provider: 'codex', path: '/var/tmp/codex-lanes', purpose: 'transcripts', capture: 'opaque', optional: true, match: laneJournalMatch },
    { id: 'claude-lane-journals', provider: 'claude', path: '/var/tmp/claude-lanes', purpose: 'transcripts', capture: 'opaque', optional: true, match: laneJournalMatch },
    { id: 'agy-lane-journals', provider: 'antigravity', path: '/var/tmp/agy-lanes', purpose: 'transcripts', capture: 'opaque', optional: true, match: laneJournalMatch },
    // learner-desktop chats and calls, spooled as Claude-format transcripts (learner-desktop-transcripts.ts).
    { id: 'desktop-uploads', provider: 'claude', path: desktopSpoolRoot(config.transcriptUploadRoot), purpose: 'transcripts', capture: 'opaque', optional: true, match: String.raw`^[a-z0-9][a-z0-9-]*/(chat|call)/[^/]+\.jsonl$` },
    // Transcripts uploaded by remote clients (uploadTranscript), one client directory deep.
    { id: 'claude-uploads', provider: 'claude', path: uploadRoots.claude, purpose: 'transcripts', capture: 'opaque', optional: true },
    { id: 'codex-uploads', provider: 'codex', path: uploadRoots.codex, purpose: 'transcripts', capture: 'opaque', optional: true },
  )
  for (const root of losslessArchiveInventory.roots) {
    const override = losslessRootOverrides[root.id]
    if (override) root.path = override
  }
  const drain = env.LEARNING_EXPOSURE_DRAIN_ENABLED === 'true'
  const learningLosslessArchiveSyncService = new LearningLosslessArchiveSyncService(kysely, learningLosslessArchiveService, {
    enabled: env.LEARNING_LOSSLESS_ARCHIVE_ENABLED === 'true',
    scheduleEnabled: env.LEARNING_LOSSLESS_ARCHIVE_SCHEDULE_ENABLED === 'true',
    inventory: losslessArchiveInventory,
    maxSources: drain ? 96 : 12,
    maxBytesPerSource: drain ? 64 * 1024 * 1024 : 4 * 1024 * 1024,
    sqliteMaxBytesPerPass: drain ? 128 * 1024 * 1024 : 4 * 1024 * 1024,
    ...(env.LEARNING_LOSSLESS_SQLITE_STAGING_ROOT ? { sqliteStagingRoot: env.LEARNING_LOSSLESS_SQLITE_STAGING_ROOT } : {}),
  })
  const learningCliVectorE2E = new LearningCliVectorE2EService(
    kysely, learningLosslessArchiveSyncService, learningExposureIngestService, learningSemanticIndex,
    env.LEARNING_ANTHROPIC_LOG_ROOT ?? '/root/.claude/projects',
  )
  const llmService = new LLMService(variables)
  const learningConceptAssessment = new LearningConceptAssessmentService(learningCurriculumStore, llmService, typesafeDecision)
  const learningVectorTurns = new LearningVectorTurnService(kysely, learningConceptAssessment, learningCurriculumStore)

  let habits: { handle: DatabaseHandle; store: LearnerDesktopHabitsStore } | undefined
  const learnerDesktopHabits = () => {
    if (!config.habitsDatabaseUrl) throw new Error('LEARNER_HABITS_DATABASE_URL is not set; learner-desktop habit uploads are unavailable')
    if (!habits) {
      const handle = createDatabase(config.habitsDatabaseUrl, { max: 2, applicationName: `learner-${config.role}-habits` })
      habits = { handle, store: new LearnerDesktopHabitsStore(handle.query) }
    }
    return habits.store
  }

  return {
    config, db, kysely, logger, variables, locks,
    queueService, queueCancellationService: transport.queueCancellationService,
    workflowService: transport.workflowService, workflowRunService: transport.workflowRunService,
    markdownReader: new FirecrawlMarkdownReader(config.firecrawlUrl),
    llmService, typesafeDecision, telemetryOutbox,
    learningSemanticIndex, learningCurriculumStore, learningCurriculumGenerationStore, learningEpisodeStore,
    learningTranscriptArchiveService, learningHindsightConsolidationTriggerService, learningLosslessArchiveService,
    learningExposureService, learningExposureIngestService, learningLosslessArchiveSyncService, learningCliVectorE2E,
    learningConceptAssessment, learningVectorTurns, learnerDesktopHabits,
    async close() {
      await habits?.handle.close().catch(() => undefined)
      registerTelemetryOutbox(undefined)
      await transport.close?.().catch(() => undefined)
      await locks.close().catch(() => undefined)
      await db.close()
    },
  }
}
