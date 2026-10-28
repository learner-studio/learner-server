import { PgBoss } from 'pg-boss'
import { addError } from '@pikku/core/errors'
import { APIError } from 'better-auth/api'
import { JsonConsoleLogger, LocalSecretService, LocalVariablesService } from '@pikku/core/services'
import { PgBossServiceFactory } from '@pikku/queue-pg-boss'
import { CFWorkerSchemaService } from '@pikku/schema-cfworker'
import { pikkuServices, pikkuWireServices } from '#pikku/setup'
import * as errors from '@learner/core/runtime/errors.js'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { authConfigFromEnv, sessionForUser } from '@learner/server/auth.js'
import { createCoreHandles, createServices } from '@learner/server/services.js'
import { LearnerQueueService, LearnerWorkflowRunService, LearnerWorkflowService, PgBossCancellation, workflowKysely } from './transport.js'
import type { SingletonServices } from './application-types.js'

// The shared error classes keep their HTTP status under this runtime too.
for (const ErrorClass of Object.values(errors)) {
  if (typeof ErrorClass === 'function' && ErrorClass.prototype instanceof errors.HttpError) {
    const sample = Reflect.construct(ErrorClass, ['']) as errors.HttpError
    addError(ErrorClass, { status: sample.status, message: sample.message || ErrorClass.name })
  }
}
// The session middleware hands `x-api-key` to Better Auth's getSession, which THROWS for an
// unknown, revoked or expired key (enableSessionForAPIKeys). That is a credential rejection, so 401
// as under the standalone runtime, not a 500 a desktop would retry; an outage is a pg error, not an
// APIError, and still surfaces.
addError(APIError, { status: 401, message: 'Invalid API key' })

/**
 * The shared Learner services, with the framework's queue (pg-boss) and
 * durable workflows as the transport. Workflow state lives in the same
 * `learner_workflow_*` tables the standalone engine uses (transport.ts).
 *
 * Only the worker consumes queues and runs schedules (`backgroundJobs`); the
 * API enqueues and starts runs, as under the standalone runtime.
 */
export const createSingletonServices = pikkuServices(async (config, existing) => {
  setRuntimeRole(config.role)
  const logger = existing?.logger ?? new JsonConsoleLogger()
  const handles = { ...createCoreHandles(config), logger }
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: process.env.LEARNER_PIKKU_PGBOSS_SCHEMA ?? 'learner_pikku_boss', max: config.bossPoolMax, application_name: `learner-pikku-boss-${config.role}` })
  boss.on('error', (error) => logger.error(`[pg-boss] ${(error as Error).message}`))
  const factory = new PgBossServiceFactory(boss)
  await factory.init()
  const queueService = new LearnerQueueService(boss)
  const workflowDb = workflowKysely(handles.db.pool)
  const workflowService = new LearnerWorkflowService(workflowDb, { queueConcurrency: Number(process.env.LEARNER_WORKFLOW_CONCURRENCY ?? 8) })
  await workflowService.init()
  const workflowRunService = new LearnerWorkflowRunService(workflowDb)
  const schedulerService = factory.getSchedulerService()

  const shared = await createServices(config, handles, {
    queueService,
    queueCancellationService: new PgBossCancellation(boss),
    workflowService,
    workflowRunService,
    close: () => factory.close(),
  }, { seedCurricula: config.role === 'api' })
  const authConfig = authConfigFromEnv(config)

  let started = false
  const backgroundJobs = {
    async start() {
      if (started || config.role !== 'learning-worker') return
      started = true
      const registered = await factory.getQueueWorkers().registerQueues(logger)
      logger.info(`[jobs] ${Object.keys(registered).length} queue worker(s) registered`)
      if (config.schedulesEnabled) await schedulerService.start()
      else logger.info('[jobs] schedules disabled (set LEARNER_SCHEDULES_ENABLED=true to run them)')
    },
    async stop() {
      await shared.close()
    },
  }

  return {
    ...shared,
    config,
    logger,
    variables: existing?.variables ?? new LocalVariablesService(),
    secrets: existing?.secrets ?? new LocalSecretService(),
    schema: existing?.schema ?? new CFWorkerSchemaService(logger),
    queueService,
    workflowService,
    workflowRunService,
    schedulerService,
    // Steps, queue jobs and schedules run as the user that owns the run or job.
    sessionStore: {
      get: async (userId: string) => {
        const session = await sessionForUser(shared.kysely, authConfig, userId)
        return session ? { ...session, scopes: [...session.scopes] } : undefined
      },
      set: async () => {},
      clear: async () => {},
    },
    authConfig,
    backgroundJobs,
  } satisfies Omit<SingletonServices, 'auth'>
})

export const createWireServices = pikkuWireServices(async () => ({}))
