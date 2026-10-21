import { createHash } from 'node:crypto'
import { basename, sep } from 'node:path'

export type TranscriptProvider = 'openai' | 'anthropic' | 'google'
export type TranscriptRole = 'user' | 'assistant'
export type TranscriptAuthorship = 'human' | 'agent' | 'system' | 'unknown'

export type SourceIdentity = {
  path: string
  kind: 'jsonl' | 'sqlite'
  device: number
  inode: number
  generation: number
  offset: number
}

export type ParserState = {
  sessionId?: string
  cwd?: string | null
  originator?: string | null
  exchangeId?: string | null
}

export type ArchivedTurn = {
  schemaVersion: 1
  provider: TranscriptProvider
  location: 'local'
  source: SourceIdentity
  thread: { nativeId: string }
  message: {
    nativeId: string | null
    exchangeNativeId: string | null
    role: TranscriptRole
    authorship: TranscriptAuthorship
    authorshipEvidence: string
    timestamp: string | null
    order: number
    model: string | null
    cwd: string | null
    text: string
    contentHash: string
  }
}

type JsonRecord = Record<string, unknown>

const record = (value: unknown): JsonRecord | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
)

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) if (typeof value === 'string' && value.length > 0) return value
  return null
}

/** Preserve provider text bytes: no trim, clipping, redaction, or whitespace normalization. */
export const contentText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    const item = record(block)
    return item && ['text', 'input_text', 'output_text'].includes(String(item.type)) && typeof item.text === 'string'
      ? item.text
      : ''
  }).filter((text) => text.length > 0).join('\n')
}

export const sha256Text = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

export const sourceCursorMustReset = (
  prior: { device: number; inode: number; cursor: number },
  current: { device: number; inode: number; size: number },
): boolean => prior.device !== current.device || prior.inode !== current.inode || current.size < prior.cursor

const systemInput = /^<(?:recommended_plugins|environment_context|turn_aborted|system-reminder)\b/i

const finishTurn = (
  provider: TranscriptProvider,
  source: SourceIdentity,
  order: number,
  fields: Omit<ArchivedTurn['message'], 'contentHash' | 'order'> & { threadId: string },
): ArchivedTurn => ({
  schemaVersion: 1,
  provider,
  location: 'local',
  source,
  thread: { nativeId: fields.threadId },
  message: {
    nativeId: fields.nativeId,
    exchangeNativeId: fields.exchangeNativeId,
    role: fields.role,
    authorship: fields.authorship,
    authorshipEvidence: fields.authorshipEvidence,
    timestamp: fields.timestamp,
    order,
    model: fields.model,
    cwd: fields.cwd,
    text: fields.text,
    contentHash: sha256Text(fields.text),
  },
})

export function parseOpenAIRecord(
  line: string,
  source: SourceIdentity,
  order: number,
  prior: ParserState,
): { state: ParserState; turn: ArchivedTurn | null } {
  const row = record(JSON.parse(line))
  if (!row) return { state: prior, turn: null }
  const state = { ...prior }
  if (row.type === 'session_meta') {
    const payload = record(row.payload)
    state.sessionId = firstString(payload?.session_id, payload?.id) ?? state.sessionId ?? basename(source.path, '.jsonl')
    state.cwd = firstString(payload?.cwd) ?? state.cwd ?? null
    state.originator = firstString(payload?.originator) ?? state.originator ?? null
    return { state, turn: null }
  }
  if (row.type !== 'response_item') return { state, turn: null }
  const response = record(row.payload)
  const role = response?.role === 'user' || response?.role === 'assistant' ? response.role : null
  if (response?.type !== 'message' || !role) return { state, turn: null }
  const text = contentText(response.content)
  if (text.length === 0) return { state, turn: null }
  const passthrough = record(response.internal_chat_message_metadata_passthrough)
  const kinds = Array.isArray(passthrough?.content_item_kinds) ? passthrough.content_item_kinds.map(String) : []
  const turnId = firstString(passthrough?.turn_id)
  if (role === 'user') state.exchangeId = turnId ?? firstString(response.id) ?? `${source.path}:${source.offset}`
  const authorship: TranscriptAuthorship = role === 'assistant'
    ? 'agent'
    : systemInput.test(text)
      ? 'system'
      : state.originator === 'codex-tui' && kinds.includes('user.text')
        ? 'human'
        : state.originator === 'codex-lane'
          ? 'agent'
          : 'unknown'
  return {
    state,
    turn: finishTurn('openai', source, order, {
      threadId: state.sessionId ?? basename(source.path, '.jsonl'),
      nativeId: firstString(response.id),
      exchangeNativeId: turnId ?? state.exchangeId ?? null,
      role,
      authorship,
      authorshipEvidence: role === 'assistant'
        ? 'assistant role'
        : `OpenAI originator=${state.originator ?? 'missing'}; kinds=${kinds.join(',') || 'missing'}`,
      timestamp: firstString(row.timestamp),
      model: firstString(response.model, row.model),
      cwd: state.cwd ?? null,
      text,
    }),
  }
}

export function parseAnthropicRecord(
  line: string,
  source: SourceIdentity,
  order: number,
  prior: ParserState,
): { state: ParserState; turn: ArchivedTurn | null } {
  const row = record(JSON.parse(line))
  if (!row || row.isMeta === true) return { state: prior, turn: null }
  const state = { ...prior }
  const message = record(row.message)
  const attachment = record(row.attachment)
  const attachmentOrigin = record(attachment?.origin)
  const queuedHuman = row.type === 'attachment' && attachment?.type === 'queued_command'
    && attachment.commandMode === 'prompt' && attachmentOrigin?.kind === 'human'
    && typeof attachment.prompt === 'string'
  const role = message?.role === 'user' || message?.role === 'assistant'
    ? message.role
    : queuedHuman ? 'user' : null
  if (!role) return { state, turn: null }
  const text = queuedHuman ? String(attachment?.prompt) : contentText(message?.content)
  if (text.length === 0) return { state, turn: null }
  const isSubagent = source.path.includes(`${sep}subagents${sep}`)
  const origin = record(row.origin)
  const originKind = firstString(origin?.kind)
  const promptSource = firstString(row.promptSource)
  let authorship: TranscriptAuthorship = 'unknown'
  let evidence = 'Anthropic record lacks explicit human provenance'
  if (role === 'assistant') {
    authorship = 'agent'; evidence = 'assistant role'
  } else if (queuedHuman) {
    authorship = 'human'; evidence = 'Anthropic queued command origin.kind=human and commandMode=prompt'
  } else if (systemInput.test(text) || originKind === 'task-notification' || promptSource === 'system' || typeof row.interruptedMessageId === 'string') {
    authorship = 'system'; evidence = `Anthropic system provenance: ${originKind ?? promptSource ?? 'structured marker'}`
  } else if (isSubagent || row.isSidechain === true || typeof row.agentId === 'string' || /<teammate-message\b/i.test(text)) {
    authorship = 'agent'; evidence = 'Anthropic sidechain, subagent, or teammate metadata'
  } else if (promptSource === 'sdk' || row.entrypoint === 'sdk-cli') {
    authorship = 'agent'; evidence = 'Anthropic SDK-submitted prompt'
  } else if (originKind === 'human' || promptSource === 'typed') {
    authorship = 'human'; evidence = 'Anthropic origin.kind=human or promptSource=typed'
  }
  const nativeId = firstString(row.uuid)
  if (role === 'user') state.exchangeId = nativeId ?? `${source.path}:${source.offset}`
  state.sessionId = firstString(row.sessionId) ?? state.sessionId ?? basename(source.path, '.jsonl')
  state.cwd = firstString(row.cwd) ?? state.cwd ?? null
  return {
    state,
    turn: finishTurn('anthropic', source, order, {
      threadId: state.sessionId,
      nativeId,
      exchangeNativeId: state.exchangeId ?? null,
      role,
      authorship,
      authorshipEvidence: evidence,
      timestamp: firstString(row.timestamp),
      model: firstString(message?.model, row.model),
      cwd: state.cwd ?? null,
      text,
    }),
  }
}

export function archiveEnvelope(turn: ArchivedTurn): { content: string; contentHash: string; documentId: string } {
  const content = JSON.stringify(turn)
  const contentHash = sha256Text(content)
  const nativeIdentity = turn.message.nativeId
    ? `${turn.provider}\0${turn.thread.nativeId}\0${turn.message.nativeId}`
    : `${turn.provider}\0${turn.source.path}\0${turn.source.device}\0${turn.source.inode}\0${turn.source.generation}\0${turn.source.offset}`
  const identityHash = sha256Text(nativeIdentity).slice(0, 32)
  return { content, contentHash, documentId: `cli-turn-v1-${turn.provider}-${identityHash}-${contentHash}` }
}

export async function retainVerifiedTranscriptEnvelope(
  turn: ArchivedTurn,
  config: { baseUrl: string; bank: string; fetchImpl?: (input: string, init?: RequestInit) => Promise<Response> },
): Promise<{ documentId: string; contentHash: string }> {
  const envelope = archiveEnvelope(turn)
  const fetchImpl = config.fetchImpl ?? fetch
  const root = `${config.baseUrl}/v1/default/banks/${encodeURIComponent(config.bank)}`
  const response = await fetchImpl(`${root}/memories`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      items: [{
        content: envelope.content,
        timestamp: turn.message.timestamp ?? 'unset',
        context: 'Exact local CLI transcript message envelope',
        document_id: envelope.documentId,
        update_mode: 'replace',
        tags: ['cli-transcript', turn.provider, turn.message.role, `authorship:${turn.message.authorship}`],
        metadata: {
          provider: turn.provider,
          role: turn.message.role,
          authorship: turn.message.authorship,
          source_path: turn.source.path,
          thread_native_id: turn.thread.nativeId,
          message_native_id: turn.message.nativeId ?? '',
          source_content_hash: turn.message.contentHash,
          envelope_content_hash: envelope.contentHash,
        },
      }],
      async: false,
    }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`Hindsight retain returned HTTP ${response.status}`)
  const documentResponse = await fetchImpl(`${root}/documents/${encodeURIComponent(envelope.documentId)}`, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
  })
  if (!documentResponse.ok) throw new Error(`Hindsight document verification returned HTTP ${documentResponse.status}`)
  const document = await documentResponse.json() as { original_text?: unknown }
  if (document.original_text !== envelope.content || sha256Text(String(document.original_text ?? '')) !== envelope.contentHash) {
    throw new Error(`Hindsight document verification mismatch for ${envelope.documentId}`)
  }
  return { documentId: envelope.documentId, contentHash: envelope.contentHash }
}

export async function verifyHindsightArchiveOnlyConfig(
  config: { baseUrl: string; bank: string; fetchImpl?: (input: string, init?: RequestInit) => Promise<Response> },
): Promise<void> {
  const fetchImpl = config.fetchImpl ?? fetch
  const root = `${config.baseUrl}/v1/default/banks/${encodeURIComponent(config.bank)}`
  const [versionResponse, configResponse] = await Promise.all([
    fetchImpl(`${config.baseUrl}/version`, { signal: AbortSignal.timeout(5_000) }),
    fetchImpl(`${root}/config`, { signal: AbortSignal.timeout(5_000) }),
  ])
  if (!versionResponse.ok || !configResponse.ok) throw new Error('Hindsight archive safety configuration is unavailable')
  const version = await versionResponse.json() as {
    api_version?: unknown
    features?: { observations?: unknown; bank_config_api?: unknown; store_document_text?: unknown }
  }
  const bank = await configResponse.json() as { config?: Record<string, unknown> }
  const effective = bank.config ?? {}
  const safe = version.api_version === '0.9.2'
    && version.features?.observations === false
    && version.features?.bank_config_api === false
    && version.features?.store_document_text === true
    && effective.retain_extraction_mode === 'chunks'
    && effective.store_document_text === true
    && effective.enable_observations === false
    && effective.enable_auto_consolidation === false
  if (!safe) throw new Error('Hindsight refused: effective archive-only/no-LLM safety settings do not match the pinned contract')
}

export type GoogleNativeRow = {
  idx: number
  step_type: number
  metadata: Uint8Array | null
  step_payload: Uint8Array | null
}

type ProtobufField = { number: number; wireType: number; value: number | Uint8Array }

const protobufFields = (value: Uint8Array | null): ProtobufField[] => {
  if (!value) return []
  const bytes = Buffer.from(value)
  const fields: ProtobufField[] = []
  let offset = 0
  const varint = (): number => {
    let result = 0
    let shift = 0
    for (let count = 0; count < 10 && offset < bytes.length; count += 1) {
      const byte = bytes[offset++]
      if (byte === undefined) throw new Error('Truncated protobuf varint')
      result += (byte & 0x7f) * (2 ** shift)
      if ((byte & 0x80) === 0) return result
      shift += 7
    }
    throw new Error('Invalid protobuf varint')
  }
  while (offset < bytes.length) {
    const key = varint()
    const number = Math.floor(key / 8)
    const wireType = key % 8
    if (number < 1) throw new Error('Invalid protobuf field number')
    if (wireType === 0) fields.push({ number, wireType, value: varint() })
    else if (wireType === 1 || wireType === 5) {
      const width = wireType === 1 ? 8 : 4
      if (offset + width > bytes.length) throw new Error('Truncated protobuf fixed field')
      fields.push({ number, wireType, value: bytes.subarray(offset, offset + width) })
      offset += width
    } else if (wireType === 2) {
      const length = varint()
      if (offset + length > bytes.length) throw new Error('Truncated protobuf bytes field')
      fields.push({ number, wireType, value: bytes.subarray(offset, offset + length) })
      offset += length
    } else throw new Error(`Unsupported protobuf wire type ${wireType}`)
  }
  return fields
}

const protobufBytes = (fields: ProtobufField[], fieldNumber: number): Uint8Array | null => {
  const field = fields.find((item) => item.number === fieldNumber && item.wireType === 2)
  return field && typeof field.value !== 'number' ? field.value : null
}

const protobufNumber = (fields: ProtobufField[], fieldNumber: number): number | null => {
  const field = fields.find((item) => item.number === fieldNumber && item.wireType === 0)
  return field && typeof field.value === 'number' ? field.value : null
}

const protobufTextExact = (fields: ProtobufField[], fieldNumber: number): string => {
  const bytes = protobufBytes(fields, fieldNumber)
  return bytes ? Buffer.from(bytes).toString('utf8') : ''
}

const googleTimestamp = (metadata: Uint8Array | null): string | null => {
  try {
    const timestamp = protobufFields(protobufBytes(protobufFields(metadata), 1))
    const seconds = protobufNumber(timestamp, 1)
    const nanos = protobufNumber(timestamp, 2) ?? 0
    return seconds === null ? null : new Date((seconds * 1_000) + (nanos / 1_000_000)).toISOString()
  } catch {
    return null
  }
}

export function parseGoogleNativeRow(
  row: GoogleNativeRow,
  conversationId: string,
  source: SourceIdentity,
  prior: ParserState,
): { state: ParserState; turn: ArchivedTurn | null } {
  if (!row.step_payload) return { state: prior, turn: null }
  const state = { ...prior, sessionId: conversationId }
  const outer = protobufFields(row.step_payload)
  const metadata = protobufFields(row.metadata)
  const nativeId = protobufTextExact(metadata, 12) || null
  if (row.step_type === 14) {
    const input = protobufFields(protobufBytes(outer, 19))
    const text = protobufTextExact(input, 2)
    if (text.length === 0) return { state, turn: null }
    const workspaceUri = protobufTextExact(input, 12)
    if (workspaceUri.startsWith('file://')) {
      try { state.cwd = decodeURIComponent(new URL(workspaceUri).pathname) } catch { state.cwd = null }
    }
    state.exchangeId = nativeId ?? `${conversationId}:${row.idx}`
    return {
      state,
      turn: finishTurn('google', source, row.idx, {
        threadId: conversationId,
        nativeId,
        exchangeNativeId: state.exchangeId,
        role: 'user',
        // Native steps prove role, not who typed it. The readline fuzzy match
        // used by the UI reader is intentionally not an archival assertion.
        authorship: 'unknown',
        authorshipEvidence: 'Native Antigravity user-input step has no explicit human provenance',
        timestamp: googleTimestamp(row.metadata),
        model: null,
        cwd: state.cwd ?? null,
        text,
      }),
    }
  }
  if (row.step_type === 15) {
    const output = protobufFields(protobufBytes(outer, 20))
    const text = protobufTextExact(output, 1)
    if (text.length === 0) return { state, turn: null }
    return {
      state,
      turn: finishTurn('google', source, row.idx, {
        threadId: conversationId,
        nativeId,
        exchangeNativeId: state.exchangeId ?? nativeId,
        role: 'assistant',
        authorship: 'agent',
        authorshipEvidence: 'Native Antigravity model-response step',
        timestamp: googleTimestamp(row.metadata),
        model: null,
        cwd: state.cwd ?? null,
        text,
      }),
    }
  }
  return { state, turn: null }
}
