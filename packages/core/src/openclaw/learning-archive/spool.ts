import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const OPENCLAW_ARCHIVE_SCHEMA_VERSION = 1 as const
const DEFAULT_MAX_MEDIA_BYTES = 64 * 1024 * 1024
const DEFAULT_MAX_RAW_PAYLOAD_BYTES = 16 * 1024 * 1024
const MAX_JSON_DEPTH = 32
const MAX_JSON_ENTRIES = 20_000
const SENSITIVE_KEY = /(?:^|_)(?:authorization|cookie|password|secret|token)(?:$|_)/i

export type ArchiveHook = 'message_received' | 'llm_input' | 'llm_output' | 'before_agent_finalize'
  | 'reply_payload_sending' | 'message_sent' | 'handoff_correlation' | 'history_import' | 'gap'
export type ArchiveDirection = 'user_to_model' | 'model_to_user' | 'internal' | 'unknown'
export type ArchiveStage = 'received' | 'model_input' | 'model_output' | 'finalizing'
  | 'delivery_attempt' | 'delivered' | 'failed' | 'gap' | 'user_facing'
export type ArchiveAuthorship = 'human' | 'agent' | 'system' | 'unknown'
export type ArchiveVisibility = 'intended' | 'delivered' | 'internal' | 'unknown'

export type ArchiveCorrelation = {
  // Live hook extraction intentionally returns a stable projection containing
  // unknown fields as `undefined`; JSON persistence then omits those fields.
  channelId?: string | undefined; channelName?: string | undefined; accountId?: string | undefined; accountName?: string | undefined
  guildId?: string | undefined; guildName?: string | undefined; conversationId?: string | undefined; conversationName?: string | undefined
  threadId?: string | undefined; threadName?: string | undefined; chatId?: string | undefined; chatName?: string | undefined
  senderId?: string | undefined; senderName?: string | undefined; senderUsername?: string | undefined
  senderIsBot?: boolean | undefined; senderIsWebhook?: boolean | undefined; messageId?: string | undefined
  authorshipEvidence?: string | undefined
  providerUpdateId?: string | undefined; providerUpdateKind?: string | undefined; runId?: string | undefined; sessionKey?: string | undefined
  sessionId?: string | undefined; sessionName?: string | undefined; agentId?: string | undefined; agentName?: string | undefined
  codexThreadId?: string | undefined; codexTurnId?: string | undefined
}

export type ArchiveGap = { code: string; detail: string }
export type ArchivePart = {
  ordinal: number
  type: 'text' | 'media'
  role?: 'staged' | 'original' | 'model-input' | 'model-output' | 'delivery'
  text?: string
  textLength?: number
  textOmitted?: boolean
  sha256?: string
  byteLength?: number
  mimeType?: string
  mediaKind?: string
  spoolRelativePath?: string
  captureStatus: 'captured' | 'embedded' | 'remote-pending' | 'missing' | 'refused'
  gapCode?: string
}

export type ArchiveObservation = {
  schemaVersion: typeof OPENCLAW_ARCHIVE_SCHEMA_VERSION
  observationId: string
  dedupeKey: string | null
  hook: ArchiveHook
  observedAt: string
  direction: ArchiveDirection
  stage: ArchiveStage
  authorship: ArchiveAuthorship
  visibility: ArchiveVisibility
  logicalMessageKey: string | null
  correlation: ArchiveCorrelation
  parts: ArchivePart[]
  raw: { event: unknown; context: unknown }
  gaps: ArchiveGap[]
}

export type MediaFact = {
  path?: string; url?: string; contentType?: string; kind?: string; transcribed?: boolean
  messageId?: string; workspaceDir?: string
  /** Exact bytes from a typed base64 content part. Never synthesized from text. */
  base64Data?: string
}

export type SpoolConfig = {
  spoolRoot: string
  approvedLocalRoots: string[]
  maxMediaBytes?: number
  maxRawPayloadBytes?: number
}

export type RemoteMaterializer = (url: string, maxBytes: number) => Promise<{
  path: string; size: number; contentType?: string
}>

type RunLink = {
  schemaVersion: 1; runId: string; logicalMessageKey: string; correlation: ArchiveCorrelation
  updatedAt: string
}

const digest = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const deterministicObservationId = (sourceDedupeKey: string): string => {
  const bytes = Buffer.from(digest(`biztools-learning-archive\0${sourceDedupeKey}`).slice(0, 32), 'hex')
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const within = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
}
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
const identifier = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value
  : typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined
const boolean = (value: unknown): boolean | undefined => typeof value === 'boolean' ? value : undefined
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined
const firstText = (source: Record<string, unknown> | undefined, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = text(source?.[key])
    if (value) return value
  }
  return undefined
}
const stable = (value: unknown): string => {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(',')}}`
}
const hashFile = async (path: string, maxBytes: number): Promise<{ sha256: string; byteLength: number }> => {
  const hash = createHash('sha256')
  let byteLength = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    byteLength += bytes.byteLength
    if (byteLength > maxBytes) throw new Error('stored blob exceeds maxMediaBytes')
    hash.update(bytes)
  }
  return { sha256: hash.digest('hex'), byteLength }
}

function boundedJson(value: unknown, maxBytes: number): { value: unknown; gaps: ArchiveGap[] } {
  let entries = 0
  let redacted = false
  let truncated = false
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH || entries++ > MAX_JSON_ENTRIES) { truncated = true; return '[TRUNCATED]' }
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') return item
    if (typeof item === 'bigint') return item.toString()
    if (Array.isArray(item)) return item.map((child) => visit(child, depth + 1))
    if (typeof item === 'object') {
      const output: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(key)) { output[key] = '[REDACTED]'; redacted = true }
        else output[key] = visit(child, depth + 1)
      }
      return output
    }
    return `[${typeof item}]`
  }
  let output = visit(value, 0)
  if (Buffer.byteLength(stable(output)) > maxBytes) { output = { truncated: true, sha256: digest(stable(output)) }; truncated = true }
  const gaps: ArchiveGap[] = []
  if (redacted) gaps.push({ code: 'raw-sensitive-field-redacted', detail: 'Sensitive-looking raw hook keys were redacted instead of being written to the spool' })
  if (truncated) gaps.push({ code: 'raw-payload-truncated', detail: 'Raw hook payload exceeded the bounded JSON retention contract' })
  return { value: output, gaps }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function durableWriteExclusive(finalPath: string, bytes: Uint8Array): Promise<boolean> {
  await ensurePrivateDirectory(dirname(finalPath))
  const tempPath = join(dirname(finalPath), `.${basename(finalPath)}.${randomUUID()}.tmp`)
  const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally { await handle.close() }
  try {
    await link(tempPath, finalPath)
    const directory = await open(dirname(finalPath), constants.O_RDONLY)
    try { await directory.sync() } finally { await directory.close() }
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  } finally { await unlink(tempPath).catch(() => undefined) }
}

async function durableReplace(finalPath: string, bytes: Uint8Array): Promise<void> {
  await ensurePrivateDirectory(dirname(finalPath))
  const tempPath = join(dirname(finalPath), `.${basename(finalPath)}.${randomUUID()}.tmp`)
  const handle = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  await rename(tempPath, finalPath)
  const directory = await open(dirname(finalPath), constants.O_RDONLY)
  try { await directory.sync() } finally { await directory.close() }
}

export class LearningArchiveSpool {
  readonly root: string
  readonly maxMediaBytes: number
  readonly maxRawPayloadBytes: number
  private approvedRoots: string[] = []
  private readonly runWrites = new Map<string, Promise<void>>()

  constructor(private readonly config: SpoolConfig, private readonly materializeRemote?: RemoteMaterializer) {
    this.root = resolve(config.spoolRoot)
    this.maxMediaBytes = config.maxMediaBytes ?? DEFAULT_MAX_MEDIA_BYTES
    this.maxRawPayloadBytes = config.maxRawPayloadBytes ?? DEFAULT_MAX_RAW_PAYLOAD_BYTES
    if (!isAbsolute(config.spoolRoot)) throw new Error('learning archive spoolRoot must be absolute')
    if (!Number.isSafeInteger(this.maxMediaBytes) || this.maxMediaBytes < 1024 * 1024 || this.maxMediaBytes > 100 * 1024 * 1024) throw new Error('maxMediaBytes must be 1-100 MiB')
    if (!Number.isSafeInteger(this.maxRawPayloadBytes) || this.maxRawPayloadBytes < 64 * 1024 || this.maxRawPayloadBytes > 16 * 1024 * 1024) throw new Error('maxRawPayloadBytes must be 64 KiB-16 MiB')
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.root)
    const rootInfo = await lstat(this.root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(this.root) !== this.root) throw new Error('spoolRoot must be a physical directory')
    this.approvedRoots = (await Promise.all(this.config.approvedLocalRoots.map((path) => realpath(path).catch(() => '')))).filter(Boolean)
    if (this.approvedRoots.length !== this.config.approvedLocalRoots.length) throw new Error('every approvedLocalRoot must exist')
    if (this.approvedRoots.some((path) => within(path, this.root) || within(this.root, path))) throw new Error('spoolRoot and approvedLocalRoots must not overlap')
    await Promise.all(['events', 'blobs', 'correlations/runs', 'correlations/delivery-runs'].map((child) => ensurePrivateDirectory(join(this.root, child))))
  }

  logicalMessageKey(input: {
    channelId?: string | undefined; accountId?: string | undefined
    conversationId?: string | undefined; messageId?: string | undefined
  }): string | null {
    if (input.channelId !== 'discord' || !input.accountId || !input.conversationId || !input.messageId) return null
    return `discord:${encodeURIComponent(input.accountId)}:${encodeURIComponent(input.conversationId)}:${encodeURIComponent(input.messageId)}`
  }

  extractCorrelation(eventValue: unknown, contextValue: unknown): ArchiveCorrelation {
    const event = record(eventValue)
    const context = record(contextValue)
    const metadata = record(event?.metadata)
    const providerUpdate = record(event?.providerUpdate)
    const channelContext = record(context?.channelContext)
    const senderContext = record(channelContext?.sender)
    const chatContext = record(channelContext?.chat)
    const agentChannel = firstText(context, 'messageProvider', 'channel')
    return {
      channelId: agentChannel ?? firstText(context, 'channelId') ?? firstText(event, 'channel'),
      channelName: firstText(metadata, 'channelName', 'ChannelName'),
      accountId: firstText(context, 'accountId') ?? firstText(event, 'accountId'),
      accountName: firstText(metadata, 'accountName', 'AccountName'),
      guildId: firstText(metadata, 'guildId', 'GuildId'), guildName: firstText(metadata, 'guildName', 'GuildName'),
      conversationId: firstText(context, 'conversationId') ?? (agentChannel ? firstText(context, 'channelId') : undefined) ?? firstText(event, 'conversationId'),
      conversationName: firstText(metadata, 'conversationName', 'ConversationName', 'channelName'),
      threadId: identifier(event?.threadId) ?? identifier(metadata?.threadId) ?? identifier(metadata?.ThreadId),
      threadName: firstText(metadata, 'threadName', 'ThreadName', 'topicName'),
      chatId: firstText(context, 'chatId') ?? firstText(chatContext, 'id') ?? firstText(metadata, 'chatId', 'ChatId'),
      chatName: firstText(chatContext, 'name') ?? firstText(metadata, 'chatName', 'ChatName'),
      senderId: firstText(event, 'senderId') ?? firstText(context, 'senderId') ?? firstText(senderContext, 'id'),
      senderName: firstText(event, 'senderName') ?? firstText(senderContext, 'name') ?? firstText(metadata, 'senderName', 'SenderName'),
      senderUsername: firstText(event, 'senderUsername') ?? firstText(senderContext, 'username') ?? firstText(metadata, 'senderUsername', 'SenderUsername'),
      senderIsBot: boolean(senderContext?.isBot) ?? boolean(metadata?.senderBot) ?? boolean(metadata?.isBot),
      senderIsWebhook: boolean(senderContext?.isWebhook) ?? boolean(metadata?.senderWebhook) ?? boolean(metadata?.isWebhook),
      messageId: firstText(event, 'messageId') ?? firstText(context, 'messageId'),
      providerUpdateId: firstText(providerUpdate, 'id'), providerUpdateKind: firstText(providerUpdate, 'kind'),
      runId: firstText(event, 'runId') ?? firstText(context, 'runId'),
      sessionKey: firstText(event, 'sessionKey') ?? firstText(context, 'sessionKey'),
      sessionId: firstText(event, 'sessionId') ?? firstText(context, 'sessionId'),
      sessionName: firstText(context, 'sessionName') ?? firstText(metadata, 'sessionName', 'SessionName'),
      agentId: firstText(context, 'agentId'), agentName: firstText(context, 'agentName') ?? firstText(metadata, 'agentName', 'AgentName'),
      codexThreadId: firstText(event, 'codexThreadId'), codexTurnId: firstText(event, 'turnId', 'codexTurnId'),
    }
  }

  async saveRunLink(runId: string, logicalMessageKey: string, correlation: ArchiveCorrelation): Promise<void> {
    const priorWrite = this.runWrites.get(runId) ?? Promise.resolve()
    const write = priorWrite.then(async () => {
      const prior = await this.loadRunLink(runId)
      const merged: RunLink = { schemaVersion: 1, runId, logicalMessageKey,
        correlation: { ...prior?.correlation, ...Object.fromEntries(Object.entries(correlation).filter(([, value]) => value !== undefined)) },
        updatedAt: new Date().toISOString() }
      await durableReplace(join(this.root, 'correlations', 'runs', `${digest(runId)}.json`), Buffer.from(`${stable(merged)}\n`))
    })
    this.runWrites.set(runId, write)
    try { await write } finally { if (this.runWrites.get(runId) === write) this.runWrites.delete(runId) }
  }

  async loadRunLink(runId?: string): Promise<RunLink | undefined> {
    if (!runId) return
    try {
      const parsed = JSON.parse(await readFile(join(this.root, 'correlations', 'runs', `${digest(runId)}.json`), 'utf8')) as RunLink
      return parsed.schemaVersion === 1 && parsed.runId === runId ? parsed : undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  async markAgentDeliveryRun(runId: string): Promise<void> {
    const path = join(this.root, 'correlations', 'delivery-runs', `${digest(runId)}.json`)
    await durableWriteExclusive(path, Buffer.from(`${stable({ schemaVersion: 1, runId })}\n`))
  }

  async hasAgentDeliveryRun(runId?: string): Promise<boolean> {
    if (!runId) return false
    try {
      const value = JSON.parse(await readFile(join(this.root, 'correlations', 'delivery-runs', `${digest(runId)}.json`), 'utf8')) as { runId?: string }
      return value.runId === runId
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async storeMediaPath(path: string, allowExactPath = false): Promise<{ sha256: string; byteLength: number; spoolRelativePath: string }> {
    const linkInfo = await lstat(path)
    if (!linkInfo.isFile() || linkInfo.isSymbolicLink()) throw new Error('media source is not a regular no-follow file')
    const source = await realpath(path)
    if (!allowExactPath && !this.approvedRoots.some((root) => within(root, source))) throw new Error('media source is outside approved local roots')
    const before = await stat(source)
    if (before.size > this.maxMediaBytes) throw new Error('media source exceeds maxMediaBytes')
    const tempPath = join(this.root, 'blobs', `.${randomUUID()}.tmp`)
    const output = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const hash = createHash('sha256')
    let byteLength = 0
    try {
      for await (const chunk of createReadStream(source, { highWaterMark: 1024 * 1024 })) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        byteLength += bytes.byteLength
        if (byteLength > this.maxMediaBytes) throw new Error('media source grew beyond maxMediaBytes')
        hash.update(bytes)
        await output.write(bytes)
      }
      await output.sync()
    } catch (error) {
      await output.close().catch(() => undefined)
      await rm(tempPath, { force: true })
      throw error
    }
    await output.close()
    const after = await stat(source)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || byteLength !== before.size) {
      await rm(tempPath, { force: true }); throw new Error('media source mutated during capture')
    }
    const sha256 = hash.digest('hex')
    const finalPath = join(this.root, 'blobs', sha256)
    let created = false
    try { await link(tempPath, finalPath); created = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    finally { await rm(tempPath, { force: true }) }
    if (created) {
      const directory = await open(dirname(finalPath), constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
    }
    const stored = await stat(finalPath)
    if (!stored.isFile() || stored.size !== byteLength) throw new Error('content-addressed media blob verification failed')
    const verified = await hashFile(finalPath, this.maxMediaBytes)
    if (verified.sha256 !== sha256 || verified.byteLength !== byteLength) throw new Error('content-addressed media blob hash verification failed')
    return { sha256, byteLength, spoolRelativePath: `blobs/${sha256}` }
  }

  private async storeMediaBytes(bytes: Uint8Array): Promise<{ sha256: string; byteLength: number; spoolRelativePath: string }> {
    if (bytes.byteLength > this.maxMediaBytes) throw new Error('media source exceeds maxMediaBytes')
    const sha256 = digest(bytes)
    const finalPath = join(this.root, 'blobs', sha256)
    await durableWriteExclusive(finalPath, bytes)
    const verified = await hashFile(finalPath, this.maxMediaBytes)
    if (verified.sha256 !== sha256 || verified.byteLength !== bytes.byteLength) throw new Error('content-addressed media blob hash verification failed')
    return { sha256, byteLength: bytes.byteLength, spoolRelativePath: `blobs/${sha256}` }
  }

  private decodeBase64(value: string): Uint8Array {
    const normalized = value.trim().replace(/-/g, '+').replace(/_/g, '/')
    if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) throw new Error('embedded media has malformed base64')
    const estimatedBytes = Math.floor(normalized.replace(/=+$/, '').length * 3 / 4)
    if (estimatedBytes > this.maxMediaBytes) throw new Error('media source exceeds maxMediaBytes')
    const decoded = Buffer.from(normalized, 'base64')
    if (decoded.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) throw new Error('embedded media has malformed base64')
    return decoded
  }

  async captureMedia(fact: MediaFact, ordinal: number, role: ArchivePart['role'], localPathReadable = true): Promise<{ part: ArchivePart; gaps: ArchiveGap[] }> {
    const base: ArchivePart = {
      ordinal, type: 'media', captureStatus: 'missing',
      ...(role === undefined ? {} : { role }),
      ...(fact.contentType === undefined ? {} : { mimeType: fact.contentType }),
      ...(fact.kind === undefined ? {} : { mediaKind: fact.kind }),
    }
    try {
      if (fact.base64Data !== undefined) return { part: { ...base, ...(await this.storeMediaBytes(this.decodeBase64(fact.base64Data))), captureStatus: 'captured' }, gaps: [] }
      if (fact.path && localPathReadable) return { part: { ...base, ...(await this.storeMediaPath(fact.path)), captureStatus: 'captured' }, gaps: [] }
      if (fact.url?.startsWith('data:')) {
        const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(fact.url)
        if (!match?.[2]) return { part: { ...base, captureStatus: 'refused', gapCode: 'embedded-media-encoding-unsupported' },
          gaps: [{ code: 'embedded-media-encoding-unsupported', detail: 'Only bounded base64 data URLs are supported for embedded media capture' }] }
        const mimeType = fact.contentType ?? (match[1] || undefined)
        return { part: { ...base, ...(await this.storeMediaBytes(this.decodeBase64(match[3]!))), ...(mimeType === undefined ? {} : { mimeType }),
          captureStatus: 'captured' }, gaps: [] }
      }
      if (fact.url) {
        const url = new URL(fact.url)
        if (url.protocol !== 'https:' || url.username || url.password
          || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname.toLowerCase())) {
          return { part: { ...base, captureStatus: 'refused', gapCode: 'remote-media-host-refused' },
            gaps: [{ code: 'remote-media-host-refused', detail: 'Only exact HTTPS Discord CDN attachment hosts are eligible for guarded retrieval' }] }
        }
        if (!this.materializeRemote) return { part: { ...base, captureStatus: 'remote-pending', gapCode: 'remote-media-materializer-unavailable' },
          gaps: [{ code: 'remote-media-materializer-unavailable', detail: 'Discord attachment was observed but guarded media retrieval is unavailable' }] }
        const saved = await this.materializeRemote(url.href, this.maxMediaBytes)
        const mimeType = fact.contentType ?? saved.contentType
        return { part: { ...base, ...(await this.storeMediaPath(saved.path, true)), ...(mimeType === undefined ? {} : { mimeType }),
          captureStatus: 'captured' }, gaps: [] }
      }
      if (fact.path && !localPathReadable) return { part: { ...base, captureStatus: 'remote-pending', gapCode: 'original-media-path-not-readable' },
        gaps: [{ code: 'original-media-path-not-readable', detail: 'Pending originalMedia.path is provider-side metadata, not a locally readable path' }] }
      return { part: { ...base, gapCode: 'media-locator-missing' }, gaps: [{ code: 'media-locator-missing', detail: 'Media fact has neither a local path nor a remote URL' }] }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown media capture failure'
      const code = /exceeds|maxMediaBytes|grew/.test(message) ? 'media-oversize' : /outside approved/.test(message) ? 'media-outside-approved-roots'
        : /mutated/.test(message) ? 'media-mutated' : 'media-capture-failed'
      const detail = code === 'media-oversize' ? 'Media exceeded the configured bounded capture size'
        : code === 'media-outside-approved-roots' ? 'Local media path was outside approved roots'
          : code === 'media-mutated' ? 'Media changed during capture' : 'Media capture failed without weakening the archive contract'
      return { part: { ...base, captureStatus: 'refused', gapCode: code }, gaps: [{ code, detail }] }
    }
  }

  async persist(input: Omit<ArchiveObservation, 'schemaVersion' | 'observationId' | 'dedupeKey' | 'observedAt' | 'raw'> & {
    event: unknown; context: unknown; sourceDedupeKey?: string; observedAt?: string
  }): Promise<ArchiveObservation> {
    const rawEvent = boundedJson(input.event, this.maxRawPayloadBytes)
    const rawContext = boundedJson(input.context, this.maxRawPayloadBytes)
    const observedAt = input.observedAt ?? new Date().toISOString()
    const observationId = input.sourceDedupeKey ? deterministicObservationId(input.sourceDedupeKey) : randomUUID()
    // Import retries reread this immutable file and reuse its UUID. Distinct
    // hook dispatches remain distinct raw observations, even when a provider
    // replays the same logical Discord message.
    const dedupeKey = input.sourceDedupeKey ?? observationId
    let observation: ArchiveObservation = {
      schemaVersion: 1, observationId, dedupeKey, hook: input.hook, observedAt,
      direction: input.direction, stage: input.stage, authorship: input.authorship, visibility: input.visibility,
      logicalMessageKey: input.logicalMessageKey,
      correlation: input.correlation, parts: input.parts,
      raw: { event: rawEvent.value, context: rawContext.value }, gaps: [...input.gaps, ...rawEvent.gaps, ...rawContext.gaps],
    }
    if (Buffer.byteLength(stable(observation)) > this.maxRawPayloadBytes) {
      observation = { ...observation,
        raw: { event: { truncated: true, sha256: digest(stable(rawEvent.value)) }, context: { truncated: true, sha256: digest(stable(rawContext.value)) } },
        gaps: [...observation.gaps, { code: 'observation-record-truncated', detail: 'Combined observation exceeded the configured spool record bound; raw values were replaced by digests' }] }
    }
    if (Buffer.byteLength(stable(observation)) > this.maxRawPayloadBytes) {
      observation = { ...observation,
        parts: observation.parts.map((part) => {
          if (part.type !== 'text' || part.text === undefined) return part
          const { text: omitted, ...metadata } = part
          return { ...metadata, sha256: digest(omitted), byteLength: Buffer.byteLength(omitted),
            textLength: omitted.length, textOmitted: true }
        }),
        gaps: [...observation.gaps, { code: 'observation-text-omitted', detail: 'Text parts exceeded the spool record bound and were replaced by length and digest evidence' }] }
    }
    if (Buffer.byteLength(stable(observation)) > this.maxRawPayloadBytes) throw new Error('observation metadata exceeds maxRawPayloadBytes')
    const finalPath = join(this.root, 'events', `${observation.observationId}.json`)
    const encoded = `${stable(observation)}\n`
    if (!await durableWriteExclusive(finalPath, Buffer.from(encoded))) {
      if (!input.sourceDedupeKey) throw new Error('observation UUID collision')
      const existing = await readFile(finalPath, 'utf8')
      if (existing !== encoded) throw new Error('historical observation source key collision')
      return JSON.parse(existing) as ArchiveObservation
    }
    return observation
  }
}
