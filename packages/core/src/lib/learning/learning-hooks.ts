import { createHash } from 'node:crypto'
import { z } from 'zod'

export const LearningHookProviderSchema = z.enum(['anthropic', 'openai'])
export type LearningHookProvider = z.infer<typeof LearningHookProviderSchema>

const LearningHookRoleSchema = z.enum(['user', 'assistant'])

export const LearningHookEventSchema = z.object({
  id: z.string().min(1),
  provider: LearningHookProviderSchema,
  sourceEvent: z.string().min(1),
  kind: z.enum(['turn', 'session']),
  role: LearningHookRoleSchema.nullable(),
  text: z.string().nullable(),
  threadId: z.string().min(1),
  exchangeId: z.string().min(1),
  agent: z.string().min(1),
  agentId: z.string().nullable(),
  model: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  cwd: z.string().nullable(),
  occurredAt: z.string(),
  receivedAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
})

export type LearningHookEvent = z.infer<typeof LearningHookEventSchema>
export type LearningHookPayload = Record<string, unknown>

export type LearningHookNormalization = {
  events: LearningHookEvent[]
  ignored: boolean
  reason?: string
}

const asRecord = (value: unknown): LearningHookPayload | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as LearningHookPayload
    : null
)

const stringValue = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
)

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    const text = stringValue(value)
    if (text) return text
  }
  return null
}

const timestampValue = (value: unknown, fallback: string): string => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value
    const date = new Date(milliseconds)
    if (!Number.isNaN(date.getTime())) return date.toISOString()
  }
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
  return fallback
}

const stableId = (parts: unknown[]): string => createHash('sha256')
  .update(JSON.stringify(parts))
  .digest('hex')
  .slice(0, 32)

const makeEvent = ({
  provider,
  sourceEvent,
  kind,
  role,
  text,
  threadId,
  exchangeId,
  agent,
  agentId,
  model,
  transcriptPath,
  cwd,
  occurredAt,
  receivedAt,
  payload,
}: {
  provider: LearningHookProvider
  sourceEvent: string
  kind: 'turn' | 'session'
  role: 'user' | 'assistant' | null
  text: string | null
  threadId: string
  exchangeId: string
  agent: string
  agentId: string | null
  model: string | null
  transcriptPath: string | null
  cwd: string | null
  occurredAt: string
  receivedAt: string
  payload: LearningHookPayload
}): LearningHookEvent => ({
  id: stableId([
    provider,
    sourceEvent,
    threadId,
    exchangeId,
    role,
    text,
    agentId,
    model,
  ]),
  provider,
  sourceEvent,
  kind,
  role,
  text,
  threadId,
  exchangeId,
  agent,
  agentId,
  model,
  transcriptPath,
  cwd,
  occurredAt,
  receivedAt,
  payload,
})

const normalizeAnthropicHook = (
  payload: LearningHookPayload,
  now: string,
): LearningHookNormalization => {
  const sourceEvent = firstString(payload.hook_event_name, payload.event) ?? 'unknown'
  const sessionId = firstString(payload.session_id, payload.transcript_path) ?? 'unknown-session'
  const transcriptPath = stringValue(payload.transcript_path)
  const cwd = stringValue(payload.cwd)
  const agentId = firstString(payload.agent_id)
  const model = firstString(payload.model, payload.model_name, asRecord(payload.response)?.model)
  const agent = firstString(payload.agent_type) ?? (agentId ? 'Claude subagent' : 'Claude')
  const threadId = sessionId
  const promptId = firstString(payload.prompt_id)
  const text = sourceEvent === 'UserPromptSubmit'
    ? stringValue(payload.prompt)
    : sourceEvent === 'Stop' || sourceEvent === 'SubagentStop'
      ? stringValue(payload.last_assistant_message)
      : null

  if (sourceEvent === 'UserPromptSubmit' && !text) {
    return { events: [], ignored: true, reason: 'UserPromptSubmit had no prompt text' }
  }
  if ((sourceEvent === 'Stop' || sourceEvent === 'SubagentStop') && !text) {
    return { events: [], ignored: true, reason: `${sourceEvent} had no assistant text` }
  }

  const role = sourceEvent === 'UserPromptSubmit' ? 'user' : 'assistant'
  const exchangeId = promptId
    ?? stableId([threadId, sourceEvent, text, agentId])
  return {
    ignored: false,
    events: [makeEvent({
      provider: 'anthropic',
      sourceEvent,
      kind: 'turn',
      role,
      text,
      threadId,
      exchangeId,
      agent,
      agentId,
      model,
      transcriptPath,
      cwd,
      occurredAt: timestampValue(payload.timestamp, now),
      receivedAt: now,
      payload,
    })],
  }
}

/**
 * OpenAI/Codex variation point.
 *
 * Codex does not currently provide a documented equivalent of Claude Code's
 * lifecycle hooks. This adapter deliberately accepts a small bridge shape so
 * a future official hook, wrapper, or SDK gateway can feed the same canonical
 * event contract without changing the ingress or queue layer.
 */
const normalizeOpenAIHook = (
  payload: LearningHookPayload,
  now: string,
): LearningHookNormalization => {
  const sourceEvent = firstString(payload.hook_event_name, payload.event, payload.type) ?? 'unknown'
  const roleValue = firstString(payload.role)
  const role = roleValue === 'user' || roleValue === 'assistant'
    ? roleValue
    : sourceEvent === 'UserPromptSubmit' || sourceEvent === 'turn.started'
      ? 'user'
      : sourceEvent === 'Stop' || sourceEvent === 'turn.completed' || sourceEvent === 'response.completed'
        ? 'assistant'
        : null
  const text = firstString(
    payload.text,
    role === 'user' ? payload.prompt : null,
    role === 'assistant' ? payload.last_assistant_message : null,
    payload.message,
  )
  if (!role || !text) {
    return { events: [], ignored: true, reason: 'OpenAI hook payload did not contain a supported role and text' }
  }

  const threadId = firstString(payload.thread_id, payload.conversation_id, payload.session_id) ?? 'unknown-session'
  const exchangeId = firstString(payload.turn_id, payload.prompt_id, payload.response_id)
    ?? stableId([threadId, sourceEvent, text])
  const agentId = firstString(payload.agent_id)
  const model = firstString(payload.model, payload.model_name, asRecord(payload.response)?.model)
  return {
    ignored: false,
    events: [makeEvent({
      provider: 'openai',
      sourceEvent,
      kind: 'turn',
      role,
      text,
      threadId,
      exchangeId,
      agent: firstString(payload.agent) ?? 'Codex',
      agentId,
      model,
      transcriptPath: firstString(payload.transcript_path),
      cwd: firstString(payload.cwd),
      occurredAt: timestampValue(payload.timestamp ?? payload.created_at, now),
      receivedAt: now,
      payload,
    })],
  }
}

const adapters: Record<LearningHookProvider, (payload: LearningHookPayload, now: string) => LearningHookNormalization> = {
  anthropic: normalizeAnthropicHook,
  openai: normalizeOpenAIHook,
}

export function normalizeLearningHook(
  provider: LearningHookProvider,
  value: unknown,
  now = new Date().toISOString(),
): LearningHookNormalization {
  const payload = asRecord(value)
  if (!payload) return { events: [], ignored: true, reason: 'Hook payload must be a JSON object' }
  return adapters[provider](payload, now)
}
