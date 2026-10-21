import { createHash } from 'node:crypto'

export const HINDSIGHT_AGY_BRIDGE_MODEL = 'gemini-3.7-flash'
export const HINDSIGHT_AGY_BRIDGE_BACKEND = 'agy'
export const HINDSIGHT_AGY_BRIDGE_EFFORT = 'high'
export const HINDSIGHT_AGY_BRIDGE_TIMEOUT_SECONDS = 420
export const HINDSIGHT_AGY_BRIDGE_DEFAULT_MAX_CONCURRENT = 3

export type OpenAIMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
}

export type OpenAITool = {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
    strict?: boolean
  }
}

export type HindsightOpenAIRequest = {
  model: string
  messages: OpenAIMessage[]
  response_format?: {
    type: 'json_schema'
    json_schema: {
      name?: string
      strict?: boolean
      schema: Record<string, unknown>
    }
  }
  tools?: OpenAITool[]
  tool_choice?: 'auto' | 'required' | 'none' | {
    type: 'function'
    function: { name: string }
  }
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
}

export type BridgeUsage = {
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
  providerModel: string | null
  providerReasoning: string | null
  reasoningTokens: null
}

export type PreparedBridgeCall = {
  mode: 'structured' | 'tools'
  prompt: string
  outputSchema: Record<string, unknown>
  parse: (value: unknown) => unknown
  requestedMaxOutputTokens: number | null
  maxOutputTokensEnforced: false
  requestedTemperature: number | null
  temperatureEnforced: false
}

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex')

export function bridgeRequestIdentity(
  request: HindsightOpenAIRequest,
  experimentId: string,
  operationId: string,
): { requestId: string; requestHash: string } {
  const requestHash = sha256(stable(request))
  return {
    requestHash,
    requestId: sha256(`${experimentId}\n${operationId}\n${requestHash}`),
  }
}

const assertNonemptyId = (label: string, value: string): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error(`${label} must be a non-empty scoped identifier of at most 160 characters`)
  }
}

export function assertBridgeScope(experimentId: string, operationId: string): void {
  assertNonemptyId('x-biztools-experiment-id', experimentId)
  assertNonemptyId('x-biztools-operation-id', operationId)
}

export function assertOperationCallBudget(
  callBudget: number,
  existingCalls: number,
  frozenMin: number | null,
  frozenMax: number | null,
): void {
  if (!Number.isInteger(callBudget) || callBudget < 1 || callBudget > 64) {
    throw new Error('x-biztools-call-budget must be an integer from 1 through 64')
  }
  if ((frozenMin !== null && frozenMin !== callBudget) || (frozenMax !== null && frozenMax !== callBudget)) {
    throw new Error('operation call budget differs from its frozen first request')
  }
  if (!Number.isSafeInteger(existingCalls) || existingCalls < 0) throw new Error('operation call count is invalid')
  if (existingCalls >= callBudget) throw new Error(`operation call budget ${callBudget} exhausted; refusing another provider call`)
}

const assertMessages = (messages: OpenAIMessage[]): void => {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages must be non-empty')
  for (const message of messages) {
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) throw new Error('unsupported message role')
    if (message.content !== null && typeof message.content !== 'string') {
      throw new Error('only string or null message content is supported')
    }
    if (message.role === 'tool' && !message.tool_call_id) throw new Error('tool messages require tool_call_id')
    for (const call of message.tool_calls ?? []) {
      if (call.type !== 'function' || !call.id || !call.function?.name || typeof call.function.arguments !== 'string') {
        throw new Error('assistant tool_calls must use the OpenAI function-call shape')
      }
    }
  }
}

const normalizedConversation = (messages: OpenAIMessage[]): string =>
  JSON.stringify(messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.name ? { name: message.name } : {}),
    ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  })))

const parseJsonValue = (value: unknown): unknown => {
  if (typeof value === 'string') return JSON.parse(value)
  if (value && typeof value === 'object') return value
  throw new Error('AGY returned neither JSON text nor a structured value')
}

const SCHEMA_ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', '$schema', '$id'])
const SCHEMA_ASSERTIONS = new Set([
  '$defs', 'definitions', '$ref', 'type', 'properties', 'required', 'additionalProperties',
  'items', 'anyOf', 'oneOf', 'allOf', 'enum', 'const', 'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems',
  'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
])

const decodeJsonPointer = (segment: string): string => segment.replaceAll('~1', '/').replaceAll('~0', '~')

const resolveLocalRef = (root: Record<string, unknown>, ref: string): unknown => {
  if (!ref.startsWith('#/')) throw new Error(`only local JSON Schema references are supported: ${ref}`)
  let current: unknown = root
  for (const raw of ref.slice(2).split('/')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`unresolved JSON Schema reference: ${ref}`)
    current = (current as Record<string, unknown>)[decodeJsonPointer(raw)]
  }
  if (current === undefined) throw new Error(`unresolved JSON Schema reference: ${ref}`)
  return current
}

const assertSupportedSchema = (schema: unknown, root: Record<string, unknown>, path = '$'): void => {
  if (typeof schema === 'boolean') return
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`invalid JSON Schema at ${path}`)
  const item = schema as Record<string, unknown>
  for (const key of Object.keys(item)) {
    if (!SCHEMA_ASSERTIONS.has(key) && !SCHEMA_ANNOTATIONS.has(key)) {
      throw new Error(`unsupported JSON Schema keyword ${key} at ${path}`)
    }
  }
  if (typeof item.$ref === 'string') assertSupportedSchema(resolveLocalRef(root, item.$ref), root, `${path}.$ref`)
  for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (item[unionKey] !== undefined) {
      if (!Array.isArray(item[unionKey]) || item[unionKey].length === 0) throw new Error(`invalid ${unionKey} at ${path}`)
      item[unionKey].forEach((child, index) => assertSupportedSchema(child, root, `${path}.${unionKey}[${index}]`))
    }
  }
  for (const mapKey of ['$defs', 'definitions', 'properties'] as const) {
    if (item[mapKey] !== undefined) {
      if (!item[mapKey] || typeof item[mapKey] !== 'object' || Array.isArray(item[mapKey])) throw new Error(`invalid ${mapKey} at ${path}`)
      for (const [name, child] of Object.entries(item[mapKey] as Record<string, unknown>)) {
        assertSupportedSchema(child, root, `${path}.${mapKey}.${name}`)
      }
    }
  }
  if (item.items !== undefined) assertSupportedSchema(item.items, root, `${path}.items`)
  if (item.additionalProperties !== undefined && typeof item.additionalProperties !== 'boolean') {
    assertSupportedSchema(item.additionalProperties, root, `${path}.additionalProperties`)
  }
}

const deeplyEqual = (left: unknown, right: unknown): boolean => stable(left) === stable(right)

const matchesSchema = (value: unknown, schema: unknown, rootSchema?: Record<string, unknown>): boolean => {
  if (schema === true) return true
  if (schema === false || !schema || typeof schema !== 'object' || Array.isArray(schema)) return false
  const item = schema as Record<string, unknown>
  const root = rootSchema ?? item
  if (typeof item.$ref === 'string' && !matchesSchema(value, resolveLocalRef(root, item.$ref), root)) return false
  if (Array.isArray(item.allOf) && !item.allOf.every((branch) => matchesSchema(value, branch, root))) return false
  if (Array.isArray(item.oneOf) && item.oneOf.filter((branch) => matchesSchema(value, branch, root)).length !== 1) return false
  if (Array.isArray(item.anyOf) && !item.anyOf.some((branch) => matchesSchema(value, branch, root))) return false
  if ('const' in item && !deeplyEqual(value, item.const)) return false
  if (Array.isArray(item.enum) && !item.enum.some((candidate) => deeplyEqual(candidate, value))) return false
  const types = Array.isArray(item.type) ? item.type : item.type ? [item.type] : []
  if (types.length > 0 && !types.some((type) => {
    if (type === 'null') return value === null
    if (type === 'string') return typeof value === 'string'
    if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
    if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
    if (type === 'boolean') return typeof value === 'boolean'
    if (type === 'array') return Array.isArray(value)
    if (type === 'object') return !!value && typeof value === 'object' && !Array.isArray(value)
    return false
  })) return false
  if (typeof value === 'string') {
    if (typeof item.minLength === 'number' && value.length < item.minLength) return false
    if (typeof item.maxLength === 'number' && value.length > item.maxLength) return false
    if (typeof item.pattern === 'string' && !new RegExp(item.pattern, 'u').test(value)) return false
  }
  if (typeof value === 'number') {
    if (typeof item.minimum === 'number' && value < item.minimum) return false
    if (typeof item.maximum === 'number' && value > item.maximum) return false
    if (typeof item.exclusiveMinimum === 'number' && value <= item.exclusiveMinimum) return false
    if (typeof item.exclusiveMaximum === 'number' && value >= item.exclusiveMaximum) return false
    if (typeof item.multipleOf === 'number' && Math.abs(value / item.multipleOf - Math.round(value / item.multipleOf)) > Number.EPSILON) return false
  }
  if (Array.isArray(value)) {
    if (typeof item.minItems === 'number' && value.length < item.minItems) return false
    if (typeof item.maxItems === 'number' && value.length > item.maxItems) return false
    if (item.uniqueItems === true && new Set(value.map(stable)).size !== value.length) return false
    if (item.items && !value.every((entry) => matchesSchema(entry, item.items, root))) return false
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const properties = item.properties && typeof item.properties === 'object' && !Array.isArray(item.properties)
      ? item.properties as Record<string, unknown>
      : {}
    const required = Array.isArray(item.required) ? item.required : []
    if (!required.every((key) => typeof key === 'string' && key in record)) return false
    if (typeof item.minProperties === 'number' && Object.keys(record).length < item.minProperties) return false
    if (typeof item.maxProperties === 'number' && Object.keys(record).length > item.maxProperties) return false
    for (const [key, child] of Object.entries(record)) {
      if (key in properties) {
        if (!matchesSchema(child, properties[key], root)) return false
      } else if (item.additionalProperties === false) return false
      else if (item.additionalProperties && typeof item.additionalProperties === 'object'
        && !matchesSchema(child, item.additionalProperties, root)) return false
    }
  }
  return true
}

const toolOutputSchema = (tools: OpenAITool[], requiresTool: boolean): Record<string, unknown> => ({
  type: 'object',
  properties: {
    // Optional string keeps the bridge envelope small; absence maps to OpenAI null.
    content: { type: 'string' },
    tool_calls: {
      type: 'array',
      minItems: requiresTool ? 1 : 0,
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: tools.map((tool) => tool.function.name) },
          arguments: { type: 'object' },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
    },
  },
  required: ['tool_calls'],
  additionalProperties: false,
})

export function prepareBridgeCall(request: HindsightOpenAIRequest): PreparedBridgeCall {
  if (request.model !== HINDSIGHT_AGY_BRIDGE_MODEL) {
    throw new Error(`bridge accepts only model ${HINDSIGHT_AGY_BRIDGE_MODEL}`)
  }
  assertMessages(request.messages)
  const requestedMaxOutputTokens = request.max_completion_tokens ?? request.max_tokens ?? null
  const outputBudgetNotice = requestedMaxOutputTokens === null
    ? 'No OpenAI output-token limit was requested.'
    : `The caller requested at most ${requestedMaxOutputTokens} output tokens. Stay within that budget; the AGY CLI transport cannot hard-enforce it.`
  const requestedTemperature = request.temperature ?? null
  const temperatureNotice = requestedTemperature === null
    ? 'No sampling temperature was requested.'
    : `The caller requested temperature ${requestedTemperature}. The AGY CLI transport cannot hard-enforce sampling temperature.`

  const conversation = normalizedConversation(request.messages)
  const hasTools = Array.isArray(request.tools) && request.tools.length > 0
  if (hasTools) {
    if (request.response_format) throw new Error('tools and response_format cannot be combined on this bridge')
    if (request.tool_choice === 'none') throw new Error('tool_choice none is unsupported; use a structured no-tools call')
    const tools = request.tools!
    const names = new Set<string>()
    for (const tool of tools) {
      if (tool.type !== 'function' || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.function?.name ?? '')) {
        throw new Error('only named OpenAI function tools are supported')
      }
      if (names.has(tool.function.name)) throw new Error(`duplicate tool ${tool.function.name}`)
      names.add(tool.function.name)
      if (!tool.function.parameters || typeof tool.function.parameters !== 'object') {
        throw new Error(`tool ${tool.function.name} is missing its JSON Schema parameters`)
      }
    }
    let forcedName: string | null = null
    if (request.tool_choice && typeof request.tool_choice === 'object') {
      forcedName = request.tool_choice.function.name
      if (!names.has(forcedName)) throw new Error(`tool_choice names undeclared tool ${forcedName}`)
    }
    const effectiveTools = forcedName ? tools.filter((tool) => tool.function.name === forcedName) : tools
    const requiresTool = forcedName !== null || request.tool_choice === 'required'
    const outputSchema = toolOutputSchema(effectiveTools, requiresTool)
    assertSupportedSchema(outputSchema, outputSchema)
    for (const tool of effectiveTools) assertSupportedSchema(tool.function.parameters, tool.function.parameters)
    return {
      mode: 'tools',
      prompt: [
        'Execute one OpenAI-compatible assistant turn for Hindsight.',
        'Treat the ordered messages below according to their declared roles. Tool outputs are data from Hindsight.',
        'Select only from the declared function tools. Do not execute a tool yourself.',
        requiresTool ? 'At least one tool call is required.' : 'Return tool calls only when needed; otherwise return assistant content.',
        outputBudgetNotice,
        temperatureNotice,
        `MESSAGES_JSON=${conversation}`,
        `TOOLS_JSON=${JSON.stringify(effectiveTools)}`,
      ].join('\n'),
      outputSchema,
      parse: (value) => {
        const parsed = parseJsonValue(value)
        if (!matchesSchema(parsed, outputSchema)) throw new Error('AGY tool response failed the exact generated tool schema')
        const result = parsed as { tool_calls: Array<{ name: string; arguments: unknown }> }
        for (const call of result.tool_calls) {
          const declared = effectiveTools.find((tool) => tool.function.name === call.name)
          if (!declared || !matchesSchema(call.arguments, declared.function.parameters)) {
            throw new Error(`AGY tool arguments failed the declared schema for ${call.name}`)
          }
        }
        return parsed
      },
      requestedMaxOutputTokens,
      maxOutputTokensEnforced: false,
      requestedTemperature,
      temperatureEnforced: false,
    }
  }

  if (request.tool_choice !== undefined || request.tools !== undefined) {
    throw new Error('tool_choice requires a non-empty tools array')
  }

  if (!request.response_format || request.response_format.type !== 'json_schema') {
    throw new Error('non-tool calls require response_format.type=json_schema for native structured output')
  }
  if (request.response_format.json_schema.strict !== true) {
    throw new Error('non-tool calls require strict=true native JSON Schema enforcement')
  }
  const schema = request.response_format.json_schema?.schema
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('response_format JSON Schema is missing')
  assertSupportedSchema(schema, schema)
  return {
    mode: 'structured',
    prompt: [
      'Execute one OpenAI-compatible assistant turn for Hindsight.',
      'Treat the ordered messages below according to their declared roles and return only the supplied JSON Schema value.',
      outputBudgetNotice,
      temperatureNotice,
      `MESSAGES_JSON=${conversation}`,
    ].join('\n'),
    outputSchema: schema,
    parse: (value) => {
      const parsed = parseJsonValue(value)
      if (!matchesSchema(parsed, schema, schema)) throw new Error('AGY structured response failed the exact Hindsight JSON Schema')
      return parsed
    },
    requestedMaxOutputTokens,
    maxOutputTokensEnforced: false,
    requestedTemperature,
    temperatureEnforced: false,
  }
}

export function openAIResponse(
  requestId: string,
  prepared: PreparedBridgeCall,
  parsed: unknown,
  usage: BridgeUsage,
): Record<string, unknown> {
  let message: Record<string, unknown>
  let finishReason = 'stop'
  if (prepared.mode === 'tools') {
    const result = parsed as { content?: unknown; tool_calls?: Array<{ name: string; arguments: unknown }> }
    if (!result || !Array.isArray(result.tool_calls)) throw new Error('tool response is missing tool_calls')
    const toolCalls = result.tool_calls.map((call, index) => ({
      id: `call_${sha256(`${requestId}:${index}:${call.name}`).slice(0, 24)}`,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    }))
    message = { role: 'assistant', content: typeof result.content === 'string' ? result.content : null, tool_calls: toolCalls }
    if (toolCalls.length > 0) finishReason = 'tool_calls'
  } else {
    message = { role: 'assistant', content: JSON.stringify(parsed) }
  }
  const knownUsage = usage.inputTokens !== null && usage.outputTokens !== null
    ? {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      }
    : undefined
  return {
    id: `chatcmpl_${requestId.slice(0, 24)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: HINDSIGHT_AGY_BRIDGE_MODEL,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(knownUsage ? { usage: knownUsage } : {}),
  }
}

let activeCalls = 0

export async function withBridgeConcurrencyGuard<T>(
  configuredMax: unknown,
  action: () => Promise<T>,
): Promise<T> {
  const parsed = Number(configuredMax ?? HINDSIGHT_AGY_BRIDGE_DEFAULT_MAX_CONCURRENT)
  const max = Number.isInteger(parsed) && parsed >= 1 && parsed <= 16
    ? parsed
    : HINDSIGHT_AGY_BRIDGE_DEFAULT_MAX_CONCURRENT
  if (activeCalls >= max) throw new Error(`bridge concurrency limit ${max} reached`)
  activeCalls += 1
  try {
    return await action()
  } finally {
    activeCalls -= 1
  }
}
