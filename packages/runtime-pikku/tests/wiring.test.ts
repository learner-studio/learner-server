import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { FUNCTION } from '@learner/server/runtime/define.js'
import { buildRegistry } from '@learner/server/functions/registry.js'
import { QUEUES, SCHEDULES } from '@learner/server/wiring/queues.js'
import { ROUTES } from '@learner/server/http/routes.js'

const ROOT = join(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')
const registry = buildRegistry()

describe('generated wiring', () => {
  test('is up to date with the shared definitions', async () => {
    const proc = Bun.spawn(['bun', 'scripts/gen-wiring.ts', '--check'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(err).toBe('')
    expect(code).toBe(0)
  })

  test('wraps every shared function exactly once, keeping its exposure', () => {
    const source = read('src/generated/functions.gen.ts')
    for (const [name, def] of registry) {
      if (def[FUNCTION] === 'workflow') continue
      const line = source.split('\n').filter((l) => l.startsWith(`export const ${name} = `))
      expect(line).toHaveLength(1)
      expect(line[0]!.includes('expose: true')).toBe(Boolean(def.meta.expose))
    }
  })

  test('the framework inspector registered every shared function', () => {
    const registered = JSON.parse(read('.pikku/function/pikku-functions-meta.gen.json'))
    expect([...registry.keys()].filter((name) => !(name in registered))).toEqual([])
  })

  test('wires every route, queue and schedule of the shared tables', () => {
    expect(read('src/wirings/generated/http.gen.ts').match(/^wireHTTP\(/gm)).toHaveLength(ROUTES.length)
    expect(read('src/wirings/generated/queues.gen.ts').match(/^wireQueueWorker\(/gm)).toHaveLength(QUEUES.length)
    expect(read('src/wirings/generated/schedules.gen.ts').match(/^wireScheduler\(/gm)).toHaveLength(SCHEDULES.length)
  })

  test('workflow bodies call their steps by literal name, with no casts', () => {
    const dir = join(ROOT, 'src/generated/workflows')
    const files = readdirSync(dir)
    const workflows = [...registry].filter(([, def]) => def[FUNCTION] === 'workflow').map(([name]) => name)
    const bodies = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
    for (const name of workflows) expect(bodies).toMatch(new RegExp(`export const ${name}\\s*=\\s*pikkuWorkflowFunc\\(`))
    // Every step call names its function with a string literal (or is an inline step body).
    const calls = [...bodies.matchAll(/\.do\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*([^,)]+)/g)].map((m) => m[1]!.trim())
    expect(calls.length).toBe(bodies.match(/\.do\(/g)!.length)
    for (const target of calls) expect(target).toMatch(/^(['"]\w+['"]|async\b|\()/)
    expect(bodies).not.toMatch(/\bas (any|unknown|never)\b|\bas '/)
  })
})
