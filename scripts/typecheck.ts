// Typechecks the workspace, then every runtime package that carries its own
// tsconfig (a runtime whose sources need generated code the root config
// cannot see). No emit, ever.
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc')
const projects = ['tsconfig.json', ...readdirSync(join(ROOT, 'packages')).filter((d) => d.startsWith('runtime-')).map((d) => `packages/${d}/tsconfig.json`).filter((p) => existsSync(join(ROOT, p)))]
let failed = 0
for (const project of projects) {
  const code = await Bun.spawn(['bun', TSC, '--noEmit', '-p', project], { cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit'] }).exited
  console.log(`${code === 0 ? 'ok  ' : 'FAIL'} ${project}`)
  if (code !== 0) failed++
}
process.exit(failed ? 1 : 0)
