import { z } from 'zod'
import { defineSessionlessFunction } from '../../runtime/define.js'
import type { Services } from '../../services.js'
import {
  SimLearnerConfig, prepareSimGrade, prepareSimLearner, recordSimGrade, simAgentTurn, simExamAnswer, simExamScore, simLearnerTurn, simNotebook, simProbe, simProbes, simSummary, type SimServices,
} from '@learner/core/lib/learning/learning-sim-experiment.js'
import { SIM_MAX_CONCURRENCY, pinSimRun, simBlockOpen, simRunReport, takeSimLook } from '@learner/core/lib/learning/learning-sim-run.js'

/** Steps of the simulated-learner workflows (docs/specs/simulated-learner-experiment.md). Each is idempotent: model
 * calls have receipts, messages are written once, an assessment run is keyed by its request id. */
const Any = z.record(z.string(), z.unknown())
const services = (s: unknown) => s as SimServices
const grader = (s: unknown) => (s as Pick<Services, 'learningConceptAssessment'>).learningConceptAssessment
/** The framework's inspector names a step's output after its TypeScript return type; the outputs are plain records. */
const plain = async (value: Promise<unknown>): Promise<Record<string, unknown>> => (await value) as Record<string, unknown>

export const SimAction = z.object({ kind: z.enum(['probe', 'exam-answer', 'exam-score', 'learner', 'agent', 'notebook']), session: z.number().int(), turn: z.number().int() })
export const SimActionInput = z.object({ config: SimLearnerConfig, action: SimAction })
export const SimGradeInput = z.object({ config: SimLearnerConfig, session: z.number().int(), conceptId: z.string(), probe: z.boolean().optional() })
export const SimProbes = z.object({ grades: z.array(SimGradeInput) })
export type SimProbes = z.infer<typeof SimProbes>
export const SimSessionPlan = z.object({ config: SimLearnerConfig, session: z.number().int(), actions: z.array(SimActionInput), grades: z.array(SimGradeInput) })
export const SimLearnerPlan = z.object({ sessions: z.array(SimSessionPlan) })
export type SimLearnerPlan = z.infer<typeof SimLearnerPlan>

export const prepareSimLearnerStep = defineSessionlessFunction({ input: SimLearnerConfig, output: SimLearnerPlan,
  func: async (s, config): Promise<SimLearnerPlan> => ({ sessions: (await prepareSimLearner(services(s), config)).sessions }) })
export const simSummaryStep = defineSessionlessFunction({ input: SimLearnerConfig, output: Any,
  func: async (s, config) => plain(simSummary(services(s), config)) })

/** One action of a session, by kind (the session workflow walks its action list in a single flat loop). */
export const simActionStep = defineSessionlessFunction({ input: SimActionInput, output: Any,
  func: async (raw, { config, action }) => {
    const s = services(raw)
    const result: unknown = action.kind === 'probe' ? await simProbe(s, config, action.session)
      : action.kind === 'learner' ? await simLearnerTurn(s, config, action.session, action.turn)
      : action.kind === 'agent' ? await simAgentTurn(s, config, action.session, action.turn)
        : action.kind === 'notebook' ? await simNotebook(s, config, action.session)
          : action.kind === 'exam-answer' ? await simExamAnswer(s, config, action.session)
            : await simExamScore(s, config, action.session)
    return { ...action, result }
  } })

/** B6: the blind probes the sessions answered, to grade after the last session. */
export const simProbesStep = defineSessionlessFunction({ input: SimLearnerConfig, output: SimProbes,
  func: async (_s, config): Promise<SimProbes> => ({ grades: await simProbes(config) }) })
export const prepareSimGradeStep = defineSessionlessFunction({ input: SimGradeInput, output: z.object({ assessmentRunId: z.string().nullable(), settled: z.boolean(), skipped: z.string().nullable() }),
  func: async (s, grade) => prepareSimGrade(grade, grader(s)) })
export const recordSimGradeStep = defineSessionlessFunction({ input: z.object({ grade: SimGradeInput, assessmentRunId: z.string() }), output: Any,
  func: async (s, { grade, assessmentRunId }) => plain(recordSimGrade(grade, assessmentRunId, grader(s))) })

/** The experiment run's own steps (learningSimExperimentWorkflow; bodies in learning-sim-run.ts). */
export const SimExperimentInput = z.object({ runId: z.string().uuid(), concurrency: z.number().int().min(1).max(SIM_MAX_CONCURRENCY), configs: z.array(SimLearnerConfig).min(1) })
const SimBlockRef = z.object({ runId: z.string().uuid(), index: z.number().int().min(0), blocks: z.number().int().min(1) })
export const SimWave = z.object({ learners: z.array(SimLearnerConfig) })
export const SimBlock = SimBlockRef.extend({ waves: z.array(SimWave) })
export const pinSimRunStep = defineSessionlessFunction({ input: SimExperimentInput, output: z.object({ blocks: z.array(SimBlock) }),
  func: async (s, input, { workflowStep }) => pinSimRun(input, workflowStep!.runId, services(s).simTest) })
export const simBlockOpenStep = defineSessionlessFunction({ input: SimBlockRef, output: z.object({ open: z.boolean() }),
  func: async (_s, { runId, index, blocks }) => simBlockOpen(runId, index, blocks) })
export const takeSimLookStep = defineSessionlessFunction({ input: SimBlockRef.pick({ runId: true, index: true }), output: z.object({ decision: z.string().nullable() }),
  func: async (s, { runId, index }): Promise<{ decision: string | null }> => takeSimLook(runId, index, services(s).simTest) })
export const simReportStep = defineSessionlessFunction({ input: z.object({ runId: z.string().uuid() }), output: z.object({ runId: z.string(), integrityOk: z.boolean(), markdown: z.string() }),
  func: async (_s, { runId }) => simRunReport(runId) })
