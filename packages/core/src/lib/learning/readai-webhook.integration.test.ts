import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { z } from 'zod'
import { READAI_WEBHOOK_TEST_PAYLOAD, type DesktopCallTranscript } from '@learner/contract'
import { metaDbQuery } from '../db-metadata/_shared.js'
import { callRecord, readAiSpeech } from './call-ingest.js'
import { ingestCalls, saveCallIdentity, type CallPipelineDeps } from './call-pipeline.js'
import { clearReadAiWebhook, loadReadAiWebhook, READAI_WEBHOOK_CLIENT_ID, ReadAiWebhookRejected, receiveReadAiDelivery, saveReadAiWebhook, verifyReadAiWebhookToken } from './readai-webhook.js'
import { lockCallTables } from './call-tables-test-lock.js'

// The Read AI webhook on learner_test with the shared fixture meeting: the token, a
// test delivery, a real one through the call pipeline, and the same meeting from biztools.
describe.skipIf(!process.env.TEST_DATABASE_URL)('Read AI webhook (learner_test)', () => {
  const TOKEN = 'test-token-aaaaaaaaaaaaaaaaaaaaaaaa'
  let stored: Map<string, z.infer<typeof DesktopCallTranscript> & { metadata: Record<string, unknown> }>
  let root: string
  const deps = (): CallPipelineDeps => ({
    uploadRoot: root,
    habits: {
      // Like the real store, the writing client is part of the row (metadata.client_id), so a
      // resend under a different client than the stored one is an update, never 'unchanged'.
      recordCallTranscripts: async (clientId, calls) => {
        let accepted = 0, updated = 0, unchanged = 0
        for (const c of calls) {
          const row = { ...c, metadata: { ...c.metadata, client_id: clientId } }
          const held = stored.get(c.sessionId)
          if (!held) accepted++; else if (JSON.stringify(held) === JSON.stringify(row)) unchanged++; else updated++
          stored.set(c.sessionId, row)
        }
        return { accepted, updated, unchanged }
      },
      callsStartingNear: async () => [],
    },
  })
  const spool = (clientId: string) => readdir(join(root, 'desktop', clientId, 'call')).catch(() => [] as string[])
  const clean = async () => {
    await metaDbQuery(`DELETE FROM learning_readai_webhook`)
    await metaDbQuery(`DELETE FROM learning_call_speech`)
    await metaDbQuery(`DELETE FROM learning_call_identity`)
  }
  beforeEach(async () => {
    await clean()
    stored = new Map()
    root = await mkdtemp(join(tmpdir(), 'readai-webhook-'))
    await saveCallIdentity({ names: ['Test Learner'], emails: [] }, 'test')
  })
  let unlock: () => Promise<void>
  beforeAll(async () => { unlock = await lockCallTables() })
  afterAll(async () => { await clean(); await unlock() })

  test('no token configured refuses every delivery', async () => {
    expect(await verifyReadAiWebhookToken(TOKEN)).toBe(false)
    expect(receiveReadAiDelivery(deps(), TOKEN, READAI_WEBHOOK_TEST_PAYLOAD, true)).rejects.toBeInstanceOf(ReadAiWebhookRejected)
    expect(await loadReadAiWebhook()).toEqual({ configured: false, tokenHint: null, updatedAt: null, lastDelivery: null })
  })

  test('only the hash is stored; a replaced token stops working and clears the history', async () => {
    const status = await saveReadAiWebhook(TOKEN, 'tester')
    expect(status).toMatchObject({ configured: true, tokenHint: 'aaaa', lastDelivery: null })
    const row = (await metaDbQuery<Record<string, unknown>>(`SELECT * FROM learning_readai_webhook`)).rows[0]!
    expect(JSON.stringify(row)).not.toContain(TOKEN)
    expect(await verifyReadAiWebhookToken(TOKEN)).toBe(true)
    expect(await verifyReadAiWebhookToken(`${TOKEN}b`)).toBe(false)
    await receiveReadAiDelivery(deps(), TOKEN, READAI_WEBHOOK_TEST_PAYLOAD, true)
    expect((await loadReadAiWebhook()).lastDelivery).not.toBeNull()
    await saveReadAiWebhook('replacement-token-bbbbbbbbbbbbbbbb', 'tester')
    expect(await verifyReadAiWebhookToken(TOKEN)).toBe(false)
    expect((await loadReadAiWebhook()).lastDelivery).toBeNull()
    expect(saveReadAiWebhook('short', 'tester')).rejects.toThrow()
    expect((await clearReadAiWebhook()).configured).toBe(false)
  })

  test('a test delivery checks token and payload end to end and stores nothing', async () => {
    await saveReadAiWebhook(TOKEN, 'tester')
    const delivery = await receiveReadAiDelivery(deps(), TOKEN, READAI_WEBHOOK_TEST_PAYLOAD, true)
    expect(delivery).toMatchObject({ test: true, outcome: 'test-ok', sessionId: 'learner-webhook-test', title: 'Learner webhook test', lines: 2 })
    expect(stored.size).toBe(0)
    expect((await metaDbQuery(`SELECT 1 FROM learning_call_speech`)).rows).toHaveLength(0)
    expect(await spool(READAI_WEBHOOK_CLIENT_ID)).toEqual([])
    expect((await loadReadAiWebhook()).lastDelivery).toMatchObject({ test: true, outcome: 'test-ok' })
    expect(receiveReadAiDelivery(deps(), TOKEN, { title: 'no session id' }, true)).rejects.toThrow()
  })

  test('a real delivery is stored and graded once; a resend is unchanged', async () => {
    await saveReadAiWebhook(TOKEN, 'tester')
    expect(await receiveReadAiDelivery(deps(), TOKEN, READAI_WEBHOOK_TEST_PAYLOAD, false)).toMatchObject({ outcome: 'stored', graded: true, lines: 2 })
    expect([...stored.keys()]).toEqual(['learner-webhook-test'])
    expect(await spool(READAI_WEBHOOK_CLIENT_ID)).toHaveLength(1)
    expect(await receiveReadAiDelivery(deps(), TOKEN, READAI_WEBHOOK_TEST_PAYLOAD, false)).toMatchObject({ outcome: 'unchanged' })
    expect(await spool(READAI_WEBHOOK_CLIENT_ID)).toHaveLength(1)
  })

  test('a meeting biztools already forwarded is not spooled a second time under the webhook', async () => {
    await saveReadAiWebhook(TOKEN, 'tester')
    await ingestCalls(deps(), 'biztools', [callRecord('readai', readAiSpeech(READAI_WEBHOOK_TEST_PAYLOAD))])
    expect(await spool('biztools')).toHaveLength(1)
    expect(await receiveReadAiDelivery(deps(), TOKEN, READAI_WEBHOOK_TEST_PAYLOAD, false)).toMatchObject({ outcome: 'unchanged' })
    expect(await spool(READAI_WEBHOOK_CLIENT_ID)).toEqual([])
    expect(await spool('biztools')).toHaveLength(1)
    expect((await metaDbQuery<{ client_id: string }>(`SELECT client_id FROM learning_call_speech`)).rows).toEqual([{ client_id: 'biztools' }])
  })

  test('biztools and the webhook delivering one meeting at the same moment spool and store it once', async () => {
    await saveReadAiWebhook(TOKEN, 'tester')
    // Hold both deliveries after their read of the speech row, so each sees no row
    // before either inserts: the race a simultaneous Read.ai + biztools delivery makes.
    let arrived = 0, release!: () => void
    const bothRead = new Promise<void>((resolve) => { release = resolve })
    const racing: typeof metaDbQuery = (async (text: string, params?: unknown[]) => {
      const result = await metaDbQuery(text, params as never)
      if (text.startsWith('SELECT * FROM learning_call_speech WHERE session_id')) { if (++arrived === 2) release(); await bothRead }
      return result
    }) as typeof metaDbQuery
    const raced = (): CallPipelineDeps => ({ ...deps(), query: racing })
    const [, delivery] = await Promise.all([
      ingestCalls(raced(), 'biztools', [callRecord('readai', readAiSpeech(READAI_WEBHOOK_TEST_PAYLOAD))]),
      receiveReadAiDelivery(raced(), TOKEN, READAI_WEBHOOK_TEST_PAYLOAD, false),
    ])
    expect(arrived).toBe(2)
    const owner = (await metaDbQuery<{ client_id: string }>(`SELECT client_id FROM learning_call_speech`)).rows[0]!.client_id
    const other = owner === 'biztools' ? READAI_WEBHOOK_CLIENT_ID : 'biztools'
    expect(await spool(owner)).toHaveLength(1)
    expect(await spool(other)).toEqual([])
    expect(stored.get('learner-webhook-test')!.metadata.client_id).toBe(owner)
    expect(['stored', 'unchanged']).toContain(delivery.outcome)
  })
})
