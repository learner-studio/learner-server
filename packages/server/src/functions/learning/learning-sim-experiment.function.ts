import { z } from 'zod'
import { defineSessionlessFunction } from '../../runtime/define.js'
import type { Services } from '../../services.js'
import {
  SimLearnerConfig, prepareSimGrade, prepareSimLearner, recordSimGrade, simAgentTurn, simExamAnswer, simExamScore, simLearnerTurn, simNotebook, simSummary, type SimServices,
} from '@learner/core/lib/learning/learning-sim-experiment.js'

/** Steps of the simulated-learner workflows (docs/specs/simulated-learner-experiment.md). Each is idempotent: model
 * calls have receipts, messages are written once, an assessment run is keyed by its request id. */
const Any = z.record(z.string(), z.unknown())
const services = (s: unknown) => s as SimServices
const grader = (s: unknown) => (s as Pick<Services, 'learningConceptAssessment'>).learningConceptAssessment
/** The framework's inspector names a step's output after its TypeScript return type; the outputs are plain records. */
const plain = async (value: Promise<unknown>): Promise<Record<string, unknown>> => (await value) as Record<string, unknown>

export const SimAction = z.object({ kind: z.enum(['exam-answer', 'exam-score', 'learner', 'agent', 'notebook']), session: z.number().int(), turn: z.number().int() })
export const SimActionInput = z.object({ config: SimLearnerConfig, action: SimAction })
export const SimGradeInput = z.object({ config: SimLearnerConfig, session: z.number().int(), conceptId: z.string() })
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
    const result: unknown = action.kind === 'learner' ? await simLearnerTurn(s, config, action.session, action.turn)
      : action.kind === 'agent' ? await simAgentTurn(s, config, action.session, action.turn)
        : action.kind === 'notebook' ? await simNotebook(s, config, action.session)
          : action.kind === 'exam-answer' ? await simExamAnswer(s, config, action.session)
            : await simExamScore(s, config, action.session)
    return { ...action, result }
  } })

export const prepareSimGradeStep = defineSessionlessFunction({ input: SimGradeInput, output: z.object({ assessmentRunId: z.string().nullable(), settled: z.boolean(), skipped: z.string().nullable() }),
  func: async (s, grade) => prepareSimGrade(grade, grader(s)) })
export const recordSimGradeStep = defineSessionlessFunction({ input: z.object({ grade: SimGradeInput, assessmentRunId: z.string() }), output: Any,
  func: async (s, { grade, assessmentRunId }) => plain(recordSimGrade(grade, assessmentRunId, grader(s))) })
