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
// A step call `workflow.do('<label>', '<function>', ...)`; the workflows the inspector built a graph for (read per test).
const STEP = /\.do\(\s*'[^']*'\s*,\s*'(\w+)'/g
const META = join(ROOT, '.pikku/workflow/meta')
const workflowMetas = () => readdirSync(META).filter((f) => !f.includes('-verbose'))
const workflowNames = () => new Set(workflowMetas().map((f) => f.replace(/\.gen\.json$/, '')))
// Every workflow body: the copies of shared ones (src/generated/workflows) and the Pikku-native ones in server/src.
const SERVER = join(ROOT, '../server/src')
const workflowBodies = () => [
  ...readdirSync(join(ROOT, 'src/generated/workflows')).map((f) => read(`src/generated/workflows/${f}`)),
  ...[...new Bun.Glob('**/*.ts').scanSync({ cwd: SERVER })].filter((f) => !f.endsWith('.test.ts'))
    .map((f) => readFileSync(join(SERVER, f), 'utf8')).filter((source) => /=\s*pikkuWorkflowFunc\(/.test(source)),
]

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

  // 2026-11-11: `x = (await workflow.do(..., 'step', ...)).field` became a `set` node holding the call
  // as text. Codegen stayed clean, the step was never registered, and the live run failed with
  // "Function not found". Every step call must be a graph node and a registered function.
  test('every step a workflow body calls is a graph node and a registered function', () => {
    const bodies = workflowBodies().join('\n')
    const targets = new Set([...bodies.matchAll(STEP)].map((m) => m[1]!))
    expect(targets.size).toBeGreaterThan(0)
    // A target is a registered function, or a registered workflow started as a child run.
    const registered = read('.pikku/function/pikku-functions.gen.ts')
    const workflows = workflowNames()
    expect([...targets].filter((name) => !registered.includes(`addFunction('${name}',`) && !workflows.has(name))).toEqual([])
    const hidden = workflowMetas().flatMap((f) =>
      Object.values((JSON.parse(readFileSync(join(META, f), 'utf8')).nodes ?? {}) as Record<string, { nodeId: string; expression?: string }>)
        .filter((node) => node.expression?.includes('.do(')).map((node) => `${f}: ${node.nodeId}`))
    expect(hidden).toEqual([])
  })

  // Per workflow, not across all bodies: `prepared = await workflow.do(...)` (a reassignment) was no node of
  // learningReactiveConceptWorkflow's graph, and the check above passed only because another workflow has that step.
  test('every step a workflow body calls is a node of that workflow\'s own graph', () => {
    const missing: string[] = []
    for (const source of workflowBodies()) {
      for (const [, name, body] of source.matchAll(/export const (\w+)\s*=\s*pikkuWorkflowFunc\(([\s\S]*?)(?=\nexport const |$)/g)) {
        const nodes = Object.values(JSON.parse(read(`.pikku/workflow/meta/${name}.gen.json`)).nodes ?? {}) as { rpcName?: string }[]
        const graph = new Set(nodes.map((node) => node.rpcName))
        for (const [, target] of body!.matchAll(STEP)) if (!graph.has(target)) missing.push(`${name} -> ${target}`)
      }
    }
    expect(missing).toEqual([])
  })

  test('every workflow a function starts by literal name is registered', () => {
    const workflows = workflowNames()
    const started = new Set<string>()
    for (const dir of [join(ROOT, '../server/src'), join(ROOT, 'src')]) {
      for (const file of new Bun.Glob('**/*.ts').scanSync({ cwd: dir })) {
        if (file.endsWith('.test.ts') || file.includes('generated/')) continue
        const source = readFileSync(join(dir, file), 'utf8')
        // startWorkflow('<name>', ...) and startWorkflowOnce(service, rpc, '<name>', ...)
        for (const [, name] of source.matchAll(/startWorkflow(?:Once)?\(\s*(?:[\w.!]+\s*,\s*){0,2}'(\w+)'/g)) started.add(name!)
      }
    }
    expect(started.size).toBeGreaterThan(10)
    expect([...started].filter((name) => !workflows.has(name))).toEqual([])
  })

  // The framework dropped step `onError`; a workflow's handler is the compensate of its FIRST step (gen-wiring.ts),
  // which the newest-first unwind runs last and once. Elsewhere a compensate would run the handler again.
  // The meta list is the guard that no failure handler is lost: converting a workflow or its first step to Pikku-native
  // never shrinks it (the native first step carries `compensate` itself; only the wrapper lines below move).
  test('a shared onError handler compensates its workflow\'s first step only, and no body keeps onError', () => {
    const meta = JSON.parse(read('.pikku/function/pikku-functions-meta.gen.json')) as Record<string, { compensate?: boolean }>
    expect(Object.keys(meta).filter((name) => meta[name]!.compensate).sort()).toEqual(['preflightLearningHindsightNativePilot', 'prepareLearningCliVectorE2EStep'])
    const source = read('src/generated/functions.gen.ts')
    expect(source).toMatch(/preflightLearningHindsightNativePilot = .*compensateWith\('failLearningHindsightNativePilot'/)
    expect(source).toMatch(/prepareLearningCliVectorE2EStep = .*compensateWith\('failLearningCliVectorE2EStep'/)
    expect(workflowBodies().filter((source) => source.includes('onError'))).toEqual([])
  })

  test('wires every route, queue and schedule of the shared tables', () => {
    expect(read('src/wirings/generated/http.gen.ts').match(/^wireHTTP\(/gm)).toHaveLength(ROUTES.length)
    expect(read('src/wirings/generated/queues.gen.ts').match(/^wireQueueWorker\(/gm)).toHaveLength(QUEUES.length)
    expect(read('src/wirings/generated/schedules.gen.ts').match(/^wireScheduler\(/gm)).toHaveLength(SCHEDULES.length)
  })

  test('workflow bodies call their steps by literal name, with no casts', () => {
    const workflows = [...registry].filter(([, def]) => def[FUNCTION] === 'workflow').map(([name]) => name)
    const bodies = workflowBodies().join('\n')
    for (const name of workflows) expect(bodies).toMatch(new RegExp(`export const ${name}\\s*=\\s*pikkuWorkflowFunc\\(`))
    // Every step call names its function with a string literal (or is an inline step body).
    const calls = [...bodies.matchAll(/\.do\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*([^,)]+)/g)].map((m) => m[1]!.trim())
    expect(calls.length).toBe(bodies.match(/\.do\(/g)!.length)
    for (const target of calls) expect(target).toMatch(/^(['"]\w+['"]|async\b|\()/)
    expect(bodies).not.toMatch(/\bas (any|unknown|never)\b|\bas '/)
  })
})
