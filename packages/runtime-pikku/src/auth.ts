import { pikkuBetterAuth } from '@pikku/better-auth'
import { createAuth } from '@learner/server/auth.js'
import type { SingletonServices } from './application-types.js'

/**
 * Better Auth with the API-key plugin, from the SAME options as the
 * standalone runtime (`createAuth`), so both read and write one set of
 * `user`/`session`/`apikey` rows and a key minted under one works under the
 * other. The CLI generates the `/api/auth/**` routes from this export.
 */
export const auth = pikkuBetterAuth(async ({ kysely, authConfig }: SingletonServices) => createAuth(kysely, authConfig))
