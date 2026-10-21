import { defineSessionlessFunction } from '../../../runtime/define.js'
import { createHash } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'

import { AGENTS } from '@learner/llm/lib/cli/cli-agents.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import {
  GRADUAL_ASSESSMENT_ARMS,
  GRADUAL_ASSESSMENT_COMPARISON_STRATEGY,
  GRADUAL_ASSESSMENT_DEADLINE_MS,
  GRADUAL_ASSESSMENT_MAX_INPUT_TOKENS,
  compareGradualAssessments,
  sumGradualAssessmentOutputTokens,
  summarizeGradualAssessment,
} from '@learner/core/lib/learning/learning-gradual-assessment-comparison-run.js'
import {
  GRADUAL_ASSESSMENT_REVISION,
  gradualAssessmentPrompt,
  gradualAssessmentSchema,
  validateGradualAssessment,
} from '@learner/core/lib/learning/learning-gradual-assessment.js'

const Input = z.object({ runId: z.string().uuid() })
const ArmInput = Input.extend({ armId: z.enum(['luna-high', 'agy-3.7-flash-high']) })
const Output = z.record(z.string(), z.unknown())
export const PreflightLearningGradualAssessmentComparisonInput = Input
export const PreflightLearningGradualAssessmentComparisonOutput = Output
export const RunLearningGradualAssessmentArmInput = ArmInput
export const RunLearningGradualAssessmentArmOutput = Output
export const FinalizeLearningGradualAssessmentComparisonInput = Input
export const FinalizeLearningGradualAssessmentComparisonOutput = Output

type ArmConfig = {
  armId: 'luna-high' | 'agy-3.7-flash-high'
  label: string
  backend: 'codex' | 'agy'
  requestedModel: string
  requestedEffort: 'high'
  outputPath: string
  deadlineMs: number
  maxAttempts: number
  modelRetries: number
}
type ComparisonConfig = {
  contextStrategy?: string
  privateInputPath?: string
  inputSha256?: string
  promptContractPath?: string
  sourceInputSha256?: string
  pairCount?: number
  messageCount?: number
  matchCount?: number
  conceptCount?: number
  nativeObservationCount?: number
  catalog?: Array<{ id?: string; title?: string }>
  arms?: ArmConfig[]
  promptContract?: {
    revision?: string
    promptSha256?: string
    schemaSha256?: string
    promptBytes?: number
    schemaBytes?: number
    conservativeInputTokenUpperBound?: number
    effectiveInputCeilingTokens?: number
    armContracts?: Array<{ armId?: string; effectiveModel?: string; effectiveEffort?: string; promptSha256?: string; schemaSha256?: string }>
  }
  callAudit?: Array<{ step?: string; armId?: string; state?: string }>
}
type Manifest = {
  cases: Array<{ caseId: string; current: { id: string; role: string; text: string }; response: { id: string; role: string; text: string }; classification?: { matches?: Array<{ conceptId: string; relationship: string }> } }>
  nodeStates: Array<{ conceptId: string; nodeId: string; nodeVersion: string; assessment?: unknown; sourceIds?: string[] }>
  nativeObservations: unknown[]
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T
const appendAudit = (runId: string, value: unknown) => metaDbQuery(`UPDATE learning_extraction_benchmark_runs
  SET config=jsonb_set(config,'{callAudit}',COALESCE(config->'callAudit','[]'::jsonb) || $2::jsonb),status='running' WHERE run_id=$1`, [runId, JSON.stringify([value])])

const load = async (runId: string) => {
  const row = (await metaDbQuery<{ status: string; count: string; config: ComparisonConfig; summary: Record<string, unknown> | null }>(`SELECT r.status,count(c.*)::text count,r.config,r.summary
    FROM learning_extraction_benchmark_runs r LEFT JOIN learning_extraction_benchmark_cases c ON c.run_id=r.run_id
    WHERE r.run_id=$1 GROUP BY r.run_id`, [runId])).rows[0]
  if (!row || row.config.contextStrategy !== GRADUAL_ASSESSMENT_COMPARISON_STRATEGY || Number(row.count) !== 100
    || row.config.pairCount !== 100 || row.config.messageCount !== 200 || row.config.matchCount !== 49 || row.config.conceptCount !== 34
    || row.config.nativeObservationCount !== 5 || !row.config.privateInputPath || !row.config.inputSha256 || !row.config.promptContractPath || row.config.arms?.length !== 2) {
    throw new Error('Gradual assessment comparison is not the frozen 100-pair/49-match/34-concept/five-observation input')
  }
  return row
}

const buildContract = async (config: ComparisonConfig) => {
  const bytes = await readFile(config.privateInputPath!)
  if (sha256(bytes) !== config.inputSha256) throw new Error('Frozen gradual assessment comparison input hash drift')
  const input = JSON.parse(bytes.toString('utf8')) as Manifest
  const titles = new Map((config.catalog ?? []).map(item => [item.id, item.title]))
  const nodeStates = input.nodeStates.map(state => ({
    ...state,
    conceptTitle: titles.get(state.conceptId) ?? state.conceptId,
    understandingPercent: null,
  }))
  const humanTextBySourceId = Object.fromEntries(input.cases.map(item => [item.current.id, item.current.text]))
  const evidence = input.cases.map(item => ({ caseId: item.caseId, current: item.current, response: item.response, matches: item.classification?.matches ?? [] }))
  const prompt = gradualAssessmentPrompt({ nodeStates, nativeObservations: input.nativeObservations, evidence })
  const conceptIds = nodeStates.map(state => state.conceptId).sort()
  const outputSchema = gradualAssessmentSchema(conceptIds)
  const promptBytes = Buffer.byteLength(prompt)
  const schemaBytes = Buffer.byteLength(JSON.stringify(outputSchema))
  const conservativeInputTokenUpperBound = promptBytes + schemaBytes + 1_024
  const context = { nodeStates, humanTextBySourceId }
  return { input, prompt, outputSchema, context, conceptIds, promptBytes, schemaBytes, conservativeInputTokenUpperBound,
    promptSha256: sha256(prompt), schemaSha256: sha256(JSON.stringify(outputSchema)) }
}

const armContract = (arm: ArmConfig, promptSha256: string, schemaSha256: string) => {
  const effectiveModel = arm.backend === 'agy' ? AGENTS.AGY.resolveModel(arm.requestedModel, arm.requestedEffort) : arm.requestedModel
  const effectiveEffort = arm.backend === 'agy' ? AGENTS.AGY.reasoningMap[arm.requestedEffort] : arm.requestedEffort
  return { armId: arm.armId, backend: arm.backend, requestedModel: arm.requestedModel, requestedEffort: arm.requestedEffort,
    effectiveModel, effectiveEffort, promptSha256, schemaSha256, deadlineMs: arm.deadlineMs, modelRetries: arm.modelRetries }
}

const reserveAttempt = async (runId: string, arm: ArmConfig, contract: ReturnType<typeof armContract>) => {
  const value = { step: 'assessment', state: 'started', attempt: 1, ...contract }
  const reserved = await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET
    config=jsonb_set(config,'{callAudit}',COALESCE(config->'callAudit','[]'::jsonb) || $3::jsonb),status='running'
    WHERE run_id=$1 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(config->'callAudit','[]'::jsonb)) a
      WHERE a->>'step'='assessment' AND a->>'armId'=$2 AND a->>'state'='started') RETURNING run_id`, [runId, arm.armId, JSON.stringify([value])])
  if (reserved.rows.length !== 1) throw new Error(`${arm.armId} attempt was already reserved; refusing a concurrent or hidden retry`)
}

export const preflightLearningGradualAssessmentComparison = defineSessionlessFunction({
  title: 'Preflight the frozen gradual-assessment comparison',
  description: 'Prove identical prompt/schema bytes, bounded context, exact model routing, and zero prior attempts before either paid arm.',
  input: PreflightLearningGradualAssessmentComparisonInput,
  output: PreflightLearningGradualAssessmentComparisonOutput,
  func: async (_services, { runId }) => {
    const { status, config } = await load(runId)
    if (!['queued', 'running', 'completed', 'partial'].includes(status)) throw new Error('Gradual assessment comparison preflight requires a queued, running, or terminal replay run')
    if ((config.callAudit?.length ?? 0) !== 0 && !config.promptContract) throw new Error('Comparison has attempts without a frozen prompt contract')
    const contract = await buildContract(config)
    if (contract.conceptIds.length !== 34 || contract.input.nativeObservations.length !== 5 || contract.conservativeInputTokenUpperBound > GRADUAL_ASSESSMENT_MAX_INPUT_TOKENS) {
      throw new Error('Gradual assessment prompt does not fit the frozen 34-concept single-batch contract')
    }
    const arms = config.arms!.map(arm => armContract(arm, contract.promptSha256, contract.schemaSha256))
    if (new Set(arms.map(arm => arm.promptSha256)).size !== 1 || new Set(arms.map(arm => arm.schemaSha256)).size !== 1
      || arms[0]?.effectiveModel !== 'gpt-5.6-luna' || arms[0]?.effectiveEffort !== 'high'
      || arms[1]?.effectiveModel !== 'gemini-3.7-flash-high' || arms[1]?.effectiveEffort !== 'high'
      || config.arms!.some(arm => arm.deadlineMs !== GRADUAL_ASSESSMENT_DEADLINE_MS || arm.maxAttempts !== 1 || arm.modelRetries !== 0)) {
      throw new Error('Gradual assessment arms are not an identical-input Luna High versus AGY 3.7 Flash High comparison')
    }
    const promptContract = { revision: GRADUAL_ASSESSMENT_REVISION, promptSha256: contract.promptSha256, schemaSha256: contract.schemaSha256,
      promptBytes: contract.promptBytes, schemaBytes: contract.schemaBytes, conservativeInputTokenUpperBound: contract.conservativeInputTokenUpperBound,
      requestedInputCeilingTokens: 400_000, effectiveInputCeilingTokens: GRADUAL_ASSESSMENT_MAX_INPUT_TOKENS, reservedOutputReasoningTokens: 64_000,
      conceptCount: contract.conceptIds.length, nativeObservationCount: contract.input.nativeObservations.length, armContracts: arms }
    const commonBytes = `${JSON.stringify({ revision: GRADUAL_ASSESSMENT_REVISION, inputSha256: config.inputSha256,
      promptSha256: contract.promptSha256, schemaSha256: contract.schemaSha256, prompt: contract.prompt, outputSchema: contract.outputSchema }, null, 2)}\n`
    if (config.promptContract) {
      if (config.promptContract.revision !== GRADUAL_ASSESSMENT_REVISION || config.promptContract.promptSha256 !== contract.promptSha256
        || config.promptContract.schemaSha256 !== contract.schemaSha256) throw new Error('Frozen gradual assessment prompt contract drift')
      if (await readFile(config.promptContractPath!, 'utf8') !== commonBytes) throw new Error('Frozen common prompt/schema bytes drift')
      return { ready: true, replayed: true, zeroModelCalls: true, promptContract: config.promptContract }
    }
    if ((config.callAudit?.length ?? 0) !== 0) throw new Error('Cannot freeze prompt/schema after an arm attempt')
    try {
      await writeFile(config.promptContractPath!, commonBytes, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(config.promptContractPath!, 'utf8') !== commonBytes) throw error
    }
    await chmod(config.promptContractPath!, 0o600)
    await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET config=jsonb_set(config,'{promptContract}',$2::jsonb) WHERE run_id=$1`, [runId, JSON.stringify(promptContract)])
    return { ready: true, zeroModelCalls: true, promptContract }
  },
})

export const runLearningGradualAssessmentArm = defineSessionlessFunction({
  title: 'Run one gradual-understanding assessment arm',
  description: 'Execute one schema-identical review-only assessment arm with one model attempt and persist raw terminal evidence privately.',
  input: RunLearningGradualAssessmentArmInput,
  output: RunLearningGradualAssessmentArmOutput,
  func: async ({ llmService }, { runId, armId }) => {
    const { config } = await load(runId)
    const arm = config.arms!.find(item => item.armId === armId)
    if (!arm || !config.promptContract?.promptSha256 || !config.promptContract.schemaSha256) throw new Error(`Missing frozen preflight contract for ${armId}`)
    const built = await buildContract(config)
    const common = await json<{ revision?: string; inputSha256?: string; promptSha256?: string; schemaSha256?: string; prompt?: string; outputSchema?: unknown }>(config.promptContractPath!)
    if (built.promptSha256 !== config.promptContract.promptSha256 || built.schemaSha256 !== config.promptContract.schemaSha256
      || common.revision !== GRADUAL_ASSESSMENT_REVISION || common.inputSha256 !== config.inputSha256
      || common.promptSha256 !== built.promptSha256 || common.schemaSha256 !== built.schemaSha256
      || common.prompt !== built.prompt || JSON.stringify(common.outputSchema) !== JSON.stringify(built.outputSchema)) throw new Error('Frozen common prompt/schema drift after paid-call preflight')
    const effective = armContract(arm, built.promptSha256, built.schemaSha256)
    try {
      const existing = await json<any>(arm.outputPath)
      if (existing.inputSha256 !== config.inputSha256 || existing.promptSha256 !== built.promptSha256 || existing.schemaSha256 !== built.schemaSha256
        || existing.revision !== GRADUAL_ASSESSMENT_REVISION || existing.armId !== armId) throw new Error(`${armId} terminal artifact contract mismatch`)
      if (!config.callAudit?.some(item => item.armId === armId && item.state === existing.terminalState)) {
        if (!config.callAudit?.some(item => item.armId === armId && item.state === 'started')) throw new Error(`${armId} terminal artifact has no reserved attempt`)
        await appendAudit(runId, { step: 'assessment', armId, state: existing.terminalState, attempt: 1, recoveredFromArtifact: true,
          durationMs: existing.durationMs, usage: existing.usage, proposalCount: existing.proposals?.length ?? 0, masteryWrites: 0 })
      }
      return { terminalState: existing.terminalState, replayed: true, newModelCalls: 0, proposalCount: existing.proposals?.length ?? 0, masteryWrites: 0 }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (config.callAudit?.some(item => item.armId === armId && item.state === 'started')) throw new Error(`${armId} attempt is reserved without a terminal receipt; refusing a hidden retry`)
    await reserveAttempt(runId, arm, effective)
    const started = Date.now()
    let raw = ''
    let usage: Record<string, unknown> | null = null
    try {
      const proposals = await llmService.callLLMWithStructuredOutput({
        label: `Learning gradual assessment ${armId} ${runId}`,
        prompt: common.prompt,
        outputSchema: common.outputSchema,
        parseFn: (value: unknown) => {
          raw = typeof value === 'string' ? value : JSON.stringify(value)
          return validateGradualAssessment(typeof value === 'string' ? JSON.parse(value) : value, built.context)
        },
        callOptions: { backend: arm.backend, model: arm.requestedModel, effort: arm.requestedEffort, timeout: 420, killMs: GRADUAL_ASSESSMENT_DEADLINE_MS,
          onUsage: (value: Record<string, unknown>) => { usage = value } },
        maxParseRetries: 0,
      })
      const receipt = { terminalState: 'completed', revision: GRADUAL_ASSESSMENT_REVISION, ...effective, proposals, raw,
        inputSha256: config.inputSha256, promptSha256: built.promptSha256, schemaSha256: built.schemaSha256, durationMs: Date.now() - started,
        usage, masteryWrites: 0 }
      await writeFile(arm.outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      await chmod(arm.outputPath, 0o600)
      await appendAudit(runId, { step: 'assessment', armId, state: 'completed', attempt: 1, durationMs: receipt.durationMs, usage,
        proposalCount: proposals.length, rawCaptured: raw.length > 0, masteryWrites: 0 })
      return { terminalState: 'completed', proposalCount: proposals.length, durationMs: receipt.durationMs, usage, masteryWrites: 0 }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      const receipt = { terminalState: 'failed', revision: GRADUAL_ASSESSMENT_REVISION, ...effective, error: errorText, raw,
        inputSha256: config.inputSha256, promptSha256: built.promptSha256, schemaSha256: built.schemaSha256, durationMs: Date.now() - started,
        usage, masteryWrites: 0 }
      try {
        await writeFile(arm.outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        await chmod(arm.outputPath, 0o600)
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
      }
      await appendAudit(runId, { step: 'assessment', armId, state: 'failed', attempt: 1, durationMs: receipt.durationMs, usage,
        error: errorText, rawCaptured: raw.length > 0, masteryWrites: 0 })
      return { terminalState: 'failed', error: errorText, durationMs: receipt.durationMs, usage, masteryWrites: 0 }
    }
  },
})

export const finalizeLearningGradualAssessmentComparison = defineSessionlessFunction({
  title: 'Finalize the gradual-understanding assessment comparison',
  description: 'Persist both arm outcomes, paired aggregates, and authenticated raw access without changing learner mastery.',
  input: FinalizeLearningGradualAssessmentComparisonInput,
  output: FinalizeLearningGradualAssessmentComparisonOutput,
  func: async (_services, { runId }) => {
    const { config, summary: priorSummary } = await load(runId)
    const armReceipts = await Promise.all(config.arms!.map(arm => json<any>(arm.outputPath)))
    const complete = armReceipts.every(receipt => receipt.terminalState === 'completed' && Array.isArray(receipt.proposals) && receipt.proposals.length === 34)
    const armSummaries = Object.fromEntries(config.arms!.map((arm, index) => {
      const receipt = armReceipts[index]
      return [arm.armId, { label: arm.label, backend: arm.backend, requestedModel: arm.requestedModel, requestedEffort: arm.requestedEffort,
        effectiveModel: receipt.effectiveModel, effectiveEffort: receipt.effectiveEffort, terminalState: receipt.terminalState,
        durationMs: receipt.durationMs, usage: receipt.usage, ...(receipt.terminalState === 'completed' ? summarizeGradualAssessment(receipt.proposals) : { error: receipt.error }) }]
    }))
    const comparison = complete ? compareGradualAssessments(armReceipts[0].proposals, armReceipts[1].proposals) : null
    const outputTokens = sumGradualAssessmentOutputTokens(armReceipts)
    const summary = { reportDate: new Date().toISOString().slice(0, 10), proof: 'seed-v1-gradual-understanding-assessment-ab',
      sourceProofRunId: '7754b037-05db-4a5b-b8b7-910411a5094a', pairCount: 100, messageCount: 200, matchCount: 49,
      conceptCount: 34, nativeObservations: 5, arms: armSummaries, comparison, masteryWrites: 0,
      nodeStateBaseline: 'synthetic-empty-v1', semanticReview: priorSummary?.semanticReview ?? 'pending',
      ...(priorSummary?.reviewer ? { reviewer: priorSummary.reviewer } : {}),
      ...(priorSummary?.semanticAudit ? { semanticAudit: priorSummary.semanticAudit } : {}),
      ...(priorSummary?.reportUrl ? { reportUrl: priorSummary.reportUrl } : {}),
      rawTranscriptPublication: 'private-only' }
    const commonPromptSchema = await json<unknown>(config.promptContractPath!)
    await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status=$2,summary=$3::jsonb,completed_at=now(),output_tokens=$7,
      config=jsonb_set(jsonb_set(jsonb_set(config,'{gradualAssessmentOutputs}',$4::jsonb),'{gradualAssessmentReceipts}',$5::jsonb),'{gradualAssessmentPromptSchema}',$6::jsonb)
      WHERE run_id=$1`,
    [runId, complete ? 'completed' : 'partial', JSON.stringify(summary), JSON.stringify(Object.fromEntries(config.arms!.map((arm, index) => [arm.armId, armReceipts[index].proposals ?? []]))),
      JSON.stringify(Object.fromEntries(config.arms!.map((arm, index) => [arm.armId, armReceipts[index]]))), JSON.stringify(commonPromptSchema), outputTokens])
    await metaDbQuery(`UPDATE learning_extraction_benchmark_cases SET status=$2,error=NULL WHERE run_id=$1`, [runId, complete ? 'completed' : 'failed'])
    return summary
  },
})
