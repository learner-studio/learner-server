import { resolveEndpoints, type PairingEndpoints } from './pairing.js'

/**
 * Process configuration. The ONLY module (with services.ts) that reads the
 * environment. Secrets arrive through env files loaded by the entry point
 * (`bun --env-file=/etc/learner/learner.env ...`); none live in the repo.
 */
export interface LearnerConfig {
  role: 'api' | 'learning-worker'
  databaseUrl: string
  pgbossSchema: string
  poolMax: number
  bossPoolMax: number
  port: number
  host: string
  /** Better Auth signing secret. */
  authSecret: string
  /** Public origin Better Auth issues cookies/redirects for. */
  baseUrl: string
  firecrawlUrl: string
  typesafeEnvFile: string
  /** Scheduled jobs are OFF unless explicitly enabled (cutover keeps one owner). */
  schedulesEnabled: boolean
  /** Web build served by the API (apps/web/dist), when present. */
  webDist: string | null
  /** Spool for transcripts uploaded by remote clients (uploadTranscript); read by the same disk ingest. */
  transcriptUploadRoot: string
  /** The `habits` database learner-desktop's habit events and calls land in (GrowthBook's datasource). */
  habitsDatabaseUrl: string | null
  /** Every URL advertised to learner-desktop; see pairing.ts. Invalid settings fail startup. */
  endpoints: PairingEndpoints
}

export function loadConfig(role: LearnerConfig['role'], env: NodeJS.ProcessEnv = process.env): LearnerConfig {
  const databaseUrl = env.LEARNER_DATABASE_URL ?? env.DATABASE_URL
  if (!databaseUrl) throw new Error('LEARNER_DATABASE_URL is required')
  const port = Number(env.LEARNER_PORT ?? 3010)
  return {
    role,
    databaseUrl,
    pgbossSchema: env.LEARNER_PGBOSS_SCHEMA ?? 'learner_boss',
    poolMax: Number(env.LEARNER_POOL_MAX ?? 20),
    bossPoolMax: Number(env.LEARNER_BOSS_POOL_MAX ?? 10),
    port,
    host: env.LEARNER_HOST ?? '127.0.0.1',
    authSecret: env.LEARNER_AUTH_SECRET ?? '',
    baseUrl: env.LEARNER_BASE_URL ?? `http://127.0.0.1:${port}`,
    firecrawlUrl: env.FIRECRAWL_API_URL ?? 'http://127.0.0.1:3002',
    typesafeEnvFile: env.LEARNER_TYPESAFE_ENV_FILE ?? '/etc/learner/typesafe.env',
    schedulesEnabled: env.LEARNER_SCHEDULES_ENABLED === 'true',
    webDist: env.LEARNER_WEB_DIST ?? null,
    transcriptUploadRoot: env.LEARNER_TRANSCRIPT_UPLOAD_ROOT ?? '/var/lib/learner/transcript-uploads',
    habitsDatabaseUrl: env.LEARNER_HABITS_DATABASE_URL ?? null,
    endpoints: resolveEndpoints({
      port, publicApiUrl: env.LEARNER_PUBLIC_API_URL, webUrl: env.LEARNER_WEB_URL, servesWeb: Boolean(env.LEARNER_WEB_DIST),
      growthbookUrl: env.LEARNER_GROWTHBOOK_URL, growthbookApiUrl: env.LEARNER_GROWTHBOOK_API_URL,
    }),
  }
}
