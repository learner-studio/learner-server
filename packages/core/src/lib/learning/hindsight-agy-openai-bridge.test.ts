import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertOperationCallBudget,
  bridgeRequestIdentity,
  openAIResponse,
  prepareBridgeCall,
  withBridgeConcurrencyGuard,
  type HindsightOpenAIRequest,
} from './hindsight-agy-openai-bridge.js'

const structured = (): HindsightOpenAIRequest => ({
  model: 'gemini-3.7-flash',
  messages: [
    { role: 'system', content: 'Extract facts.' },
    { role: 'user', content: 'A user understands queues.' },
  ],
  response_format: {
    type: 'json_schema',
    json_schema: {
      name: 'facts',
      strict: true,
      schema: {
        type: 'object',
        properties: { facts: { type: 'array', items: { type: 'string' } } },
        required: ['facts'],
        additionalProperties: false,
      },
    },
  },
})

test('preserves scoped identity and does not collide across experiments', () => {
  const request = structured()
  const a = bridgeRequestIdentity(request, 'exp-a', 'retain')
  const replay = bridgeRequestIdentity(request, 'exp-a', 'retain')
  const next = bridgeRequestIdentity(request, 'exp-b', 'retain')
  assert.deepEqual(a, replay)
  assert.notEqual(a.requestId, next.requestId)
  assert.equal(a.requestHash.length, 64)
})

test('freezes and enforces a hard per-operation call budget', () => {
  assert.doesNotThrow(() => assertOperationCallBudget(3, 2, 3, 3))
  assert.throws(() => assertOperationCallBudget(3, 3, 3, 3), /budget 3 exhausted/)
  assert.throws(() => assertOperationCallBudget(4, 2, 3, 3), /differs from its frozen first request/)
  assert.throws(() => assertOperationCallBudget(0, 0, null, null), /integer from 1 through 64/)
})

test('requires exact Flash model and strict schema while disclosing an unenforced output hint', () => {
  const prepared = prepareBridgeCall(structured())
  assert.equal(prepared.mode, 'structured')
  assert.match(prepared.prompt, /"role":"system"/)
  assert.deepEqual(prepared.outputSchema, structured().response_format!.json_schema.schema)
  assert.throws(() => prepareBridgeCall({ ...structured(), model: 'arbitrary' }), /only model/)
  const { response_format: _responseFormat, ...withoutFormat } = structured()
  assert.throws(() => prepareBridgeCall(withoutFormat), /json_schema/)
  assert.throws(() => prepareBridgeCall({
    ...structured(),
    response_format: { ...structured().response_format!, json_schema: { ...structured().response_format!.json_schema, strict: false } },
  }), /strict=true/)
  const hinted = prepareBridgeCall({ ...structured(), max_tokens: 100 })
  assert.equal(hinted.requestedMaxOutputTokens, 100)
  assert.equal(hinted.maxOutputTokensEnforced, false)
  assert.match(hinted.prompt, /cannot hard-enforce/)
  const sampled = prepareBridgeCall({ ...structured(), temperature: 0.2 })
  assert.equal(sampled.requestedTemperature, 0.2)
  assert.equal(sampled.temperatureEnforced, false)
})

test('validates nullable anyOf and local refs without weakening the native Hindsight schema', () => {
  const request = structured()
  request.response_format!.json_schema.schema = {
    type: 'object',
    properties: {
      fact: { $ref: '#/$defs/fact' },
      occurredAt: { anyOf: [{ type: 'string', pattern: '^2026-' }, { type: 'null' }] },
    },
    required: ['fact', 'occurredAt'],
    additionalProperties: false,
    $defs: {
      fact: {
        type: 'object',
        properties: { text: { type: 'string', minLength: 1 } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  }
  const prepared = prepareBridgeCall(request)
  assert.deepEqual(prepared.parse({ fact: { text: 'queues' }, occurredAt: null }), { fact: { text: 'queues' }, occurredAt: null })
  assert.throws(() => prepared.parse({ fact: { text: '' }, occurredAt: 'yesterday' }), /exact Hindsight JSON Schema/)
  assert.throws(() => prepareBridgeCall({
    ...request,
    response_format: {
      ...request.response_format!,
      json_schema: { ...request.response_format!.json_schema, schema: { type: 'string', format: 'email' } },
    },
  }), /unsupported JSON Schema keyword format/)
})

test('translates reflect tools as model-selected data without executing them', () => {
  const request: HindsightOpenAIRequest = {
    model: 'gemini-3.7-flash',
    messages: [
      { role: 'system', content: 'Use memory tools.' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'recall', arguments: '{"q":"x"}' } }] },
      { role: 'tool', tool_call_id: 'old', content: '{"facts":[]}' },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'recall',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'recall' } },
  }
  const prepared = prepareBridgeCall(request)
  assert.equal(prepared.mode, 'tools')
  assert.equal((prepared.outputSchema.properties as any).tool_calls.minItems, 1)
  const response = openAIResponse('a'.repeat(64), prepared, {
    tool_calls: [{ name: 'recall', arguments: { query: 'queues' } }],
  }, {
    inputTokens: 12,
    outputTokens: 4,
    durationMs: 100,
    providerModel: 'gemini-3.7-flash-high',
    providerReasoning: 'high',
    reasoningTokens: null,
  }) as any
  assert.equal(response.choices[0].finish_reason, 'tool_calls')
  assert.equal(response.choices[0].message.tool_calls[0].function.name, 'recall')
  assert.equal(response.choices[0].message.tool_calls[0].function.arguments, '{"query":"queues"}')
  assert.deepEqual(response.usage, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 })
})

test('tool parsing rejects undeclared tools, malformed arguments, and missing required calls', () => {
  const prepared = prepareBridgeCall({
    model: 'gemini-3.7-flash',
    messages: [{ role: 'user', content: 'Recall queues.' }],
    tools: [{
      type: 'function',
      function: {
        name: 'recall',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      },
    }],
    tool_choice: 'required',
  })
  assert.throws(() => prepared.parse({ tool_calls: [] }), /exact generated tool schema/)
  assert.throws(() => prepared.parse({ tool_calls: [{ name: 'other', arguments: { query: 'x' } }] }), /exact generated tool schema/)
  assert.throws(() => prepared.parse({ tool_calls: [{ name: 'recall', arguments: {} }] }), /declared schema/)
})

test('omits OpenAI usage when the provider did not report both sides', () => {
  const response = openAIResponse('b'.repeat(64), prepareBridgeCall(structured()), { facts: [] }, {
    inputTokens: null,
    outputTokens: 3,
    durationMs: null,
    providerModel: null,
    providerReasoning: null,
    reasoningTokens: null,
  })
  assert.equal('usage' in response, false)
})

test('bridge concurrency is a rejecting safety guard, not a second scheduler', async () => {
  let release!: () => void
  const held = withBridgeConcurrencyGuard(1, () => new Promise<void>((resolve) => { release = resolve }))
  await assert.rejects(withBridgeConcurrencyGuard(1, async () => undefined), /limit 1 reached/)
  release()
  await held
  await withBridgeConcurrencyGuard(1, async () => undefined)
})
