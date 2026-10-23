import { defineWorkflow } from '../runtime/define.js'
import type { SpacedRepetitionResult } from '@learner/core/lib/learning/learning-spaced-repetition-experiment.js'
import { SpacedRepetitionAny, SpacedRepetitionRun } from '../functions/learning/learning-spaced-repetition-experiment.function.js'

/** The spaced-repetition experiment, end to end through the live hook path: one step per prompt
 * (seed a fixture user, begin, submit, check), then clean-up and, when asked, the Langfuse export.
 * It writes fixture rows, so it runs on learner_test (see learning-spaced-repetition-experiment.ts). */
export const learningSpacedRepetitionExperimentWorkflow = defineWorkflow({
  title: 'Spaced repetition: real prompts through the live hook path, checked and logged',
  input: SpacedRepetitionRun, output: SpacedRepetitionAny,
  func: async ({}, data, { workflow }) => {
    const prepared = await workflow.do('Freeze the fixture cases', 'prepareSpacedRepetitionExperimentStep', data, { retries: 1, retryDelay: '1s' })
    let results: SpacedRepetitionResult[] = []
    for (const caseId of prepared.caseIds) {
      const result = await workflow.do('Send one fixture prompt through the live hook path', 'runSpacedRepetitionCaseStep', { runId: data.runId, caseId }, { retries: 1, retryDelay: '1s' })
      results = [...results, result]
    }
    const summary = await workflow.do('Remove fixture rows and summarise', 'finishSpacedRepetitionExperimentStep', { runId: data.runId, results }, { retries: 2, retryDelay: '1s' })
    if (!data.export) return summary
    const exported = await workflow.do('Export dataset, traces and pass scores to Langfuse', 'exportSpacedRepetitionExperimentStep', { runId: data.runId, results }, { retries: 2, retryDelay: '5s' })
    const verified = await workflow.do('Read the Langfuse session back', 'verifySpacedRepetitionExportStep', { runId: data.runId, expected: results.length }, { retries: 6, retryDelay: '10s' })
    return { ...summary, langfuse: { ...exported, ...verified } }
  },
})
