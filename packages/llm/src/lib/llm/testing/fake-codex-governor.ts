#!/usr/bin/env bun
// A fake `codex exec --json` for the CLI governor tests (CODEX_CLI_BIN). FAKE_CODEX_MODE=429 prints Codex's real
// rate-limit failure and exits 1. Otherwise it records its start and end times (ms) as one line in
// $FAKE_CODEX_SPANS, after sleeping $FAKE_CODEX_SLEEP_MS, and answers `{"ok":true}`.
import { appendFileSync } from 'node:fs'
await new Response(Bun.stdin.stream()).text()
if (process.env.FAKE_CODEX_MODE === '429') {
  process.stdout.write(`${JSON.stringify({ type: 'error', message: 'exceeded retry limit, last status: 429 Too Many Requests' })}\n`)
  process.stderr.write('ERROR: exceeded retry limit, last status: 429 Too Many Requests\n')
  process.exit(1)
}
const start = Date.now()
await Bun.sleep(Number(process.env.FAKE_CODEX_SLEEP_MS ?? 0))
if (process.env.FAKE_CODEX_SPANS) appendFileSync(process.env.FAKE_CODEX_SPANS, `${start} ${Date.now()}\n`)
process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fake' })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '{"ok":true}' } })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } })}\n`)
