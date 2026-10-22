import type { CoreConfig, CoreServices, CoreSingletonServices, CoreUserSession } from '@pikku/core/types'
import type { BetterAuthInstance } from '@pikku/better-auth'
import type { LearnerConfig } from '@learner/server/config.js'
import type { Services as LearnerServices } from '@learner/server/services.js'
import type { AuthConfig } from '@learner/server/auth.js'
import type { LearnerQueueService, LearnerWorkflowRunService, LearnerWorkflowService } from './transport.js'

/** The Learner process configuration is the framework config. */
export interface Config extends CoreConfig, LearnerConfig {}

/** The shared session: identity plus the scopes derived from the owning user. */
export interface UserSession extends CoreUserSession {
  userId: string
  email?: string | null
  scopes: string[]
}

/**
 * The framework's singleton services ARE the shared Learner services: every
 * function body receives the same bag under either runtime. The transport
 * members are the framework's own implementations, adapted to the shared
 * interfaces (see transport.ts).
 */
export interface SingletonServices
  extends CoreSingletonServices<Config>,
    Omit<LearnerServices, 'config' | 'logger' | 'variables' | 'workflowService' | 'workflowRunService' | 'queueService'> {
  workflowService: LearnerWorkflowService
  workflowRunService: LearnerWorkflowRunService
  queueService: LearnerQueueService
  auth: () => Promise<BetterAuthInstance>
  authConfig: AuthConfig
  backgroundJobs: { start(): Promise<void>; stop(): Promise<void> }
}

export interface Services extends CoreServices<SingletonServices> {}
