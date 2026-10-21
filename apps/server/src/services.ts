import { readFile } from 'node:fs/promises'
import { PgBoss } from 'pg-boss'
import type { Kysely } from 'kysely'
import type { DB } from '@learner/core/db/db.types.js'
import { bindDatabase, createDatabase, type DatabaseHandle } from '@learner/core/db/handle.js'
import type { Logger, VariablesService } from '@learner/core/runtime/index.js'
import { LEARNING_CURRICULA } from '@learner/core/functions/learning/computer-science-seed.js'
import { defaultLosslessArchiveInventory } from '@learner/core/lib/learning/lossless-archive-files.js'
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
import { PgBossQueue } from './runtime/queue.js'
import { FirecrawlMarkdownReader, type MarkdownReader } from './runtime/markdown-reader.js'
import { DurableEngine, type DurableEngineOptions } from './workflow/durable.js'
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
  boss: PgBoss
  queue: PgBossQueue
  queueService: PgBossQueue
  queueCancellationService: PgBossQueue
  locks: AdvisoryLockService
  engine: DurableEngine
  workflowService: DurableEngine
  workflowRunService: DurableEngine
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
  close(): Promise<void>
}
/** The name the ported functions use for the service bag. */
export type WiredServices = Services

/** Optional credential file of KEY=VALUE lines; absent means "not configured". */
async function readEnvFile(path: string): Promise<Record<string, string>> {
  const text = await readFile(path, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e })
  return Object.fromEntries(text.split('\n').map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2')]))
}

export async function createServices(config: LearnerConfig, options: { engine?: DurableEngineOptions; seedCurricula?: boolean } = {}): Promise<Services> {
  const env = process.env
  const db = bindDatabase(createDatabase(config.databaseUrl, { max: config.poolMax, applicationName: `learner-${config.role}` }))
  const kysely = db.kysely
  const logger = createLogger()
  const variables = new EnvVariablesService()

  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: config.pgbossSchema, max: config.bossPoolMax, application_name: `learner-boss-${config.role}` })
  boss.on('error', (error) => logger.error({ event: 'pg-boss-error', message: (error as Error).message }))
  await boss.start()
  const queue = new PgBossQueue(boss)
  const locks = new AdvisoryLockService({ connectionString: config.databaseUrl })
  const engine = new DurableEngine(db, options.engine)

  const typeSafeKey = (await readEnvFile(config.typesafeEnvFile)).TYPESAFE_API_KEY
  const typesafeDecision = new TypeSafeDecisionService(typeSafeKey || undefined, fetch, {
    provider: env.DECISION_MODEL_PROVIDER ?? DEFAULT_DECISION_SELECTION.provider,
    model: env.DECISION_MODEL ?? DEFAULT_DECISION_SELECTION.model,
  })
  const telemetryOutbox = new TelemetryOutboxService(db.query, { langfuse: new LangfuseTelemetryDestination() },
    () => queue.add('telemetry.outbox', {}, { attempts: 3, backoff: { type: 'exponential', delay: 1000 } }))
  registerTelemetryOutbox(telemetryOutbox)

  const learningSemanticIndex = new LearningSemanticIndexService(kysely, {
    enabled: env.LEARNING_SEMANTIC_INDEX_ENABLED === 'true',
    scheduleEnabled: env.LEARNING_SEMANTIC_INDEX_SCHEDULE_ENABLED === 'true',
  })
  const learningCurriculumStore = new LearningCurriculumStore(kysely)
  const learningCurriculumGenerationStore = new LearningCurriculumGenerationStore(kysely)
  if (options.seedCurricula !== false) await learningCurriculumStore.syncSeeds(LEARNING_CURRICULA)
  const learningEpisodeStore = new LearningEpisodeStore(kysely)
  const learningTranscriptArchiveService = LearningTranscriptArchiveService.local(kysely, {
    ...(env.LEARNING_OPENAI_SESSION_ROOT ? { openaiRoot: env.LEARNING_OPENAI_SESSION_ROOT } : {}),
    ...(env.LEARNING_ANTHROPIC_LOG_ROOT ? { anthropicRoot: env.LEARNING_ANTHROPIC_LOG_ROOT } : {}),
    ...(env.LEARNING_GOOGLE_CONVERSATION_ROOT ? { googleRoot: env.LEARNING_GOOGLE_CONVERSATION_ROOT } : {}),
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

  return {
    config, db, kysely, logger, variables, boss, queue, queueService: queue, queueCancellationService: queue, locks,
    engine, workflowService: engine, workflowRunService: engine,
    markdownReader: new FirecrawlMarkdownReader(config.firecrawlUrl),
    llmService, typesafeDecision, telemetryOutbox,
    learningSemanticIndex, learningCurriculumStore, learningCurriculumGenerationStore, learningEpisodeStore,
    learningTranscriptArchiveService, learningHindsightConsolidationTriggerService, learningLosslessArchiveService,
    learningExposureService, learningExposureIngestService, learningLosslessArchiveSyncService, learningCliVectorE2E,
    learningConceptAssessment, learningVectorTurns,
    async close() {
      registerTelemetryOutbox(undefined)
      await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined)
      await locks.close().catch(() => undefined)
      await db.close()
    },
  }
}
