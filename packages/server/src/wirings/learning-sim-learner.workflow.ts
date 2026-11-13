import { z } from 'zod'
import { defineWorkflow } from '../runtime/define.js'
import { SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { SimBlock, SimExperimentInput, SimGradeInput, SimWave, SimSessionPlan } from '../functions/learning/learning-sim-experiment.function.js'

/** The simulated-learner experiment (docs/specs/simulated-learner-experiment.md) as nested durable workflows, one run
 * per learner (the runner starts them, one per run id and learner id): a learner runs its sessions in order, a session
 * runs its conversation, notebook and exam step by step and then its gradings, and a grading runs the product's learningConceptAssessmentWorkflow as
 * a child run. A parent waiting on a child holds no queue slot; a restart resumes every level by its run id. Model
 * steps retry on a 3-minute delay: capacity errors ("high demand") are waited out, not failed. */
export const SimWorkflowOutput = z.record(z.string(), z.unknown())

/** One experiment run (spec "Durable workflows"): the first step refuses and pins the run, then its blocks in order,
 * then the report of record, which is the run's output. The sim worker (bin/sim-worker.ts) executes it; a restart
 * resumes it, adopting every learner, look and model call it already has. */
export const learningSimExperimentWorkflow = defineWorkflow({
  title: 'Simulated-learner experiment: pin the run, run its blocks of learners, take the looks, report',
  input: SimExperimentInput, output: SimWorkflowOutput,
  func: async ({}, data, { workflow }) => {
    const plan = await workflow.do('Pin the run', 'pinSimRunStep', data, { retries: 2, retryDelay: '5s' })
    for (const block of plan.blocks) {
      await workflow.do('Run one block', 'learningSimBlockWorkflow', block, { compensate: false })
    }
    return await workflow.do('Analyse and report', 'simReportStep', { runId: data.runId }, { retries: 2, retryDelay: '5s' })
  },
})

/** One block: unless an earlier look stopped the sequence, its waves in order, then the efficacy look after it. A
 * learner that still fails after its retries fails its wave, the block and the run before the look: a look never
 * reads a block with a failed learner. */
export const learningSimBlockWorkflow = defineWorkflow({
  title: 'Simulated-learner block: its learners in waves under the concurrency cap, then its look',
  input: SimBlock, output: SimWorkflowOutput,
  func: async ({}, data, { workflow }) => {
    const gate = await workflow.do('Check the sequence', 'simBlockOpenStep', { runId: data.runId, index: data.index, blocks: data.blocks }, { retries: 2, retryDelay: '5s' })
    if (gate.open) {
      for (const wave of data.waves) {
        await workflow.do('Run one wave', 'learningSimWaveWorkflow', wave, { compensate: false })
      }
      return await workflow.do('Take the look', 'takeSimLookStep', { runId: data.runId, index: data.index }, { retries: 2, retryDelay: '5s' })
    }
    return gate
  },
})

/** At most the run's concurrency of learners at once: a wave's learners in parallel; the wave ends when all have. */
export const learningSimWaveWorkflow = defineWorkflow({
  title: 'Simulated-learner wave: its learners in parallel',
  input: SimWave, output: SimWorkflowOutput,
  func: async ({}, data, { workflow }) => {
    await Promise.all(data.learners.map((learner) => workflow.do('Run one learner', 'learningSimLearnerWorkflow', learner, { retries: 2, retryDelay: '5m', compensate: false })))
    return { learners: data.learners.length }
  },
})

export const learningSimLearnerWorkflow = defineWorkflow({
  title: 'Simulated learner: sessions through the Learner hook path, graded by Learner, examined closed-book',
  input: SimLearnerConfig, output: SimWorkflowOutput,
  func: async ({}, config, { workflow }) => {
    const plan = await workflow.do('Prepare the simulated learner', 'prepareSimLearnerStep', config, { retries: 2, retryDelay: '5s' })
    for (const session of plan.sessions) {
      await workflow.do('Run one session', 'learningSimSessionWorkflow', session, { retries: 1, retryDelay: '5m', compensate: false })
    }
    // B6: the blind probes are graded only now, so no probe reading can reach an injection.
    const probes = await workflow.do('List the blind probes', 'simProbesStep', config, { retries: 2, retryDelay: '5s' })
    for (const grade of probes.grades) {
      await workflow.do('Grade one blind probe', 'learningSimGradeWorkflow', grade, { retries: 1, retryDelay: '3m', compensate: false })
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
      await workflow.do('Grade one concept', 'learningSimGradeWorkflow', grade, { retries: 1, retryDelay: '3m', compensate: false })
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
      await workflow.do('Grade through the product workflow', 'learningConceptAssessmentWorkflow', { runId: prepared.assessmentRunId }, { retries: 1, retryDelay: '3m', compensate: false })
    }
    if (prepared.assessmentRunId) {
      return await workflow.do('Record the gradings', 'recordSimGradeStep', { grade, assessmentRunId: prepared.assessmentRunId }, { retries: 2, retryDelay: '5s' })
    }
    return prepared
  },
})
