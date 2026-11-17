import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { liveCatalogContexts, RpcError } from '@learner/contract'
import { Config, learner, paths } from './config.js'

/**
 * Wires the hook into Claude Code for EVERY session of this user, on any machine:
 *
 *   install.ts                         add the hook to ~/.claude/settings.json (user level)
 *   install.ts --check                 report what is wired and whether the server answers; exit 1 if not
 *   install.ts --uninstall             remove it
 *
 *   --remove-from <settings file>      also take the hook out of that file (an older, project-level install)
 *   --server-url <url>                 the Learner server, when it is not on this machine
 *   --key-command-json '["argv",...]'  how to print the API key (e.g. the Mac's /usr/bin/security lookup)
 *   --key-file <path>                  or a file holding LEARNER_API_KEY=...
 *   --catalog-parts <n>                companion hooks that carry the concept catalog (default 5)
 *
 * User level matters: a hook in a project's settings.local.json runs only for sessions started
 * in that one folder. It never prints a key, and it leaves every other hook and setting alone.
 */
export const HOOK_MARKER = 'clients/hook/src/index.ts'
export const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const
const TIMEOUT_SECONDS = 4
type Hook = { type?: string; command?: string; timeout?: number; [k: string]: unknown }
type Group = { matcher?: string; hooks?: Hook[]; [k: string]: unknown }
export type Settings = { hooks?: Record<string, Group[]>; permissions?: { allow?: string[]; [k: string]: unknown }; [k: string]: unknown }

const quote = (part: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`)
/** The command line Claude Code runs: this bun, this checkout's hook. */
export const hookCommand = (bun = process.execPath, entry = join(import.meta.dir, 'index.ts')) => `${quote(bun)} ${quote(entry)}`
const isOurs = (hook: Hook) => typeof hook.command === 'string' && hook.command.includes(HOOK_MARKER)

/** The groups this install owns, per event: the control hook, and on a prompt the catalog companions. */
export function learnerHooks(command: string, catalogParts = 5): Record<(typeof EVENTS)[number], Group> {
  const one = (suffix = ''): Hook => ({ type: 'command', command: command + suffix, timeout: TIMEOUT_SECONDS })
  const parts = Array.from({ length: catalogParts }, (_, n) => one(` --catalog-part ${n}`))
  return { SessionStart: { hooks: [one()] }, UserPromptSubmit: { hooks: [one(), ...parts] }, PostToolUse: { hooks: [one()] }, Stop: { hooks: [one()] } }
}

/** Every Learner hook taken out; other hooks, groups and settings untouched. */
export function withoutLearnerHooks(settings: Settings): Settings {
  if (!settings.hooks) return settings
  const hooks: Record<string, Group[]> = {}
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue }
    const kept = groups.map((group) => (Array.isArray(group.hooks) ? { ...group, hooks: group.hooks.filter((hook) => !isOurs(hook)) } : group))
      .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0)
    if (kept.length) hooks[event] = kept
  }
  const { hooks: _, ...rest } = settings
  return Object.keys(hooks).length ? { ...rest, hooks } : rest
}

/** Exactly one Learner group per event, whatever was there before (idempotent). */
export function withLearnerHooks(settings: Settings, command: string, catalogParts = 5): Settings {
  const clean = withoutLearnerHooks(settings)
  const hooks: Record<string, Group[]> = { ...(clean.hooks ?? {}) }
  for (const [event, group] of Object.entries(learnerHooks(command, catalogParts))) hooks[event] = [...(hooks[event] ?? []), group]
  return { ...clean, hooks }
}

/** The two commands the hook asks Claude to run, allowed without a prompt (the reply would otherwise stall on approval). */
export const learnerPermissions = (command: string) => [`Bash(${command} --submit*)`, `Bash(${command} --catalog*)`]
const isOurRule = (rule: unknown) => typeof rule === 'string' && rule.startsWith('Bash(') && rule.includes(HOOK_MARKER)
export function withoutLearnerPermissions(settings: Settings): Settings {
  const allow = settings.permissions?.allow
  if (!Array.isArray(allow) || !allow.some(isOurRule)) return settings
  const kept = allow.filter((rule) => !isOurRule(rule))
  const { allow: _, ...others } = settings.permissions!
  const permissions = kept.length ? { ...others, allow: kept } : others
  const { permissions: __, ...rest } = settings
  return Object.keys(permissions).length ? { ...rest, permissions } : rest
}
export function withLearnerPermissions(settings: Settings, command: string): Settings {
  const clean = withoutLearnerPermissions(settings)
  const allow = Array.isArray(clean.permissions?.allow) ? clean.permissions.allow : []
  return { ...clean, permissions: { ...clean.permissions, allow: [...allow, ...learnerPermissions(command)] } }
}

/** Which events run a Learner hook, and how many catalog companions a prompt runs. */
export function coverage(settings: Settings) {
  const ours = (event: string) => (settings.hooks?.[event] ?? []).flatMap((group) => (Array.isArray(group.hooks) ? group.hooks : [])).filter(isOurs)
  const events = Object.fromEntries(EVENTS.map((event) => [event, ours(event).some((hook) => !hook.command!.includes('--catalog-part'))])) as Record<(typeof EVENTS)[number], boolean>
  return { events, catalogParts: ours('UserPromptSubmit').filter((hook) => hook.command!.includes('--catalog-part')).length, installed: EVENTS.every((event) => events[event]) }
}

const readJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error })
  if (text === undefined) return undefined
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} is not a JSON object`)
  return value as Record<string, unknown>
}
/** Replace the file in one step; the first change keeps the original beside it. */
async function writeJson(path: string, value: unknown, before: unknown, mode?: number) {
  const next = JSON.stringify(value, null, 2) + '\n'
  if (before !== undefined && JSON.stringify(before, null, 2) + '\n' === next) return false
  await mkdir(dirname(path), { recursive: true })
  if (before !== undefined) await writeFile(`${path}.bak-learner`, JSON.stringify(before, null, 2) + '\n', { flag: 'wx', mode: 0o600 }).catch(() => undefined)
  // An existing file keeps its own permissions; a new one gets `mode`.
  const kept = await stat(path).then((s) => s.mode & 0o777, () => mode ?? 0o600)
  await writeFile(`${path}.learner-tmp`, next, { mode: kept })
  await chmod(`${path}.learner-tmp`, kept)
  await rename(`${path}.learner-tmp`, path)
  return true
}

const TOGGLES = {
  'learner-off.md': '---\ndescription: Turn Learning (learner) context and feedback OFF for this session only\n---\n<!-- learner-toggle:off -->\nThe Learning hook has switched Learner OFF for this session. Confirm in one short line and do nothing else.\n',
  'learner-on.md': '---\ndescription: Turn Learning (learner) context and feedback back ON for this session\n---\n<!-- learner-toggle:on -->\nThe Learning hook has switched Learner back ON for this session. Confirm in one short line and do nothing else.\n',
}

const flag = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const flags = (name: string) => process.argv.flatMap((arg, at) => (arg === name && process.argv[at + 1] ? [process.argv[at + 1]!] : []))

/** Does the server answer this machine's key? Never throws, never carries the key. */
async function serverStatus(): Promise<{ server: string; catalogPartsNeeded?: number }> {
  try {
    const catalog = await (await learner())('getLearningFeedbackCatalog', {}, { timeoutMs: 5000 })
    return { server: 'ok', catalogPartsNeeded: liveCatalogContexts(catalog.catalog, catalog.catalogVersion).length }
  } catch (error) {
    if (error instanceof RpcError) return { server: error.status === 401 || error.status === 403 ? `refused (HTTP ${error.status})` : `error (HTTP ${error.status})` }
    return { server: error instanceof Error && error.message === 'Learning credential unavailable' ? 'no credential' : 'unreachable' }
  }
}

export async function main() {
  const claudeDir = dirname(paths.config)
  const settingsPath = join(claudeDir, 'settings.json')
  const settings = (await readJson(settingsPath)) as Settings | undefined
  // The bun on PATH's own name, not the file it links to: /usr/bin/bun stays right across bun upgrades.
  const command = hookCommand(flag('--bun') ?? Bun.which('bun') ?? process.execPath)

  if (process.argv.includes('--check')) {
    const config = await readJson(paths.config).catch(() => undefined)
    // Judged against the command that is actually wired, not the one this run would choose.
    const wiredCommand = (settings?.hooks?.Stop ?? []).flatMap((group) => group.hooks ?? []).find(isOurs)?.command ?? command
    const wired = { ...coverage(settings ?? {}), permissions: learnerPermissions(wiredCommand).every((rule) => settings?.permissions?.allow?.includes(rule) ?? false) }
    const status = await serverStatus()
    const enough = status.catalogPartsNeeded === undefined || wired.catalogParts >= status.catalogPartsNeeded
    const ok = wired.installed && wired.permissions && Config.safeParse(config).success && status.server === 'ok' && enough
    process.stdout.write(JSON.stringify({ ok, settings: settingsPath, ...wired, config: Config.safeParse(config).success ? 'ok' : config ? 'invalid' : 'missing', ...status }) + '\n')
    process.exitCode = ok ? 0 : 1
    return
  }

  if (process.argv.includes('--uninstall')) {
    const changed = settings ? await writeJson(settingsPath, withoutLearnerPermissions(withoutLearnerHooks(settings)), settings) : false
    process.stdout.write(JSON.stringify({ uninstalled: true, changed, settings: settingsPath }) + '\n')
    return
  }

  const parts = Number(flag('--catalog-parts') ?? 5)
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > 12) throw new Error('--catalog-parts must be 1..12')
  const keyCommandJson = flag('--key-command-json')
  const keyCommand = keyCommandJson === undefined ? undefined : Config.shape.keyCommand.unwrap().parse(JSON.parse(keyCommandJson))
  const before = await readJson(paths.config)
  const config = Config.parse({
    foundationFirst: true, timeoutMs: 2500, liveFeedback: true, ...before,
    ...(flag('--server-url') ? { serverUrl: flag('--server-url') } : {}),
    ...(keyCommand ? { keyCommand } : {}), ...(flag('--key-file') ? { keyFile: flag('--key-file') } : {}),
    submitCommand: `${command} --submit`,
  })
  const wroteConfig = await writeJson(paths.config, config, before)
  await chmod(paths.config, 0o600)
  await mkdir(paths.traceDir, { recursive: true, mode: 0o700 })
  await mkdir(join(claudeDir, 'commands'), { recursive: true })
  for (const [name, text] of Object.entries(TOGGLES)) await writeFile(join(claudeDir, 'commands', name), text, { flag: 'wx' }).catch(() => undefined)
  const wroteSettings = await writeJson(settingsPath, withLearnerPermissions(withLearnerHooks(settings ?? {}, command, parts), command), settings, 0o644)
  const removedFrom: string[] = []
  for (const other of flags('--remove-from')) {
    const old = (await readJson(other)) as Settings | undefined
    if (old && other !== settingsPath && (await writeJson(other, withoutLearnerPermissions(withoutLearnerHooks(old)), old))) removedFrom.push(other)
  }
  process.stdout.write(JSON.stringify({ installed: true, settings: settingsPath, changed: wroteSettings || wroteConfig, removedFrom, command }) + '\n')
}

if (import.meta.main) {
  try { await main() } catch (error) {
    process.stderr.write(`learner hook install failed: ${error instanceof Error ? error.message : 'unknown error'}\n`)
    process.exitCode = 1
  }
}
