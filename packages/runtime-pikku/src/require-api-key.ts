import { pikkuMiddleware } from '#pikku/middleware'
import { ForbiddenError, UnauthorizedError } from '@learner/core/runtime/errors.js'

/**
 * Machine-only routes: the caller must present `x-api-key` (the session middleware has verified it).
 * No credential at all is 401, as in the standalone runtime, where the route's auth check comes first;
 * a signed-in caller without a key is 403.
 */
export const requireApiKey = pikkuMiddleware(async (_services, { http, session }, next) => {
  if (!http?.request?.header('x-api-key')) {
    if (!session) throw new UnauthorizedError('Authentication required')
    throw new ForbiddenError('This route requires a machine API key')
  }
  await next()
})
