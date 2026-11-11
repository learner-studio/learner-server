import { z } from 'zod'
import { defineWorkflow } from '../runtime/define.js'
import { SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { SimGradeInput, SimSessionPlan } from '../functions/learning/learning-sim-experiment.function.js'

/** The simulated-learner experiment (docs/specs/simulated-learner-experiment.md) as nested durable workflows, one run
 * per learner (the runner starts them, one per run id and learner id): a learner runs its sessions in order, a session
 * runs its conversation, notebook and exam step by step and then its gradings, and a grading runs the product's learningConceptAssessmentWorkflow as
 * a child run. A parent waiting on a child holds no queue slot; a restart resumes every level by its run id. Model
 * steps retry on a 3-minute delay: capacity errors ("high demand") are waited out, not failed. */
export const SimWorkflowOutput = z.record(z.string(), z.unknown())

export const learningSimLearnerWorkflow = defineWorkflow({
  title: 'Simulated learner: sessions through the Learner hook path, graded by Learner, examined closed-book',
  input: SimLearnerConfig, output: SimWorkflowOutput,
  func: async ({}, config, { workflow }) => {
    const plan = await workflow.do('Prepare the simulated learner', 'prepareSimLearnerStep', config, { retries: 2, retryDelay: '5s' })
    for (const session of plan.sessions) {
      await workflow.do('Run one session', 'learningSimSessionWorkflow', session, { retries: 1, retryDelay: '5m' })
    }
    const summary = await workflow.do('Summarise the learner', 'simSummaryStep', config, { retries: 2, retryDelay: '5s' })
    return summary
  },
})

export const learningSimSessionWorkflow = defineWorkflow({
  title: 'Simulated session: conversation, notebook and exam, then the gradings',
  input: SimSessionPlan, output: SimWorkflowOutput,
  func: async ({}, data, { workflow }) => {
    for (const step of data.actions) {
      await workflow.do('Run one action (message, notebook or exam)', 'simActionStep', step, { retries: 5, retryDelay: '3m' })
    }
    // In order, never Promise.all: @pikku/core 0.12.102 re-dispatches a sibling step that is still running when the
    // run replays after another one settles, so a parallel fan-out started each grading's child run several times.
    for (const grade of data.grades) {
      await workflow.do('Grade one concept', 'learningSimGradeWorkflow', grade, { retries: 1, retryDelay: '3m' })
    }
    return { session: data.session, grades: data.grades.length }
  },
})

export const learningSimGradeWorkflow = defineWorkflow({
  title: 'Simulated grading: one concept through the product assessment workflow',
  input: SimGradeInput, output: SimWorkflowOutput,
  func: async ({}, grade, { workflow }) => {
    const prepared = await workflow.do('Prepare the assessment run', 'prepareSimGradeStep', grade, { retries: 2, retryDelay: '5s' })
    if (prepared.assessmentRunId && !prepared.settled) {
      await workflow.do('Grade through the product workflow', 'learningConceptAssessmentWorkflow', { runId: prepared.assessmentRunId }, { retries: 1, retryDelay: '3m' })
    }
    if (prepared.assessmentRunId) {
      return await workflow.do('Record the gradings', 'recordSimGradeStep', { grade, assessmentRunId: prepared.assessmentRunId }, { retries: 2, retryDelay: '5s' })
    }
    return prepared
  },
})
