import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * The clients (CLI hook, web app) talk to the server only through
 * @learner/contract. This walks every import reachable from each client and
 * fails on anything that would pull server, core or LLM code into a client.
 */
const root = resolve(import.meta.dir, '..')
const contractSrc = join(root, 'packages/contract/src')
const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (name === 'node_modules' || name === 'dist') return []
    if (statSync(path).isDirectory()) return sources(path)
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}
const resolveFile = (from: string, spec: string) => {
  const base = resolve(dirname(from), spec.replace(/\.js$/, ''))
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base]) {
    try { if (statSync(candidate).isFile()) return candidate } catch { /* next */ }
  }
  throw new Error(`Unresolvable import ${spec} from ${relative(root, from)}`)
}

/** Every bare specifier reachable from `entries`, following relative and @learner/contract imports. */
function reachable(entries: string[], packageRoot: string) {
  const seen = new Set<string>(), bare = new Map<string, string>(), escapes: string[] = []
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = (m[1] ?? m[2] ?? m[3])!
      if (spec.startsWith('.')) {
        const target = resolveFile(file, spec)
        const inside = target.startsWith(packageRoot) || target.startsWith(contractSrc)
        if (!inside) escapes.push(`${relative(root, file)} -> ${spec}`)
        else visit(target)
      } else if (spec === '@learner/contract') visit(join(contractSrc, 'index.ts'))
      else if (spec.startsWith('@learner/contract/')) visit(resolveFile(join(contractSrc, 'x.ts'), `./${spec.slice('@learner/contract/'.length)}`))
      else bare.set(spec, relative(root, file))
    }
  }
  entries.forEach(visit)
  return { bare, escapes }
}

describe('client separation', () => {
  test('contract depends on nothing but zod and node builtins', () => {
    const { bare, escapes } = reachable(sources(contractSrc), contractSrc)
    expect(escapes).toEqual([])
    expect([...bare.keys()].filter((s) => s !== 'zod' && !s.startsWith('node:'))).toEqual([])
  })

  for (const [client, allowed] of [
    ['clients/hook/src', /^(zod|node:.*)$/],
    ['apps/web/src', /^(zod|node:.*|react|react-dom(\/.*)?|react\/jsx-runtime|@tanstack\/react-query|react-router-dom|clsx|tailwind-merge|class-variance-authority|lucide-react|@radix-ui\/.*)$/],
  ] as const) {
    test(`${client} imports only @learner/contract`, () => {
      const dir = join(root, client)
      const files = sources(dir)
      expect(files.length).toBeGreaterThan(0)
      const { bare, escapes } = reachable(files, dir)
      expect(escapes).toEqual([])
      const offending = [...bare].filter(([spec]) => !allowed.test(spec)).map(([spec, file]) => `${file} -> ${spec}`)
      expect(offending).toEqual([])
    })
  }
})

describe('no trace of the previous framework', () => {
  const word = ['pik', 'ku'].join('')
  test('no source, config or doc mentions it (except MIGRATION-SOURCE.md)', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', '.git', 'dist'].includes(name) || name === 'MIGRATION-SOURCE.md') continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) { walk(path); continue }
        if (statSync(path).size > 5_000_000) continue
        if (readFileSync(path, 'utf8').toLowerCase().includes(word)) hits.push(relative(root, path))
      }
    }
    walk(root)
    expect(hits).toEqual([])
  })
})
