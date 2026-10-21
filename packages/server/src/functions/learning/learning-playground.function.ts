import { defineFunction } from '../../runtime/define.js'
import { NotFoundError } from '@learner/core/runtime/errors.js'
import { z } from 'zod'
import { LearningPlaygroundInput, LearningPlaygroundFixturesOutput, LearningPlaygroundLookupOutput, LearningPlaygroundNormalizationOutput, LearningPlaygroundResponseOutput, LearningPlaygroundTurnOutput, readPlaygroundFixtures, validatePlaygroundStart, assertPlaygroundReplayMatches } from '@learner/core/lib/learning/learning-playground.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'

export const LearningPlaygroundEmptyInput = z.object({})
export const LearningPlaygroundRunId = z.object({ runId: z.string().uuid() })

export const getLearningPlaygroundFixtures = defineFunction({
  expose: true, readonly: true, scopes: ['admin'],
  input: LearningPlaygroundEmptyInput, output: LearningPlaygroundFixturesOutput,
  func: async () => {
    assertLearningLocalMvpEnabled()
    return { fixtures: (await readPlaygroundFixtures()).map(({ classification: _classification, ...fixture }) => fixture) }
  },
})

export const startLearningPlaygroundTurn = defineFunction({
  expose: true, scopes: ['admin'], input: LearningPlaygroundInput, output: LearningPlaygroundRunId,
  func: async ({ workflowRunService, workflowService, locks }, input, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    validatePlaygroundStart(input)
    return await locks.withLock(`learning-playground:${session.userId}`, input.requestId, async () => {
    // Native workflow history is the only run store. Repeated requests adopt
    // their existing run; pagination avoids a time-dependent last-N window.
    for (let offset = 0; ; offset += 100) {
      const runs = await workflowRunService.listRuns({ workflowName: 'learningPlaygroundWorkflow', limit: 100, offset })
      const prior = runs.find((run) => run.wire.userId === session.userId && run.input?.requestId === input.requestId)
      if (prior) {
        assertPlaygroundReplayMatches(input, prior.input)
        return { runId: prior.id }
      }
      if (runs.length < 100) break
    }
    if (input.contextMode !== 'retrieval' && !(await readPlaygroundFixtures()).some((fixture) => fixture.fixtureId === input.fixtureId)) throw new NotFoundError('Unknown playground fixture')
    const history = input.history.map(({ role, text }) => ({ role, text }))
    return await workflowService.startWorkflow('learningPlaygroundWorkflow', {
      fixtureId: input.fixtureId, provider: input.provider, mode: input.mode,
      contextMode: input.contextMode, scenario: input.scenario, message: input.message, history,
      conversationId: input.conversationId,
      receivedAt: new Date().toISOString(),
      requestId: input.requestId, userId: session.userId, expectedSeconds: 120,
    }, { type: 'http', userId: session.userId }, rpc)
    })
  },
})

export const getLearningPlaygroundTurn = defineFunction({
  expose: true, readonly: true, scopes: ['admin'], input: LearningPlaygroundRunId, output: LearningPlaygroundTurnOutput,
  func: async ({ workflowRunService }, { runId }, { session }) => {
    assertLearningLocalMvpEnabled()
    const run = await workflowRunService.getRun(runId)
    if (!run || run.workflow !== 'learningPlaygroundWorkflow' || run.wire.userId !== session.userId) throw new NotFoundError('Playground turn not found')
    const input = LearningPlaygroundInput.parse(run.input)
    const steps = await workflowRunService.getRunSteps(runId)
    const lookupStep = steps.find((step) => step.stepName === 'Learning lookup')
    const responseStep = steps.find((step) => step.stepName === 'CLI response')
    const normalizationStep = steps.find((step) => step.stepName === 'Background normalization')
    const lookup = LearningPlaygroundLookupOutput.safeParse(lookupStep?.result)
    const result = LearningPlaygroundResponseOutput.safeParse(responseStep?.result ?? run.output)
    const normalization = LearningPlaygroundNormalizationOutput.safeParse(normalizationStep?.result)
    const events: z.infer<typeof LearningPlaygroundTurnOutput>['events'] = []
    const add = (kind: string, at: Date, payload: unknown) => events.push({ sequence: events.length + 1, kind, at: at.toISOString(), payload })
    const actualContextMode = lookup.success ? lookup.data.provenance.contextMode : 'fixture'
    add('turn_received', run.createdAt, { mode: input.mode, requestedContextMode: input.contextMode, provider: input.provider, fixtureId: input.fixtureId, scenario: input.scenario })
    if (lookupStep) add('learning_lookup_started', lookupStep.createdAt, { requestedContextMode: input.contextMode, source: actualContextMode, enforcement: lookup.success ? lookup.data.provenance.enforcement : 'adapter-before-response' })
    if (lookup.success && lookupStep) add('learning_lookup_result', lookupStep.succeededAt ?? lookupStep.updatedAt, { ...lookup.data, source: actualContextMode, requestedContextMode: input.contextMode, scenario: input.scenario })
    if (responseStep) add('cli_started', responseStep.runningAt ?? responseStep.createdAt, { mode: input.mode, contextMode: input.contextMode, provider: input.provider, executed: input.mode === 'live', invocationNumber: lookup.success ? lookup.data.invocationCount + 1 : 1, contextInjected: lookup.success && Boolean(lookup.data.context), context: lookup.success ? lookup.data.context : '', prompt: lookup.success ? lookup.data.prompt : '' })
    if (result.success && responseStep) add(result.data.error ? 'cli_error' : 'assistant_response', responseStep.succeededAt ?? responseStep.updatedAt, result.data)
    if (normalizationStep) add('background_normalization_started', normalizationStep.runningAt ?? normalizationStep.createdAt, { provisionalOnly: true, masteryWrites: 0 })
    if (normalization.success && normalizationStep) add('background_normalization_completed', normalizationStep.succeededAt ?? normalizationStep.updatedAt, normalization.data)
    const failed = run.status === 'failed' || run.status === 'cancelled' || (result.success && Boolean(result.data.error))
    const classificationMs = lookup.success ? lookup.data.classification.durationMs : 0
    const responseMs = result.success ? result.data.durationMs : 0
    const backgroundStatus = normalization.success ? 'completed' as const
      : normalizationStep?.status === 'failed' ? 'failed' as const
        : normalizationStep ? 'running' as const : run.status === 'completed' ? 'not_requested' as const : 'pending' as const
    return LearningPlaygroundTurnOutput.parse({ runId, status: failed ? 'failed' as const : run.status === 'completed' ? 'completed' as const : 'running' as const,
      response: result.success ? result.data.response : null,
      error: result.success ? result.data.error : failed ? 'Playground workflow failed; inspect workflow history.' : null,
      invocationCount: result.success ? result.data.invocationCount : lookup.success ? lookup.data.invocationCount : 0,
      classification: lookup.success ? lookup.data.classification : null,
      provenance: lookup.success ? lookup.data.provenance : null,
      timing: { classificationMs, responseMs, normalizationMs: normalization.success ? normalization.data.durationMs : 0, totalModelMs: classificationMs + responseMs },
      background: { status: backgroundStatus, provisionalOnly: true, masteryWrites: 0 }, events })
  },
})
