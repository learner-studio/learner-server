import { betterAuth } from 'better-auth'
import { apiKey } from '@better-auth/api-key'
import type { Kysely } from 'kysely'
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
    adminEmails: (env.LEARNER_ADMIN_EMAILS ?? 'operator@example.invalid').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
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
    plugins: [apiKey({ enableMetadata: true, enableSessionForAPIKeys: true, rateLimit: { enabled: false } })],
  })
}
export type Auth = ReturnType<typeof createAuth>

/** Resolve the caller from an API key or a session cookie; `undefined` when anonymous. */
export async function resolveSession(auth: Auth, kysely: Kysely<DB>, config: AuthConfig, headers: Headers): Promise<Session | undefined> {
  let userId: string | undefined
  const key = headers.get('x-api-key')
  if (key) {
    const verified = await auth.api.verifyApiKey({ body: { key } })
    if (!verified.valid || !verified.key) return undefined
    userId = verified.key.referenceId
  } else {
    const session = await auth.api.getSession({ headers })
    userId = session?.user.id
  }
  return userId ? sessionForUser(kysely, config, userId) : undefined
}

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

/** The session for a user: identity, plus `admin` for an admin email or `app` for a device user. */
export async function sessionForUser(kysely: Kysely<DB>, config: AuthConfig, userId: string): Promise<Session | undefined> {
  const user = await kysely.selectFrom('user').select(['id', 'email']).where('id', '=', userId).executeTakeFirst()
  if (!user) return undefined
  const scopes = config.adminEmails.includes(user.email.toLowerCase()) ? ['admin'] : deviceClientId(user) ? ['app'] : []
  return { userId: user.id, email: user.email, scopes }
}
