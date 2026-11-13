// The one way to move the dev box's checkout (/root/learner) to origin/main (restart-safety.md, "Deploys"):
//
//   bun scripts/deploy.ts
//
// Stop both units (the worker's SIGTERM hands in-flight steps over, restart-safe), so their watchers never run the
// new source on the old node_modules. Then: fast-forward pull, `bun install --frozen-lockfile`, and clear the
// git-ignored packages/runtime-pikku/.pikku, which prepare writes in full and a CLI change can leave stale. Then
// start both units: each runs prepare (codegen) and migrate before its server starts (scripts/runtime.ts).
// A failed deploy never leaves the units stopped or on a mixed tree:
// - a step after the pull that fails puts the checkout back on the HEAD it started from (`git reset --keep`, which
//   refuses rather than overwrites local edits) and installs that lockfile again;
// - SIGHUP (a dropped ssh/mosh session) and SIGINT are ignored from the stop to the start, so the start always runs;
// - the units are started either way, and the health wait runs either way, so the operator learns whether they came
//   back; then a failure exits non-zero.
// Health: the API answers /api/health and the worker publishes a runtime heartbeat newer than the start.
// Every child's output goes to LOG, never the terminal: after a hang-up the tty is dead, and a child writing to it
// exits 1 (EIO), which would fail the install and its rollback. The terminal gets one line per step.
import { appendFileSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const LOG = process.env.LEARNER_DEPLOY_LOG ?? '/var/log/learner/deploy.log'
const say = (line: string) => { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`); try { console.error(line) } catch { /* dead tty */ } }
const logFd = openSync(LOG, 'a')
const run = (cmd: string[]) => { say(`deploy: ${cmd.join(' ')} (output in ${LOG})`); return Bun.spawnSync(cmd, { cwd: ROOT, stdio: ['ignore', logFd, logFd] }).exitCode }
const sh = (cmd: string[]) => { const code = run(cmd); if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}`) }
const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const UNITS = ['learner-api', 'learner-worker']
let started = 0
const healthy = {
  api: async () => (await fetch(`http://127.0.0.1:${process.env.LEARNER_PORT ?? 3010}/api/health`).catch(() => null))?.ok === true,
  worker: async () => { try { return Date.parse(JSON.parse(readFileSync('/run/learner/runtime/learning-worker.json', 'utf8')).observedAt) > started } catch { return false } },
}

const before = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim()
const ignored = (signal: string) => () => say(`deploy: ${signal} ignored until the units are started again`)
const shielded = { SIGHUP: ignored('SIGHUP'), SIGINT: ignored('SIGINT') }
for (const [signal, handler] of Object.entries(shielded)) process.on(signal, handler)
const failures: string[] = []
sh(['systemctl', 'stop', ...UNITS.toReversed()])
try {
  sh(['git', 'pull', '--ff-only'])
  try {
    sh(['bun', 'install', '--frozen-lockfile'])
    rmSync(join(ROOT, 'packages/runtime-pikku/.pikku'), { recursive: true, force: true })
  } catch (error) {
    failures.push(message(error))
    sh(['git', 'reset', '--keep', before])
    sh(['bun', 'install', '--frozen-lockfile'])
    failures.push(`rolled back to ${before.slice(0, 7)}`)
  }
} catch (error) {
  failures.push(message(error))
}
started = Date.now()
const start = run(['systemctl', 'start', ...UNITS])
for (const [signal, handler] of Object.entries(shielded)) process.off(signal, handler)
if (start !== 0) {
  run(['systemctl', 'status', '--no-pager', '--lines=20', ...UNITS])
  say(`deploy: systemctl start failed; unit status in ${LOG}, unit logs in /var/log/learner/`)
  process.exit(1)
}
for (const [unit, ok] of Object.entries(healthy)) {
  const deadline = Date.now() + 180_000
  while (!(await ok())) {
    if (Date.now() > deadline) { say(`deploy: ${unit} not healthy 180 s after the start; see /var/log/learner/${unit}.log`); process.exit(1) }
    await Bun.sleep(2_000)
  }
  say(`deploy: ${unit} healthy`)
}
const head = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT }).stdout.toString().trim()
if (failures.length) { say(`deploy: FAILED (${failures.join('; ')}); the units are back up at ${head}`); process.exit(1) }
say(`deploy: at ${head}`)
