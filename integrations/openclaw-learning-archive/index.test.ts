import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('openclaw/plugin-sdk/plugin-entry', () => ({ definePluginEntry: <T>(entry: T) => entry }))
mock.module('openclaw/plugin-sdk/media-store', () => ({ saveMediaSource: async () => { throw new Error('unexpected remote retrieval') } }))

const temporary: string[] = []
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('OpenClaw learning archive plugin hooks', () => {
  test('observes canonical inbound, embedded output, attachment delivery, and terminal receipt without dispatching or mutating payloads', async () => {
    const base = await mkdtemp(join(tmpdir(), 'openclaw-learning-plugin-'))
    temporary.push(base)
    const approved = join(base, 'approved')
    const spoolRoot = join(base, 'spool')
    await mkdir(approved)
    const localDelivery = join(approved, 'answer.bin')
    await writeFile(localDelivery, Buffer.from([4, 5, 6]))

    const handlers = new Map<string, (event: any, context: any) => unknown>()
    const logs: string[] = []
    const api = {
      pluginConfig: { spoolRoot, approvedLocalRoots: [approved], humanSenderIds: ['confirmed-human'], maxMediaBytes: 1024 * 1024, maxRawPayloadBytes: 64 * 1024 },
      logger: { error: (message: string) => logs.push(message) },
      on: (name: string, handler: (event: any, context: any) => unknown) => { handlers.set(name, handler) },
    }
    const plugin = (await import('./index.js')).default as { register(api: typeof api): void }
    plugin.register(api)
    expect([...handlers.keys()].sort()).toEqual(['before_agent_finalize', 'gateway_stop', 'llm_input', 'llm_output', 'message_received', 'message_sent', 'reply_payload_sending'].sort())

    const inbound = { content: 'hello', messageId: 'message-1', senderId: 'confirmed-human', metadata: { channelName: 'general', guildId: 'guild-1' } }
    const inboundBefore = structuredClone(inbound)
    await handlers.get('message_received')!(inbound, { channelId: 'discord', accountId: 'account-1', conversationId: 'channel-1', agentId: 'main' })
    expect(inbound).toEqual(inboundBefore)

    await handlers.get('llm_input')!({ runId: 'run-1', sessionId: 'session-1', prompt: 'normalized model prompt', imagesCount: 0 },
      { runId: 'run-1', messageProvider: 'discord', channelId: 'channel-1', accountId: 'account-1' })
    await handlers.get('before_agent_finalize')!({ runId: 'run-1', sessionId: 'session-1', turnId: 'codex-turn-1', messages: [
      { role: 'user', content: 'hello', __openclaw: { mirrorIdentity: 'codex-turn-1:prompt', transport: { channel: 'discord', messageId: 'message-1' } } },
    ] }, { runId: 'run-1', messageProvider: 'discord', channelId: 'channel-1', accountId: 'account-1' })

    const embedded = Buffer.from([1, 2, 3]).toString('base64')
    const output = { runId: 'run-1', assistantTexts: ['answer'], lastAssistant: { contentParts: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: embedded } },
    ] } }
    await handlers.get('llm_output')!(output, { messageProvider: 'discord', channelId: 'channel-1', accountId: 'account-1' })

    const attempt = { kind: 'final', runId: 'run-1', payload: { text: 'answer', mediaUrls: [localDelivery, `data:audio/ogg;base64,${embedded}`],
      attachments: [{ type: 'file', path: localDelivery, mimeType: 'application/octet-stream' }, { type: 'audio', mimeType: 'audio/ogg' }] } }
    const attemptBefore = structuredClone(attempt)
    await handlers.get('reply_payload_sending')!(attempt, { messageProvider: 'discord', channelId: 'channel-1', accountId: 'account-1' })
    expect(attempt).toEqual(attemptBefore)
    await handlers.get('message_sent')!({ success: true, content: 'answer', runId: 'run-1', messageId: 'discord-answer-1' },
      { messageProvider: 'discord', channelId: 'channel-1', accountId: 'account-1' })
    await handlers.get('gateway_stop')!({}, {})

    expect(logs).toEqual([])
    const eventNames = await readdir(join(spoolRoot, 'events'))
    expect(eventNames).toHaveLength(7)
    const observations = await Promise.all(eventNames.map(async (name) => JSON.parse(await readFile(join(spoolRoot, 'events', name), 'utf8'))))
    expect(observations.find((row) => row.hook === 'message_received')).toMatchObject({
      authorship: 'human', logicalMessageKey: 'discord:account-1:channel-1:message-1',
      correlation: { authorshipEvidence: 'operator-configured-human-sender-id', channelName: 'general', guildId: 'guild-1' },
    })
    expect(observations.find((row) => row.hook === 'llm_output').parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'media', role: 'model-output', captureStatus: 'captured', mimeType: 'image/png', byteLength: 3 }),
    ]))
    expect(observations.find((row) => row.hook === 'before_agent_finalize')).toMatchObject({
      correlation: { messageId: 'message-1', runId: 'run-1', codexTurnId: 'codex-turn-1' },
    })
    expect(observations.find((row) => row.hook === 'handoff_correlation')).toMatchObject({
      direction: 'user_to_model', stage: 'finalizing', authorship: 'unknown', visibility: 'internal',
      logicalMessageKey: 'discord:account-1:channel-1:message-1', parts: [],
      correlation: { messageId: 'message-1', runId: 'run-1', codexTurnId: 'codex-turn-1' },
      raw: { event: { receiptKind: 'codex-finalization-transport', runId: 'run-1', turnId: 'codex-turn-1', messageId: 'message-1' } },
    })
    expect(observations.find((row) => row.hook === 'llm_output')).toMatchObject({
      correlation: { messageId: 'message-1', runId: 'run-1', codexTurnId: 'codex-turn-1' },
    })
    expect(observations.find((row) => row.hook === 'reply_payload_sending')).toMatchObject({ stage: 'delivery_attempt', authorship: 'unknown', visibility: 'intended' })
    expect(observations.find((row) => row.hook === 'reply_payload_sending').parts.filter((part: any) => part.type === 'media')).toHaveLength(2)
    expect(observations.find((row) => row.hook === 'message_sent')).toMatchObject({
      stage: 'delivered', authorship: 'agent', visibility: 'delivered', logicalMessageKey: 'discord-output:account-1:channel-1:discord-answer-1',
    })
  })
})
