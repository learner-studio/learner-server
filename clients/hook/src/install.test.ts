import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { coverage, hookCommand, learnerPermissions, withLearnerHooks, withLearnerPermissions, withoutLearnerHooks, withoutLearnerPermissions, EVENTS, type Settings } from './install.js'

const COMMAND = '/usr/bin/bun /srv/learner/clients/hook/src/index.ts'
const FOREIGN = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/audit.sh', timeout: 2 }] }

describe('settings merge', () => {
  test('adds one group per event and keeps every other hook and setting', () => {
    const before: Settings = { model: 'x', permissions: { allow: ['Bash(ls)'] }, hooks: { PostToolUse: [FOREIGN], PreToolUse: [FOREIGN] } }
    const after = withLearnerHooks(before, COMMAND)
    expect(after.model).toBe('x')
    expect(after.permissions).toEqual(before.permissions)
    expect(after.hooks!.PreToolUse).toEqual([FOREIGN])
    expect(after.hooks!.PostToolUse![0]).toEqual(FOREIGN)
    expect(coverage(after)).toEqual({ events: { SessionStart: true, UserPromptSubmit: true, PostToolUse: true, Stop: true }, catalogParts: 5, installed: true })
    expect(after.hooks!.UserPromptSubmit![0]!.hooks!.map((h) => h.command)).toEqual([COMMAND, ...[0, 1, 2, 3, 4].map((n) => `${COMMAND} --catalog-part ${n}`)])
    expect(before.hooks!.PostToolUse).toEqual([FOREIGN]) // the input is not mutated
  })

  test('installing twice, or over an older path, leaves exactly one Learner group per event', () => {
    const old = withLearnerHooks({}, '/usr/bin/bun /old/place/clients/hook/src/index.ts', 3)
    const twice = withLearnerHooks(withLearnerHooks(old, COMMAND), COMMAND)
    expect(twice).toEqual(withLearnerHooks({}, COMMAND))
    for (const event of EVENTS) expect(twice.hooks![event]).toHaveLength(1)
  })

  test('a Learner hook sharing a group with a foreign hook is removed alone', () => {
    const mixed: Settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: COMMAND }, FOREIGN.hooks[0]!] }] } }
    expect(withoutLearnerHooks(mixed)).toEqual({ hooks: { Stop: [{ hooks: [FOREIGN.hooks[0]!] }] } })
  })

  test('uninstall restores the settings it started from', () => {
    const before: Settings = { model: 'x', hooks: { PreToolUse: [FOREIGN] } }
    expect(withoutLearnerHooks(withLearnerHooks(before, COMMAND))).toEqual(before)
    expect(withoutLearnerHooks(withLearnerHooks({ model: 'x' }, COMMAND))).toEqual({ model: 'x' })
  })

  test('coverage is false while any event is missing, and companions alone do not count', () => {
    const partial = withLearnerHooks({}, COMMAND)
    delete partial.hooks!.Stop
    expect(coverage(partial).installed).toBe(false)
    expect(coverage({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `${COMMAND} --catalog-part 0` }] }] } }).events.UserPromptSubmit).toBe(false)
    expect(coverage({}).installed).toBe(false)
  })

  test('the submit and catalog commands are allowed once, beside the rules already there, and taken out again', () => {
    const before: Settings = { model: 'x', permissions: { deny: ['Bash(rm *)'], allow: ['Bash(ls)'] } }
    const stale = 'Bash(/old/bun /old/place/clients/hook/src/index.ts --submit*)'
    const after = withLearnerPermissions(withLearnerPermissions({ ...before, permissions: { ...before.permissions, allow: ['Bash(ls)', stale] } }, COMMAND), COMMAND)
    expect(after.permissions).toEqual({ deny: ['Bash(rm *)'], allow: ['Bash(ls)', `Bash(${COMMAND} --submit*)`, `Bash(${COMMAND} --catalog*)`] })
    expect(learnerPermissions(COMMAND)).toEqual(after.permissions!.allow!.slice(1))
    expect(withoutLearnerPermissions(after)).toEqual(before)
    expect(withoutLearnerPermissions(withLearnerPermissions({ model: 'x' }, COMMAND))).toEqual({ model: 'x' })
    expect(before.permissions!.allow).toEqual(['Bash(ls)']) // the input is not mutated
  })

  test('a path with a space is quoted as one shell word', () => {
    expect(hookCommand('/Users/a b/.bun/bin/bun', '/Users/a b/code/clients/hook/src/index.ts')).toBe(`'/Users/a b/.bun/bin/bun' '/Users/a b/code/clients/hook/src/index.ts'`)
  })
})

/** The installer as a subprocess against a scratch ~/.claude; the network is an outage (test/network.preload.ts). */
describe('install.ts', () => {
  const ENTRY = join(import.meta.dir, 'install.ts')
  const PRELOAD = join(import.meta.dir, '../test/network.preload.ts')
  async function run(dir: string, args: string[], env: Record<string, string> = {}) {
    const child = Bun.spawn(['bun', '--preload', PRELOAD, ENTRY, ...args], {
      env: { ...process.env, LEARNER_HOOK_CONFIG: join(dir, '.claude/learning-hook.json'), LEARNER_HOOK_TRACE_DIR: join(dir, '.claude/learner-hook-traces'), LEARNER_API_KEY: '', LEARNER_URL: '', ...env },
      stdout: 'pipe', stderr: 'pipe',
    })
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { stdout, stderr, exit }
  }
  const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'))
  async function withHome(body: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), 'learner-hook-test-install-'))
    try { await mkdir(join(dir, '.claude'), { recursive: true }); await body(dir) } finally { await rm(dir, { recursive: true, force: true }) }
  }

  test('wires user-level settings, moves an old project-level install out, and is idempotent', () => withHome(async (dir) => {
    const user = join(dir, '.claude/settings.json'); const local = join(dir, '.claude/settings.local.json')
    await writeFile(user, JSON.stringify({ model: 'x', hooks: { PreToolUse: [FOREIGN] } }), { mode: 0o644 })
    await writeFile(local, JSON.stringify({ outputStyle: 'Explanatory', ...withLearnerPermissions(withLearnerHooks({}, COMMAND), COMMAND) }))
    const secret = 'device-key-that-must-not-appear'
    const first = await run(dir, ['--remove-from', local, '--server-url', 'https://learner.example/learner-api', '--key-command-json', JSON.stringify(['/bin/echo', secret])])
    expect(first.stderr).toBe(''); expect(first.exit).toBe(0)
    expect(first.stdout).not.toContain(secret)
    const report = JSON.parse(first.stdout)
    expect(report).toMatchObject({ installed: true, changed: true, removedFrom: [local] })

    const settings = await json(user)
    expect(settings.model).toBe('x'); expect(settings.hooks.PreToolUse).toEqual([FOREIGN])
    expect(coverage(settings).installed).toBe(true)
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(report.command)
    expect(settings.permissions.allow).toEqual([`Bash(${report.command} --submit*)`, `Bash(${report.command} --catalog*)`])
    expect(report.command).toEndWith('clients/hook/src/index.ts')
    expect((await stat(user)).mode & 0o777).toBe(0o644)
    expect(await json(`${user}.bak-learner`)).toEqual({ model: 'x', hooks: { PreToolUse: [FOREIGN] } })
    expect(await json(local)).toEqual({ outputStyle: 'Explanatory' })

    const config = await json(join(dir, '.claude/learning-hook.json'))
    expect(config).toEqual({ foundationFirst: true, timeoutMs: 2500, liveFeedback: true, serverUrl: 'https://learner.example/learner-api', keyCommand: ['/bin/echo', secret], submitCommand: `${report.command} --submit` })
    expect((await stat(join(dir, '.claude/learning-hook.json'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(dir, '.claude/commands/learner-off.md'), 'utf8')).toContain('learner-toggle:off')
    expect((await stat(join(dir, '.claude/learner-hook-traces'))).mode & 0o777).toBe(0o700)

    const second = await run(dir, ['--remove-from', local])
    expect(JSON.parse(second.stdout)).toMatchObject({ installed: true, changed: false, removedFrom: [] })
    expect(await json(user)).toEqual(settings)
    expect(await json(join(dir, '.claude/learning-hook.json'))).toEqual(config) // a later run without flags keeps the connection
  }))

  test('an existing hook config keeps its own choices', () => withHome(async (dir) => {
    await writeFile(join(dir, '.claude/learning-hook.json'), JSON.stringify({ foundationFirst: false, timeoutMs: 1500, liveFeedback: false }))
    expect((await run(dir, [])).exit).toBe(0)
    expect(await json(join(dir, '.claude/learning-hook.json'))).toMatchObject({ foundationFirst: false, timeoutMs: 1500, liveFeedback: false })
  }))

  test('settings that are not a JSON object stop the install and are left alone', () => withHome(async (dir) => {
    await writeFile(join(dir, '.claude/settings.json'), '[1,2]')
    const result = await run(dir, [])
    expect(result.exit).toBe(1); expect(result.stderr).toContain('is not a JSON object')
    expect(await readFile(join(dir, '.claude/settings.json'), 'utf8')).toBe('[1,2]')
  }))

  test('--check: exit 1 and the reason while unwired or the server does not answer; never the key', () => withHome(async (dir) => {
    const unwired = await run(dir, ['--check'], { LEARNER_API_KEY: 'k-secret', LEARNER_URL: 'http://127.0.0.1:9' })
    expect(unwired.exit).toBe(1)
    expect(JSON.parse(unwired.stdout)).toMatchObject({ ok: false, installed: false, permissions: false, config: 'missing', server: 'unreachable' })
    await run(dir, [])
    const wired = await run(dir, ['--check'], { LEARNER_API_KEY: 'k-secret', LEARNER_URL: 'http://127.0.0.1:9' })
    expect(JSON.parse(wired.stdout)).toMatchObject({ ok: false, installed: true, permissions: true, catalogParts: 5, config: 'ok', server: 'unreachable' })
    expect(wired.stdout + wired.stderr).not.toContain('k-secret')
    const refused = await run(dir, ['--check'], { LEARNER_API_KEY: 'k-secret', LEARNER_URL: 'http://127.0.0.1:9', LEARNER_HOOK_TEST_HTTP_STATUS: '403' })
    expect(JSON.parse(refused.stdout).server).toBe('refused (HTTP 403)')
    const none = await run(dir, ['--check'], { LEARNER_HOOK_KEY_FILE: join(dir, 'absent.env'), LEARNER_URL: 'http://127.0.0.1:9' })
    expect(JSON.parse(none.stdout).server).toBe('no credential')
  }))

  test('--uninstall removes only the Learner hooks', () => withHome(async (dir) => {
    const user = join(dir, '.claude/settings.json')
    await writeFile(user, JSON.stringify({ hooks: { PreToolUse: [FOREIGN] } }))
    await run(dir, [])
    expect((await run(dir, ['--uninstall'])).exit).toBe(0)
    expect(await json(user)).toEqual({ hooks: { PreToolUse: [FOREIGN] } })
  }))
})
