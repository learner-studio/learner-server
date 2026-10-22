// Preloaded only into the hook subprocesses of hook.test.ts: replaces the
// network so the installed entry point runs against an outage (default) or an
// injected HTTP status (LEARNER_HOOK_TEST_HTTP_STATUS). Never imported by the hook.
// LEARNER_HOOK_TEST_REQUEST_LOG names a file that gets one `<rpc> <body>` line per request.
import { appendFileSync } from 'node:fs'

if (!process.env.LEARNER_HOOK_TRACE_DIR?.includes('learner-hook-test-')) throw new Error('hook network preload outside an isolated test directory')
const status = Number(process.env.LEARNER_HOOK_TEST_HTTP_STATUS ?? 0)
const requestLog = process.env.LEARNER_HOOK_TEST_REQUEST_LOG
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (requestLog) appendFileSync(requestLog, `${String(input instanceof Request ? input.url : input).split('/rpc/')[1]} ${String(init?.body ?? '')}\n`)
  if (status) return new Response(status < 300 ? '{"recorded":true}' : '{"message":"injected"}', { status, headers: { 'content-type': 'application/json' } })
  throw new DOMException('Injected API outage', 'TimeoutError')
}) as unknown as typeof fetch
