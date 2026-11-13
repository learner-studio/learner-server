// The one way to move the dev box's checkout (/root/learner) to origin/main (restart-safety.md, "Deploys"):
//
//   bun scripts/deploy.ts
//
// Stop both units (the worker's SIGTERM hands in-flight steps over, restart-safe), so their watchers never run the
// new source on the old node_modules. Then: fast-forward pull, `bun install --frozen-lockfile`, and clear the
// git-ignored packages/runtime-pikku/.pikku, which prepare writes in full and a CLI change can leave stale. Then
// start both units: each runs prepare (codegen) and migrate before its server starts (scripts/runtime.ts). The units
// are started again even when a step before failed, so a failed deploy never leaves them stopped. Last, wait until
// the API answers /api/health and the worker publishes a runtime heartbeat newer than the start; exit non-zero if not.
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'] }); if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} exited ${r.exitCode}`) }
const UNITS = ['learner-api', 'learner-worker']
let started = 0
const healthy = {
  api: async () => (await fetch(`http://127.0.0.1:${process.env.LEARNER_PORT ?? 3010}/api/health`).catch(() => null))?.ok === true,
  worker: async () => { try { return Date.parse(JSON.parse(readFileSync('/run/learner/runtime/learning-worker.json', 'utf8')).observedAt) > started } catch { return false } },
}

let failed: unknown = null
sh(['systemctl', 'stop', ...UNITS.toReversed()])
try {
  sh(['git', 'pull', '--ff-only'])
  sh(['bun', 'install', '--frozen-lockfile'])
  rmSync(join(ROOT, 'packages/runtime-pikku/.pikku'), { recursive: true, force: true })
} catch (error) {
  failed = error
}
started = Date.now()
if (Bun.spawnSync(['systemctl', 'start', ...UNITS], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode !== 0) {
  Bun.spawnSync(['systemctl', 'status', '--no-pager', '--lines=20', ...UNITS], { stdio: ['inherit', 'inherit', 'inherit'] })
  console.error(`deploy: systemctl start failed; unit status above, logs in /var/log/learner/`)
  process.exit(1)
}
if (failed) { console.error(`deploy: ${failed instanceof Error ? failed.message : String(failed)}; the units were started again on the checkout as it stands`); process.exit(1) }
for (const [unit, ok] of Object.entries(healthy)) {
  const deadline = Date.now() + 180_000
  while (!(await ok())) {
    if (Date.now() > deadline) { console.error(`deploy: ${unit} not healthy 180 s after the start; see /var/log/learner/${unit}.log`); process.exit(1) }
    await Bun.sleep(2_000)
  }
  console.log(`deploy: ${unit} healthy`)
}
console.log(`deploy: at ${Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT }).stdout.toString().trim()}`)
