import { z } from 'zod'
import { defineSessionlessFunction } from '../../runtime/define.js'
import {
  SimLearnerConfig, prepareSimLearner, simAgentTurn, simExamAnswer, simExamScore, simGradeConcept, simLeakageProbe, simLearnerTurn, simNotebook, simRetest, simSummary,
  type SimServices,
} from '@learner/core/lib/learning/learning-sim-experiment.js'

/** Steps of learningSimLearnerWorkflow (docs/specs/simulated-learner-experiment.md). Each is idempotent: model
 * calls have receipts, messages are written once, grading is fenced by the product's assessment service. */
const Any = z.record(z.string(), z.unknown())
const services = (s: unknown) => s as SimServices
/** The framework's inspector names a step's output after its TypeScript return type; the outputs are plain records. */
const plain = async (value: Promise<unknown>): Promise<Record<string, unknown>> => (await value) as Record<string, unknown>

export const SimAction = z.object({ kind: z.enum(['exam-answer', 'exam-score', 'learner', 'agent', 'notebook', 'grade']), session: z.number().int(), turn: z.number().int(), conceptId: z.string() })
export const SimLearnerPlan = z.object({ actions: z.array(SimAction) })
export type SimLearnerPlan = z.infer<typeof SimLearnerPlan>
export const prepareSimLearnerStep = defineSessionlessFunction({ input: SimLearnerConfig, output: SimLearnerPlan,
  func: async (s, config): Promise<SimLearnerPlan> => ({ actions: (await prepareSimLearner(services(s), config)).actions }) })
export const simRetestStep = defineSessionlessFunction({ input: SimLearnerConfig, output: z.object({ retests: z.array(Any) }),
  func: async (s, config) => ({ retests: (await simRetest(services(s), config)) as Array<Record<string, unknown>> }) })
export const simLeakageProbeStep = defineSessionlessFunction({ input: SimLearnerConfig, output: z.object({ probes: z.array(Any) }),
  func: async (s, config) => ({ probes: (await simLeakageProbe(services(s), config)) as Array<Record<string, unknown>> }) })
export const simSummaryStep = defineSessionlessFunction({ input: SimLearnerConfig, output: Any,
  func: async (s, config) => plain(simSummary(services(s), config)) })

/** One action of the learner's run, by kind (the workflow walks the action list in a single flat loop). */
export const simActionStep = defineSessionlessFunction({ input: z.object({ config: SimLearnerConfig, action: SimAction }), output: Any,
  func: async (raw, { config, action }) => {
    const s = services(raw)
    const result: unknown = action.kind === 'learner' ? await simLearnerTurn(s, config, action.session, action.turn)
      : action.kind === 'agent' ? await simAgentTurn(s, config, action.session, action.turn)
        : action.kind === 'notebook' ? await simNotebook(s, config, action.session)
          : action.kind === 'grade' ? await simGradeConcept(s, config, action.session, action.conceptId)
            : action.kind === 'exam-answer' ? await simExamAnswer(s, config, action.session)
              : await simExamScore(s, config, action.session)
    return { kind: action.kind, session: action.session, turn: action.turn, conceptId: action.conceptId, result }
  } })
