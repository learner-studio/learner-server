import { betterAuth } from 'better-auth'
import { APIError, createAuthMiddleware } from 'better-auth/api'
import { apiKey } from '@better-auth/api-key'
import { sql, type Kysely } from 'kysely'
import type { DB } from '@learner/core/db/db.types.js'
import type { Session } from '@learner/core/runtime/index.js'

/**
 * Better Auth with the API-key plugin, configured as the previous host had it
 * for machine callers (`x-api-key`, metadata on, rate limit off). Human
 * sign-in is Google OAuth when LEARNER_GOOGLE_CLIENT_ID/SECRET are set.
 *
 * Privilege comes from the OWNING USER, never from the key: `admin` is granted
 * to the emails in LEARNER_ADMIN_EMAILS, so a minted key cannot self-elevate.
 */
export interface AuthConfig {
  secret: string
  baseUrl: string
  adminEmails: readonly string[]
  google?: { clientId: string; clientSecret: string }
}

export function authConfigFromEnv(base: { authSecret: string; baseUrl: string }, env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const google = env.LEARNER_GOOGLE_CLIENT_ID && env.LEARNER_GOOGLE_CLIENT_SECRET
    ? { clientId: env.LEARNER_GOOGLE_CLIENT_ID, clientSecret: env.LEARNER_GOOGLE_CLIENT_SECRET } : undefined
  return {
    secret: base.authSecret,
    baseUrl: base.baseUrl,
    adminEmails: (env.LEARNER_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    ...(google ? { google } : {}),
  }
}

export function createAuth(kysely: Kysely<DB>, config: AuthConfig) {
  if (!config.secret) throw new Error('LEARNER_AUTH_SECRET is required')
  return betterAuth({
    secret: config.secret,
    baseURL: config.baseUrl,
    database: { db: kysely, type: 'postgres' },
    trustedOrigins: [config.baseUrl],
    ...(config.google ? { socialProviders: { google: config.google } } : {}),
    plugins: [apiKey({ enableMetadata: true, enableSessionForAPIKeys: true, rateLimit: { enabled: false }, maximumNameLength: 80 })],
    // An API key is a machine credential for the RPCs (checkAccess); over /api/auth/* it may only read its session,
    // never mint keys, rename its user or anything else Better Auth would let any session do.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.headers?.get('x-api-key') && ctx.path !== '/get-session') throw new APIError('FORBIDDEN', { message: 'An API key may only call get-session on /api/auth' })
      }),
    },
  })
}
export type Auth = ReturnType<typeof createAuth>

/**
 * A desktop client signs in as its own device user, `<clientId>@devices.learner.invalid`.
 * The `.invalid` TLD can never complete a Google sign-in, so only
 * `mint-api-key.ts --device` creates one. A device user holds the `app` scope
 * and nothing else, and its clientId is fixed by its email.
 */
export const DEVICE_EMAIL_DOMAIN = 'devices.learner.invalid'
export const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/
export const deviceEmail = (clientId: string): string => `${clientId}@${DEVICE_EMAIL_DOMAIN}`
/** The clientId a session's device user is bound to; `undefined` for a human. */
export function deviceClientId(session: Pick<Session, 'email'> | undefined): string | undefined {
  const [local, domain] = (session?.email ?? '').toLowerCase().split('@')
  return domain === DEVICE_EMAIL_DOMAIN && local && CLIENT_ID_PATTERN.test(local) ? local : undefined
}

/**
 * The CI minter (`mint-api-key.ts --ci-mint`): scope `ci-mint`, confined to creating, seeding and
 * revoking test devices (runtime/invoke.ts CONFINED_SCOPES). `.invalid`, so no sign-in can reach it.
 */
export const CI_MINT_EMAIL = 'ci-mint@ci.learner.invalid'

/**
 * The session for a user: identity, plus `admin` for an admin email, `ci-mint` for the CI minter,
 * `app` for a device user and `app` + `test-device` for a live test device. A test device whose
 * row is expired or revoked has no session at all, whether or not the sweep has run.
 */
export async function sessionForUser(kysely: Kysely<DB>, config: AuthConfig, userId: string): Promise<Session | undefined> {
  const user = (await sql<{ id: string; email: string; test: boolean | null }>`SELECT u.id, u.email, t.revoked_at IS NULL AND t.expires_at > now() AS test
    FROM "user" u LEFT JOIN learner_test_devices t ON t.user_id = u.id WHERE u.id = ${userId}`.execute(kysely)).rows[0]
  // test === false: an expired or revoked test device. A `ci-` device with no test row at all can only be one recreated
  // after its purge (createTestDevice mints without creating, mint-api-key and pairDesktop refuse ci- ids): no session either.
  if (!user || user.test === false || (user.test === null && deviceClientId(user)?.startsWith('ci-'))) return undefined
  const email = user.email.toLowerCase()
  const scopes = config.adminEmails.includes(email) ? ['admin'] : email === CI_MINT_EMAIL ? ['ci-mint']
    : deviceClientId(user) ? (user.test ? ['app', 'test-device'] : ['app']) : []
  return { userId: user.id, email: user.email, scopes }
}
