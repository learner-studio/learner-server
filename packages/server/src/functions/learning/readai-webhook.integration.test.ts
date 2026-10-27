import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { READAI_WEBHOOK_TEST_HEADER, READAI_WEBHOOK_TEST_PAYLOAD } from '@learner/contract'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { saveReadAiWebhook } from '@learner/core/lib/learning/readai-webhook.js'
import { BadRequestError, UnauthorizedError } from '@learner/core/runtime/errors.js'
import { receiveReadAiWebhook } from './readai-webhook.function.js'
import { lockCallTables } from '@learner/core/lib/learning/call-tables-test-lock.js'

// The webhook function as a route calls it: the route merges query, body and path
// params into `input`, so the token must come from the path alone, and the test
// header is the only switch into a test delivery.
describe.skipIf(!process.env.TEST_DATABASE_URL)('receiveReadAiWebhook (learner_test)', () => {
  const TOKEN = 'route-token-aaaaaaaaaaaaaaaaaaaaaaaa'
  let root: string
  const services = () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    config: { transcriptUploadRoot: root },
    learnerDesktopHabits: () => ({ recordCallTranscripts: async () => ({ accepted: 1, updated: 0, unchanged: 0 }), callsStartingNear: async () => [] }),
  }) as never
  const http = (token: string, headers: Record<string, string> = {}) => ({ request: { params: () => ({ token }), header: (name: string) => headers[name] } })
  const call = (input: Record<string, unknown>, token: string, headers?: Record<string, string>) =>
    receiveReadAiWebhook.func(services(), input, { http: http(token, headers) } as never)
  const clean = async () => {
    await metaDbQuery(`DELETE FROM learning_readai_webhook`)
    await metaDbQuery(`DELETE FROM learning_call_speech`)
  }
  beforeEach(async () => { await clean(); root = await mkdtemp(join(tmpdir(), 'readai-route-')); await saveReadAiWebhook(TOKEN, 'tester') })
  let unlock: () => Promise<void>
  beforeAll(async () => { unlock = await lockCallTables() })
  afterAll(async () => { await clean(); await unlock() })

  test('the token is read from the path, never from the merged body or query', async () => {
    expect(call({ ...READAI_WEBHOOK_TEST_PAYLOAD, token: TOKEN }, 'wrong-token-bbbbbbbbbbbbbbbbbbbbbbb', { [READAI_WEBHOOK_TEST_HEADER]: '1' })).rejects.toBeInstanceOf(UnauthorizedError)
    expect(call({ ...READAI_WEBHOOK_TEST_PAYLOAD }, '', { [READAI_WEBHOOK_TEST_HEADER]: '1' })).rejects.toBeInstanceOf(UnauthorizedError)
    // The merged path param is stripped before the payload is parsed, and the delivery goes through.
    expect(await call({ ...READAI_WEBHOOK_TEST_PAYLOAD, token: TOKEN }, TOKEN, { [READAI_WEBHOOK_TEST_HEADER]: '1' })).toEqual({ ok: true, test: true, sessionId: 'learner-webhook-test', outcome: 'test-ok' })
  })

  test('only the test header makes a test; without it the meeting is stored', async () => {
    expect(await call({ ...READAI_WEBHOOK_TEST_PAYLOAD, test: '1' }, TOKEN)).toMatchObject({ test: false, outcome: 'stored' })
    expect((await metaDbQuery(`SELECT 1 FROM learning_call_speech WHERE session_id = 'learner-webhook-test'`)).rows).toHaveLength(1)
  })

  test('a body that is not a Read.ai meeting is a 400, after the token is checked', async () => {
    expect(call({ title: 'no session' }, TOKEN)).rejects.toBeInstanceOf(BadRequestError)
    expect(call({ title: 'no session' }, 'wrong-token-bbbbbbbbbbbbbbbbbbbbbbb')).rejects.toBeInstanceOf(UnauthorizedError)
  })
})
