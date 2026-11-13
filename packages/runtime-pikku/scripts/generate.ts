// Regenerates everything the framework needs before a process starts: the
// wirings from the shared definitions (gen-wiring.ts), then the framework's
// own codegen (`pikku all`). Fails on any diagnostic the CLI prints, since
// the CLI can exit 0 with a broken inspection.
//
//   bun scripts/generate.ts           regenerate (skips the CLI when nothing changed)
//   bun scripts/generate.ts --force   always run the CLI
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const CLI = join(ROOT, '../../node_modules/@pikku/cli/dist/bin/pikku.js')
// Written after a clean run (the CLI leaves unchanged outputs untouched, so their times say nothing).
const { CODEGEN_STAMP: STAMP, codegenFresh } = await import('./codegen-fresh.js')
// Diagnostics the CLI reports without failing its exit code.
const DIAGNOSTIC = /\[PKU\d+\]|inspection failed|\bfailed\b|\berror\b/i

async function run(cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, log: out + err }
}

const wiring = await run(['bun', 'scripts/gen-wiring.ts'])
if (wiring.code !== 0) { console.error(wiring.log); process.exit(wiring.code) }
// Schemas derive from the shared types, so any shared source change reruns the CLI.
if (codegenFresh() && !process.argv.includes('--force')) {
  console.log('framework codegen up to date')
  process.exit(0)
}
// PKU719: the CLI's own tooling (@pikku/cli, inspector-go, knowledge, openapi-parser) carries zod 4.6.7 beside the
// app's 4.5.4. The check only sees it since the project root moved to the repository root (pikku.config.json); the
// copies are internal to the dev tooling, and aligning zod is a dependency change of its own.
// pikku.config.json sits at the repository root: the inspector sweeps only files under its rootDir and skips any
// directory below it that holds a pikku.config.json, so server/src is inspected only from a root config. The CLI
// always writes to <config dir>/.pikku (the config's outDir key is ignored), hence -o.
const cli = await run(['bun', CLI, 'all', '--inspector', 'go', '-o', 'packages/runtime-pikku/.pikku'], { PIKKU_SKIP_TYPE_IDENTITY_CHECK: '1' })
const diagnostics = cli.log.split('\n').filter((line) => DIAGNOSTIC.test(line))
if (cli.code !== 0 || diagnostics.length) {
  console.error(cli.log)
  console.error(`framework codegen failed (exit ${cli.code}, ${diagnostics.length} diagnostic lines)`)
  process.exit(cli.code || 1)
}
// The inspector registers a function only when a wiring or a literal rpc.invoke under src names it, and a
// missing one surfaces only at runtime as "Function not found". Refuse to stamp a run that dropped any.
const { buildRegistry } = await import('@learner/server/functions/registry.js')
const registered = JSON.parse(readFileSync(join(ROOT, '.pikku/function/pikku-functions-meta.gen.json'), 'utf8'))
const unregistered = [...buildRegistry().keys()].filter((name) => !(name in registered))
if (unregistered.length) {
  console.error(`framework codegen registered no function for: ${unregistered.join(', ')}`)
  process.exit(1)
}
writeFileSync(STAMP, new Date().toISOString() + '\n')
console.log(wiring.log.trim())
console.log('framework codegen clean')
