#!/usr/bin/env bun
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createLearnerClient } from '@learner/contract'
import { acquireLock, runUploader } from './uploader.js'

/**
 * learner-upload: captures this machine's Claude Code and Codex CLI sessions
 * on a remote Learner server.
 *
 *   index.ts --once                  one pass, then exit (cron, a tray "sync now")
 *   index.ts --watch [--interval s]  the service loop (launchd / systemd); the default
 *   index.ts --status                print status.json
 *
 * Settings: `$LEARNER_UPLOAD_CONFIG` (default `~/.learner/uploader.json`):
 *   { "serverUrl": "https://host/learner-api", "keyFile": "~/.learner/device-key.env", "clientId": "my-mac" }
 * `LEARNER_URL`, `LEARNER_API_KEY`, `LEARNER_CLIENT_ID`, `LEARNER_UPLOAD_STATE_DIR`,
 * `LEARNER_CLAUDE_ROOT` and `LEARNER_CODEX_ROOT` override it (`LEARNER_UPLOAD_CHUNK_BYTES`
 * lowers the chunk size, for tests). The key is a
 * device key (`mint-api-key.ts --device <clientId>`) whose clientId matches.
 */
const home = homedir()
const expand = (p: string) => (p.startsWith('~/') ? join(home, p.slice(2)) : p)
const Settings = z.object({
  serverUrl: z.string().url().optional(), keyFile: z.string().optional(), clientId: z.string().optional(),
  stateDir: z.string().optional(), claudeRoot: z.string().optional(), codexRoot: z.string().optional(),
})
const configPath = expand(process.env.LEARNER_UPLOAD_CONFIG ?? '~/.learner/uploader.json')
const settings = Settings.parse(await readFile(configPath, 'utf8').then(JSON.parse, () => ({})))
const stateDir = expand(process.env.LEARNER_UPLOAD_STATE_DIR ?? settings.stateDir ?? '~/.learner/uploader')
const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)

if (process.argv.includes('--status')) {
  console.log(await readFile(join(stateDir, 'status.json'), 'utf8').catch(() => '{"state":"never-run"}'))
  process.exit(0)
}

const fail = (message: string): never => { console.error(`learner-upload: ${message}`); process.exit(2) }
const serverUrl = process.env.LEARNER_URL ?? settings.serverUrl ?? fail(`no serverUrl (set it in ${configPath} or LEARNER_URL)`)
const clientId = process.env.LEARNER_CLIENT_ID ?? settings.clientId ?? fail(`no clientId (set it in ${configPath} or LEARNER_CLIENT_ID)`)
const apiKey = process.env.LEARNER_API_KEY ?? await (async () => {
  const keyFile = expand(settings.keyFile ?? '~/.learner/device-key.env')
  const text = await readFile(keyFile, 'utf8').catch(() => fail(`cannot read key file ${keyFile}`))
  return text.match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? fail(`no LEARNER_API_KEY= line in ${keyFile}`)
})()

const intervalSeconds = Number(arg('--interval') ?? 30)
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) fail(`--interval must be a number of seconds >= 1, got ${arg('--interval')}`)
const intervalMs = intervalSeconds * 1000

const release = await acquireLock(stateDir)
if (!release) { console.error(`learner-upload: another uploader holds ${stateDir}/uploader.lock`); process.exit(process.argv.includes('--once') ? 0 : 3) }
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort())

try {
  const status = await runUploader({
    rpc: createLearnerClient({ baseUrl: serverUrl.replace(/\/$/, ''), apiKey }),
    clientId, stateDir,
    roots: { claude: expand(process.env.LEARNER_CLAUDE_ROOT ?? settings.claudeRoot ?? '~/.claude/projects'), codex: expand(process.env.LEARNER_CODEX_ROOT ?? settings.codexRoot ?? '~/.codex/sessions') },
    ...(process.env.LEARNER_UPLOAD_CHUNK_BYTES ? { maxChunkBytes: Number(process.env.LEARNER_UPLOAD_CHUNK_BYTES) } : {}),
    intervalMs,
    once: process.argv.includes('--once'),
    signal: controller.signal,
    onStatus: (s) => { if (s.state !== 'syncing') console.error(`learner-upload: ${s.state} files=${s.files} pending=${s.pendingFiles}/${s.pendingBytes}B uploaded=${s.uploadedBytes}B healed=${s.healed} diverged=${s.diverged.length} failed=${s.failed.length}${s.lastError ? ` error=${s.lastError}` : ''}`) },
  })
  process.exitCode = status.state === 'ok' ? 0 : 1
} finally {
  await release()
}
