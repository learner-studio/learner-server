// Runs every test file in its own `bun test` process, a few at a time.
//
// One process per file is load-bearing: several ported tests replace a
// module with `mock.module(...)`, and inside one shared process that
// replacement leaks into every file that runs after it. Which files are hit
// then depends on discovery order, so a new test file can break an unrelated
// one. The previous host ran its suite the same way for the same reason.
//
//   bun scripts/run-tests.ts                 every *.test.ts in the workspace
//   bun scripts/run-tests.ts <file|dir>...   only those
//   TEST_CONCURRENCY=8 bun scripts/run-tests.ts
import { Glob } from 'bun'
import { statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { cpus } from 'node:os'

const ROOT = join(import.meta.dir, '..')
const IGNORE = /(^|\/)(node_modules|dist|\.[^/]+)\//

function discover(targets: string[]): string[] {
  const roots = targets.length ? targets : ['.']
  const files = new Set<string>()
  for (const target of roots) {
    const abs = join(ROOT, target)
    if (statSync(abs).isFile()) { files.add(relative(ROOT, abs)); continue }
    for (const f of new Glob('**/*.test.{ts,tsx}').scanSync({ cwd: abs })) {
      const rel = relative(ROOT, join(abs, f))
      if (!IGNORE.test(rel)) files.add(rel)
    }
  }
  return [...files].sort()
}

interface Result { file: string; code: number; pass: number; skip: number; fail: number; ms: number; output: string }

async function runFile(file: string): Promise<Result> {
  const started = performance.now()
  const proc = Bun.spawn(['bun', 'test', file], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe', env: process.env })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  const output = out + err
  const count = (word: string) => Number(new RegExp(`^\\s*(\\d+) ${word}$`, 'm').exec(output)?.[1] ?? 0)
  return { file, code, pass: count('pass'), skip: count('skip'), fail: count('fail'), ms: Math.round(performance.now() - started), output }
}

const files = discover(process.argv.slice(2))
const concurrency = Number(process.env.TEST_CONCURRENCY ?? Math.max(2, Math.min(6, cpus().length - 1)))
const results: Result[] = []
let next = 0
await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
  while (next < files.length) {
    const result = await runFile(files[next++]!)
    results.push(result)
    // A file that exits non-zero with no failing test (a crash, a load error) is still a failure.
    if (result.code !== 0 || result.fail) process.stdout.write(`\n--- FAIL ${result.file} (exit ${result.code})\n${result.output}\n`)
  }
}))

const sum = (k: 'pass' | 'skip' | 'fail') => results.reduce((n, r) => n + r[k], 0)
const failed = results.filter((r) => r.code !== 0 || r.fail)
console.log(`\n${files.length} files: ${sum('pass')} pass, ${sum('skip')} skip, ${sum('fail')} fail, ${failed.length} failing file(s)`)
for (const r of failed) console.log(`  FAIL ${r.file}`)
process.exit(failed.length ? 1 : 0)
