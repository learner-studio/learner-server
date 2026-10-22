// Regenerates everything the framework needs before a process starts: the
// wirings from the shared definitions (gen-wiring.ts), then the framework's
// own codegen (`pikku all`). Fails on any diagnostic the CLI prints, since
// the CLI can exit 0 with a broken inspection.
//
//   bun scripts/generate.ts           regenerate (skips the CLI when nothing changed)
//   bun scripts/generate.ts --force   always run the CLI
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const CLI = join(ROOT, '../../node_modules/@pikku/cli/dist/bin/pikku.js')
// Written after a clean run (the CLI leaves unchanged outputs untouched, so their times say nothing).
const STAMP = join(ROOT, '.pikku/.generated')
// Diagnostics the CLI reports without failing its exit code.
const DIAGNOSTIC = /\[PKU\d+\]|inspection failed|\bfailed\b|\berror\b/i

async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, log: out + err }
}

const newest = (dir: string): number => readdirSync(dir).reduce((max, name) => {
  if (name === 'node_modules' || name === '.pikku') return max
  const path = join(dir, name)
  const stat = statSync(path)
  return Math.max(max, stat.isDirectory() ? newest(path) : stat.mtimeMs)
}, 0)

const wiring = await run(['bun', 'scripts/gen-wiring.ts'])
if (wiring.code !== 0) { console.error(wiring.log); process.exit(wiring.code) }
// Schemas derive from the shared types, so any shared source change reruns the CLI.
const inputs = ['src', '../server/src', '../core/src', '../contract/src', '../llm/src'].map((d) => join(ROOT, d))
const fresh = existsSync(STAMP) && statSync(STAMP).mtimeMs > Math.max(...inputs.map(newest))
if (fresh && !process.argv.includes('--force')) {
  console.log('framework codegen up to date')
  process.exit(0)
}
const cli = await run(['bun', CLI, 'all'])
const diagnostics = cli.log.split('\n').filter((line) => DIAGNOSTIC.test(line))
if (cli.code !== 0 || diagnostics.length) {
  console.error(cli.log)
  console.error(`framework codegen failed (exit ${cli.code}, ${diagnostics.length} diagnostic lines)`)
  process.exit(cli.code || 1)
}
writeFileSync(STAMP, new Date().toISOString() + '\n')
console.log(wiring.log.trim())
console.log('framework codegen clean')
