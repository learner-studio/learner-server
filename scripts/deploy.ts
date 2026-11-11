// The one way to move the dev box's checkout (/root/learner) to origin/main (restart-safety.md, "Deploys"):
//
//   bun scripts/deploy.ts
//
// fast-forward pull, then restart both units: each runs prepare (codegen) and migrate before its server starts
// (scripts/runtime.ts), and the worker's SIGTERM hands in-flight steps over (restart-safe). Then waits until the API
// answers /api/health and the worker publishes a runtime heartbeat newer than the restart; exits non-zero if not.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const sh = (cmd: string[]) => { const r = Bun.spawnSync(cmd, { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'] }); if (r.exitCode !== 0) throw new Error(`${cmd.join(' ')} exited ${r.exitCode}`) }
const healthy = {
  api: async () => (await fetch(`http://127.0.0.1:${process.env.LEARNER_PORT ?? 3010}/api/health`).catch(() => null))?.ok === true,
  worker: async () => { try { return Date.parse(JSON.parse(readFileSync('/run/learner/runtime/learning-worker.json', 'utf8')).observedAt) > started } catch { return false } },
}

sh(['git', 'pull', '--ff-only'])
const started = Date.now()
const UNITS = ['learner-api', 'learner-worker']
if (Bun.spawnSync(['systemctl', 'restart', ...UNITS], { stdio: ['inherit', 'inherit', 'inherit'] }).exitCode !== 0) {
  Bun.spawnSync(['systemctl', 'status', '--no-pager', '--lines=20', ...UNITS], { stdio: ['inherit', 'inherit', 'inherit'] })
  console.error(`deploy: systemctl restart failed; unit status above, logs in /var/log/learner/`)
  process.exit(1)
}
for (const [unit, ok] of Object.entries(healthy)) {
  const deadline = Date.now() + 180_000
  while (!(await ok())) {
    if (Date.now() > deadline) { console.error(`deploy: ${unit} not healthy 180 s after the restart; see /var/log/learner/${unit}.log`); process.exit(1) }
    await Bun.sleep(2_000)
  }
  console.log(`deploy: ${unit} healthy`)
}
console.log(`deploy: at ${Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT }).stdout.toString().trim()}`)
