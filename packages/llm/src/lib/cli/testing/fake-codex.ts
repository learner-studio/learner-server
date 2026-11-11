#!/usr/bin/env bun
// A fake `codex exec --json` for restart-safety tests (CODEX_CLI_BIN). It counts its invocations in
// $FAKE_CODEX_COUNT (one line each, written BEFORE it answers: a paid call), sleeps $FAKE_CODEX_SLEEP_MS, and
// answers $FAKE_CODEX_ANSWER (default `{"ok":true}`) as one item.completed event. The prompt arrives on stdin.
import { appendFileSync } from 'node:fs'
const prompt = await new Response(Bun.stdin.stream()).text()
if (process.env.FAKE_CODEX_COUNT) appendFileSync(process.env.FAKE_CODEX_COUNT, `${process.pid} ${prompt.length}\n`)
await Bun.sleep(Number(process.env.FAKE_CODEX_SLEEP_MS ?? 0))
const answer = process.env.FAKE_CODEX_ANSWER ?? '{"ok":true}'
process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fake' })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: answer } })}\n`)
process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } })}\n`)
