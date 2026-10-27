import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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
    ['clients/uploader/src', /^(zod|node:.*)$/],
    ['apps/web/src', /^(zod|node:.*|react|react-dom(\/.*)?|react\/jsx-runtime|@tanstack\/react-query|react-router-dom|clsx|tailwind-merge|class-variance-authority|lucide-react|@radix-ui\/.*|sigma|graphology|@xyflow\/react(\/.*)?)$/],
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

/**
 * The framework runtime lives in ONE package. Nothing else may import it or
 * name it, so the app installs, boots and tests without that package present
 * (LEARNER_RUNTIME=standalone). The allowed places are the adapter package,
 * its patches, the lockfile, the documents that describe the split, and the
 * deployment config, which is where an environment picks its runtime.
 */
describe('framework runtime is confined to its adapter package', () => {
  const word = ['pik', 'ku'].join('')
  const adapter = `packages/runtime-${word}`
  const ALLOWED = [adapter + '/', 'patches/', 'deploy/', 'bun.lock', 'package.json', 'MIGRATION-SOURCE.md', 'MIGRATION-LOG.md', 'TODO.md', 'CLAUDE.md', 'AGENTS.md']
  const allowed = (rel: string) => ALLOWED.some((a) => a.endsWith('/') ? rel.startsWith(a) : rel === a)
  // What git tracks or would track: new files count, ignored ones (node_modules, builds, agent
  // worktrees under .claude/) do not. A directory walk read other checkouts nested in the tree.
  const files = (): string[] => Bun.spawnSync(['git', 'ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root }).stdout.toString()
    .split('\n').filter((rel) => rel && existsSync(join(root, rel)) && statSync(join(root, rel)).size <= 5_000_000)

  test('no file outside the adapter mentions it', () => {
    const hits = files().filter((rel) => !allowed(rel))
      .filter((rel) => readFileSync(join(root, rel), 'utf8').toLowerCase().includes(word))
    expect(hits).toEqual([])
  })

  test('the root package.json names it only for patches and version pins', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const { patchedDependencies, overrides, ...rest } = pkg
    expect(JSON.stringify(rest).toLowerCase().includes(word)).toBe(false)
    // Overrides may pin the adapter's transitive versions, and only to an exact version.
    for (const [dep, version] of Object.entries(overrides ?? {})) {
      if (dep.toLowerCase().includes(word)) expect(String(version)).toMatch(/^\d+\.\d+\.\d+$/)
    }
    for (const [dep, patch] of Object.entries(patchedDependencies ?? {})) {
      if (dep.toLowerCase().includes(word)) expect(String(patch)).toMatch(/^patches\//)
    }
  })

  test('no package but the adapter imports or depends on it', () => {
    const offenders: string[] = []
    for (const dir of ['packages', 'apps', 'clients']) {
      for (const pkg of readdirSync(join(root, dir))) {
        const pkgDir = join(root, dir, pkg)
        if (`${dir}/${pkg}` === adapter || !statSync(pkgDir).isDirectory()) continue
        const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
        for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          for (const dep of Object.keys(manifest[field] ?? {})) {
            if (dep.toLowerCase().includes(word) || dep === `@learner/runtime-${word}`) offenders.push(`${dir}/${pkg}/package.json ${field}: ${dep}`)
          }
        }
        for (const rel of files().filter((f) => f.startsWith(`${dir}/${pkg}/`) && /\.(ts|tsx|js|mjs)$/.test(f))) {
          for (const m of readFileSync(join(root, rel), 'utf8').matchAll(IMPORT)) {
            const spec = (m[1] ?? m[2] ?? m[3])!
            if (spec.toLowerCase().includes(word)) offenders.push(`${rel} -> ${spec}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
