import { addGlobalMiddleware, addHTTPMiddleware } from '#pikku/middleware'
import { defineScope } from '@pikku/core/scope'
import { externalAccess, learnerCallScope, learnerSession } from '../middleware.js'

/**
 * The scopes a native function may require (server/src/auth.ts sessionForUser); `ci-mint` and `test-device` are
 * confined. A session's `app` scope is not declared: Pikku reserves the `app` root for its virtual users
 * (@pikku/cli withAppScopes), so a function requiring `app` stays a shared definition until that scope is renamed.
 */
defineScope({
  admin: { description: 'An operator (LEARNER_ADMIN_EMAILS)' },
  'ci-mint': { description: 'The CI minter: creates, seeds and revokes test devices only' },
  'test-device': { description: 'A CI test device: its heartbeat, endpoints, feed and feedback only' },
})

addGlobalMiddleware([learnerSession, learnerCallScope])
addHTTPMiddleware('*', [externalAccess])
