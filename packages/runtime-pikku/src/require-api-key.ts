import { pikkuMiddleware } from '#pikku/middleware'
import { ForbiddenError } from '@learner/core/runtime/errors.js'

/** Machine-only routes: the caller must present `x-api-key` (the session middleware has verified it). */
export const requireApiKey = pikkuMiddleware(async (_services, { http }, next) => {
  if (!http?.request?.header('x-api-key')) throw new ForbiddenError('This route requires a machine API key')
  await next()
})
