// The one way to move the dev box's checkout (/root/learner) to origin/main (restart-safety.md, "Deploys"):
//
//   bun run deploy        (bun --env-file=/etc/learner/db.env scripts/deploy.ts: the drain reads the database)
//   systemd-run --wait --collect --unit learner-deploy --working-directory=/root/learner --setenv=HOME=/root \
//     -p 'ExecStopPost=/bin/sh -c "[ $$EXIT_STATUS = 0 ] || { systemctl restart learner-worker; systemctl start learner-api; }"' \
//     bun run deploy
//
// Use the second from an interactive session: an ssh hang-up sends SIGHUP to the job's whole process group, which
// kills a running git or bun child (a pull killed mid-checkout can leave a partial tree); a transient unit has none.
// Its ExecStopPost brings the units back after any deploy that did not succeed: one killed (SIGKILL, OOM, `systemctl
// stop learner-deploy`) while the API was stopped or the schedules paused, or one that threw; the worker restart
// schedules again. After a failure the deploy handled itself, that is one more worker restart, which is safe.
//
// 1. Drain (packages/runtime-pikku/src/drain.ts). Stop the API (no run is admitted over HTTP), pause the schedules,
//    and wait up to LEARNER_DEPLOY_DRAIN_SECONDS (default 600) for every in-flight run to end, so no run is resumed
//    on a changed workflow graph. On a timeout, print the runs still in flight, restart the worker (its start
//    schedules everything again) and start the API: the system is back as it was, and the deploy exits 1.
//    LEARNER_DEPLOY_DRAIN_SECONDS=0 skips the drain (an urgent fix that must not wait for a long run).
// 2. Stop both units (the worker's SIGTERM hands in-flight steps over, restart-safe), so their watchers never run the
//    new source on the old node_modules. Then: fast-forward pull, `bun install --frozen-lockfile`, and clear the
//    git-ignored packages/runtime-pikku/.pikku, which prepare writes in full and a CLI change can leave stale. Then
//    start both units: each runs prepare (codegen) and migrate before its server starts (scripts/runtime.ts); the
//    worker's start schedules every task again.
// A failed deploy never leaves the units stopped or on a mixed tree:
// - a step after the pull that fails puts the checkout back on the HEAD it started from (`git reset --keep`, which
//   refuses rather than overwrites local edits) and installs that lockfile again;
// - SIGHUP (a dropped ssh/mosh session) and SIGINT are ignored from the first stop to the start, so the start runs;
// - the units are started either way, and the health wait runs either way, so the operator learns whether they came
//   back; then a failure exits non-zero.
// Health: the API answers /api/health and the worker publishes a runtime heartbeat newer than the start.
// Every child's output goes to LOG, never the terminal: after a hang-up the tty is dead, and a child writing to it
// exits 1 (EIO), which would fail the install and its rollback. The terminal gets one line per step.
import { appendFileSync, openSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { drain } from '../packages/runtime-pikku/src/drain.ts'

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
/** Wait for both units' health; exits 1 if either is not healthy 180 s after `started`. */
const awaitHealth = async () => {
  for (const [unit, ok] of Object.entries(healthy)) {
    const deadline = Date.now() + 180_000
    while (!(await ok())) {
      if (Date.now() > deadline) { say(`deploy: ${unit} not healthy 180 s after the start; see /var/log/learner/${unit}.log`); process.exit(1) }
      await Bun.sleep(2_000)
    }
    say(`deploy: ${unit} healthy`)
  }
}

const before = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim()
const ignored = (signal: string) => () => say(`deploy: ${signal} ignored until the units are started again`)
const shielded = { SIGHUP: ignored('SIGHUP'), SIGINT: ignored('SIGINT') }
for (const [signal, handler] of Object.entries(shielded)) process.on(signal, handler)

const drainSeconds = Number(process.env.LEARNER_DEPLOY_DRAIN_SECONDS ?? 600)
if (drainSeconds > 0) {
  sh(['systemctl', 'stop', 'learner-api'])
  let undrained: string | null = null
  try {
    const connectionString = process.env.LEARNER_DATABASE_URL ?? process.env.DATABASE_URL
    if (!connectionString) throw new Error('DATABASE_URL is not set (run it as `bun run deploy`, which loads /etc/learner/db.env)')
    const bossSchema = process.env.LEARNER_PIKKU_PGBOSS_SCHEMA ?? 'learner_pikku_boss' // as packages/runtime-pikku/src/services.ts:41
    const { drained, paused, left } = await drain({ connectionString, bossSchema, timeoutMs: drainSeconds * 1000, log: say })
    say(`deploy: schedules paused: ${paused.length}`)
    if (!drained) undrained = [`still busy after ${drainSeconds} s:`,
      ...left.runs.map((r) => `  run ${r.runId} ${r.workflow} ${r.status} since ${new Date(r.createdAt).toISOString()}`),
      ...left.jobs.map((j) => `  queue ${j.queue}: ${j.count} job(s) due or active`)].join('\n')
  } catch (error) {
    undrained = `drain failed: ${message(error)}`
  }
  if (undrained) {
    say(`deploy: ${undrained}`)
    // Nothing was pulled. The worker's restart schedules every task again; the API comes back as it was.
    started = Date.now()
    run(['systemctl', 'restart', 'learner-worker'])
    run(['systemctl', 'start', 'learner-api'])
    for (const [signal, handler] of Object.entries(shielded)) process.off(signal, handler)
    await awaitHealth()
    say(`deploy: NOT deployed (drain did not finish); still at ${before.slice(0, 7)}. Retry, or set LEARNER_DEPLOY_DRAIN_SECONDS=0 to deploy over the runs above`)
    process.exit(1)
  }
  say('deploy: drained')
}

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
await awaitHealth()
const head = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT }).stdout.toString().trim()
if (failures.length) { say(`deploy: FAILED (${failures.join('; ')}); the units are back up at ${head}`); process.exit(1) }
say(`deploy: at ${head}`)
