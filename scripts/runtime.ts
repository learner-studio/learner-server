// Runs a process under the selected runtime package (packages/runtime-<name>).
//
//   bun scripts/runtime.ts <api|worker|dev|worker-dev|prepare|...>
//
// LEARNER_RUNTIME picks the runtime: a name, or an absolute path to a runtime directory. Unset, it is the
// framework adapter when that package is installed and `standalone` otherwise, so the app runs with the adapter
// removed. Before a server starts, the runtime package's `prepare` (code generation, under the prepare lock) and
// `migrate` scripts run when it defines them: a stale generated file or a pending migration never reaches a
// serving process (docs/operations/restart-safety.md, "Deploys").
//
// `dev` / `worker-dev` are `api` / `worker` with hot reload done HERE, not by `bun --watch`: a source change stops
// the child (SIGTERM, graceful), re-runs prepare and migrate, and starts it again. Any exit this wrapper did not
// ask for, including a child that fails to load, exits the wrapper non-zero, so systemd restarts the unit from
// ExecStartPre. A dead server never sits behind an "active" unit (2026-11-11: 27 minutes with nothing on :3010).
import { existsSync, readdirSync, readFileSync, watch } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const installed = readdirSync(join(ROOT, 'packages')).filter((d) => d.startsWith('runtime-')).map((d) => d.slice('runtime-'.length)).sort()
export const selectedRuntime = (env = process.env) => env.LEARNER_RUNTIME ?? installed.find((r) => r !== 'standalone') ?? 'standalone'
const HOT: Record<string, string> = { dev: 'api', 'worker-dev': 'worker' }
const SERVERS = new Set(['api', 'worker', ...Object.keys(HOT)])
const LOCK = '/run/learner/prepare.lock' // shared with the units' ExecStartPre: the two units never generate at once
/** A source edit, not generated output (prepare writes those) and not a test. */
const isSource = (file: string) => /\.(ts|tsx|sql|json)$/.test(file) && !/(^|\/)(node_modules|generated|\.pikku)\/|\.gen\.ts$|\.test\.tsx?$/.test(file)

const spawn = (dir: string, script: string, lock = false) => Bun.spawn([...(lock && existsSync(dirname(LOCK)) ? ['flock', LOCK] : []), 'bun', 'run', script],
  { cwd: dir, stdio: ['inherit', 'inherit', 'inherit'], env: process.env })

if (import.meta.main) {
  const command = process.argv[2] ?? ''
  const runtime = selectedRuntime()
  const dir = isAbsolute(runtime) ? runtime : join(ROOT, 'packages', `runtime-${runtime}`)
  if (!existsSync(dir)) throw new Error(`LEARNER_RUNTIME=${runtime}: packages/runtime-${runtime} is not installed (have: ${installed.join(', ')})`)
  const scripts: Record<string, string> = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {}
  const script = HOT[command] ?? command
  if (!scripts[script]) throw new Error(`usage: bun scripts/runtime.ts <${[...Object.keys(scripts), ...Object.keys(HOT)].join('|')}>`)
  /** prepare + migrate (when defined); exits the wrapper on failure. */
  const ready = async () => {
    for (const step of ['prepare', 'migrate'].filter((s) => scripts[s])) {
      const code = await spawn(dir, step, step === 'prepare').exited
      if (code !== 0) process.exit(code || 1)
    }
  }
  if (!SERVERS.has(command)) process.exit(await spawn(dir, script, command === 'prepare').exited)
  await ready()
  let child = spawn(dir, script)
  let reloading = false
  const stop = (signal: 'SIGTERM' | 'SIGINT') => { child.kill(signal); child.exited.then((code) => process.exit(code)) }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { reloading = true; stop(signal) })
  const supervise = () => child.exited.then((code) => { if (!reloading) { console.error(`[runtime] ${script} exited (${code}) unasked; exiting so the unit restarts`); process.exit(code || 1) } })
  supervise()
  if (HOT[command]) {
    let timer: ReturnType<typeof setTimeout> | undefined
    watch(dirname(dir), { recursive: true }, (_event, file) => {
      if (!file || !isSource(String(file))) return
      clearTimeout(timer)
      // Debounced: a `git pull` writes many files; one reload after it settles.
      timer = setTimeout(async () => {
        reloading = true
        console.error(`[runtime] source changed (${file}); restarting ${script} after prepare + migrate`)
        child.kill('SIGTERM')
        await child.exited
        await ready()
        child = spawn(dir, script)
        reloading = false
        supervise()
      }, Number(process.env.LEARNER_RELOAD_DEBOUNCE_MS ?? 1_500))
    })
  }
}
