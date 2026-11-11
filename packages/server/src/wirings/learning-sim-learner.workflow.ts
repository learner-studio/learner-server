import { z } from 'zod'
import { defineWorkflow } from '../runtime/define.js'
import { SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'

export const LearningSimLearnerWorkflowOutput = z.record(z.string(), z.unknown())

/** One simulated learner of the simulated-learner experiment (docs/specs/simulated-learner-experiment.md), end
 * to end: a baseline exam, then per session the conversation (each agent turn through the live hook's server
 * path in the Learner arms), the learner's notebook, grading by Learner per concept and a closed-book exam;
 * finally the grader's retest and leakage checks. The run is one ordered action list walked in a single flat
 * loop, one step per action (the DSL takes neither nested loops nor a branch inside a loop). Every model call has a receipt,
 * so a resumed run never pays twice. Model steps retry on a 3-minute delay: capacity errors ("high demand") are
 * waited out, not failed. */
export const learningSimLearnerWorkflow = defineWorkflow({
  title: 'Simulated learner: sessions through the Learner hook path, graded by Learner, examined closed-book',
  input: SimLearnerConfig, output: LearningSimLearnerWorkflowOutput,
  func: async ({}, config, { workflow }) => {
    const plan = await workflow.do('Prepare the simulated learner', 'prepareSimLearnerStep', config, { retries: 2, retryDelay: '5s' })
    for (const action of plan.actions) {
      await workflow.do('Run one action (exam, message, notebook or grade)', 'simActionStep', { config, action }, { retries: 5, retryDelay: '3m' })
    }
    await workflow.do('Regrade identical evidence (test-retest)', 'simRetestStep', config, { retries: 2, retryDelay: '3m' })
    await workflow.do('Leakage probe: assistant-only explanations', 'simLeakageProbeStep', config, { retries: 2, retryDelay: '3m' })
    const summary = await workflow.do('Summarise the learner', 'simSummaryStep', config, { retries: 2, retryDelay: '5s' })
    return summary
  },
})
