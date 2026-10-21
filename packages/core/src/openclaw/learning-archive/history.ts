import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { LearningArchiveSpool, type ArchiveCorrelation, type ArchiveGap, type ArchivePart, type MediaFact } from './spool.js'

export type OpenClawHistoryCursor = { createdAt: number; sessionId: string; seq: number }
export type OpenClawHistoryPartition = { index: number; count: number }
export type OpenClawHistoryDrainOptions = {
  databasePath: string
  spool: LearningArchiveSpool
  cursor?: OpenClawHistoryCursor | null
  maxRows: number
  confirmedHumanSenderIds: ReadonlySet<string>
  originalMediaRoots: readonly string[]
  partition?: OpenClawHistoryPartition
}
export type OpenClawHistoryDrainResult = {
  cursor: OpenClawHistoryCursor | null
  exhausted: boolean
  rowsRead: number
  observationsWritten: number
  usersImported: number
  assistantsImported: number
  mediaCaptured: number
  mediaParityVerified: number
  gaps: number
}

type HistoryRow = {
  session_id: string; seq: number; event_json: string; created_at: number
  session_key: string; channel: string | null; account_id: string | null; primary_conversation_id: string | null
  model_provider: string | null; model: string | null; agent_harness_id: string | null
  conversation_id: string | null; conversation_channel: string | null; conversation_account_id: string | null
  conversation_delivery_target: string | null; native_channel_id: string | null; conversation_label: string | null
}

const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const iso = (value: unknown, fallbackMs: number): string => {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString()
  return new Date(fallbackMs).toISOString()
}
const agentFromSessionKey = (value: string): string | undefined => /^agent:([^:]+):/.exec(value)?.[1]
const historyContext = (row: HistoryRow): Record<string, unknown> => ({
  sessionId: row.session_id, sessionKey: row.session_key, seq: row.seq, createdAt: row.created_at,
  channel: row.channel, accountId: row.account_id, primaryConversationId: row.primary_conversation_id,
  modelProvider: row.model_provider, model: row.model, agentHarnessId: row.agent_harness_id,
  conversationRef: row.conversation_id, deliveryTarget: row.conversation_delivery_target,
  nativeChannelId: row.native_channel_id, conversationLabel: row.conversation_label,
})
const assistantIdentity = (metadata: Record<string, unknown>): { runId?: string; codexThreadId?: string; codexTurnId?: string } => {
  const mirrorIdentity = string(metadata.mirrorIdentity)
  const mirrorTurn = mirrorIdentity?.match(/^([^:]+):assistant(?::.*)?$/)?.[1]
  const idempotencyKey = string(metadata.idempotencyKey)
  const native = idempotencyKey?.match(/^codex-app-server:([^:]+):([^:]+):assistant(?::.*)?$/)
  const runId = string(metadata.runId)
  const codexThreadId = native?.[1]
  const codexTurnId = native?.[2] ?? mirrorTurn
  return {
    ...(runId === undefined ? {} : { runId }),
    ...(codexThreadId === undefined ? {} : { codexThreadId }),
    ...(codexTurnId === undefined ? {} : { codexTurnId }),
  }
}

const transportIdentity = (spool: LearningArchiveSpool, row: HistoryRow, event: Record<string, unknown>): {
  logicalMessageKey: string | null; correlation: ArchiveCorrelation & Record<string, unknown>; senderId?: string
} => {
  const message = object(event.message)
  const metadata = object(message?.__openclaw)
  const transport = object(metadata?.transport)
  const transportChannel = string(transport?.channel)
  const conversationRef = string(transport?.conversationRef)
  const resolved = Boolean(conversationRef && conversationRef === row.conversation_id
    && transportChannel && transportChannel === row.conversation_channel
    && row.conversation_delivery_target && row.conversation_account_id)
  const channelId = resolved ? row.conversation_channel ?? undefined : undefined
  const accountId = resolved ? row.conversation_account_id ?? undefined : undefined
  const conversationId = resolved ? row.conversation_delivery_target ?? undefined : undefined
  const messageId = string(transport?.messageId)
  const logicalMessageKey = spool.logicalMessageKey({ channelId, accountId, conversationId, messageId })
  const senderId = string(metadata?.senderId)
  return {
    logicalMessageKey,
    ...(senderId === undefined ? {} : { senderId }),
    correlation: {
      channelId, accountId, conversationId, messageId,
      conversationRef, nativeChannelId: row.native_channel_id ?? undefined, conversationName: row.conversation_label ?? undefined,
      senderId, senderName: string(metadata?.senderName), senderUsername: string(metadata?.senderUsername),
      sessionId: row.session_id, sessionKey: row.session_key, agentId: agentFromSessionKey(row.session_key),
      transcriptEventId: string(event.id), transcriptParentEventId: string(event.parentId),
      modelProvider: row.model_provider ?? undefined, model: row.model ?? undefined, agentHarnessId: row.agent_harness_id ?? undefined,
    },
  }
}

const mediaFact = (value: unknown): MediaFact | undefined => {
  const fact = object(value)
  if (!fact) return
  const path = string(fact.path)
  const url = string(fact.url)
  const source = object(fact.source)
  const sourceData = string(source?.data)
  const directData = string(fact.data) ?? string(fact.base64)
  if (!path && !url && !sourceData && !directData) return undefined
  const base64Data = sourceData ?? directData
  const contentType = string(fact.contentType) ?? string(fact.mimeType) ?? string(fact.media_type) ?? string(source?.media_type)
  const kind = string(fact.kind) ?? string(fact.type)
  const workspaceDir = string(fact.workspaceDir)
  const messageId = string(fact.messageId)
  return {
    ...(path === undefined ? {} : { path }),
    ...(url === undefined ? {} : { url }),
    ...(base64Data === undefined ? {} : { base64Data }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(kind === undefined ? {} : { kind }),
    ...(workspaceDir === undefined ? {} : { workspaceDir }),
    ...(messageId === undefined ? {} : { messageId }),
  }
}

const originalProducerName = (path: string): string | undefined => {
  const directory = basename(dirname(path))
  if (!/^openclaw-staged-(?:[a-f0-9]{64}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/u.test(directory)) return
  const stagedName = basename(path)
  return stagedName.startsWith('input-') && stagedName.length > 6 ? stagedName.slice(6) : undefined
}

async function captureHistoricalMedia(spool: LearningArchiveSpool, facts: readonly MediaFact[], originalMediaRoots: readonly string[], parts: ArchivePart[], gaps: ArchiveGap[]): Promise<{ captured: number; parity: number }> {
  let captured = 0
  let parity = 0
  for (const fact of facts) {
    const staged = await spool.captureMedia(fact, parts.length, 'staged')
    parts.push(staged.part); gaps.push(...staged.gaps)
    if (staged.part.captureStatus === 'captured') captured++
    const producerName = fact.path ? originalProducerName(fact.path) : undefined
    if (!producerName) continue
    const candidates: string[] = []
    for (const root of originalMediaRoots) {
      if (!isAbsolute(root)) throw new Error('originalMediaRoots must be absolute')
      const candidate = join(root, producerName)
      if (await lstat(candidate).then(() => true, () => false)) candidates.push(candidate)
    }
    if (candidates.length !== 1) {
      gaps.push({ code: candidates.length ? 'historical-original-media-ambiguous' : 'historical-original-media-missing',
        detail: candidates.length ? 'Multiple exact approved original-media candidates matched the staged producer name' : 'No exact approved original-media candidate matched the staged producer name' })
      continue
    }
    const original = await spool.captureMedia({
      path: candidates[0]!,
      ...(fact.contentType === undefined ? {} : { contentType: fact.contentType }),
      ...(fact.kind === undefined ? {} : { kind: fact.kind }),
    }, parts.length, 'original')
    parts.push(original.part); gaps.push(...original.gaps)
    if (original.part.captureStatus === 'captured') captured++
    if (staged.part.sha256 && original.part.sha256) {
      if (staged.part.sha256 === original.part.sha256 && staged.part.byteLength === original.part.byteLength) parity++
      else gaps.push({ code: 'historical-media-parity-mismatch', detail: 'Original and staged media bytes did not have identical length and SHA-256' })
    }
  }
  return { captured, parity }
}

const messageTextParts = (message: Record<string, unknown> | undefined): ArchivePart[] => {
  if (typeof message?.content === 'string') return message.content ? [{ ordinal: 0, type: 'text', text: message.content, captureStatus: 'captured' }] : []
  return array(message?.content).flatMap((part) => {
    const item = object(part)
    const text = item?.type === 'text' ? string(item.text) : undefined
    return text ? [{ ordinal: 0, type: 'text' as const,
      ...(message?.role === 'assistant' ? { role: 'model-output' as const } : {}),
      text, captureStatus: 'captured' as const }] : []
  }).map((part, ordinal) => ({ ...part, ordinal }))
}

const projectionSourceDedupeKey = (sourceDedupeKey: string, requiresRevision: boolean, parts: readonly ArchivePart[], gaps: readonly ArchiveGap[], revisionLabel?: string): string => {
  if (!requiresRevision) return sourceDedupeKey
  // Media may become capturable after an operational repair. Keep the failed
  // receipt immutable, but give the repaired projection a deterministic new
  // occurrence while retaining the same canonical logical message identity.
  const revisionDigest = createHash('sha256').update(JSON.stringify({ parts, gaps })).digest('hex')
  return `${sourceDedupeKey}${revisionLabel ? `:${revisionLabel}` : ''}:projection:${revisionDigest}`
}

type AssistantEligibility = {
  stage: 'user_facing' | 'model_output'
  visibility: 'intended' | 'internal' | 'unknown'
}

const assistantEligibility = (row: HistoryRow, message: Record<string, unknown>, parts: readonly ArchivePart[], gaps: ArchiveGap[]): AssistantEligibility => {
  const hasText = parts.some((part) => part.type === 'text' && part.captureStatus === 'captured' && Boolean(part.text))
  const finalText = hasText && string(message.stopReason) === 'stop'
  const explicitDiscordTarget = row.conversation_channel === 'discord'
    && Boolean(row.conversation_account_id) && Boolean(row.conversation_delivery_target)
  if (finalText && explicitDiscordTarget) return { stage: 'user_facing', visibility: 'intended' }
  if (!explicitDiscordTarget) {
    gaps.push({ code: 'historical-assistant-discord-target-missing',
      detail: 'Historical assistant event lacked an explicit Discord account and delivery target; user-facing visibility was not inferred' })
    return { stage: 'model_output', visibility: 'unknown' }
  }
  return { stage: 'model_output', visibility: 'internal' }
}

function parentUserIdentity(spool: LearningArchiveSpool, database: Database, row: HistoryRow, event: Record<string, unknown>, pageEvents: ReadonlyMap<string, Record<string, unknown>>): ReturnType<typeof transportIdentity> | undefined {
  const parentId = string(event.parentId)
  if (!parentId) return
  let parent = pageEvents.get(`${row.session_id}\0${parentId}`)
  if (!parent) {
    const matches = database.query<{ event_json: string }, [string, string]>(
      `SELECT event_json FROM transcript_events WHERE session_id = ?
        AND CASE WHEN json_valid(event_json) THEN json_extract(event_json, '$.id') END = ? LIMIT 2`,
    ).all(row.session_id, parentId)
    if (matches.length !== 1) return
    try { parent = object(JSON.parse(matches[0]!.event_json)) } catch { return }
  }
  if (!parent) return
  if (object(parent?.message)?.role !== 'user') return
  return transportIdentity(spool, row, parent)
}

export async function drainOpenClawTranscriptHistory({ databasePath, spool, cursor = null, maxRows, confirmedHumanSenderIds,
  originalMediaRoots, partition = { index: 0, count: 1 } }: OpenClawHistoryDrainOptions): Promise<OpenClawHistoryDrainResult> {
  if (!isAbsolute(databasePath)) throw new Error('databasePath must be absolute')
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000) throw new Error('maxRows must be 1-1000')
  if (!Number.isSafeInteger(partition.count) || partition.count < 1 || partition.count > 16
    || !Number.isSafeInteger(partition.index) || partition.index < 0 || partition.index >= partition.count) throw new Error('partition must be a valid index within 1-16 workers')
  const database = new Database(databasePath, { readonly: true, strict: true })
  try {
    const start = cursor ?? { createdAt: -1, sessionId: '', seq: -1 }
    const rows = database.query<HistoryRow, [number, number, string, number, string, number, number, number, number, number, number, number]>(`
      SELECT te.session_id, te.seq, te.event_json, te.created_at,
        sw.session_key, sw.channel, sw.account_id, sw.primary_conversation_id,
        sw.model_provider, sw.model, sw.agent_harness_id,
        c.conversation_id, c.channel AS conversation_channel, c.account_id AS conversation_account_id,
        c.delivery_target AS conversation_delivery_target, c.native_channel_id, c.label AS conversation_label
      FROM transcript_events te
      JOIN session_windows sw ON sw.session_id = te.session_id
      LEFT JOIN conversations c ON c.conversation_id = sw.primary_conversation_id
      WHERE (te.created_at > ? OR (te.created_at = ? AND te.session_id > ?)
        OR (te.created_at = ? AND te.session_id = ? AND te.seq > ?))
        AND (? = 1 OR ((unicode(substr(te.session_id, 1, 1)) % ? + ?) % ?) = ?)
      ORDER BY te.created_at, te.session_id, te.seq
      LIMIT ?
    `).all(start.createdAt, start.createdAt, start.sessionId, start.createdAt, start.sessionId, start.seq,
      partition.count, partition.count, partition.count, partition.count, partition.index, maxRows)
    const pageEvents = new Map<string, Record<string, unknown>>()
    for (const row of rows) {
      try {
        const event = object(JSON.parse(row.event_json))
        const eventId = string(event?.id)
        if (event && eventId) pageEvents.set(`${row.session_id}\0${eventId}`, event)
      } catch { /* Persisted as an explicit malformed gap below. */ }
    }
    const result: OpenClawHistoryDrainResult = { cursor, exhausted: rows.length < maxRows, rowsRead: rows.length,
      observationsWritten: 0, usersImported: 0, assistantsImported: 0, mediaCaptured: 0, mediaParityVerified: 0, gaps: 0 }
    for (const row of rows) {
      let event: Record<string, unknown> | undefined
      try { event = object(JSON.parse(row.event_json)) } catch { /* handled below */ }
      const eventId = string(event?.id) ?? `missing-id-${row.seq}`
      const observedAt = iso(event?.timestamp, row.created_at)
      const sourceDedupeKey = `openclaw-history:${row.session_id}:${row.seq}:${eventId}`
      const message = object(event?.message)
      const role = string(message?.role)
      const gaps: ArchiveGap[] = []
      if (!event || !message || event.type !== 'message' || (role !== 'user' && role !== 'assistant')) {
        gaps.push({ code: !event ? 'historical-event-json-malformed' : 'historical-event-unsupported',
          detail: !event ? 'Historical transcript event JSON could not be parsed' : 'Historical transcript row was not a supported user or assistant message event' })
        const correlation: ArchiveCorrelation & Record<string, unknown> = { sessionId: row.session_id, sessionKey: row.session_key, transcriptEventId: eventId }
        await spool.persist({ hook: 'gap', direction: 'internal', stage: 'gap', authorship: 'unknown', visibility: 'internal',
          logicalMessageKey: null, correlation,
          parts: [], gaps, event: event ?? { malformedEventSha256: createHash('sha256').update(row.event_json).digest('hex') },
          context: historyContext(row), sourceDedupeKey, observedAt })
      } else if (role === 'user') {
        const identity = transportIdentity(spool, row, event)
        if (!identity.logicalMessageKey) gaps.push({ code: 'historical-discord-identity-missing', detail: 'Historical user event lacked an explicit Discord account, conversation, or transport message ID' })
        const parts = messageTextParts(message)
        const metadata = object(message.__openclaw)
        const facts = array(metadata?.media).flatMap((item) => mediaFact(item) ?? [])
        const media = await captureHistoricalMedia(spool, facts, originalMediaRoots, parts, gaps)
        result.mediaCaptured += media.captured; result.mediaParityVerified += media.parity
        const projectionKey = projectionSourceDedupeKey(sourceDedupeKey, facts.length > 0, parts, gaps)
        await spool.persist({ hook: 'history_import', direction: 'user_to_model', stage: 'received',
          authorship: identity.senderId && confirmedHumanSenderIds.has(identity.senderId) ? 'human' : 'unknown', visibility: 'intended',
          logicalMessageKey: identity.logicalMessageKey, correlation: identity.correlation, parts, gaps,
          event, context: historyContext(row), sourceDedupeKey: projectionKey, observedAt })
        result.usersImported++
      } else {
        const parent = parentUserIdentity(spool, database, row, event, pageEvents)
        if (!parent?.logicalMessageKey) gaps.push({ code: 'historical-parent-user-identity-missing', detail: 'Assistant parentId did not resolve to one explicit Discord user transcript event' })
        const metadata = object(message.__openclaw) ?? {}
        const native = assistantIdentity({ ...metadata, idempotencyKey: message.idempotencyKey })
        const parts = messageTextParts(message)
        const embeddedFacts = array(message.content).flatMap((part) => mediaFact(part) ?? [])
        const media = await captureHistoricalMedia(spool, embeddedFacts, originalMediaRoots, parts, gaps)
        result.mediaCaptured += media.captured; result.mediaParityVerified += media.parity
        const eligibility = assistantEligibility(row, message, parts, gaps)
        const projectionKey = projectionSourceDedupeKey(sourceDedupeKey, true, parts, gaps, 'eligibility-v3')
        const correlation: ArchiveCorrelation & Record<string, unknown> = {
          ...parent?.correlation, ...native,
          historyProjectionRevision: '3',
          sessionId: row.session_id, sessionKey: row.session_key, agentId: agentFromSessionKey(row.session_key),
          transcriptEventId: eventId, parentTranscriptEventId: string(event.parentId), parentLogicalMessageKey: parent?.logicalMessageKey,
          modelProvider: string(message.provider) ?? row.model_provider ?? undefined, model: string(message.model) ?? row.model ?? undefined,
          agentHarnessId: row.agent_harness_id ?? undefined,
        }
        await spool.persist({ hook: 'history_import', direction: 'model_to_user', stage: eligibility.stage, authorship: 'agent', visibility: eligibility.visibility,
          logicalMessageKey: `openclaw-history-assistant:${encodeURIComponent(row.session_id)}:${encodeURIComponent(eventId)}`,
          correlation, parts, gaps, event, context: historyContext(row), sourceDedupeKey: projectionKey, observedAt })
        if (parent?.logicalMessageKey && native.runId) {
          const handoffCorrelation: ArchiveCorrelation & Record<string, unknown> = {
            ...parent.correlation, ...native, transcriptEventId: string(event.parentId), assistantTranscriptEventId: eventId,
            parentTranscriptEventId: string(event.parentId), parentLogicalMessageKey: parent.logicalMessageKey,
          }
          await spool.persist({ hook: 'handoff_correlation', direction: 'user_to_model', stage: 'finalizing', authorship: 'unknown', visibility: 'internal',
            logicalMessageKey: parent.logicalMessageKey, correlation: handoffCorrelation, parts: [], gaps: [],
            event: { receiptKind: 'historical-parent-link', assistantTranscriptEventId: eventId,
              parentTranscriptEventId: string(event.parentId), runId: native.runId,
              codexThreadId: native.codexThreadId, codexTurnId: native.codexTurnId },
            context: historyContext(row), sourceDedupeKey: `${sourceDedupeKey}:parent-correlation`, observedAt })
          result.observationsWritten++
        }
        result.assistantsImported++
      }
      result.observationsWritten++
      result.gaps += gaps.length
      result.cursor = { createdAt: row.created_at, sessionId: row.session_id, seq: row.seq }
    }
    return result
  } finally { database.close() }
}
