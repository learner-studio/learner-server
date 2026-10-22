// Runs a process under the selected runtime package (packages/runtime-<name>).
//
//   bun scripts/runtime.ts <api|worker|dev|prepare>
//
// LEARNER_RUNTIME picks the runtime. Unset, it is the framework adapter when
// that package is installed and `standalone` otherwise, so the app runs with
// the adapter removed. A runtime package that defines a `prepare` script
// (code generation) has it run first.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const installed = readdirSync(join(ROOT, 'packages')).filter((d) => d.startsWith('runtime-')).map((d) => d.slice('runtime-'.length)).sort()
export const selectedRuntime = (env = process.env) => env.LEARNER_RUNTIME ?? installed.find((r) => r !== 'standalone') ?? 'standalone'

async function run(dir: string, script: string): Promise<number> {
  const proc = Bun.spawn(['bun', 'run', script], { cwd: dir, stdio: ['inherit', 'inherit', 'inherit'], env: process.env })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => proc.kill(signal))
  return proc.exited
}

if (import.meta.main) {
  const command = process.argv[2]
  const runtime = selectedRuntime()
  const dir = join(ROOT, 'packages', `runtime-${runtime}`)
  if (!existsSync(dir)) throw new Error(`LEARNER_RUNTIME=${runtime}: packages/runtime-${runtime} is not installed (have: ${installed.join(', ')})`)
  const scripts: Record<string, string> = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {}
  if (!command || !scripts[command]) throw new Error(`usage: bun scripts/runtime.ts <${Object.keys(scripts).join('|')}>`)
  if (command !== 'prepare' && scripts.prepare) {
    const code = await run(dir, 'prepare')
    if (code !== 0) process.exit(code)
  }
  process.exit(await run(dir, command))
}
