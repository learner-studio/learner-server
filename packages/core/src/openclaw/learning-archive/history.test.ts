import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { drainOpenClawTranscriptHistory } from './history.js'
import { LearningArchiveSpool } from './spool.js'

const temporary: string[] = []
afterEach(async () => Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('OpenClaw historical transcript drain', () => {
  test('pages read-only rows, preserves exact parent/native identity, verifies original/staged parity, and replays idempotently', async () => {
    const base = await mkdtemp(join(tmpdir(), 'openclaw-history-'))
    temporary.push(base)
    const nativeInbound = join(base, 'native', 'media', 'inbound')
    const originalInbound = join(base, 'openclaw', 'media', 'inbound')
    const stagingId = 'c6bfcdf0-6139-4f7e-b5be-207a26d98a43'
    const producerName = 'image---0da6a8f5-0820-451e-b7d2-1dfbf53478c4.png'
    const stagedDirectory = join(nativeInbound, `openclaw-staged-${stagingId}`)
    await mkdir(stagedDirectory, { recursive: true })
    await mkdir(originalInbound, { recursive: true })
    const bytes = Buffer.from('owned screenshot bytes')
    const stagedPath = join(stagedDirectory, `input-${producerName}`)
    await writeFile(stagedPath, bytes)
    await writeFile(join(originalInbound, producerName), bytes)

    const databasePath = join(base, 'history.sqlite')
    const database = new Database(databasePath, { create: true, strict: true })
    database.run(`CREATE TABLE session_windows (
      session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, channel TEXT, account_id TEXT,
      primary_conversation_id TEXT, model_provider TEXT, model TEXT, agent_harness_id TEXT
    ) STRICT`)
    database.run(`CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY, channel TEXT NOT NULL, account_id TEXT NOT NULL,
      delivery_target TEXT NOT NULL, native_channel_id TEXT, label TEXT
    ) STRICT`)
    database.run(`CREATE TABLE transcript_events (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    ) STRICT`)
    const sessionId = 'c45f8c39-00ca-459f-84cf-49a19be6b3cb'
    database.query('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)').run(
      'conv_595bf38a6fc1862c6d04b5a15bc47d31', 'discord', 'default', 'channel:1480347628565823632', '1480347628565823632', 'discord:guild#general',
    )
    database.query(`INSERT INTO session_windows VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      sessionId, 'agent:main:discord:channel:1480347628565823632', 'discord', 'default',
      'conv_595bf38a6fc1862c6d04b5a15bc47d31', 'openai', 'gpt-5.6-sol', 'codex',
    )
    const nonDiscordSessionId = 'local-session-without-delivery-target'
    database.query(`INSERT INTO session_windows VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      nonDiscordSessionId, 'agent:main:local:test', null, null, null, 'openai', 'gpt-5.6-sol', 'codex',
    )
    const userId = 'b274c9cf-e2f9-4a96-9801-aa5642d8ae72'
    const assistantId = '88169b31-310e-4431-b80d-3388008fdc92'
    const user = { type: 'message', id: userId, parentId: 'prior', timestamp: '2026-09-05T15:56:05.043Z', message: {
      role: 'user', content: 'can you see this?', __openclaw: {
        senderId: '268899119567732737', senderName: 'Benjamin', senderUsername: 'bap9370',
        senderIdentity: { accountId: 'default' },
        transport: { channel: 'discord', conversationRef: 'conv_595bf38a6fc1862c6d04b5a15bc47d31', messageId: '1545824836708864030' },
        media: [{ path: stagedPath, url: stagedPath, contentType: 'image/png', kind: 'image', fileName: producerName }],
      },
    } }
    const assistant = { type: 'message', id: assistantId, parentId: userId, timestamp: '2026-09-05T15:56:11.338Z', message: {
      role: 'assistant', content: [{ type: 'text', text: 'It is a screenshot.' }], provider: 'openai', model: 'gpt-5.6-sol',
      stopReason: 'stop',
      idempotencyKey: 'codex-app-server:01a07246-8053-7dc0-896a-268fdd1f9d21:01a07248-be97-7710-b0de-d68cc098dad7:assistant',
      __openclaw: { mirrorIdentity: '01a07248-be97-7710-b0de-d68cc098dad7:assistant', runId: 'ff3be52b-c93e-4084-91bc-bbcf5d32a94b' },
    } }
    const toolOnly = { type: 'message', id: 'tool-call-assistant', parentId: assistantId, timestamp: '2026-09-05T15:56:12.000Z', message: {
      role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], stopReason: 'toolUse',
    } }
    const unscopedFinal = { type: 'message', id: 'unscoped-final', parentId: 'missing-user', timestamp: '2026-09-05T15:56:13.000Z', message: {
      role: 'assistant', content: [{ type: 'text', text: 'Local-only result' }], stopReason: 'stop',
    } }
    const insert = database.query(`INSERT INTO transcript_events VALUES (?, ?, ?, ?)`)
    insert.run(sessionId, 6, JSON.stringify(user), 1788623765043)
    insert.run(sessionId, 7, JSON.stringify(assistant), 1788623771338)
    insert.run(sessionId, 8, JSON.stringify(toolOnly), 1788623772000)
    insert.run(nonDiscordSessionId, 1, JSON.stringify(unscopedFinal), 1788623773000)
    database.close()

    const spoolRoot = join(base, 'spool')
    const initiallyApproved = join(base, 'initially-approved')
    await mkdir(initiallyApproved)
    const failedSpool = new LearningArchiveSpool({ spoolRoot, approvedLocalRoots: [initiallyApproved], maxMediaBytes: 1024 * 1024 })
    await failedSpool.initialize()
    const failed = await drainOpenClawTranscriptHistory({ databasePath, spool: failedSpool, maxRows: 1,
      confirmedHumanSenderIds: new Set(['268899119567732737']), originalMediaRoots: [originalInbound] })
    expect(failed).toMatchObject({ rowsRead: 1, usersImported: 1, mediaCaptured: 0, mediaParityVerified: 0, gaps: 2 })

    const spool = new LearningArchiveSpool({ spoolRoot, approvedLocalRoots: [nativeInbound, originalInbound], maxMediaBytes: 1024 * 1024 })
    await spool.initialize()
    const common = { databasePath, spool, confirmedHumanSenderIds: new Set(['268899119567732737']), originalMediaRoots: [originalInbound] }
    const first = await drainOpenClawTranscriptHistory({ ...common, maxRows: 1 })
    expect(first).toMatchObject({ rowsRead: 1, usersImported: 1, assistantsImported: 0, mediaCaptured: 2, mediaParityVerified: 1, gaps: 0, exhausted: false })
    const second = await drainOpenClawTranscriptHistory({ ...common, cursor: first.cursor, maxRows: 10 })
    expect(second).toMatchObject({ rowsRead: 3, observationsWritten: 4, usersImported: 0, assistantsImported: 3, gaps: 3, exhausted: true })

    const names = await readdir(join(spoolRoot, 'events'))
    expect(names).toHaveLength(6)
    const observations = await Promise.all(names.map(async (name) => JSON.parse(await readFile(join(spoolRoot, 'events', name), 'utf8'))))
    const userObservations = observations.filter((row) => row.hook === 'history_import' && row.direction === 'user_to_model')
    // Classify by the MEDIA parts: both observations carry a captured text part, and readdir order is filesystem-specific.
    const userObservation = userObservations.find((row) => row.parts.some((part: { type: string; captureStatus: string }) => part.type === 'media' && part.captureStatus === 'captured'))
    const failedUserObservation = userObservations.find((row) => row.parts.some((part: { type: string; captureStatus: string }) => part.type === 'media' && part.captureStatus === 'refused'))
    const assistantObservation = observations.find((row) => row.direction === 'model_to_user' && row.stage === 'user_facing')
    const toolObservation = observations.find((row) => row.raw?.event?.id === toolOnly.id)
    const unscopedObservation = observations.find((row) => row.raw?.event?.id === unscopedFinal.id)
    const correlationObservation = observations.find((row) => row.hook === 'handoff_correlation')
    const expectedSha = createHash('sha256').update(bytes).digest('hex')
    expect(userObservations).toHaveLength(2)
    expect(failedUserObservation).toMatchObject({ observedAt: user.timestamp, logicalMessageKey: userObservation.logicalMessageKey })
    expect(failedUserObservation.observationId).not.toBe(userObservation.observationId)
    expect(userObservation).toMatchObject({
      authorship: 'human', stage: 'received', logicalMessageKey: 'discord:default:channel%3A1480347628565823632:1545824836708864030',
      correlation: { transcriptEventId: userId, senderId: '268899119567732737',
        conversationRef: 'conv_595bf38a6fc1862c6d04b5a15bc47d31', nativeChannelId: '1480347628565823632' },
    })
    expect(userObservation.parts.filter((part: any) => part.type === 'media')).toEqual([
      expect.objectContaining({ role: 'staged', sha256: expectedSha, byteLength: bytes.length }),
      expect.objectContaining({ role: 'original', sha256: expectedSha, byteLength: bytes.length }),
    ])
    expect(assistantObservation).toMatchObject({
      authorship: 'agent', stage: 'user_facing', visibility: 'intended',
      correlation: {
        historyProjectionRevision: '3',
        transcriptEventId: assistantId, parentTranscriptEventId: userId,
        parentLogicalMessageKey: userObservation.logicalMessageKey,
        runId: 'ff3be52b-c93e-4084-91bc-bbcf5d32a94b',
        codexThreadId: '01a07246-8053-7dc0-896a-268fdd1f9d21', codexTurnId: '01a07248-be97-7710-b0de-d68cc098dad7',
      },
    })
    expect(toolObservation).toMatchObject({
      direction: 'model_to_user', stage: 'model_output', visibility: 'internal', parts: [],
      correlation: { historyProjectionRevision: '3' },
    })
    expect(unscopedObservation).toMatchObject({
      direction: 'model_to_user', stage: 'model_output', visibility: 'unknown',
      correlation: { historyProjectionRevision: '3' },
      gaps: expect.arrayContaining([expect.objectContaining({ code: 'historical-assistant-discord-target-missing' })]),
    })
    expect(correlationObservation).toMatchObject({
      direction: 'user_to_model', stage: 'finalizing', visibility: 'internal', parts: [],
      logicalMessageKey: userObservation.logicalMessageKey,
      correlation: { parentTranscriptEventId: userId, runId: 'ff3be52b-c93e-4084-91bc-bbcf5d32a94b',
        codexThreadId: '01a07246-8053-7dc0-896a-268fdd1f9d21', codexTurnId: '01a07248-be97-7710-b0de-d68cc098dad7' },
    })
    expect(userObservation.logicalMessageKey).toBe(spool.logicalMessageKey({
      channelId: 'discord', accountId: 'default', conversationId: 'channel:1480347628565823632', messageId: '1545824836708864030',
    }))

    const replay = await drainOpenClawTranscriptHistory({ ...common, maxRows: 10 })
    expect(replay.rowsRead).toBe(4)
    expect(await readdir(join(spoolRoot, 'events'))).toHaveLength(6)
    const readonly = new Database(databasePath, { readonly: true, strict: true })
    expect(readonly.query<{ count: number }, []>('SELECT count(*) AS count FROM transcript_events').get()?.count).toBe(4)
    readonly.close()
  })

  test('uses disjoint stable partitions', async () => {
    const base = await mkdtemp(join(tmpdir(), 'openclaw-history-partitions-'))
    temporary.push(base)
    const approved = join(base, 'approved')
    await mkdir(approved)
    const databasePath = join(base, 'history.sqlite')
    const database = new Database(databasePath, { create: true, strict: true })
    database.run('CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, channel TEXT, account_id TEXT, primary_conversation_id TEXT, model_provider TEXT, model TEXT, agent_harness_id TEXT) STRICT')
    database.run('CREATE TABLE conversations (conversation_id TEXT PRIMARY KEY, channel TEXT NOT NULL, account_id TEXT NOT NULL, delivery_target TEXT NOT NULL, native_channel_id TEXT, label TEXT) STRICT')
    database.run('CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,seq)) STRICT')
    for (const [sessionId, createdAt] of [['a-session', 1], ['b-session', 2]] as const) {
      database.query('INSERT INTO session_windows VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sessionId, `agent:main:test:${sessionId}`, null, null, null, null, null, null)
      database.query('INSERT INTO transcript_events VALUES (?, ?, ?, ?)').run(sessionId, 1, JSON.stringify({ type: 'gap', id: `${sessionId}-event` }), createdAt)
    }
    database.close()
    const spool = new LearningArchiveSpool({ spoolRoot: join(base, 'spool'), approvedLocalRoots: [approved] })
    await spool.initialize()
    const common = { databasePath, spool, maxRows: 10, confirmedHumanSenderIds: new Set<string>(), originalMediaRoots: [] }
    const zero = await drainOpenClawTranscriptHistory({ ...common, partition: { index: 0, count: 2 } })
    const one = await drainOpenClawTranscriptHistory({ ...common, partition: { index: 1, count: 2 } })
    expect(zero.rowsRead + one.rowsRead).toBe(2)
    expect([zero.rowsRead, one.rowsRead].sort()).toEqual([1, 1])
    expect(await readdir(join(base, 'spool', 'events'))).toHaveLength(2)
  })
})
