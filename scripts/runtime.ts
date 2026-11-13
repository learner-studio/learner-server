// Runs a process under the runtime package (packages/runtime-pikku).
//
//   bun scripts/runtime.ts <api|worker|dev|worker-dev|prepare|...>
//
// LEARNER_RUNTIME overrides the runtime directory (a name under packages/runtime-<name>, or an absolute path; the
// supervision tests point it at a fixture). Unset, it is `pikku`. Before a server starts, the runtime package's `prepare` (code generation, under the prepare lock) and
// `migrate` scripts run when it defines them: a stale generated file or a pending migration never reaches a
// serving process (docs/operations/restart-safety.md, "Deploys").
//
// `dev` / `worker-dev` are `api` / `worker` with hot reload done HERE, not by `bun --watch`: a source change stops
// the child (SIGTERM, graceful), re-runs prepare, and starts it again, one reload at a time. Any exit this wrapper did not
// ask for, including a child that fails to load, exits the wrapper non-zero, so systemd restarts the unit from
// ExecStartPre. A dead server never sits behind an "active" unit (2026-11-11: 27 minutes with nothing on :3010).
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
export const selectedRuntime = (env = process.env) => env.LEARNER_RUNTIME ?? 'pikku'
const HOT: Record<string, string> = { dev: 'api', 'worker-dev': 'worker' }
const SERVERS = new Set(['api', 'worker', ...Object.keys(HOT)])
// The one prepare lock: the units' ExecStartPre and every hot reload take it here, so the two units never generate at
// once. Never take it around this script too -- flock on a second file description waits on its own parent.
const LOCK = process.env.LEARNER_PREPARE_LOCK ?? '/run/learner/prepare.lock'
// An explicit lock always locks; the default one only where the units' RuntimeDirectory exists (not in lane worktrees).
if (process.env.LEARNER_PREPARE_LOCK) mkdirSync(dirname(LOCK), { recursive: true })
/** A source edit, not generated output (prepare writes those), not a test, not a (possibly draft) migration. */
const isSource = (file: string) => /\.(ts|tsx|json)$/.test(file) && !/(^|\/)(node_modules|generated|\.pikku)\/|\.gen\.ts$|\.test\.tsx?$/.test(file)

const spawn = (dir: string, script: string, lock = false) => Bun.spawn([...(lock && existsSync(dirname(LOCK)) ? ['flock', LOCK] : []), 'bun', 'run', script],
  { cwd: dir, stdio: ['inherit', 'inherit', 'inherit'], env: process.env })

if (import.meta.main) {
  const command = process.argv[2] ?? ''
  const runtime = selectedRuntime()
  const dir = isAbsolute(runtime) ? runtime : join(ROOT, 'packages', `runtime-${runtime}`)
  if (!existsSync(dir)) throw new Error(`LEARNER_RUNTIME=${runtime}: ${dir} does not exist`)
  const scripts: Record<string, string> = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {}
  const script = HOT[command] ?? command
  if (!scripts[script]) throw new Error(`usage: bun scripts/runtime.ts <${[...Object.keys(scripts), ...Object.keys(HOT)].join('|')}>`)
  /** prepare, and at process start migrate (when defined); exits the wrapper on failure. A hot reload never migrates:
   * a draft migration saved in the checkout must not reach the DB (deploys restart the units, which migrate). */
  const ready = async (migrate: boolean) => {
    for (const step of ['prepare', ...(migrate ? ['migrate'] : [])].filter((s) => scripts[s])) {
      const code = await spawn(dir, step, step === 'prepare').exited
      if (code !== 0) process.exit(code || 1)
    }
  }
  if (!SERVERS.has(command)) process.exit(await spawn(dir, script, command === 'prepare').exited)
  await ready(true)
  let child = spawn(dir, script)
  let reloading = false
  const stop = (signal: 'SIGTERM' | 'SIGINT') => { child.kill(signal); child.exited.then((code) => process.exit(code)) }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { reloading = true; stop(signal) })
  const supervise = () => child.exited.then((code) => { if (!reloading) { console.error(`[runtime] ${script} exited (${code}) unasked; exiting so the unit restarts`); process.exit(code || 1) } })
  supervise()
  if (HOT[command]) {
    let timer: ReturnType<typeof setTimeout> | undefined
    // One reload at a time: a change during a reload (prepare is slow) re-runs prepare before the one new child starts.
    let inFlight: Promise<void> | undefined
    let again = false
    const reload = () => {
      if (inFlight) { again = true; return }
      reloading = true
      inFlight = (async () => {
        console.error(`[runtime] source changed; restarting ${script} after prepare`)
        child.kill('SIGTERM')
        await child.exited
        do { again = false; await ready(false) } while (again)
        child = spawn(dir, script)
        reloading = false
        inFlight = undefined
        supervise()
      })()
    }
    watch(dirname(dir), { recursive: true }, (_event, file) => {
      if (!file || !isSource(String(file))) return
      clearTimeout(timer)
      // Debounced: a `git pull` writes many files; one reload after it settles.
      timer = setTimeout(reload, Number(process.env.LEARNER_RELOAD_DEBOUNCE_MS ?? 1_500))
    })
  }
}
