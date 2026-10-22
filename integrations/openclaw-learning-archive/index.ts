import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { saveMediaSource } from 'openclaw/plugin-sdk/media-store'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { LearningArchiveSpool, type ArchiveCorrelation, type ArchiveGap, type ArchivePart, type MediaFact, type SpoolConfig } from './spool.js'

const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {}
const string = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
const integer = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
const definedCorrelation = (value: ArchiveCorrelation): ArchiveCorrelation => Object.fromEntries(
  Object.entries(value).filter(([, child]) => child !== undefined),
) as ArchiveCorrelation
const mediaFacts = (value: unknown): MediaFact[] => Array.isArray(value) ? value.flatMap((item) => {
  const row = asRecord(item)
  return [{ path: string(row.path), url: string(row.url), contentType: string(row.contentType), kind: string(row.kind),
    transcribed: row.transcribed === true, messageId: string(row.messageId), workspaceDir: string(row.workspaceDir) }]
}) : []

const mediaFactFromContentPart = (value: unknown): MediaFact | undefined => {
  const part = asRecord(value)
  const source = asRecord(part.source)
  const type = string(part.type)
  const sourceType = string(source.type)
  const kind = ['image', 'audio', 'video', 'file'].includes(type ?? '') ? type : undefined
  const contentType = string(part.mimeType) ?? string(part.media_type) ?? string(source.mediaType) ?? string(source.media_type)
  const locator = string(part.url) ?? string(part.mediaUrl) ?? string(part.path) ?? string(part.filePath)
    ?? string(asRecord(part.image_url).url) ?? (typeof part.image_url === 'string' ? part.image_url : undefined)
    ?? string(source.url) ?? string(source.path)
  if (locator) return { ...(locator.startsWith('http') || locator.startsWith('data:') ? { url: locator } : { path: locator }), contentType, kind }
  const base64Data = string(part.base64) ?? ((type === 'base64' || kind) ? string(part.data) : undefined)
    ?? (sourceType === 'base64' ? string(source.data) : undefined)
  return base64Data ? { base64Data, contentType, kind } : undefined
}

const embeddedContentMedia = (value: unknown): { facts: MediaFact[]; gaps: ArchiveGap[] } => {
  const roots = Array.isArray(value) ? value : [value]
  const facts: MediaFact[] = []
  const gaps: ArchiveGap[] = []
  let examined = 0
  for (const rootValue of roots) {
    const root = asRecord(rootValue)
    const parts = Array.isArray(root.contentParts) ? root.contentParts : Array.isArray(root.content) ? root.content : []
    for (const part of parts) {
      if (++examined > 256) {
        gaps.push({ code: 'embedded-content-parts-oversize', detail: 'More than 256 typed content parts were exposed; the bounded metadata pass stopped' })
        return { facts, gaps }
      }
      const fact = mediaFactFromContentPart(part)
      const row = asRecord(part)
      const mediaLike = ['image', 'audio', 'video', 'file', 'base64', 'image_url'].includes(string(row.type) ?? '')
      if (fact) facts.push(fact)
      else if (mediaLike) gaps.push({ code: 'embedded-media-shape-unsupported', detail: 'A typed media content part did not expose a supported path, URL, data URL, or base64 source' })
    }
  }
  return { facts, gaps }
}

const deliveryMediaFacts = (payload: Record<string, unknown>): { facts: MediaFact[]; gaps: ArchiveGap[] } => {
  const attachments = Array.isArray(payload.attachments) ? payload.attachments.map(asRecord) : []
  const primary = (Array.isArray(payload.mediaUrls) ? payload.mediaUrls.map(string).filter((value): value is string => Boolean(value)) : [])
  if (!primary.length && string(payload.mediaUrl)) primary.push(string(payload.mediaUrl)!)
  const facts: MediaFact[] = []
  const gaps: ArchiveGap[] = []
  const seen = new Set<string>()
  const add = (locator: string, attachment?: Record<string, unknown>) => {
    if (seen.has(locator)) return
    seen.add(locator)
    facts.push({ ...(locator.startsWith('http') || locator.startsWith('data:') ? { url: locator } : { path: locator }),
      contentType: string(attachment?.mimeType), kind: string(attachment?.type) })
  }
  primary.forEach((locator, index) => add(locator, attachments[index]))
  attachments.forEach((attachment) => {
    const locator = string(attachment.path) ?? string(attachment.url) ?? string(attachment.mediaUrl) ?? string(attachment.filePath)
    if (locator) {
      add(locator, attachment)
      if (!primary.length) gaps.push({ code: 'delivery-attachment-not-routed', detail: 'Attachment metadata exposed a locator but no mediaUrl or mediaUrls transport entry; delivery is not asserted' })
    }
    else gaps.push({ code: 'delivery-attachment-locator-missing', detail: 'Reply attachment metadata had no path, URL, mediaUrl, or filePath locator' })
  })
  if (payload.sensitiveMedia === true && facts.length) gaps.push({ code: 'sensitive-media-upstream-not-durable', detail: 'OpenClaw marks this media live-only; archive capture is independent and provider recovery may be unavailable' })
  return { facts, gaps }
}

const codexFinalizationHandoff = (event: Record<string, unknown>): { messageId?: string; gap?: ArchiveGap } => {
  const turnId = string(event.turnId)
  if (!turnId || !Array.isArray(event.messages)) return { gap: { code: 'codex-handoff-receipt-missing', detail: 'Finalization did not expose a Codex turn ID and prompt snapshot' } }
  const promptIdentity = `${turnId}:prompt`
  const matches = event.messages.filter((message) => {
    const metadata = asRecord(asRecord(message).__openclaw)
    return asRecord(message).role === 'user' && metadata.mirrorIdentity === promptIdentity
  })
  if (matches.length !== 1) return { gap: { code: 'codex-handoff-receipt-ambiguous', detail: 'Finalization did not expose exactly one current user prompt with the native turn mirror identity' } }
  const transport = asRecord(asRecord(asRecord(matches[0]).__openclaw).transport)
  const messageId = string(transport.messageId)
  return messageId ? { messageId } : { gap: { code: 'codex-handoff-message-id-missing', detail: 'The exact current Codex prompt lacked its preserved provider transport message ID' } }
}

export default definePluginEntry({
  id: 'biztools-learning-archive',
  name: 'BizTools Learning Archive',
  description: 'Durably observes OpenClaw learning inputs and outputs without dispatching messages.',
  register(api) {
    const supplied = asRecord(api.pluginConfig)
    const openClawRoot = join(homedir(), '.openclaw')
    const configuredRoots = Array.isArray(supplied.approvedLocalRoots) ? supplied.approvedLocalRoots.map(string).filter((value): value is string => Boolean(value)) : []
    const humanSenderIds = new Set(Array.isArray(supplied.humanSenderIds) ? supplied.humanSenderIds.map(string).filter((value): value is string => Boolean(value)) : [])
    const configuredMaxMediaBytes = integer(supplied.maxMediaBytes)
    const configuredMaxRawPayloadBytes = integer(supplied.maxRawPayloadBytes)
    const config: SpoolConfig = {
      spoolRoot: string(supplied.spoolRoot) ?? join(openClawRoot, 'learning-archive'),
      approvedLocalRoots: configuredRoots.length ? configuredRoots : [join(openClawRoot, 'media', 'inbound'), join(openClawRoot, 'media', 'outbound')],
      ...(configuredMaxMediaBytes !== undefined ? { maxMediaBytes: configuredMaxMediaBytes } : {}),
      ...(configuredMaxRawPayloadBytes !== undefined ? { maxRawPayloadBytes: configuredMaxRawPayloadBytes } : {}),
    }
    const spool = new LearningArchiveSpool(config, async (url, maxBytes) => saveMediaSource(url, undefined, 'learning-archive-fetch', maxBytes))
    const ready = spool.initialize()
    const pending = new Set<Promise<unknown>>()
    const track = <T>(operation: Promise<T>): Promise<T> => {
      pending.add(operation)
      operation.finally(() => pending.delete(operation)).catch(() => undefined)
      return operation
    }
    const inherited = async (runId?: string) => runId ? spool.loadRunLink(runId) : undefined
    const persistSimple = async (hook: 'llm_input' | 'llm_output' | 'before_agent_finalize' | 'reply_payload_sending' | 'message_sent', eventValue: unknown, contextValue: unknown) => {
      await ready
      const event = asRecord(eventValue)
      const correlation = spool.extractCorrelation(event, contextValue)
      const gaps: ArchiveGap[] = []
      let handoffLogicalMessageKey: string | null = null
      if (hook === 'before_agent_finalize') {
        const receipt = codexFinalizationHandoff(event)
        if (receipt.gap) gaps.push(receipt.gap)
        else if (correlation.messageId && correlation.messageId !== receipt.messageId) gaps.push({ code: 'codex-handoff-message-id-conflict', detail: 'Finalization transport identity conflicted with the hook correlation message ID' })
        else correlation.messageId = receipt.messageId
        handoffLogicalMessageKey = spool.logicalMessageKey(correlation)
        if (handoffLogicalMessageKey && correlation.runId) await spool.saveRunLink(correlation.runId, handoffLogicalMessageKey, correlation)
        else if (receipt.messageId) gaps.push({ code: 'codex-handoff-routing-identity-missing', detail: 'Exact provider message and Codex run/turn identity were present, but Discord account or conversation identity was absent' })
      }
      const link = await inherited(correlation.runId)
      if (hook === 'before_agent_finalize' && handoffLogicalMessageKey && correlation.runId) {
        await spool.persist({ hook: 'handoff_correlation', direction: 'user_to_model', stage: 'finalizing',
          authorship: 'unknown', visibility: 'internal', logicalMessageKey: handoffLogicalMessageKey,
          correlation: { ...link?.correlation, ...definedCorrelation(correlation) }, parts: [], gaps: [],
          event: { receiptKind: 'codex-finalization-transport', runId: correlation.runId, turnId: correlation.codexTurnId,
            messageId: correlation.messageId },
          context: { channelId: correlation.channelId, accountId: correlation.accountId, conversationId: correlation.conversationId },
        })
      }
      const finalReply = hook === 'reply_payload_sending' && event.kind === 'final'
      if (finalReply && correlation.runId) await spool.markAgentDeliveryRun(correlation.runId)
      const provenAgentDelivery = hook === 'message_sent' && event.success === true && await spool.hasAgentDeliveryRun(correlation.runId)
      if (hook === 'before_agent_finalize' && correlation.runId && link?.logicalMessageKey) await spool.saveRunLink(correlation.runId, link.logicalMessageKey,
        { ...link.correlation, ...definedCorrelation(correlation) })
      if ((hook === 'llm_input' || hook === 'llm_output') && !link) gaps.push({ code: 'run-link-missing', detail: 'No durable inbound logical-message link exists for this run ID' })
      if (hook === 'llm_input' && Number(event.imagesCount ?? 0) > 0) gaps.push({ code: 'llm-image-bytes-not-exposed', detail: 'LLM input hook exposes only imagesCount, not image byte locators' })
      if (hook === 'before_agent_finalize' && !correlation.codexThreadId) gaps.push({ code: 'codex-thread-id-not-exposed', detail: 'Public OpenClaw Codex hooks do not expose the native Codex thread ID' })
      const payload = asRecord(event.payload)
      const content = hook === 'llm_input' ? [string(event.prompt)]
        : hook === 'llm_output' ? (Array.isArray(event.assistantTexts) ? event.assistantTexts.map(string) : [])
          : hook === 'message_sent' ? [string(event.content)]
            : hook === 'reply_payload_sending' ? [string(payload.text), string(asRecord(payload.fallbackText).text)] : []
      const parts: ArchivePart[] = content.flatMap((value, ordinal) => value ? [{ ordinal, type: 'text' as const,
        role: hook === 'llm_input' ? 'model-input' as const : hook === 'llm_output' ? 'model-output' as const : 'delivery' as const,
        text: value, captureStatus: 'captured' as const }] : [])
      if (hook === 'reply_payload_sending') {
        const deliveryMedia = deliveryMediaFacts(payload)
        gaps.push(...deliveryMedia.gaps)
        for (const fact of deliveryMedia.facts) {
          const captured = await spool.captureMedia(fact, parts.length, 'delivery')
          parts.push(captured.part); gaps.push(...captured.gaps)
        }
      }
      if (hook === 'llm_output' || hook === 'before_agent_finalize') {
        const finalizeAssistantMessages = Array.isArray(event.messages)
          ? event.messages.filter((message) => string(asRecord(message).role) === 'assistant') : []
        const embedded = embeddedContentMedia(hook === 'llm_output' ? event.lastAssistant : finalizeAssistantMessages)
        gaps.push(...embedded.gaps)
        for (const fact of embedded.facts) {
          const captured = await spool.captureMedia(fact, parts.length, 'model-output')
          parts.push(captured.part); gaps.push(...captured.gaps)
        }
      }
      const direction = hook === 'llm_input' ? 'user_to_model' as const : 'model_to_user' as const
      const stage = hook === 'llm_input' ? 'model_input' as const : hook === 'llm_output' ? 'model_output' as const
        : hook === 'before_agent_finalize' ? 'finalizing' as const : hook === 'reply_payload_sending' ? 'delivery_attempt' as const
          : event.success === false ? 'failed' as const : 'delivered' as const
      const outputLogicalMessageKey = hook === 'message_sent' && correlation.channelId === 'discord'
        && correlation.accountId && correlation.conversationId && correlation.messageId
        ? `discord-output:${encodeURIComponent(correlation.accountId)}:${encodeURIComponent(correlation.conversationId)}:${encodeURIComponent(correlation.messageId)}` : null
      const logicalMessageKey = hook === 'llm_input' ? link?.logicalMessageKey ?? null : outputLogicalMessageKey
      if (hook === 'message_sent' && event.success === true && !provenAgentDelivery) gaps.push({ code: 'outbound-authorship-unproven', detail: 'Successful delivery lacked an exact run-linked final reply preparation receipt' })
      await spool.persist({ hook, direction, stage,
        authorship: hook === 'llm_output' || hook === 'before_agent_finalize' || provenAgentDelivery ? 'agent' : 'unknown',
        visibility: hook === 'llm_input' || hook === 'llm_output' || hook === 'before_agent_finalize' ? 'internal'
          : hook === 'reply_payload_sending' ? 'intended' : provenAgentDelivery ? 'delivered' : 'unknown',
        logicalMessageKey,
        correlation: { ...link?.correlation, ...definedCorrelation(correlation) }, parts, gaps, event, context: contextValue })
    }

    api.on('message_received', (event, ctx) => track((async () => {
      await ready
      const correlation = spool.extractCorrelation(event, ctx)
      const logicalMessageKey = spool.logicalMessageKey(correlation)
      const configuredHuman = correlation.senderId !== undefined && humanSenderIds.has(correlation.senderId)
      const authorship = correlation.senderIsBot === true ? 'agent' as const : correlation.senderIsWebhook === true ? 'system' as const
        : correlation.senderIsBot === false && correlation.senderIsWebhook === false ? 'human' as const
          : configuredHuman ? 'human' as const : 'unknown' as const
      if (configuredHuman && authorship === 'human') correlation.authorshipEvidence = 'operator-configured-human-sender-id'
      const gaps: ArchiveGap[] = []
      if (authorship === 'unknown') gaps.push({ code: 'sender-authorship-not-exposed', detail: 'Typed message_received payload omits Discord bot/webhook flags, so human authorship cannot be asserted' })
      if (!logicalMessageKey) gaps.push({ code: 'missing-logical-identity', detail: 'Discord account, conversation, and original message IDs are required for canonical projection' })
      if (logicalMessageKey && correlation.runId) await spool.saveRunLink(correlation.runId, logicalMessageKey, correlation)
      else if (logicalMessageKey && !correlation.runId) gaps.push({ code: 'run-id-not-exposed', detail: 'Inbound observation cannot be explicitly linked to the model handoff without a run ID' })
      const parts: ArchivePart[] = []
      if (event.content) parts.push({ ordinal: parts.length, type: 'text', text: event.content, captureStatus: 'captured' })
      for (const [role, facts] of [['staged', mediaFacts(event.media)], ['original', mediaFacts(event.originalMedia)]] as const) {
        for (const fact of facts) {
          const captured = await spool.captureMedia(fact, parts.length, role, !(role === 'original' && event.mediaStagingPending === true))
          parts.push(captured.part); gaps.push(...captured.gaps)
        }
      }
      if (event.mediaStagingPending === true && !event.originalMedia?.length) gaps.push({ code: 'original-media-facts-missing', detail: 'OpenClaw reported pending media staging without typed original media facts' })
      if (event.media?.length && !event.originalMedia?.length) gaps.push({ code: 'original-media-facts-not-exposed', detail: 'Locally staged media was captured, but the hook did not separately expose provider-original media facts' })
      await spool.persist({ hook: 'message_received', direction: 'user_to_model', stage: 'received',
        authorship, visibility: 'intended', logicalMessageKey,
        correlation, parts, gaps, event, context: ctx })
    })()).catch((error) => api.logger.error(`learning archive message observation failed: ${String(error)}`)))
    api.on('llm_input', (event, ctx) => track(persistSimple('llm_input', event, ctx)).catch((error) => api.logger.error(`learning archive llm_input failed: ${String(error)}`)))
    api.on('llm_output', (event, ctx) => track(persistSimple('llm_output', event, ctx)).catch((error) => api.logger.error(`learning archive llm_output failed: ${String(error)}`)))
    api.on('before_agent_finalize', (event, ctx) => track(persistSimple('before_agent_finalize', event, ctx)).then(() => undefined)
      .catch((error) => { api.logger.error(`learning archive finalization observation failed: ${String(error)}`); return undefined }))
    api.on('reply_payload_sending', (event, ctx) => track(persistSimple('reply_payload_sending', event, ctx)).then(() => undefined)
      .catch((error) => { api.logger.error(`learning archive delivery-attempt observation failed: ${String(error)}`); return undefined }))
    api.on('message_sent', (event, ctx) => track(persistSimple('message_sent', event, ctx)).catch((error) => api.logger.error(`learning archive delivery observation failed: ${String(error)}`)))
    api.on('gateway_stop', async () => { await Promise.allSettled([...pending]) })
  },
})
