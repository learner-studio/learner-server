import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { z } from 'zod'
import { assertLearningLocalMvpEnabled } from '../../lib/runtime-flags.js'

export const GetConversationHistoryInput = z.object({
  // HTTP query parameters arrive as strings while RPC callers send numbers.
  // Keep both forms in the generated transport schema. The function below
  // normalizes the string form after transport validation.
  limit: z.union([
    z.number().int().min(1).max(200),
    z.string().regex(/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/),
  ]).optional(),
  // A concept filter is applied to complete exchanges, so a matching user
  // turn keeps its corresponding assistant response in the result.
  conceptId: z.string().min(1).optional(),
})

const ConversationTurnSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  threadTitle: z.string(),
  exchangeId: z.string(),
  sourceRecordId: z.string(),
  sourceOrder: z.number().int().nonnegative(),
  agent: z.string(),
  provider: z.enum(['google', 'anthropic', 'openai']),
  location: z.enum(['local', 'remote']),
  role: z.enum(['user', 'assistant']),
  authorship: z.enum(['human', 'agent', 'system', 'unknown']),
  authorshipEvidence: z.string(),
  text: z.string(),
  timestamp: z.string(),
  model: z.string().nullable(),
  cwd: z.string().nullable(),
})

const ConversationThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  agent: z.string(),
  provider: z.enum(['google', 'anthropic', 'openai']),
  location: z.enum(['local', 'remote']),
  latestAt: z.string(),
  workspacePath: z.string().nullable(),
  folderSegments: z.array(z.string()),
  models: z.array(z.string()).default([]),
  turns: z.array(ConversationTurnSchema),
})

export const GetConversationHistoryOutput = z.object({
  limit: z.number(),
  totalTurns: z.number(),
  threads: z.array(ConversationThreadSchema),
  sources: z.array(z.object({
    provider: z.enum(['google', 'anthropic', 'openai']),
    location: z.enum(['local', 'remote']),
    available: z.boolean(),
    files: z.number(),
    error: z.string().nullable(),
  })),
})

export type ConversationTurn = z.infer<typeof ConversationTurnSchema>
export type ConversationThread = z.infer<typeof ConversationThreadSchema>
export type ConversationHistory = z.infer<typeof GetConversationHistoryOutput>

export function normalizeWorkspacePath(cwd: string | null | undefined): { workspacePath: string | null; folderSegments: string[] } {
  const value = typeof cwd === 'string' ? cwd.trim() : ''
  if (!value) return { workspacePath: null, folderSegments: [] }
  const folderSegments: string[] = []
  for (const segment of value.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      folderSegments.pop()
      continue
    }
    folderSegments.push(segment)
  }
  return { workspacePath: `/${folderSegments.join('/')}`, folderSegments }
}

export function latestWorkspacePath(turns: Pick<ConversationTurn, 'cwd' | 'timestamp'>[]): ReturnType<typeof normalizeWorkspacePath> {
  const latestCwd = [...turns]
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp))
    .reverse()
    .find((turn) => typeof turn.cwd === 'string' && turn.cwd.trim())?.cwd
  return normalizeWorkspacePath(latestCwd)
}

type JsonRecord = Record<string, unknown>

const asRecord = (value: unknown): JsonRecord | null => (
  value !== null && typeof value === 'object' ? value as JsonRecord : null
)

const textFromContent = (content: unknown): string => {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const record = asRecord(block)
      return record && ['text', 'input_text', 'output_text'].includes(String(record.type)) && typeof record.text === 'string'
        ? record.text
        : ''
    })
    .filter(Boolean)
    .join('\n')
    .trim()
}

const timestampOr = (value: unknown, fallback: string): string => {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
  return fallback
}

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

const systemInputPattern = /^<(?:recommended_plugins|environment_context|turn_aborted|system-reminder)\b/i

const anthropicAuthorship = (
  record: JsonRecord,
  text: string,
  isSubagent: boolean,
): Pick<ConversationTurn, 'authorship' | 'authorshipEvidence'> => {
  const origin = asRecord(record.origin)
  const originKind = typeof origin?.kind === 'string' ? origin.kind : null
  const promptSource = typeof record.promptSource === 'string' ? record.promptSource : null
  if (systemInputPattern.test(text) || originKind === 'task-notification' || promptSource === 'system' || typeof record.interruptedMessageId === 'string') {
    return { authorship: 'system', authorshipEvidence: `Anthropic system provenance: ${originKind ?? promptSource ?? 'structured marker'}` }
  }
  if (isSubagent || record.isSidechain === true || typeof record.agentId === 'string' || /<teammate-message\b/i.test(text)) {
    return { authorship: 'agent', authorshipEvidence: 'Anthropic sidechain, subagent, or teammate metadata' }
  }
  if (promptSource === 'sdk' || record.entrypoint === 'sdk-cli') {
    return { authorship: 'agent', authorshipEvidence: 'Anthropic SDK-submitted prompt' }
  }
  if (originKind === 'human' || promptSource === 'typed') {
    return { authorship: 'human', authorshipEvidence: 'Anthropic origin.kind=human or promptSource=typed' }
  }
  return { authorship: 'unknown', authorshipEvidence: 'Anthropic record lacks explicit human provenance' }
}

export function parseAnthropicTranscript(raw: string, filePath: string): ConversationTurn[] {
  const records = raw.split('\n').flatMap((line) => {
    if (!line.trim()) return []
    try {
      const parsed = JSON.parse(line) as unknown
      const record = asRecord(parsed)
      return record ? [record] : []
    } catch {
      return []
    }
  })
  const titles = new Map<string, string>()
  const turns: ConversationTurn[] = []
  const isSubagent = filePath.includes(`${sep}subagents${sep}`)
  const agent = isSubagent ? basename(filePath, '.jsonl') : 'Claude'
  const fallbackTitle = isSubagent
    ? `Claude subagent · ${agent}`
    : basename(dirname(filePath)) || 'Claude conversation'
  let currentExchangeId: string | null = null

  for (const record of records) {
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : null
    if (record.type === 'custom-title' && sessionId && typeof record.customTitle === 'string') {
      titles.set(sessionId, record.customTitle)
    }
  }

  records.forEach((record, index) => {
    const message = asRecord(record.message)
    const attachment = asRecord(record.attachment)
    const attachmentOrigin = asRecord(attachment?.origin)
    const isHumanQueuedPrompt = record.type === 'attachment'
      && attachment?.type === 'queued_command'
      && attachment.commandMode === 'prompt'
      && attachmentOrigin?.kind === 'human'
      && typeof attachment.prompt === 'string'
    const role = message?.role === 'user' || message?.role === 'assistant'
      ? message.role
      : isHumanQueuedPrompt ? 'user' : null
    if (!role || record.isMeta === true) return
    const text = isHumanQueuedPrompt ? String(attachment.prompt).trim() : textFromContent(message?.content)
    if (!text) return
    const threadId = typeof record.sessionId === 'string' ? record.sessionId : fallbackTitle
    if (role === 'user') currentExchangeId = typeof record.uuid === 'string' ? record.uuid : `${filePath}:${index}`
    const fallbackTimestamp = new Date(index).toISOString()
    const authorship = role === 'assistant'
      ? { authorship: 'agent' as const, authorshipEvidence: 'assistant role' }
      : isHumanQueuedPrompt
        ? { authorship: 'human' as const, authorshipEvidence: 'Anthropic queued command origin.kind=human and commandMode=prompt' }
      : anthropicAuthorship(record, text, isSubagent)
    turns.push({
      id: typeof record.uuid === 'string' ? record.uuid : `${filePath}:${index}`,
      threadId,
      threadTitle: titles.get(threadId) ?? fallbackTitle,
      exchangeId: currentExchangeId ?? `${filePath}:${index}`,
      sourceRecordId: `${filePath}:${index}`,
      sourceOrder: index,
      agent,
      provider: 'anthropic',
      location: 'local',
      role,
      ...authorship,
      text,
      timestamp: timestampOr(record.timestamp, fallbackTimestamp),
      model: firstString(message?.model, record.model),
      cwd: typeof record.cwd === 'string' ? record.cwd : null,
    })
  })
  return turns
}

export function parseOpenAIHistory(raw: string): ConversationTurn[] {
  return raw.split('\n').flatMap((line, index) => {
    if (!line.trim()) return []
    try {
      const record = asRecord(JSON.parse(line))
      if (!record || typeof record.text !== 'string' || !record.text.trim()) return []
      const threadId = typeof record.session_id === 'string' ? record.session_id : 'openai-history'
      const seconds = typeof record.ts === 'number' ? record.ts : index
      const timestamp = new Date(seconds * 1000).toISOString()
      return [{
        id: `openai:${threadId}:${index}`,
        threadId,
        threadTitle: 'OpenAI / Codex history',
        exchangeId: `openai:${threadId}:${index}`,
        sourceRecordId: `openai-history:${threadId}:${index}`,
        sourceOrder: index,
        agent: 'Codex',
        provider: 'openai' as const,
        location: 'local' as const,
        role: 'user' as const,
        authorship: 'human' as const,
        authorshipEvidence: 'OpenAI readline history records submitted prompts only',
        text: record.text.trim(),
        timestamp,
        model: firstString(record.model),
        cwd: null,
      }]
    } catch {
      return []
    }
  })
}

export function parseAnthropicHistory(raw: string): ConversationTurn[] {
  return raw.split('\n').flatMap((line, index) => {
    if (!line.trim()) return []
    try {
      const record = asRecord(JSON.parse(line))
      const sessionId = firstString(record?.sessionId) ?? `claude-history-${index}`
      const pasted = asRecord(record?.pastedContents)
      let text = firstString(record?.display) ?? ''
      text = text.replace(/\[Pasted text #(\d+)[^\]]*\]/g, (marker, id: string) => {
        const item = asRecord(pasted?.[id])
        return firstString(item?.content) ?? marker
      }).trim()
      if (!text || text.startsWith('/')) return []
      const timestamp = typeof record?.timestamp === 'number'
        ? new Date(record.timestamp).toISOString()
        : new Date(index).toISOString()
      const project = firstString(record?.project)
      return [{
        id: `claude-history:${sessionId}:${record?.timestamp ?? index}`,
        threadId: `claude-history:${sessionId}`,
        threadTitle: 'Anthropic / Claude · submitted prompts',
        exchangeId: `claude-history:${sessionId}:${record?.timestamp ?? index}`,
        sourceRecordId: `claude-history:${sessionId}:${index}`,
        sourceOrder: index,
        agent: 'Claude',
        provider: 'anthropic' as const,
        location: 'local' as const,
        role: 'user' as const,
        authorship: 'human' as const,
        authorshipEvidence: 'Anthropic readline history records submitted prompts only',
        text,
        timestamp,
        model: null,
        cwd: project?.startsWith('/') ? project : null,
      }]
    } catch {
      return []
    }
  })
}

const parseJsonlRecords = (raw: string): JsonRecord[] => raw.split('\n').flatMap((line) => {
  if (!line.trim()) return []
  try {
    const record = asRecord(JSON.parse(line))
    return record ? [record] : []
  } catch {
    return []
  }
})

// The history view only needs the newest completed exchanges. A bounded tail
// avoids turning every five-second refresh into a multi-hundred-megabyte JSONL
// parse while still covering several recent turns in each session file.
const HISTORY_TAIL_BYTES = 512 * 1024

async function readTail(filePath: string, maxBytes = HISTORY_TAIL_BYTES): Promise<string> {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const byteCount = Math.min(Number(size), maxBytes)
    const buffer = Buffer.alloc(byteCount)
    await handle.read(buffer, 0, byteCount, Number(size) - byteCount)
    const raw = buffer.toString('utf8')
    if (Number(size) <= maxBytes) return raw
    const firstLineBreak = raw.indexOf('\n')
    // The first line may be truncated at the beginning of the tail. Discard it
    // so a partial JSON record can never make the rest of the tail unusable.
    return firstLineBreak === -1 ? raw : raw.slice(firstLineBreak + 1)
  } finally {
    await handle.close()
  }
}

export async function readOpenAISessionSlice(filePath: string, maxBytes = HISTORY_TAIL_BYTES): Promise<string> {
  const tail = await readTail(filePath, maxBytes)
  if (tail.includes('"type":"session_meta"') || tail.includes('"type": "session_meta"')) return tail
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const head = buffer.subarray(0, bytesRead).toString('utf8')
    const lineBreak = head.indexOf('\n')
    const firstLine = lineBreak === -1 ? head : head.slice(0, lineBreak)
    return firstLine.includes('session_meta') ? `${firstLine}\n${tail}` : tail
  } finally {
    await handle.close()
  }
}

async function listJsonlFiles(root: string, depth = 0): Promise<string[]> {
  if (depth > 5) return []
  const entries = await readdir(root, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const filePath = join(root, entry.name)
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(filePath)
    if (entry.isDirectory()) files.push(...await listJsonlFiles(filePath, depth + 1).catch(() => []))
  }
  return files
}

async function listRecentJsonlFiles(root: string): Promise<string[]> {
  const files = await listJsonlFiles(root)
  const withStats = await Promise.all(files.map(async (filePath) => {
    try {
      const details = await stat(filePath)
      return { filePath, modifiedAt: details.mtimeMs }
    } catch {
      return null
    }
  }))
  return withStats
    .filter((entry): entry is { filePath: string; modifiedAt: number } => entry !== null)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .map(({ filePath }) => filePath)
}

const exchangeKey = (turn: ConversationTurn): string => [
  turn.provider,
  turn.location,
  turn.threadId,
  turn.agent,
  turn.exchangeId,
].join(':')

const completedExchangeCount = (turns: ConversationTurn[]): number => {
  const exchanges = new Map<string, { user: boolean; assistant: boolean }>()
  for (const turn of turns) {
    const exchange = exchanges.get(exchangeKey(turn)) ?? { user: false, assistant: false }
    exchange[turn.role] = true
    exchanges.set(exchangeKey(turn), exchange)
  }
  return [...exchanges.values()].filter((exchange) => exchange.user && exchange.assistant).length
}

async function readRecentTurns(
  files: string[],
  limit: number,
  parse: (raw: string, filePath: string) => ConversationTurn[],
  tailBytes: (filePath: string) => number = () => HISTORY_TAIL_BYTES,
  readSlice: (filePath: string, maxBytes: number) => Promise<string> = readTail,
): Promise<{ turns: ConversationTurn[]; error: string | null }> {
  const turns: ConversationTurn[] = []
  let firstError: string | null = null
  for (const filePath of files) {
    try {
      turns.push(...parse(await readSlice(filePath, tailBytes(filePath)), filePath))
    } catch (error) {
      firstError ??= error instanceof Error ? error.message : String(error)
    }
    // Files are newest first. Once the requested number of complete exchanges
    // is present, older files cannot change the newest result and are skipped.
    const verifiedHumanInputs = turns.filter((turn) => turn.role === 'user' && turn.authorship === 'human').length
    if (completedExchangeCount(turns) >= limit && verifiedHumanInputs >= Math.min(limit, 5)) break
  }
  return { turns, error: firstError }
}

async function readAnthropicTurns(root: string, historyPath: string, limit: number, transcriptTailBytes = 8 * 1024 * 1024): Promise<{ turns: ConversationTurn[]; files: number; error: string | null }> {
  try {
    const files = await listRecentJsonlFiles(root)
    // Root Claude sessions can interleave long-running agent activity with
    // sparse, explicitly human queued prompts. Read a larger bounded tail for
    // those sessions so the provenance sample does not silently favor agents;
    // subagent logs retain the small history-view tail.
    const recent = await readRecentTurns(
      files,
      limit,
      parseAnthropicTranscript,
      (filePath) => filePath.includes(`${sep}subagents${sep}`) ? HISTORY_TAIL_BYTES : transcriptTailBytes,
    )
    const submitted = await readTail(historyPath).then(parseAnthropicHistory).catch(() => [])
    return { turns: [...recent.turns, ...submitted], files: files.length + (submitted.length ? 1 : 0), error: recent.error }
  } catch (error) {
    return { turns: [], files: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

export function parseOpenAISession(raw: string, filePath: string): ConversationTurn[] {
  const records = parseJsonlRecords(raw)
  const metadata = records.find((record) => record.type === 'session_meta')
  const payload = asRecord(metadata?.payload)
  const sessionId = typeof payload?.session_id === 'string' ? payload.session_id : basename(filePath, '.jsonl')
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd : null
  const originator = typeof payload?.originator === 'string' ? payload.originator : null
  const cwdName = cwd ? basename(cwd) : 'history'
  const threadTitle = `OpenAI / Codex · ${cwdName}`
  const turns: ConversationTurn[] = []
  let currentExchangeId: string | null = null

  records.forEach((record, index) => {
    if (record.type !== 'response_item') return
    const message = asRecord(record)
    const response = asRecord(message?.payload)
    if (response?.type !== 'message' || (response.role !== 'user' && response.role !== 'assistant')) return
    const passthrough = asRecord(response.internal_chat_message_metadata_passthrough)
    const contentKinds = Array.isArray(passthrough?.content_item_kinds)
      ? passthrough.content_item_kinds.map(String)
      : []
    const allText = textFromContent(response.content)
    const content = Array.isArray(response.content) ? response.content : []
    const humanText = content.map((block, blockIndex) => {
      const kind = contentKinds[blockIndex]
      if (kind !== 'user.text') return ''
      const item = asRecord(block)
      return typeof item?.text === 'string' ? item.text : ''
    }).filter(Boolean).join('\n').trim()
    const text = response.role === 'user' && originator === 'codex-tui' && humanText ? humanText : allText
    if (!text) return
    const turnId = typeof passthrough?.turn_id === 'string' ? passthrough.turn_id : null
    if (response.role === 'user') currentExchangeId = turnId ?? `${sessionId}:${index}`
    const exchangeId = turnId ?? currentExchangeId ?? `${sessionId}:${index}`
    turns.push({
      id: typeof response.id === 'string' ? response.id : `${filePath}:${index}`,
      threadId: sessionId,
      threadTitle,
      exchangeId,
      sourceRecordId: `${filePath}:${index}`,
      sourceOrder: index,
      agent: 'Codex',
      provider: 'openai',
      location: 'local',
      role: response.role,
      authorship: response.role === 'assistant'
        ? 'agent'
        : systemInputPattern.test(text) || !contentKinds.includes('user.text')
          ? 'system'
          : originator === 'codex-tui' ? 'human' : originator === 'codex-lane' ? 'agent' : 'unknown',
      authorshipEvidence: response.role === 'assistant'
        ? 'assistant role'
        : `OpenAI originator=${originator ?? 'missing'}; kinds=${contentKinds.join(',') || 'missing'}`,
      text,
      timestamp: timestampOr(record.timestamp, new Date(index).toISOString()),
      model: firstString(response.model, record.model),
      cwd,
    })
  })
  return turns
}

export function parseGoogleHistory(raw: string): ConversationTurn[] {
  return raw.split('\n').flatMap((line, index) => {
    if (!line.trim()) return []
    try {
      const record = asRecord(JSON.parse(line))
      if (!record) return []
      const text = typeof record.display === 'string' ? record.display.trim() : ''
      const conversationId = typeof record.conversationId === 'string' ? record.conversationId : null
      if (!text || !conversationId || record.type === 'slash_command') return []
      const timestampMs = typeof record.timestamp === 'number' ? record.timestamp : index
      const id = `google:${conversationId}:${timestampMs}:${index}`
      return [{
        id,
        threadId: conversationId,
        threadTitle: 'Google / Antigravity conversation',
        exchangeId: id,
        sourceRecordId: `google-history:${conversationId}:${index}`,
        sourceOrder: index,
        agent: 'Antigravity',
        provider: 'google' as const,
        location: 'local' as const,
        role: 'user' as const,
        authorship: 'human' as const,
        authorshipEvidence: 'Antigravity readline history prompt; slash commands excluded',
        text,
        timestamp: new Date(timestampMs).toISOString(),
        model: null,
        cwd: typeof record.workspace === 'string' ? record.workspace : null,
      }]
    } catch {
      return []
    }
  })
}

export type AntigravityStepRow = {
  idx: number
  step_type: number
  status: number
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
    else if (wireType === 1) {
      if (offset + 8 > bytes.length) throw new Error('Truncated fixed64 field')
      fields.push({ number, wireType, value: bytes.subarray(offset, offset + 8) })
      offset += 8
    } else if (wireType === 2) {
      const length = varint()
      if (length < 0 || offset + length > bytes.length) throw new Error('Truncated protobuf bytes field')
      fields.push({ number, wireType, value: bytes.subarray(offset, offset + length) })
      offset += length
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) throw new Error('Truncated fixed32 field')
      fields.push({ number, wireType, value: bytes.subarray(offset, offset + 4) })
      offset += 4
    } else throw new Error(`Unsupported protobuf wire type ${wireType}`)
  }
  return fields
}

const protobufBytes = (fields: ProtobufField[], number: number): Uint8Array | null => {
  const field = fields.find((item) => item.number === number && item.wireType === 2)
  return field && typeof field.value !== 'number' ? field.value : null
}

const protobufNumber = (fields: ProtobufField[], number: number): number | null => {
  const field = fields.find((item) => item.number === number && item.wireType === 0)
  return field && typeof field.value === 'number' ? field.value : null
}

const protobufText = (fields: ProtobufField[], number: number): string => {
  const bytes = protobufBytes(fields, number)
  return bytes ? Buffer.from(bytes).toString('utf8').trim() : ''
}

const antigravityTimestamp = (metadata: Uint8Array | null, fallbackIndex: number): string => {
  try {
    const timestamp = protobufFields(protobufBytes(protobufFields(metadata), 1))
    const seconds = protobufNumber(timestamp, 1)
    const nanos = protobufNumber(timestamp, 2) ?? 0
    if (seconds !== null) return new Date((seconds * 1_000) + (nanos / 1_000_000)).toISOString()
  } catch {
    // A malformed row is retained with a stable fallback timestamp; its text
    // parser below can still recover an otherwise valid conversation turn.
  }
  return new Date(fallbackIndex).toISOString()
}

const normalizedPrompt = (value: string): string => value.replace(/\s+/g, ' ').trim()

export function parseAntigravityNativeRows(
  conversationId: string,
  rows: AntigravityStepRow[],
  readlineTurns: ConversationTurn[],
): ConversationTurn[] {
  const humanLedger = new Map<string, ConversationTurn[]>()
  for (const turn of readlineTurns.filter((item) => item.threadId === conversationId && item.authorship === 'human')) {
    const key = normalizedPrompt(turn.text)
    const matches = humanLedger.get(key) ?? []
    matches.push(turn)
    humanLedger.set(key, matches)
  }
  const consumedHumanIds = new Set<string>()
  const turns: ConversationTurn[] = []
  let currentExchangeId: string | null = null
  let workspacePath: string | null = null

  for (const row of rows) {
    if (!row.step_payload) continue
    try {
      const outer = protobufFields(row.step_payload)
      const timestamp = antigravityTimestamp(row.metadata, row.idx)
      const metadata = protobufFields(row.metadata)
      const stableId = protobufText(metadata, 12) || `${conversationId}:${row.idx}`
      if (row.step_type === 14) {
        const userInput = protobufFields(protobufBytes(outer, 19))
        const text = protobufText(userInput, 2)
        if (!text) continue
        const workspaceUri = protobufText(userInput, 12)
        if (workspaceUri.startsWith('file://')) {
          try { workspacePath = decodeURIComponent(new URL(workspaceUri).pathname) } catch { workspacePath = null }
        }
        const candidates = humanLedger.get(normalizedPrompt(text)) ?? []
        const matched = candidates
          .filter((item) => !consumedHumanIds.has(item.id))
          .sort((left, right) => Math.abs(Date.parse(left.timestamp) - Date.parse(timestamp)) - Math.abs(Date.parse(right.timestamp) - Date.parse(timestamp)))
          .find((item) => Math.abs(Date.parse(item.timestamp) - Date.parse(timestamp)) <= 5_000)
        if (matched) consumedHumanIds.add(matched.id)
        currentExchangeId = stableId
        turns.push({
          id: `google-native:${conversationId}:${stableId}`,
          threadId: conversationId,
          threadTitle: `Google / Antigravity · ${workspacePath ? basename(workspacePath) : conversationId.slice(0, 8)}`,
          exchangeId: stableId,
          sourceRecordId: `google-native:${conversationId}:${row.idx}`,
          sourceOrder: row.idx,
          agent: 'Antigravity',
          provider: 'google',
          location: 'local',
          role: 'user',
          authorship: matched ? 'human' : 'unknown',
          authorshipEvidence: matched
            ? 'Native Antigravity user-input step matched TUI readline submission by conversation, normalized text, and timestamp'
            : 'Native Antigravity user-input step has no matching TUI readline submission',
          text,
          timestamp,
          model: null,
          cwd: workspacePath,
        })
      } else if (row.step_type === 15) {
        const modelResponse = protobufFields(protobufBytes(outer, 20))
        const text = protobufText(modelResponse, 1)
        if (!text) continue
        turns.push({
          id: `google-native:${conversationId}:${stableId}`,
          threadId: conversationId,
          threadTitle: `Google / Antigravity · ${workspacePath ? basename(workspacePath) : conversationId.slice(0, 8)}`,
          exchangeId: currentExchangeId ?? stableId,
          sourceRecordId: `google-native:${conversationId}:${row.idx}`,
          sourceOrder: row.idx,
          agent: 'Antigravity',
          provider: 'google',
          location: 'local',
          role: 'assistant',
          authorship: 'agent',
          authorshipEvidence: 'Native Antigravity model-response step',
          text,
          timestamp,
          model: null,
          cwd: workspacePath,
        })
      }
    } catch {
      // Individual native rows can be partially written while Antigravity is
      // active. Skip only that row; SQLite/WAL and later refreshes recover it.
    }
  }
  return turns
}

async function readGoogleTurns(conversationRoot: string, historyPath: string): Promise<{ turns: ConversationTurn[]; files: number; error: string | null }> {
  try {
    // Pikku's schema scanner loads this module under Node, while the live
    // function runs under Bun. Keep Bun's native SQLite driver behind the
    // runtime boundary so schema generation can still inspect the Zod types.
    const { Database } = await import('bun:sqlite')
    const readlineTurns = parseGoogleHistory(await readTail(historyPath))
    const entries = await readdir(conversationRoot, { withFileTypes: true }).catch(() => [])
    const databasePaths = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.db'))
      .map((entry) => join(conversationRoot, entry.name))
    const nativeTurns: ConversationTurn[] = []
    let firstError: string | null = null
    for (const databasePath of databasePaths) {
      try {
        const database = new Database(databasePath, { readonly: true })
        try {
          const rows = database.query<AntigravityStepRow, []>('SELECT idx, step_type, status, metadata, step_payload FROM steps ORDER BY idx').all()
          nativeTurns.push(...parseAntigravityNativeRows(basename(databasePath, '.db'), rows, readlineTurns))
        } finally {
          database.close()
        }
      } catch (error) {
        firstError ??= error instanceof Error ? error.message : String(error)
      }
    }
    return {
      turns: nativeTurns.length ? nativeTurns : readlineTurns,
      files: databasePaths.length || 1,
      error: firstError,
    }
  } catch (error) {
    return { turns: [], files: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

async function readOpenAITurns(sessionRoot: string, historyPath: string, limit: number, tailBytes = HISTORY_TAIL_BYTES): Promise<{ turns: ConversationTurn[]; files: number; error: string | null }> {
  try {
    const sessionFiles = await listRecentJsonlFiles(sessionRoot)
    if (sessionFiles.length > 0) {
      const recent = await readRecentTurns(sessionFiles, limit, parseOpenAISession, () => tailBytes, readOpenAISessionSlice)
      const submitted = await readTail(historyPath).then(parseOpenAIHistory).catch(() => [])
      return { turns: [...recent.turns, ...submitted], files: sessionFiles.length + (submitted.length ? 1 : 0), error: recent.error }
    }
    return { turns: parseOpenAIHistory(await readTail(historyPath)), files: 1, error: null }
  } catch (error) {
    return { turns: [], files: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

const selectCompletedExchanges = (allTurns: ConversationTurn[], limit: number): ConversationTurn[] => {
  const exchanges = new Map<string, ConversationTurn[]>()
  for (const turn of allTurns) {
    const key = exchangeKey(turn)
    const turns = exchanges.get(key) ?? []
    turns.push(turn)
    exchanges.set(key, turns)
  }
  const selectedKeys = [...exchanges.entries()]
    .filter(([, turns]) => (
      turns.some((turn) => turn.role === 'user')
      && (turns.some((turn) => turn.role === 'assistant') || turns.some((turn) => (
        turn.provider === 'google'
        || turn.authorshipEvidence.endsWith('readline history records submitted prompts only')
      )))
    ))
    .sort(([, left], [, right]) => {
      const leftLatest = left[left.length - 1]?.timestamp ?? ''
      const rightLatest = right[right.length - 1]?.timestamp ?? ''
      return rightLatest.localeCompare(leftLatest)
    })
    .slice(0, limit)
    .map(([key]) => key)
  const selected = new Set(selectedKeys)
  return allTurns.filter((turn) => selected.has(exchangeKey(turn)))
}

const normalizedConceptText = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

const conceptSearchTerms = (conceptId: string): string[] => {
  const atomicId = conceptId.split('--').at(-1) ?? conceptId
  return [normalizedConceptText(atomicId.replace(/-/g, ' '))].filter(Boolean)
}

const turnMatchesConcept = (turn: ConversationTurn, terms: string[]): boolean => {
  const text = ` ${normalizedConceptText(turn.text)} `
  return terms.some((term) => text.includes(` ${term} `))
}

export const filterConceptExchanges = (allTurns: ConversationTurn[], conceptId: string): ConversationTurn[] => {
  const terms = conceptSearchTerms(conceptId)
  if (terms.length === 0) return []
  const exchanges = new Map<string, ConversationTurn[]>()
  for (const turn of allTurns) {
    const key = exchangeKey(turn)
    const exchange = exchanges.get(key) ?? []
    exchange.push(turn)
    exchanges.set(key, exchange)
  }
  return [...exchanges.values()]
    .filter((exchange) => exchange.some((turn) => turnMatchesConcept(turn, terms)))
    .flat()
}

async function readRemoteTurns(url: string, limit: number, conceptId?: string): Promise<{ turns: ConversationTurn[]; files: number; error: string | null }> {
  try {
    const remoteUrl = new URL(url)
    remoteUrl.searchParams.set('limit', String(limit))
    remoteUrl.searchParams.set('location', 'local')
    if (conceptId) remoteUrl.searchParams.set('conceptId', conceptId)
    const headers: Record<string, string> = { accept: 'application/json' }
    if (process.env.LEARNING_REMOTE_HISTORY_API_KEY) headers['x-api-key'] = process.env.LEARNING_REMOTE_HISTORY_API_KEY
    const response = await fetch(remoteUrl, { headers, signal: AbortSignal.timeout(2500) })
    if (!response.ok) throw new Error(`Remote history returned HTTP ${response.status}`)
    const parsed = GetConversationHistoryOutput.safeParse(await response.json())
    if (!parsed.success) throw new Error('Remote history returned an invalid conversation-history shape')
    const turns = parsed.data.threads.flatMap((thread) => thread.turns).map((turn) => ({ ...turn, location: 'remote' as const }))
    return { turns, files: 1, error: null }
  } catch (error) {
    return { turns: [], files: 0, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function readConversationHistory(
  limit = 50,
  conceptId?: string,
  options: { transcriptTailBytes?: number; includeIncomplete?: boolean } = {},
): Promise<ConversationHistory> {
  const home = homedir()
  const remoteUrl = process.env.LEARNING_REMOTE_HISTORY_URL
  const [google, anthropic, openai, remote] = await Promise.all([
    readGoogleTurns(
      process.env.LEARNING_GOOGLE_CONVERSATION_ROOT ?? join(home, '.gemini', 'antigravity-cli', 'conversations'),
      process.env.LEARNING_GOOGLE_HISTORY_FILE ?? join(home, '.gemini', 'antigravity-cli', 'history.jsonl'),
    ),
    readAnthropicTurns(
      process.env.LEARNING_ANTHROPIC_LOG_ROOT ?? join(home, '.claude', 'projects'),
      process.env.LEARNING_ANTHROPIC_HISTORY_FILE ?? join(home, '.claude', 'history.jsonl'),
      limit,
      options.transcriptTailBytes,
    ),
    readOpenAITurns(
      process.env.LEARNING_OPENAI_SESSION_ROOT ?? join(home, '.codex', 'sessions'),
      process.env.LEARNING_OPENAI_HISTORY_FILE ?? join(home, '.codex', 'history.jsonl'),
      limit,
      options.transcriptTailBytes,
    ),
    remoteUrl ? readRemoteTurns(remoteUrl, limit, conceptId) : Promise.resolve({ turns: [], files: 0, error: null }),
  ])
  const allTurns = [...google.turns, ...anthropic.turns, ...openai.turns, ...remote.turns]
  const conceptTurns = conceptId ? filterConceptExchanges(allTurns, conceptId) : allTurns
  // Offline chronology audits need incomplete user boundaries so they can
  // reject gaps instead of accidentally joining the exchanges around them.
  // The public history RPC keeps its existing completed-exchange behavior.
  const turns = options.includeIncomplete ? conceptTurns : selectCompletedExchanges(conceptTurns, limit)
  const threadMap = new Map<string, ConversationThread>()
  for (const turn of turns) {
    const key = `${turn.provider}:${turn.location}:${turn.threadId}:${turn.agent}`
    const existing = threadMap.get(key)
    if (existing) {
      existing.turns.push(turn)
      continue
    }
    threadMap.set(key, {
      id: key,
      title: turn.threadTitle,
      agent: turn.agent,
      provider: turn.provider,
      location: turn.location,
      latestAt: turn.timestamp,
      ...normalizeWorkspacePath(turn.cwd),
      models: turn.model ? [turn.model] : [],
      turns: [turn],
    })
  }
  const threads = [...threadMap.values()]
    .map((thread) => ({
      ...thread,
      models: [...new Set(thread.turns.flatMap((turn) => turn.model ? [turn.model] : []))],
      turns: [...thread.turns].sort((left, right) => left.timestamp.localeCompare(right.timestamp)),
    }))
    .map((thread) => {
      return { ...thread, ...latestWorkspacePath(thread.turns) }
    })
    .sort((left, right) => right.latestAt.localeCompare(left.latestAt))
  return {
    limit,
    totalTurns: turns.length,
    threads,
    sources: [
      { provider: 'google', location: 'local', available: google.files > 0, files: google.files, error: google.error },
      { provider: 'anthropic', location: 'local', available: anthropic.files > 0, files: anthropic.files, error: anthropic.error },
      { provider: 'openai', location: 'local', available: openai.files > 0, files: openai.files, error: openai.error },
      { provider: 'anthropic', location: 'remote', available: remote.files > 0, files: remote.files, error: remote.error },
      { provider: 'openai', location: 'remote', available: remote.files > 0, files: remote.files, error: remote.error },
    ],
  }
}

