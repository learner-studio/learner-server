import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { defineSessionlessFunction } from '../../../runtime/define.js'
import { z } from 'zod'
import { AGENTS, runCliAgent } from '@learner/llm/lib/cli/cli-agents.js'
import { createCliObserver } from '@learner/llm/lib/cli/cli-telemetry.js'
import { resolveRetrievalLookup } from '@learner/core/lib/learning/learning-playground-retrieval.js'
import { archivePlaygroundTurn } from '@learner/core/lib/learning/learning-playground-archive.js'
import { assessmentHash } from '@learner/core/lib/learning/learning-concept-assessment.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { isRunActive } from '@learner/core/lib/workflow/workflow-runs.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import {
  LearningPlaygroundNormalizationInput,
  LearningPlaygroundNormalizationOutput,
  LearningPlaygroundProposal,
  LearningPlaygroundWorkflowInput,
  LearningPlaygroundLookupOutput,
  LearningPlaygroundResponseInput,
  LearningPlaygroundResponseOutput,
  PLAYGROUND_LIVE_EFFORT,
  PLAYGROUND_LIVE_MODEL,
  playgroundPrompt,
  playgroundProposalPrompt,
  readPlaygroundFixtures,
  resolveCurrentTurnLookup,
  resolvePlaygroundLookup,
} from '@learner/core/lib/learning/learning-playground.js'

const executionFrom = (result: Awaited<ReturnType<typeof runCliAgent>>) => ({
  model: String(result.model), effort: String(result.reasoning), durationMs: Number(result.durationMs),
  inputTokens: typeof result.telemetryResult?.inputTokens === 'number' ? result.telemetryResult.inputTokens : null,
  outputTokens: typeof result.telemetryResult?.outputTokens === 'number' ? result.telemetryResult.outputTokens : null,
})

export const lookupLearningPlaygroundStep = defineSessionlessFunction({
  input: LearningPlaygroundWorkflowInput, output: LearningPlaygroundLookupOutput,
  func: async ({ learningSemanticIndex, learningConceptAssessment, learningCurriculumStore }, input) => {
    assertLearningLocalMvpEnabled()
    if (input.contextMode === 'retrieval' && input.mode === 'live') {
      const retrievalStarted = Date.now()
      try {
        const [hits, assessments, graphs] = await Promise.all([learningSemanticIndex.search({ query: input.message, limit: 12 }), learningConceptAssessment.list(input.userId), input.foundationFirst ? learningCurriculumStore.listGraphs() : Promise.resolve([])])
        const lookup = resolveRetrievalLookup({ ...input, dependencyEdges: graphs.flatMap(graph => graph.edges) }, hits, assessments, undefined, Date.now() - retrievalStarted)
        return { ...lookup, prompt: playgroundPrompt({ ...input, lookup }) }
      } catch {
        const lookup = resolveRetrievalLookup(input, [], [], 'Learning retrieval unavailable; continuing without context.', Date.now() - retrievalStarted)
        return { ...lookup, prompt: playgroundPrompt({ ...input, lookup }) }
      }
    }
    if (input.contextMode === 'current_turn' && input.mode === 'live') {
      const proposalPrompt = playgroundProposalPrompt(input)
      const proposalSchema = z.toJSONSchema(LearningPlaygroundProposal)
      const started = Date.now()
      try {
        const result = await runCliAgent({
          agent: AGENTS.CODEX,
          model: PLAYGROUND_LIVE_MODEL,
          reasoning: PLAYGROUND_LIVE_EFFORT,
          prompt: proposalPrompt,
          outputSchema: proposalSchema,
          chatOnly: true,
          timeoutSec: 90,
          killMs: 90_000,
          observer: createCliObserver({ userId: input.userId, label: `learning-playground:${input.requestId}:proposal` }),
        })
        const proposal = LearningPlaygroundProposal.parse(JSON.parse(String(result.stdout)))
        const lookup = resolveCurrentTurnLookup(input, proposal, executionFrom(result))
        return { ...lookup, proposalPrompt, proposalSchema, prompt: playgroundPrompt({ ...input, lookup }) }
      } catch {
        const lookup = resolveCurrentTurnLookup(input, null, undefined, 'Current-turn classification failed or timed out; continuing without Learning context.', Date.now() - started)
        return { ...lookup, proposalPrompt, proposalSchema, prompt: playgroundPrompt({ ...input, lookup }) }
      }
    }
    try {
      const fixtures = await readPlaygroundFixtures()
      const fixture = fixtures.find((entry) => entry.fixtureId === input.fixtureId)
      if (!fixture) throw new Error('Unknown playground fixture')
      const lookup = resolvePlaygroundLookup(input, fixture.classification)
      // Fixture simulation remains fixture-sourced even when the caller is
      // exercising the current-turn UI selection. The requested mode must not
      // rewrite where the classification actually came from.
      return { ...lookup, prompt: playgroundPrompt({ ...input, lookup }) }
    } catch {
      const lookup = resolvePlaygroundLookup(input, null)
      lookup.decision = 'fail_open'
      lookup.reason = 'Learning fixture lookup failed; continuing without context.'
      return { ...lookup, prompt: playgroundPrompt({ ...input, lookup }) }
    }
  },
})

export const respondLearningPlaygroundStep = defineSessionlessFunction({
  input: LearningPlaygroundResponseInput, output: LearningPlaygroundResponseOutput,
  func: async (_services, input) => {
    assertLearningLocalMvpEnabled()
    const { mode, provider, scenario, lookup } = input
    if (mode === 'fixture') {
      return scenario === 'cli_error'
        ? { mode, provider, response: null, error: 'Injected CLI failure (fixture mode; no CLI executed).', invocationCount: 0, durationMs: 0 }
        : { mode, provider, error: null, invocationCount: 0, durationMs: 0, response: lookup.decision === 'influence'
          ? `[Fixture response — no CLI executed] Learning context supplied: ${lookup.matches.map((match) => match.title).join(', ')}. A live response would receive these provisional hints before answering.`
          : `[Fixture response — no CLI executed] Continuing without Learning context (${lookup.decision}).` }
    }
    if (input.contextMode === 'retrieval') {
      const inputHash = assessmentHash({ userId: input.userId, provider, prompt: lookup.prompt })
      const prior = (await metaDbQuery<{ input_hash: string; user_id: string; receipt: unknown }>(`SELECT a.input_hash,a.user_id,r.receipt FROM learning_playground_response_attempts a
        LEFT JOIN learning_playground_response_receipts r USING(request_id) WHERE a.request_id=$1`, [input.requestId])).rows[0]
      if (prior) {
        if (prior.user_id !== input.userId || prior.input_hash !== inputHash) throw new Error('Playground response request identity conflict')
        if (prior.receipt) return LearningPlaygroundResponseOutput.parse(prior.receipt)
        return { mode, provider, response: null, outcome: 'provider_error' as const, error: 'Response attempt is reserved without a terminal receipt; automatic duplicate call refused.', invocationCount: 1, durationMs: 0 }
      }
      const reserved = await metaDbQuery('INSERT INTO learning_playground_response_attempts(request_id,user_id,input_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_id', [input.requestId,input.userId,inputHash])
      if (!reserved.rowCount) return { mode, provider, response: null, outcome: 'provider_error' as const, error: 'Response attempt already reserved; automatic duplicate call refused.', invocationCount: 1, durationMs: 0 }
    }
    const started = Date.now()
    let responseReceipt: z.infer<typeof LearningPlaygroundResponseOutput>
    try {
      const currentTurn = input.contextMode === 'current_turn'
      const result = await runCliAgent({ agent: currentTurn ? AGENTS.CODEX : { codex: AGENTS.CODEX, claude: AGENTS.CLAUDE, agy: AGENTS.AGY }[provider], model: currentTurn ? PLAYGROUND_LIVE_MODEL : undefined, prompt: lookup.prompt, chatOnly: true, reasoning: currentTurn ? PLAYGROUND_LIVE_EFFORT : 'medium', timeoutSec: 90, killMs: 90_000,
        observer: createCliObserver({ userId: input.userId, label: `learning-playground:${input.requestId}` }),
      })
      if (typeof result.stdout !== 'string' || !result.stdout.trim()) throw new Error('Empty CLI response')
      responseReceipt = { mode, provider, response: String(result.stdout), outcome: 'response' as const, error: null, execution: executionFrom(result), invocationCount: lookup.invocationCount + 1, durationMs: Date.now() - started }
    } catch {
      // Raw runner errors can contain stderr, paths, and auth material. The
      // shared runner retains operational telemetry; the browser gets a code.
      responseReceipt = { mode, provider, response: null, outcome: 'provider_error' as const, error: 'Live CLI failed; inspect shared CLI telemetry for the provider failure.', invocationCount: lookup.invocationCount + 1, durationMs: Date.now() - started }
    }
    if (input.contextMode === 'retrieval') await metaDbQuery('INSERT INTO learning_playground_response_receipts(request_id,receipt) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [input.requestId,JSON.stringify(responseReceipt)])
    return responseReceipt
  },
})

export const normalizeLearningPlaygroundStep = defineSessionlessFunction({
  input: LearningPlaygroundNormalizationInput,
  output: LearningPlaygroundNormalizationOutput,
  func: async ({ learningLosslessArchiveService, learningExposureService, learningSemanticIndex, workflowRunService, workflowService }, input, { rpc }) => {
    const started = Date.now()
    const { lookup } = input
    if (input.mode === 'live' && input.contextMode === 'retrieval') {
      if (!input.receivedAt) throw new Error('Live retrieval turn has no immutable received timestamp')
      await archivePlaygroundTurn(learningLosslessArchiveService, learningExposureService, { ...input, response: input.responseResult.response, receivedAt: input.receivedAt })
      await rpc.invoke('markLearningIndexDirtyStep', { runId: input.requestId })
      await learningSemanticIndex.withStartLock(async () => {
        const runs = await workflowRunService.listRuns({ workflowName: 'learningSemanticIndexWorkflow', limit: 100 })
        if (runs.some(run => isRunActive(run))) return
        if (!learningAdmissionPaused()) await workflowService.startWorkflow('learningSemanticIndexWorkflow', {}, { type: 'unknown', userId: input.userId }, rpc)
      })
    }
    return { status: 'completed' as const, conceptIds: [...new Set(lookup.classification.conceptIds)], provisionalOnly: true as const, masteryWrites: 0 as const, durationMs: Date.now() - started }
  },
})
