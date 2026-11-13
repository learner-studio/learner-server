/**
 * The environment of every process that opens learner_sim (bin/sim-worker.ts, scripts/sim-experiment.ts), set before
 * anything opens a pool. The database is learner_sim, derived from DATABASE_URL (the live `learner` DB and :3010 are
 * never touched), with its own queue schema and runtime directory, so neither the product worker's queues nor its
 * heartbeat file are shared. No product flag, schedule or other database, retry or lease knob (LLM_*,
 * LEARNER_ATTEMPT_*, LEARNER_UNLEASED_*, LEARNER_LLM_*: the attempt directory a restart adopts a detached call from),
 * fault-injection seam (LEARNER_FAULT_*), other CLI binary or default model (*_CLI_*), GrowthBook, or switch that
 * disables workers or schedules or marks the process production reaches it: each takes its code default (spec,
 * "Inputs of a real run").
 */
const SCRUB = /^LEARNING_|^LEARNER_SCHEDULES|^LEARNER_HINDSIGHT|^LEARNER_HABITS|^PG_BOSS_|^TEST_DATABASE|^LLM_|^LEARNER_ATTEMPT_|^LEARNER_UNLEASED_|^LEARNER_LLM_|^LEARNER_FAULT_|^LEARNER_GROWTHBOOK|^(CODEX|CLAUDE|AGY|GEMINI)_CLI_|^DISABLE_|^ENABLE_SCHEDULED_JOBS$|^LEARNER_ENV$|^APP_ENV$/

/** `readOnly`: every pool of the process opens read-only (pg reads PGOPTIONS), so a reader cannot write. */
export async function simEnvironment({ readOnly = false }: { readOnly?: boolean } = {}) {
  const base = process.env.DATABASE_URL
  if (!base) throw new Error('DATABASE_URL is required: run with --env-file=/etc/learner/db.env')
  for (const key of Object.keys(process.env)) if (SCRUB.test(key)) delete process.env[key]
  const url = new URL(base)
  url.pathname = '/learner_sim'
  process.env.DATABASE_URL = process.env.LEARNER_DATABASE_URL = url.toString()
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = 'learner_boss_sim'
  process.env.LEARNER_RUNTIME_DIRECTORY = '/run/learner/sim-runtime'
  if (readOnly) process.env.PGOPTIONS = '-c default_transaction_read_only=on'
  else delete process.env.PGOPTIONS
  const { SIM_MAX_CONCURRENCY } = await import('@learner/core/lib/learning/learning-sim-run.js')
  process.env.LEARNER_WORKFLOW_CONCURRENCY = process.env.LLM_CLI_MAX_CONCURRENT = String(SIM_MAX_CONCURRENCY)
}
