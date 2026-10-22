import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LearningArchiveSpool } from './spool.js'

const temporary: string[] = []
const fixture = async () => {
  const path = await mkdtemp(join(tmpdir(), 'openclaw-learning-archive-'))
  temporary.push(path)
  return path
}
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

const makeSpool = async (materializeRemote?: ConstructorParameters<typeof LearningArchiveSpool>[1]) => {
  const base = await fixture()
  const approved = join(base, 'approved')
  const spoolRoot = join(base, 'spool')
  await mkdir(approved)
  const spool = new LearningArchiveSpool({ spoolRoot, approvedLocalRoots: [approved], maxMediaBytes: 1024 * 1024,
    maxRawPayloadBytes: 64 * 1024 }, materializeRemote)
  await spool.initialize()
  return { base, approved, spoolRoot, spool }
}

describe('OpenClaw learning archive spool', () => {
  test('captures exact local media once by content hash with private spool permissions', async () => {
    const { approved, spoolRoot, spool } = await makeSpool()
    const bytes = Buffer.from([0, 255, 1, 2, 3])
    const path = join(approved, 'image.png')
    await writeFile(path, bytes)
    const first = await spool.captureMedia({ path, contentType: 'image/png', kind: 'image' }, 0, 'staged')
    const second = await spool.captureMedia({ path, contentType: 'image/png', kind: 'image' }, 1, 'original')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    expect(first).toEqual({ part: { ordinal: 0, type: 'media', role: 'staged', mimeType: 'image/png', mediaKind: 'image',
      captureStatus: 'captured', sha256, byteLength: bytes.byteLength, spoolRelativePath: `blobs/${sha256}` }, gaps: [] })
    expect(second.part.sha256).toBe(sha256)
    expect(await readFile(join(spoolRoot, 'blobs', sha256))).toEqual(bytes)
    expect((await stat(spoolRoot)).mode & 0o777).toBe(0o700)
    expect((await stat(join(spoolRoot, 'blobs', sha256))).mode & 0o777).toBe(0o600)
    expect((await readdir(join(spoolRoot, 'blobs')))).toEqual([sha256])
    const observation = await spool.persist({ hook: 'message_received', direction: 'user_to_model', stage: 'received',
      authorship: 'unknown', visibility: 'intended', logicalMessageKey: null,
      correlation: spool.extractCorrelation({ messageId: 'message' }, { channelId: 'discord' }),
      parts: [first.part], gaps: [], event: { media: [{ path }] }, context: {} })
    expect(JSON.parse(await readFile(join(spoolRoot, 'events', `${observation.observationId}.json`), 'utf8'))).toMatchObject({
      observationId: observation.observationId, parts: [{ sha256 }],
    })
  })

  test('refuses local traversal and symlinks without leaking their paths in gap details', async () => {
    const { base, approved, spool } = await makeSpool()
    const outside = join(base, 'outside.txt')
    const link = join(approved, 'link.txt')
    await writeFile(outside, 'secret')
    await symlink(outside, link)
    const escaped = await spool.captureMedia({ path: outside }, 0, 'original')
    const linked = await spool.captureMedia({ path: link }, 1, 'original')
    expect(escaped.part).toMatchObject({ captureStatus: 'refused', gapCode: 'media-outside-approved-roots' })
    expect(linked.part).toMatchObject({ captureStatus: 'refused', gapCode: 'media-capture-failed' })
    expect(JSON.stringify([escaped.gaps, linked.gaps])).not.toContain(base)
  })

  test('materializes only exact HTTPS Discord CDN URLs through the injected guarded loader', async () => {
    const remoteRoot = await fixture()
    const remote = join(remoteRoot, 'remote.png')
    await writeFile(remote, 'remote-original')
    const calls: string[] = []
    const { spool } = await makeSpool(async (url, maxBytes) => {
      calls.push(`${url}|${maxBytes}`)
      return { path: remote, size: 15, contentType: 'image/png' }
    })
    const accepted = await spool.captureMedia({ url: 'https://cdn.discordapp.com/attachments/1/2/image.png?ex=abc' }, 0, 'original')
    const refused = await spool.captureMedia({ url: 'https://example.test/attachment.png' }, 1, 'original')
    expect(accepted.part).toMatchObject({ captureStatus: 'captured', byteLength: 15 })
    expect(refused.part).toMatchObject({ captureStatus: 'refused', gapCode: 'remote-media-host-refused' })
    expect(calls).toEqual(['https://cdn.discordapp.com/attachments/1/2/image.png?ex=abc|1048576'])
  })

  test('decodes bounded base64 and data URL media into verified content-addressed blobs', async () => {
    const { spool, spoolRoot } = await makeSpool()
    const bytes = Buffer.from([9, 8, 7, 6])
    const base64 = bytes.toString('base64')
    const direct = await spool.captureMedia({ base64Data: base64, contentType: 'application/octet-stream', kind: 'file' }, 0, 'model-output')
    const dataUrl = await spool.captureMedia({ url: `data:image/png;base64,${base64}`, kind: 'image' }, 1, 'delivery')
    const malformed = await spool.captureMedia({ base64Data: '%%%' }, 2, 'delivery')
    expect(direct.part).toMatchObject({ captureStatus: 'captured', byteLength: 4, mimeType: 'application/octet-stream', mediaKind: 'file' })
    expect(dataUrl.part).toMatchObject({ captureStatus: 'captured', byteLength: 4, mimeType: 'image/png', mediaKind: 'image' })
    expect(dataUrl.part.sha256).toBe(direct.part.sha256)
    expect(await readFile(join(spoolRoot, dataUrl.part.spoolRelativePath!))).toEqual(bytes)
    expect(malformed.part).toMatchObject({ captureStatus: 'refused', gapCode: 'media-capture-failed' })
  })

  test('uses explicit Discord message identity and persists run correlation across restart', async () => {
    const { approved, spoolRoot, spool } = await makeSpool()
    const correlation = { channelId: 'discord', accountId: 'acct', conversationId: 'chat', messageId: 'message',
      providerUpdateId: 'edit-2', runId: 'run-1', sessionKey: 'session', agentId: 'main' }
    const logical = spool.logicalMessageKey(correlation)
    expect(logical).toBe('discord:acct:chat:message')
    await spool.saveRunLink('run-1', logical!, correlation)
    const restarted = new LearningArchiveSpool({ spoolRoot, approvedLocalRoots: [approved] })
    await restarted.initialize()
    expect(await restarted.loadRunLink('run-1')).toMatchObject({ logicalMessageKey: logical, correlation })
    await restarted.saveRunLink('run-1', logical!, { codexTurnId: 'turn-9', sessionName: 'Main chat' })
    expect(await spool.loadRunLink('run-1')).toMatchObject({ correlation: { ...correlation, codexTurnId: 'turn-9', sessionName: 'Main chat' } })
  })

  test('persists exact run-linked agent delivery evidence across restart without creating message identity', async () => {
    const { approved, spoolRoot, spool } = await makeSpool()
    expect(await spool.hasAgentDeliveryRun('delivery-run')).toBe(false)
    await spool.markAgentDeliveryRun('delivery-run')
    expect(await spool.hasAgentDeliveryRun('delivery-run')).toBe(true)
    expect(await spool.hasAgentDeliveryRun('different-run')).toBe(false)

    const restarted = new LearningArchiveSpool({ spoolRoot, approvedLocalRoots: [approved] })
    await restarted.initialize()
    expect(await restarted.hasAgentDeliveryRun('delivery-run')).toBe(true)
    expect(restarted.logicalMessageKey({ channelId: 'discord', accountId: 'account', conversationId: 'chat' })).toBeNull()
  })

  test('preserves available Discord and OpenClaw names and does not confuse agent channel targets with providers', async () => {
    const { spool } = await makeSpool()
    expect(spool.extractCorrelation({ runId: 'run', sessionId: 'session-id' }, {
      messageProvider: 'discord', channelId: 'conversation-9', accountId: 'account', sessionKey: 'session-key',
      agentId: 'main', agentName: 'Main agent', sessionName: 'Primary chat',
      channelContext: { sender: { id: 'sender', name: 'Human', username: 'human-name', isBot: false, isWebhook: false }, chat: { id: 'chat', name: 'Chat name' } },
    })).toEqual({
      channelId: 'discord', accountId: 'account', conversationId: 'conversation-9', chatId: 'chat', chatName: 'Chat name',
      senderId: 'sender', senderName: 'Human', senderUsername: 'human-name', senderIsBot: false, senderIsWebhook: false,
      runId: 'run', sessionKey: 'session-key', sessionId: 'session-id', sessionName: 'Primary chat', agentId: 'main', agentName: 'Main agent',
    })
    expect(spool.extractCorrelation({ messageId: 'message', threadId: 42, metadata: {
      channelName: 'general', guildId: 'guild', topicName: 'Thread topic', senderName: 'Name', senderUsername: 'user',
    } }, { channelId: 'discord', conversationId: 'conversation' })).toMatchObject({
      channelId: 'discord', conversationId: 'conversation', messageId: 'message', threadId: '42', threadName: 'Thread topic',
      channelName: 'general', conversationName: 'general', guildId: 'guild', senderName: 'Name', senderUsername: 'user',
    })
  })

  test('retains repeated hook dispatches while giving each immutable file a stable import key', async () => {
    const { spool, spoolRoot } = await makeSpool()
    const base = { hook: 'message_received' as const, direction: 'user_to_model' as const, stage: 'received' as const,
      authorship: 'unknown' as const, visibility: 'intended' as const, logicalMessageKey: 'discord:a:c:m', correlation: {},
      parts: [], gaps: [], event: { messageId: 'm', content: 'one' }, context: {}, }
    const first = await spool.persist(base)
    const replay = await spool.persist(base)
    const changed = await spool.persist({ ...base, event: { messageId: 'm', content: 'two' } })
    expect(replay.observationId).not.toBe(first.observationId)
    expect(changed.observationId).not.toBe(first.observationId)
    expect(first.dedupeKey).toBe(first.observationId)
    expect(await readdir(join(spoolRoot, 'events'))).toHaveLength(3)
  })

  test('replays deterministic historical observations idempotently and rejects source-key collisions', async () => {
    const { spool, spoolRoot } = await makeSpool()
    const input = { hook: 'gap' as const, direction: 'internal' as const, stage: 'gap' as const,
      authorship: 'unknown' as const, visibility: 'internal' as const, logicalMessageKey: null, correlation: {},
      parts: [], gaps: [], event: { source: 'history' }, context: {}, sourceDedupeKey: 'history:session:1:event',
      observedAt: '2026-09-05T12:00:00.000Z' }
    const first = await spool.persist(input)
    const replay = await spool.persist(input)
    expect(replay).toEqual(first)
    expect(first.dedupeKey).toBe('history:session:1:event')
    expect(await readdir(join(spoolRoot, 'events'))).toHaveLength(1)
    await expect(spool.persist({ ...input, event: { source: 'changed-history' } })).rejects.toThrow('source key collision')
  })

  test('bounds and redacts raw hook payloads with explicit fidelity gaps', async () => {
    const { spool, spoolRoot } = await makeSpool()
    const observation = await spool.persist({ hook: 'gap', direction: 'unknown', stage: 'gap', authorship: 'unknown',
      visibility: 'internal', logicalMessageKey: null, correlation: {}, parts: [], gaps: [],
      event: { authorization: 'do-not-store', nested: { value: 'x'.repeat(80_000) } }, context: {},
    })
    expect(observation.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining(['raw-sensitive-field-redacted', 'raw-payload-truncated']))
    const files = await readdir(join(spoolRoot, 'events'))
    const stored = await readFile(join(spoolRoot, 'events', files[0]!), 'utf8')
    expect(stored).not.toContain('do-not-store')
    expect(stored).toContain('raw-sensitive-field-redacted')
  })

  test('refuses a spool that overlaps an approved source root', async () => {
    const root = await fixture()
    const approved = join(root, 'approved')
    await mkdir(approved)
    const spool = new LearningArchiveSpool({ spoolRoot: join(approved, 'spool'), approvedLocalRoots: [approved] })
    await expect(spool.initialize()).rejects.toThrow('must not overlap')
  })
})
