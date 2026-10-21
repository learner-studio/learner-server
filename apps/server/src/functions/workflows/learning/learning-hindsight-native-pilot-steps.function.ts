import { defineSessionlessFunction } from '../../../runtime/define.js'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'

import { getKysely } from '@learner/core/db.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { assertCompletedBridgeCallAudit, HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY, submitNativeRetainOnce } from '@learner/core/lib/learning/learning-hindsight-native-pilot.js'
import { nativeReflectQuery, readOptionalPrivateJson, validateNativeReflectHttp, writeImmutablePrivateJson } from '@learner/core/lib/learning/learning-hindsight-reflect-receipt.js'
import { LearningHindsightConsolidationTriggerService } from '@learner/core/services/learning-hindsight-consolidation-trigger-service.js'

const Base = z.object({ runId: z.string().uuid() })
const Stage = z.object({ state: z.enum(['ready', 'submitted', 'pending', 'completed', 'failed']), operationId: z.string().uuid().optional(), detail: z.record(z.string(), z.unknown()).optional() })
const stage = (value: z.input<typeof Stage>): z.output<typeof Stage> => Stage.parse(value)
export const PreflightLearningHindsightNativePilotInput = Base
export const PreflightLearningHindsightNativePilotOutput = Stage
export const SubmitLearningHindsightPilotRetainInput = Base
export const SubmitLearningHindsightPilotRetainOutput = Stage
export const PollLearningHindsightPilotRetainInput = Base
export const PollLearningHindsightPilotRetainOutput = Stage
export const SubmitLearningHindsightPilotConsolidationInput = Base
export const SubmitLearningHindsightPilotConsolidationOutput = Stage
export const PollLearningHindsightPilotConsolidationInput = Base
export const PollLearningHindsightPilotConsolidationOutput = Stage
export const RunLearningHindsightPilotReflectInput = Base
export const RunLearningHindsightPilotReflectOutput = Stage
export const FinalizeLearningHindsightNativePilotInput = Base
export const FinalizeLearningHindsightNativePilotOutput = z.record(z.string(), z.unknown())
export const FailLearningHindsightNativePilotInput = z.object({ error: z.object({ message: z.string() }) })
export const FailLearningHindsightNativePilotOutput = z.object({ failed: z.literal(true) })
export const AssertLearningHindsightPilotStageInput = Base.extend({ stage: z.string(), state: z.enum(['ready', 'submitted', 'pending', 'completed', 'failed']) })
export const AssertLearningHindsightPilotStageOutput = Stage

type Config = { contextStrategy: string; privateInputPath: string; inputSha256: string; preflightPath: string; rawOutputPath: string;
  preflightSha256: string; bankId: string; experimentTag: string; dataset: { membershipDigest: string }; callAudit?: unknown[]; nativePilot?: Record<string, any> }
const BASE = 'http://127.0.0.1:18922'
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T
const load = async (runId: string) => {
  const row = (await metaDbQuery<{ status: string; config: Config }>('SELECT status,config FROM learning_extraction_benchmark_runs WHERE run_id=$1', [runId])).rows[0]
  if (!row || row.config.contextStrategy !== HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY) throw new Error('Not the frozen native Hindsight AGY pilot')
  return row
}
const request = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(`${BASE}${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(method === 'GET' ? 30_000 : 425_000) })
  const value = await response.json() as Record<string, any>
  if (!response.ok) throw new Error(`Hindsight ${method} ${path} HTTP${response.status}: ${JSON.stringify(value).slice(0, 800)}`)
  return value
}
const patchState = (runId: string, patch: unknown, audit: unknown) => metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status='running',
  config=jsonb_set(jsonb_set(config,'{nativePilot}',COALESCE(config->'nativePilot','{}'::jsonb)||$2::jsonb),'{callAudit}',COALESCE(config->'callAudit','[]'::jsonb)||$3::jsonb)
  WHERE run_id=$1`, [runId, JSON.stringify(patch), JSON.stringify([audit])])
const operation = async (bank: string, id: string) => request('GET', `/v1/default/banks/${encodeURIComponent(bank)}/operations/${id}`)
const MemoryList = z.object({ items: z.array(z.record(z.string(), z.unknown())), total: z.number().int().nonnegative(), limit: z.number().int().nonnegative(), offset: z.literal(0) })
const listScopedMemories = async (bankId: string, experimentTag: string, type: 'world' | 'experience' | 'observation') => {
  const query = `type=${type}&tags=${encodeURIComponent(experimentTag)}&tags_match=exact&limit=10000&offset=0`
  const value = MemoryList.parse(await request('GET', `/v1/default/banks/${encodeURIComponent(bankId)}/memories/list?${query}`))
  if (value.total !== value.items.length) throw new Error(`Scoped ${type} list was paginated or incomplete: total=${value.total} returned=${value.items.length}`)
  if (value.items.some(item => !Array.isArray(item.tags) || item.tags.length !== 1 || item.tags[0] !== experimentTag)) {
    throw new Error(`Scoped ${type} list returned a memory outside the exact experiment tag`)
  }
  return value.items
}
const nativeState = (value: Record<string, any>) => {
  if (!['pending', 'processing', 'completed', 'failed', 'cancelled'].includes(value.status)) throw new Error(`Native operation returned invalid status: ${String(value.status)}`)
  return value.status === 'completed' ? 'completed' : ['failed', 'cancelled'].includes(value.status) ? 'failed' : 'pending'
}
const consolidationTrigger = async (bankId: string) => new LearningHindsightConsolidationTriggerService(await getKysely(), {
  enabled: true, baseUrl: BASE, bankId, factCount: 1, maxAgeMs: 1, deadlineMs: 15 * 60_000,
})
const bridgeAudit = async (runId: string) => {
  const rows = (await metaDbQuery<{ status: string; usage: Record<string, unknown> | null; started_at: string; completed_at: string | null }>(
    `SELECT status,usage,started_at::text,completed_at::text FROM learning_hindsight_agy_bridge_requests WHERE experiment_id=$1 ORDER BY started_at,request_id`, [runId])).rows
  const token = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value
    : typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null
  const aggregate = (key: 'inputTokens' | 'outputTokens' | 'durationMs') => {
    const values = rows.map(row => token(row.usage?.[key]))
    return rows.length > 0 && values.every((value): value is number => value !== null) ? values.reduce((sum, value) => sum + value, 0) : null
  }
  const startedAt = rows[0]?.started_at ?? null
  const completedValues = rows.map(row => row.completed_at).filter((value): value is string => typeof value === 'string')
  const completedAt = completedValues.at(-1) ?? null
  return { callCount: rows.length, completedCalls: rows.filter(row => row.status === 'completed').length, failedCalls: rows.filter(row => row.status === 'failed').length,
    inputTokens: aggregate('inputTokens'), outputTokens: aggregate('outputTokens'), providerDurationMs: aggregate('durationMs'), startedAt, completedAt,
    bridgeWindowMs: startedAt && completedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null }
}
const terminalTiming = (config: Config, calls: Awaited<ReturnType<typeof bridgeAudit>>) => {
  const completedAt = new Date().toISOString()
  const startedAt = typeof config.nativePilot?.retainStartedAt === 'string' ? config.nativePilot.retainStartedAt : calls.startedAt
  return { startedAt, completedAt, wallClockMs: startedAt ? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)) : null,
    providerDurationMs: calls.providerDurationMs, bridgeWindowMs: calls.bridgeWindowMs }
}

export const preflightLearningHindsightNativePilot = defineSessionlessFunction({ tags: ['internal', 'learning-hindsight-pilot'], expose: false, input: PreflightLearningHindsightNativePilotInput, output: PreflightLearningHindsightNativePilotOutput, func: async (_services, { runId }) => {
  const { config } = await load(runId); const bytes = await readFile(config.privateInputPath)
  if (createHash('sha256').update(bytes).digest('hex') !== config.inputSha256) throw new Error('Frozen pilot input hash drift')
  const input = z.object({ runId: z.string().uuid(), bankId: z.string(), experimentTag: z.string(), membershipDigest: z.string().length(64) }).passthrough().parse(JSON.parse(bytes.toString('utf8')))
  if (input.runId !== runId || input.bankId !== config.bankId || input.experimentTag !== config.experimentTag || input.membershipDigest !== config.dataset.membershipDigest) {
    throw new Error('Frozen pilot identity does not match its run, bank, tag, and membership config')
  }
  const preflightBytes = await readFile(config.preflightPath); const receipt = JSON.parse(preflightBytes.toString('utf8')) as any
  if (createHash('sha256').update(preflightBytes).digest('hex') !== config.preflightSha256) throw new Error('Frozen native preflight receipt hash drift')
  if (receipt.terminalState !== 'ready' || receipt.zeroModelCalls !== true || receipt.inputSha256 !== config.inputSha256
    || receipt.retain?.nativeChunkCount !== 1 || receipt.fanout?.experimentCallBudgetUpperBound !== 5
    || receipt.reflect?.responseSchemaSent !== false || receipt.requests?.bankConfig?.max_observations_per_scope !== -1) throw new Error('Native pilot preflight is stale or unsafe')
  const retainItems = z.array(z.object({ tags: z.array(z.string()), observation_scopes: z.array(z.array(z.string())), metadata: z.record(z.string(), z.unknown()) }).passthrough()).length(1).parse(receipt.requests?.retain?.items)
  const retainItem = retainItems[0]
  if (!retainItem || retainItem.tags.length !== 1 || retainItem.tags[0] !== config.experimentTag
    || retainItem.observation_scopes.length !== 1 || retainItem.observation_scopes[0]?.length !== 1 || retainItem.observation_scopes[0]?.[0] !== config.experimentTag
    || retainItem.metadata.runId !== runId || retainItem.metadata.membershipDigest !== config.dataset.membershipDigest) {
    throw new Error('Native retain request is not bound to the exact experiment tag, scope, run, and membership')
  }
  return stage({ state: 'ready', detail: { preflightPath: config.preflightPath, membershipDigest: config.dataset.membershipDigest } })
} })

export const submitLearningHindsightPilotRetain = defineSessionlessFunction({ tags: ['internal', 'learning-hindsight-pilot'], expose: false, input: SubmitLearningHindsightPilotRetainInput, output: SubmitLearningHindsightPilotRetainOutput, func: async (_services, { runId }) => {
  const { status, config } = await load(runId)
  if (status === 'failed') throw new Error('Pilot is terminal-failed; refusing native retain')
  const receipt = await json<any>(config.preflightPath)
  const requestSha256 = createHash('sha256').update(JSON.stringify(receipt.requests.retain)).digest('hex')
  const submitted = await submitNativeRetainOnce({
    checkpoint: config.nativePilot ?? {}, requestSha256,
    reserve: async () => {
      const claimed = await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status='running',
        config=jsonb_set(jsonb_set(config,'{nativePilot}',COALESCE(config->'nativePilot','{}'::jsonb)||$2::jsonb),'{callAudit}',COALESCE(config->'callAudit','[]'::jsonb)||$3::jsonb)
        WHERE run_id=$1 AND config->'nativePilot'->>'retainState' IS NULL AND config->'nativePilot'->>'retainOperationId' IS NULL RETURNING run_id`,
      [runId, JSON.stringify({ retainState: 'reserved', retainRequestSha256: requestSha256, retainStartedAt: new Date().toISOString() }),
        JSON.stringify([{ stage: 'retain', state: 'reserved', requestSha256 }])])
      return claimed.rows.length === 1
    },
    post: async () => {
      const response = await request('POST', `/v1/default/banks/${encodeURIComponent(config.bankId)}/memories`, receipt.requests.retain)
      if (typeof response.operation_id !== 'string') throw new Error('Native retain omitted operation ID')
      return response.operation_id
    },
    checkpointOperation: async operationId => {
      await patchState(runId, { retainOperationId: operationId, retainState: 'submitted' }, { stage: 'retain', state: 'submitted', operationId, requestSha256 })
    },
    markUncertain: async message => {
      await patchState(runId, { retainState: 'uncertain', retainError: message.slice(0, 4_000) }, { stage: 'retain', state: 'uncertain', requestSha256, error: message.slice(0, 4_000) })
    },
  })
  return stage({ state: 'submitted', operationId: submitted.operationId, detail: { replayed: submitted.replayed } })
} })

export const pollLearningHindsightPilotRetain = defineSessionlessFunction({ tags: ['internal', 'learning-hindsight-pilot'], expose: false, input: PollLearningHindsightPilotRetainInput, output: PollLearningHindsightPilotRetainOutput, func: async (_services, { runId }) => {
  const { config } = await load(runId); const id = config.nativePilot?.retainOperationId
  if (typeof id !== 'string') throw new Error('Retain has no durable operation checkpoint')
  const value = await operation(config.bankId, id); const state = nativeState(value)
  await patchState(runId, { retainState: state }, { stage: 'retain-poll', state, operationId: id })
  if (state === 'pending') throw new Error(`Native retain ${id} remains pending`)
  return stage({ state, operationId: id, detail: { nativeStatus: value.status } })
} })

export const submitLearningHindsightPilotConsolidation = defineSessionlessFunction({ tags: ['internal', 'learning-hindsight-pilot'], expose: false, input: SubmitLearningHindsightPilotConsolidationInput, output: SubmitLearningHindsightPilotConsolidationOutput, func: async (_services, { runId }) => {
  const { status, config } = await load(runId)
  if (status === 'failed') throw new Error('Pilot is terminal-failed; refusing native consolidation')
  if (config.nativePilot?.retainState !== 'completed') throw new Error('Consolidation requires terminal-success retain')
  const prior = config.nativePilot?.consolidationOperationId
  if (typeof prior === 'string') return stage({ state: 'submitted', operationId: prior })
  const [world, experience] = await Promise.all([
    listScopedMemories(config.bankId, config.experimentTag, 'world'),
    listScopedMemories(config.bankId, config.experimentTag, 'experience'),
  ])
  const items = [...world, ...experience]
  const conservativeTokens = Buffer.byteLength(JSON.stringify(items))
  if (items.length === 0) {
    await patchState(runId, { consolidationState: 'completed', reflectState: 'completed', retainedFactCount: 0, validAbstention: true },
      { stage: 'consolidation', state: 'skipped-empty', retainedFactCount: 0, newModelCalls: 0 })
    return stage({ state: 'completed', detail: { retainedFactCount: 0, validAbstention: true, newModelCalls: 0 } })
  }
  if (items.length > 50 || conservativeTokens > 400_000) throw new Error(`Actual retain output requires more than one bounded consolidation call: facts=${items.length} conservativeTokens=${conservativeTokens}`)
  const watermark = createHash('sha256').update(`${config.dataset.membershipDigest}\n${config.nativePilot?.retainOperationId}\n${items.length}`).digest('hex')
  const result = await (await consolidationTrigger(config.bankId)).trigger({ bankId: config.bankId, scope: [config.experimentTag], sequence: 1,
    watermark, pendingFacts: items.length, oldestPendingAt: new Date().toISOString() })
  if (result.state === 'uncertain' || result.state === 'busy' || result.state === 'disabled') throw new Error(`Consolidation reservation ended ${result.state}; refusing blind submit`)
  if (!('operationId' in result)) throw new Error(`Consolidation trigger did not submit: ${result.state}`)
  await patchState(runId, { consolidationOperationId: result.operationId, consolidationState: 'submitted', retainedFactCount: items.length,
    consolidationConservativeInputTokens: conservativeTokens, consolidationWatermark: watermark }, { stage: 'consolidation', state: 'submitted', operationId: result.operationId, retainedFactCount: items.length })
  return stage({ state: 'submitted', operationId: result.operationId, detail: { retainedFactCount: items.length, conservativeTokens } })
} })

export const pollLearningHindsightPilotConsolidation = defineSessionlessFunction({ tags: ['internal', 'learning-hindsight-pilot'], expose: false, input: PollLearningHindsightPilotConsolidationInput, output: PollLearningHindsightPilotConsolidationOutput, func: async (_services, { runId }) => {
  const { config } = await load(runId); const id = config.nativePilot?.consolidationOperationId
  if (typeof id !== 'string') throw new Error('Consolidation has no durable operation checkpoint')
  const result = await (await consolidationTrigger(config.bankId)).poll({ bankId: config.bankId, scope: [config.experimentTag] })
  if (result.state === 'uncertain') throw new Error('Consolidation checkpoint is uncertain; refusing blind submit')
  const state = result.state === 'completed' ? 'completed' : ['failed', 'timed_out'].includes(result.state) ? 'failed' : 'pending'
  await patchState(runId, { consolidationState: state }, { stage: 'consolidation-poll', state, operationId: id })
  if (state === 'pending') throw new Error(`Native consolidation ${id} remains pending`)
  return stage({ state, operationId: id, detail: { nativeStatus: result.state } })
} })

const entities = (fact: Record<string, any>) => typeof fact.entities === 'string' ? fact.entities.split(',').map((item: string) => item.trim()) : Array.isArray(fact.entities) ? fact.entities : []
export const runLearningHindsightPilotReflect = defineSessionlessFunction({ tags: ['internal', 'learning-hindsight-pilot'], expose: false, input: RunLearningHindsightPilotReflectInput, output: RunLearningHindsightPilotReflectOutput, func: async (_services, { runId }) => {
  const { status, config } = await load(runId)
  if (status === 'failed') throw new Error('Pilot is terminal-failed; refusing native reflect')
  if (config.nativePilot?.consolidationState !== 'completed') throw new Error('Reflect requires terminal-success consolidation')
  const Node = z.object({ conceptId: z.string(), nodeVersion: z.string().length(64), understandingPercent: z.number().nullable() })
  const Source = z.object({ id: z.string(), text: z.string(), textSha256: z.string().length(64) }).passthrough()
  const Pilot = z.object({ nodeStates: z.array(Node), cases: z.array(z.object({ caseId: z.string(), current: Source, response: Source }).passthrough()) }).passthrough()
  const List = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).passthrough()
  const Raw = z.object({ inputSha256: z.string(), requestSha256: z.string(), requestBody: z.record(z.string(), z.unknown()),
    nodeStates: z.array(Node), facts: List.shape.items, observations: List.shape.items,
    responseStatus: z.number().int(), responseText: z.string(), durationMs: z.number(), startedAt: z.string(), completedAt: z.string() })
  const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
  const bytes = await readFile(config.privateInputPath)
  if (digest(bytes) !== config.inputSha256) throw new Error('Reflect source snapshot drift')
  const input = Pilot.parse(JSON.parse(bytes.toString('utf8')))
  const humanTextBySourceId = Object.fromEntries(input.cases.map(item => [item.current.id, item.current.text]))
  const rawPath = `${config.rawOutputPath}.http-response.json`
  const existingOutput = await readOptionalPrivateJson(config.rawOutputPath)
  let rawValue = await readOptionalPrivateJson(rawPath)
  let replayed = rawValue !== null
  if (existingOutput !== null && rawValue === null) throw new Error('Validated output lacks its immutable raw response; refusing another call')
  if (rawValue === null) {
    const [world, experience, observations] = await Promise.all([
      listScopedMemories(config.bankId, config.experimentTag, 'world'),
      listScopedMemories(config.bankId, config.experimentTag, 'experience'),
      listScopedMemories(config.bankId, config.experimentTag, 'observation'),
    ])
    const facts = [...world, ...experience]
    const conceptIds = new Set(facts.flatMap(fact => entities(fact).filter((item: string) => item.startsWith('concept_id:')).map((item: string) => item.slice(11))))
    const nodeStates = input.nodeStates.filter(node => conceptIds.has(node.conceptId))
    if (!nodeStates.length || nodeStates.length !== conceptIds.size) throw new Error('Native facts lack valid mapped concept IDs; refusing ungrounded assessment')
    const receipt = z.object({ requests: z.object({ reflect: z.record(z.string(), z.unknown()) }) }).parse(await json<unknown>(config.preflightPath))
    if ('response_schema' in receipt.requests.reflect) throw new Error('Refusing lossy native reflect schema conversion')
    const body = { ...receipt.requests.reflect, query: nativeReflectQuery({ nodeStates, humanTextBySourceId }, observations, input.cases) }
    const requestSha256 = digest(JSON.stringify(body))
    const started = Date.now()
    const claim = await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET config=jsonb_set(config,'{nativePilot}',
      COALESCE(config->'nativePilot','{}'::jsonb)||$2::jsonb)
      WHERE run_id=$1 AND config->'nativePilot'->>'reflectState' IS NULL RETURNING run_id`,
    [runId, JSON.stringify({ reflectState: 'reserved', reflectRequestSha256: requestSha256, reflectStartedAt: new Date(started).toISOString() })])
    if (claim.rows.length !== 1) {
      rawValue = await readOptionalPrivateJson(rawPath)
      if (rawValue === null) throw new Error('Reflect is in-flight or uncertain; refusing a duplicate native call')
      replayed = true
    } else {
      try {
        // Three native iterations may each use the independently bounded 420s.
        const response = await fetch(`${BASE}/v1/default/banks/${encodeURIComponent(config.bankId)}/reflect`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3 * 420_000 + 60_000),
        })
        const responseText = await response.text()
        rawValue = { inputSha256: config.inputSha256, requestSha256, requestBody: body, nodeStates, facts, observations,
          responseStatus: response.status, responseText, durationMs: Date.now() - started,
          startedAt: new Date(started).toISOString(), completedAt: new Date().toISOString() }
        // Preserve HTTP bytes before parsing either JSON layer or source evidence.
        await writeImmutablePrivateJson(rawPath, rawValue)
      } catch (error) {
        await patchState(runId, { reflectState: 'uncertain' }, { stage: 'reflect', state: 'uncertain', error: String(error), rawPath })
        throw error
      }
    }
  }
  const raw = Raw.parse(rawValue)
  const latest = await load(runId)
  if (raw.inputSha256 !== config.inputSha256 || digest(JSON.stringify(raw.requestBody)) !== raw.requestSha256
    || latest.config.nativePilot?.reflectRequestSha256 !== raw.requestSha256
    || raw.nodeStates.some(node => !input.nodeStates.some(frozen => frozen.conceptId === node.conceptId && frozen.nodeVersion === node.nodeVersion))) {
    throw new Error('Raw reflect receipt does not match its frozen source and reserved request')
  }
  let validated: ReturnType<typeof validateNativeReflectHttp>
  try { validated = validateNativeReflectHttp(raw.responseStatus, raw.responseText, { nodeStates: raw.nodeStates, humanTextBySourceId }) }
  catch (error) {
    await patchState(runId, { reflectState: 'failed', reflectRawPath: rawPath }, { stage: 'reflect', state: 'invalid-output', error: String(error), rawPath })
    throw error
  }
  const { response, proposals } = validated
  const output = { terminalState: 'success', inputSha256: config.inputSha256, requestSha256: raw.requestSha256,
    native: { facts: raw.facts, observations: raw.observations, reflect: response }, proposals,
    timing: { reflectMs: raw.durationMs }, effective: { backend: 'agy', model: 'gemini-3.7-flash', effort: 'high' }, masteryWrites: 0 }
  if (existingOutput !== null) {
    const prior = z.object({ terminalState: z.literal('success'), inputSha256: z.string(), requestSha256: z.string(), proposals: z.unknown() }).passthrough().parse(existingOutput)
    if (prior.inputSha256 !== config.inputSha256 || prior.requestSha256 !== raw.requestSha256 || JSON.stringify(prior.proposals) !== JSON.stringify(proposals)) throw new Error('Existing validated receipt conflicts with raw response')
  } else await writeImmutablePrivateJson(config.rawOutputPath, output)
  await patchState(runId, { reflectState: 'completed', reflectRawPath: rawPath }, { stage: 'reflect', state: 'completed', proposalCount: proposals.length, usage: response.usage ?? null, replayed })
  return stage({ state: 'completed', detail: { proposalCount: proposals.length, durationMs: raw.durationMs, replayed, ...(replayed ? { newModelCalls: 0 } : {}) } })
} })

export const finalizeLearningHindsightNativePilot = defineSessionlessFunction({ tags: ['internal', 'learning-hindsight-pilot'], expose: false, input: FinalizeLearningHindsightNativePilotInput, output: FinalizeLearningHindsightNativePilotOutput, func: async (_services, { runId }) => {
  const { status, config } = await load(runId)
  if (status === 'failed') throw new Error('Pilot is terminal-failed; refusing successful finalization')
  const calls = await bridgeAudit(runId)
  assertCompletedBridgeCallAudit(calls)
  const timing = terminalTiming(config, calls)
  if (config.nativePilot?.validAbstention === true) {
    const summary = { reportDate: new Date().toISOString().slice(0, 10), proof: HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY, terminalState: 'completed', pairCount: 3, messageCount: 6,
      nativeFacts: 0, nativeObservations: 0, proposalCount: 0, masteryWrites: 0, rawTranscriptPublication: 'private-only', calls, timing,
      reportMarkdown: `# Hindsight AGY three-pair native pilot\n\n**Result:** valid abstention  \n**Cohort:** 3 pairs · 6 messages  \n**Membership:** \`${config.dataset.membershipDigest}\`  \n**Native calls:** ${calls.callCount}; ${calls.inputTokens ?? 'input tokens unknown'} input tokens; ${calls.outputTokens ?? 'output tokens unknown'} output tokens; ${timing.wallClockMs ?? 'wall clock unknown'} ms workflow wall clock; ${timing.providerDurationMs ?? 'provider duration unknown'} ms summed provider duration\n\nNative extraction returned no facts. Consolidation and reflect were therefore not called; this pilot does not prove their positive path. The result remains review-only, no mastery was written, the 500-turn gate is not passed, and realtime processing remains disabled.` }
    await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status='completed',summary=$2::jsonb,output_tokens=$3,
      config=jsonb_set(config,'{nativePilotResult}',$4::jsonb),completed_at=now() WHERE run_id=$1`,
    [runId, JSON.stringify(summary), calls.outputTokens, JSON.stringify({ terminalState: 'success', validAbstention: true, facts: [], observations: [], proposals: [], calls, timing })])
    await metaDbQuery(`UPDATE learning_extraction_benchmark_cases SET status='completed' WHERE run_id=$1`, [runId])
    return summary
  }
  const output = await json<any>(config.rawOutputPath)
  if (output.terminalState !== 'success') throw new Error('Pilot output is not successful')
  const unknown = output.proposals.filter((item: any) => item.understandingPercent === null).length
  const summary = { reportDate: new Date().toISOString().slice(0, 10), proof: HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY, terminalState: 'completed', pairCount: 3, messageCount: 6,
    nativeFacts: output.native.facts.length, nativeObservations: output.native.observations.length, proposalCount: output.proposals.length, unknownConcepts: unknown,
    needsReview: output.proposals.filter((item: any) => item.needsReview).length, masteryWrites: 0, rawTranscriptPublication: 'private-only', calls, timing,
    reportMarkdown: `# Hindsight AGY three-pair native pilot\n\n**Completed:** ${timing.completedAt}  \n**Cohort:** 3 pairs · 6 messages (strict canonical pairs)  \n**Membership:** \`${config.dataset.membershipDigest}\`  \n**Native calls:** ${calls.callCount}; ${calls.inputTokens ?? 'input tokens unknown'} input tokens; ${calls.outputTokens ?? 'output tokens unknown'} output tokens; ${timing.wallClockMs ?? 'wall clock unknown'} ms workflow wall clock; ${timing.providerDurationMs ?? 'provider duration unknown'} ms summed provider duration\n\nNative Hindsight retained ${output.native.facts.length} untrusted staged facts, consolidated ${output.native.observations.length} observations, and returned ${output.proposals.length} review-only gradual-understanding proposals. ${unknown} concepts remained unknown. No learner mastery was written. Raw transcripts remain private. The 500-turn gate is not passed; realtime processing remains disabled.` }
  await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status='completed',summary=$2::jsonb,output_tokens=$3,
    config=jsonb_set(config,'{nativePilotResult}',$4::jsonb),completed_at=now() WHERE run_id=$1`,
  [runId, JSON.stringify(summary), calls.outputTokens, JSON.stringify({ terminalState: 'success', facts: output.native.facts,
    observations: output.native.observations, proposals: output.proposals, effective: output.effective, calls, timing,
    privateRawReceiptPath: config.rawOutputPath })])
  await metaDbQuery(`UPDATE learning_extraction_benchmark_cases SET status='completed' WHERE run_id=$1`, [runId])
  return summary
} })

export const failLearningHindsightNativePilot = defineSessionlessFunction({ tags: ['internal', 'learning-hindsight-pilot'], expose: false, input: FailLearningHindsightNativePilotInput, output: FailLearningHindsightNativePilotOutput,
  func: async ({ workflowRunService }, { error }, { workflowStep }) => {
  if (!workflowStep?.runId) throw new Error('Pilot failure compensation requires a workflow run')
  const workflowRun = await workflowRunService.getRun(workflowStep.runId)
  if (!workflowRun || workflowRun.workflow !== 'learningHindsightNativePilotWorkflow') throw new Error('Pilot failure compensation received the wrong workflow run')
  const { runId } = Base.parse(workflowRun.input)
  const { config } = await load(runId)
  const calls = await bridgeAudit(runId)
  const timing = terminalTiming(config, calls)
  const message = error.message.slice(0, 4_000)
  const reportMarkdown = `# Hindsight AGY canonical three-pair pilot\n\n**Status:** failed visibly  \n**Cohort:** 3 pairs · 6 messages  \n**Membership:** ${config.dataset.membershipDigest}  \n**Native calls:** ${calls.callCount}; ${calls.inputTokens ?? 'input tokens unknown'} input tokens; ${calls.outputTokens ?? 'output tokens unknown'} output tokens; ${timing.wallClockMs ?? 'wall clock unknown'} ms workflow wall clock; ${timing.providerDurationMs ?? 'provider duration unknown'} ms summed provider duration\n\nThe review-only pilot stopped at a durable gate: ${message}\n\nNo mastery was written. The 500-turn gate is not passed; realtime processing remains disabled. Private native receipts were preserved for review.`
  await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status='failed',error=$2,summary=$3::jsonb,output_tokens=$4,completed_at=now() WHERE run_id=$1 AND status<>'completed'`,
    [runId, message, JSON.stringify({ reportDate: new Date().toISOString().slice(0, 10), proof: HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY,
      terminalState: 'failed', pairCount: 3, messageCount: 6, masteryWrites: 0, calls, timing, reportMarkdown, rawTranscriptPublication: 'private-only' }), calls.outputTokens])
  await metaDbQuery(`UPDATE learning_extraction_benchmark_cases SET status='failed',error=$2 WHERE run_id=$1 AND status<>'completed'`, [runId, message])
  return { failed: true as const }
} })

export const assertLearningHindsightPilotStage = defineSessionlessFunction({ tags: ['internal', 'learning-hindsight-pilot'], expose: false, input: AssertLearningHindsightPilotStageInput, output: AssertLearningHindsightPilotStageOutput,
  func: async (_services, input) => {
    if (input.state !== 'completed') throw new Error(`${input.stage} did not reach terminal success: ${input.state}`)
    return stage({ state: 'completed', detail: { checkedStage: input.stage } })
  },
})
