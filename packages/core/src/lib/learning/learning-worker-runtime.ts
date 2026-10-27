import { Client } from 'pg'
import { existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { resolveDatabaseUrl } from '../../db.js'

/**
 * Process roles. Learner runs two processes from one tree: the API (`api`)
 * serves RPCs and dispatches work; the worker (`learning-worker`) drains the
 * queues and executes durable workflow runs. Queue-only handlers refuse to run
 * in the API, exactly as before.
 *
 * Differences from the previous host, deliberately:
 *  - the role comes from LEARNER_RUNTIME_ROLE (the API entry point sets `api`,
 *    the worker entry point sets `learning-worker`);
 *  - the singleton fence is a session-level Postgres advisory lock only; the
 *    previous host also required a file-descriptor lock opened by its wrapper
 *    script, which Learner does not have.
 */
export type RuntimeRole = 'api' | 'learning-worker'
export function runtimeRole(): RuntimeRole {
  const role = process.env.LEARNER_RUNTIME_ROLE ?? 'api'
  if (role !== 'api' && role !== 'learning-worker') throw new Error('Invalid LEARNER_RUNTIME_ROLE')
  return role
}
export const setRuntimeRole = (role: RuntimeRole) => { process.env.LEARNER_RUNTIME_ROLE = role }
/** Operator kill switch for all new Learning admission (the file's presence pauses it). */
export const learningAdmissionPaused = () => existsSync(process.env.LEARNING_PAUSE_FILE ?? '/run/learner/learning-admission-paused')
export const workerRuntimeDirectory = () => process.env.LEARNER_RUNTIME_DIRECTORY ?? '/run/learner/runtime'
export const runtimeRevision = () => process.env.LEARNER_REVISION ?? 'working-tree'

let roleLock: Client | undefined
/**
 * Hold the role's singleton fence for the life of the process. While another
 * process holds it, wait and retry rather than exit: under `bun --watch` an
 * exit is not a crash systemd can restart (the watcher idles until a file
 * changes), so a worker started while a peer still held the fence used to sit
 * "active" and dead. Waiting keeps the fence exclusive and takes over as soon
 * as the holder is gone.
 */
export async function acquireRuntimeRole(options: { retryMs?: number; waitMs?: number; log?: (message: string) => void } = {}) {
  if (roleLock) return
  const { retryMs = 5_000, waitMs = Infinity, log = (m: string) => console.error(m) } = options
  const started = Date.now()
  for (let attempt = 0; ; attempt++) {
    const client = new Client({ connectionString: resolveDatabaseUrl(), application_name: `learner-role:${runtimeRole()}` })
    client.on('error', () => undefined) // a waiting attempt's connection may drop; the loop retries
    let reason = 'is held by another process'
    try {
      await client.connect()
      const result = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [`learner-runtime:${runtimeRole()}`])
      if (result.rows[0]?.locked) { client.removeAllListeners('error'); holdRole(client); if (attempt) log(`[runtime] role ${runtimeRole()} acquired after ${attempt} wait(s)`); return }
    } catch (error) {
      reason = `could not be checked (${(error as Error).message})`
    }
    await client.end().catch(() => undefined)
    if (Date.now() - started >= waitMs) throw new Error(`Runtime role already active: ${runtimeRole()}`)
    if (attempt % 12 === 0) log(`[runtime] role ${runtimeRole()} ${reason}; waiting for it (retry every ${retryMs} ms)`)
    await new Promise((resolve) => setTimeout(resolve, retryMs))
  }
}
function holdRole(client: Client) {
  // Losing the singleton fence must stop consumers before another process adopts them.
  client.on('error', () => process.exit(1))
  client.on('end', () => { if (roleLock === client) process.exit(1) })
  roleLock = client
}
export async function releaseRuntimeRole() { const client = roleLock; roleLock = undefined; await client?.end() }
export function publishRuntimeState(queues: string[], health: unknown) {
  const dir = workerRuntimeDirectory(); mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = `${dir}/${runtimeRole()}.json`, temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify({ role: runtimeRole(), pid: process.pid, revision: runtimeRevision(), queues, health, observedAt: new Date().toISOString() }), { mode: 0o600 })
  renameSync(temporary, file)
}
