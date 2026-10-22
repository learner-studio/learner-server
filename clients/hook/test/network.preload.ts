// Preloaded only into the hook subprocesses of hook.test.ts: replaces the
// network so the installed entry point runs against an outage (default) or an
// injected HTTP status (LEARNER_HOOK_TEST_HTTP_STATUS). Never imported by the hook.
if (!process.env.LEARNER_HOOK_TRACE_DIR?.includes('learner-hook-test-')) throw new Error('hook network preload outside an isolated test directory')
const status = Number(process.env.LEARNER_HOOK_TEST_HTTP_STATUS ?? 0)
globalThis.fetch = (async () => {
  if (status) return new Response('{"message":"injected"}', { status, headers: { 'content-type': 'application/json' } })
  throw new DOMException('Injected API outage', 'TimeoutError')
}) as unknown as typeof fetch
