import { BadRequestError, ConflictError, LocalEnvironmentOnlyError, TooManyRequestsError } from '@learner/core/runtime/errors.js'
import { sql } from 'kysely'
import { z } from 'zod'
import { defineFunction } from '../../runtime/define.js'
import {
  HINDSIGHT_AGY_BRIDGE_BACKEND,
  HINDSIGHT_AGY_BRIDGE_EFFORT,
  HINDSIGHT_AGY_BRIDGE_MODEL,
  HINDSIGHT_AGY_BRIDGE_TIMEOUT_SECONDS,
  assertBridgeScope,
  assertOperationCallBudget,
  bridgeRequestIdentity,
  openAIResponse,
  prepareBridgeCall,
  withBridgeConcurrencyGuard,
  type BridgeUsage,
  type HindsightOpenAIRequest,
} from '@learner/core/lib/learning/hindsight-agy-openai-bridge.js'

const ToolCall = z.object({
  id: z.string().min(1),
  type: z.literal('function'),
  function: z.object({ name: z.string().min(1), arguments: z.string() }).strict(),
}).strict()

const Message = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string().nullable(),
  name: z.string().optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(ToolCall).optional(),
}).strict()

const FunctionTool = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()),
    strict: z.boolean().optional(),
  }).strict(),
}).strict()

const ResponseFormat = z.object({
  type: z.literal('json_schema'),
  json_schema: z.object({
    name: z.string().optional(),
    strict: z.boolean().optional(),
    schema: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict()

export const HindsightAgyOpenAIChatInput = z.object({
  model: z.literal(HINDSIGHT_AGY_BRIDGE_MODEL),
  messages: z.array(Message).min(1),
  response_format: ResponseFormat.optional(),
  tools: z.array(FunctionTool).max(32).optional(),
  tool_choice: z.union([
    z.enum(['auto', 'required', 'none']),
    z.object({ type: z.literal('function'), function: z.object({ name: z.string().min(1) }).strict() }).strict(),
  ]).optional(),
  reasoning_effort: z.literal(HINDSIGHT_AGY_BRIDGE_EFFORT),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
}).strict()

const OpenAIUsage = z.object({
  prompt_tokens: z.number().int().nonnegative(),
  completion_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
}).strict()

export const HindsightAgyOpenAIChatOutput = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number().int(),
  model: z.literal(HINDSIGHT_AGY_BRIDGE_MODEL),
  choices: z.array(z.object({
    index: z.number().int(),
    message: z.object({
      role: z.literal('assistant'),
      content: z.string().nullable(),
      tool_calls: z.array(ToolCall).optional(),
    }).strict(),
    finish_reason: z.enum(['stop', 'tool_calls']),
  }).strict()).length(1),
  usage: OpenAIUsage.optional(),
}).strict()

type ReceiptRow = {
  status: 'running' | 'completed' | 'failed'
  request_sha256: string
  response_body: Record<string, unknown> | null
  error: string | null
}

export const hindsightAgyOpenAIChat = defineFunction({
  title: 'Serve one authenticated loopback OpenAI-compatible Hindsight model call through AGY',
  description: 'Fixed Flash High bridge with one-attempt idempotency receipts; not a general model proxy.',
  scopes: ['admin'],
  input: HindsightAgyOpenAIChatInput,
  output: HindsightAgyOpenAIChatOutput,
  func: async ({ kysely, llmService, variables }, input, { http }) => {
    const learningEnabled = await variables.get<string>('LEARNING_LOCAL_MVP_ENABLED')
    const runtimeEnvironment = await variables.get<string>('LEARNER_ENV')
    if (String(learningEnabled).toLowerCase() !== 'true' || /^prod(?:uction)?$/i.test(String(runtimeEnvironment ?? ''))) {
      throw new LocalEnvironmentOnlyError('The Hindsight AGY bridge is available only in the local Learning MVP runtime')
    }
    const experimentId = http?.request?.header('x-biztools-experiment-id') ?? ''
    const operationId = http?.request?.header('x-biztools-operation-id') ?? ''
    const callBudget = Number(http?.request?.header('x-biztools-call-budget') ?? '')
    try {
      assertBridgeScope(experimentId, operationId)
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : String(error))
    }
    try {
      assertOperationCallBudget(callBudget, 0, null, null)
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : String(error))
    }
    const request = input as HindsightOpenAIRequest
    const identity = bridgeRequestIdentity(request, experimentId, operationId)
    let prepared
    try {
      prepared = prepareBridgeCall(request)
    } catch (error) {
      throw new BadRequestError(error instanceof Error ? error.message : String(error))
    }

    const configuredMax = await variables.get<string>('HINDSIGHT_AGY_BRIDGE_MAX_CONCURRENT')
    const prior = await sql<ReceiptRow>`
      SELECT status,request_sha256,response_body,error
      FROM learning_hindsight_agy_bridge_requests
      WHERE request_id=${identity.requestId}
    `.execute(kysely)
    const replay = prior.rows[0]
    if (replay) {
      if (replay.request_sha256 !== identity.requestHash) throw new ConflictError('bridge request identity conflict')
      if (replay.status === 'completed' && replay.response_body) return HindsightAgyOpenAIChatOutput.parse(replay.response_body)
      throw new ConflictError(
        replay.status === 'running'
          ? 'bridge request is already in-flight or its provider outcome is uncertain; refusing a duplicate call'
          : `bridge request already failed and is not replayable: ${replay.error ?? 'unknown failure'}`,
      )
    }

    try {
      return await withBridgeConcurrencyGuard(configuredMax, async () => {
        const reservation = await kysely.transaction().execute(async (trx) => {
          await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${experimentId}\n${operationId}`},0))`.execute(trx)
          const raced = await sql<ReceiptRow>`
            SELECT status,request_sha256,response_body,error
            FROM learning_hindsight_agy_bridge_requests
            WHERE request_id=${identity.requestId}
          `.execute(trx)
          if (raced.rows[0]) return { existing: raced.rows[0], inserted: false }
          const operation = await sql<{ calls: string; min_budget: number | null; max_budget: number | null }>`
            SELECT COUNT(*)::text AS calls,MIN(operation_call_budget) AS min_budget,MAX(operation_call_budget) AS max_budget
            FROM learning_hindsight_agy_bridge_requests
            WHERE experiment_id=${experimentId} AND operation_id=${operationId}
          `.execute(trx)
          const operationRow = operation.rows[0]!
          try {
            assertOperationCallBudget(callBudget, Number(operationRow.calls), operationRow.min_budget, operationRow.max_budget)
          } catch (error) {
            throw new ConflictError(error instanceof Error ? error.message : String(error))
          }
          await sql`
            INSERT INTO learning_hindsight_agy_bridge_requests
              (request_id,experiment_id,operation_id,operation_call_budget,request_sha256,status,backend,requested_model,
               requested_effort,timeout_seconds,attempt_limit,requested_max_output_tokens,
               max_output_tokens_enforced,requested_temperature,temperature_enforced,request_body)
            VALUES
              (${identity.requestId},${experimentId},${operationId},${callBudget},${identity.requestHash},'running',
               ${HINDSIGHT_AGY_BRIDGE_BACKEND},${HINDSIGHT_AGY_BRIDGE_MODEL},${HINDSIGHT_AGY_BRIDGE_EFFORT},
               ${HINDSIGHT_AGY_BRIDGE_TIMEOUT_SECONDS},1,${prepared.requestedMaxOutputTokens},
               ${prepared.maxOutputTokensEnforced},${prepared.requestedTemperature},${prepared.temperatureEnforced},
               ${JSON.stringify(request)}::jsonb)
          `.execute(trx)
          return { existing: null, inserted: true }
        })
        if (!reservation.inserted) {
          const row = reservation.existing!
          if (row.request_sha256 !== identity.requestHash) throw new ConflictError('bridge request identity conflict')
          if (row.status === 'completed' && row.response_body) return HindsightAgyOpenAIChatOutput.parse(row.response_body)
          throw new ConflictError(
            row.status === 'running'
              ? 'bridge request is already in-flight or its provider outcome is uncertain; refusing a duplicate call'
              : `bridge request already failed and is not replayable: ${row.error ?? 'unknown failure'}`,
          )
        }

        const usage: BridgeUsage = {
          inputTokens: null,
          outputTokens: null,
          durationMs: null,
          providerModel: null,
          providerReasoning: null,
          reasoningTokens: null,
        }
        try {
          const parsed = await llmService.callLLMWithStructuredOutput({
          label: `Hindsight AGY bridge ${experimentId}/${operationId}/${identity.requestId.slice(0, 12)}`,
          prompt: prepared.prompt,
          outputSchema: prepared.outputSchema,
          parseFn: prepared.parse,
          callOptions: {
            backend: HINDSIGHT_AGY_BRIDGE_BACKEND,
            model: HINDSIGHT_AGY_BRIDGE_MODEL,
            effort: HINDSIGHT_AGY_BRIDGE_EFFORT,
            timeout: HINDSIGHT_AGY_BRIDGE_TIMEOUT_SECONDS,
            killMs: HINDSIGHT_AGY_BRIDGE_TIMEOUT_SECONDS * 1_000,
            onUsage: (reported: Record<string, unknown>) => {
              usage.inputTokens = Number.isFinite(Number(reported.inputTokens)) && Number(reported.inputTokens) > 0
                ? Number(reported.inputTokens)
                : null
              usage.outputTokens = Number.isFinite(Number(reported.outputTokens)) && Number(reported.outputTokens) > 0
                ? Number(reported.outputTokens)
                : null
              usage.durationMs = Number.isFinite(Number(reported.durationMs)) ? Number(reported.durationMs) : null
              usage.providerModel = typeof reported.model === 'string' ? reported.model : null
              usage.providerReasoning = typeof reported.reasoning === 'string' ? reported.reasoning : null
            },
          },
          maxParseRetries: 0,
          })
          const response = HindsightAgyOpenAIChatOutput.parse(openAIResponse(identity.requestId, prepared, parsed, usage))
          const settled = await sql<{ request_id: string }>`
            UPDATE learning_hindsight_agy_bridge_requests
            SET status='completed',response_body=${JSON.stringify(response)}::jsonb,
                usage=${JSON.stringify(usage)}::jsonb,completed_at=NOW()
            WHERE request_id=${identity.requestId} AND request_sha256=${identity.requestHash} AND status='running'
            RETURNING request_id
          `.execute(kysely)
          if (settled.rows.length !== 1) throw new ConflictError('bridge completion receipt lost its running reservation')
          return response
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await sql`
            UPDATE learning_hindsight_agy_bridge_requests
            SET status='failed',error=${message.slice(0, 8_000)},usage=${JSON.stringify(usage)}::jsonb,completed_at=NOW()
            WHERE request_id=${identity.requestId} AND request_sha256=${identity.requestHash} AND status='running'
          `.execute(kysely)
          throw error
        }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/concurrency limit/.test(message)) throw new TooManyRequestsError(message)
      throw error
    }
  },
})
