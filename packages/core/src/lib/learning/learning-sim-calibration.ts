/**
 * Dose-response calibration of the simulated learner, independent of Learner (docs/specs/simulated-learner-experiment.md,
 * "Calibration"). No hook, agent model or grader: a fixed explanation of a concept is shown to Sam 0, 1, 2 or 4 times
 * across four sessions, Sam replies and keeps the per-topic notebook, and the blind closed-book exam runs after every
 * session. The learner model is fit for the experiment only if the final score rises with the dose and stays near 0
 * at dose 0. Concepts rotate through the doses across replicates (a Latin square), so a concept's difficulty is not
 * read as a dose effect. Every model call is a receipt in learning_sim_calls: a rerun with the same run id is free.
 */
import { halyardId, type ExamQuestion } from './learning-sim-halyard.js'
import { calibrationFactExam, factSheetExplanation } from './learning-sim-facts.js'
import { simCall, type SimModelChoice, type SimTransport } from './learning-sim-model.js'
import { EXAM_ANSWER_SCHEMA, EXAM_SCORE_SCHEMA, NOTEBOOK_SCHEMA, calibrationReplyPrompt, examAnswerPrompt, examScorePrompt, notebookPrompt, type SimMessage } from './learning-sim-prompts.js'
import { SIM_LANES, updateNotebook, type NotebookEntry, type SimLane } from './learning-sim-memory.js'

export const CALIBRATION_CONCEPTS = ['keel-key', 'draft-limit', 'refit', 'slack-window'].map(halyardId)
export const CALIBRATION_DOSES = [0, 1, 2, 4] as const
/** One explanation per session, so concepts never compete for the learner's capacity. Seven sessions carry the
 * 4 + 2 + 1 explanations; the last explanation of each dose falls at sessions 7 (dose 4), 6 (dose 1) and 4 (dose 2). */
export const CALIBRATION_SCHEDULE = [4, 2, 4, 2, 4, 1, 4] as const
export const CALIBRATION_SESSIONS = CALIBRATION_SCHEDULE.length
export const DOSE_SESSIONS: Record<number, number[]> = Object.fromEntries(CALIBRATION_DOSES.map((d) => [d, CALIBRATION_SCHEDULE.flatMap((x, i) => x === d && d > 0 ? [i + 1] : [])]))

export const doseOf = (replicate: number, conceptIndex: number) => CALIBRATION_DOSES[(conceptIndex + replicate) % CALIBRATION_DOSES.length]!
export const calibrationExam = (): ExamQuestion[] => calibrationFactExam()

export const explanationOf = factSheetExplanation

export type CalibrationModels = { learner: SimModelChoice; scorer: SimModelChoice }
export type CalibrationExam = { replicate: number; timepoint: number; byConcept: Record<string, number>; points: Record<string, number> }
export type CalibrationReplicate = { lane: SimLane; replicate: number; doses: Record<string, number>; exams: CalibrationExam[]; notebooks: Array<{ session: number; facts: number; added: number; overCapacity: number; forgotten: number }> }
/** replies: Sam answers each explanation (the experiment's shape) or only reads it; examAt: the sessions after which the exam runs. */
export type CalibrationOptions = { replies: boolean; examAt: number[] }

const percentByConcept = (questions: ExamQuestion[], points: Record<string, number>) => Object.fromEntries(CALIBRATION_CONCEPTS.map((conceptId) => {
  const qs = questions.filter((x) => x.conceptId === conceptId)
  return [conceptId, Math.round(100 * qs.reduce((n, x) => n + (points[x.id] ?? 0), 0) / (2 * qs.length))]
}))

async function exam(runId: string, learnerId: string, key: string, notebook: string, models: CalibrationModels, transport: SimTransport) {
  const questions = calibrationExam()
  const answered = await simCall({ ...models.learner, runId, learnerId, callKey: `${key}:answer`, role: 'exam-answer', schema: EXAM_ANSWER_SCHEMA,
    prompt: examAnswerPrompt({ notebook, questions }) }, transport)
  const answers = new Map((answered.json as { answers: Array<{ id: string; answer: string }> }).answers.map((x) => [x.id, x.answer]))
  return score(runId, learnerId, key, questions.map(({ id, question, rubric }) => ({ id, question, rubric, answer: answers.get(id) ?? "I don't know" })), models, transport)
}
async function score(runId: string, learnerId: string, key: string, items: Array<{ id: string; question: string; rubric: string; answer: string }>, models: CalibrationModels, transport: SimTransport) {
  const scored = await simCall({ ...models.scorer, runId, learnerId, callKey: `${key}:score`, role: 'exam-score', schema: EXAM_SCORE_SCHEMA, prompt: examScorePrompt(items) }, transport)
  const points = Object.fromEntries((scored.json as { scores: Array<{ id: string; points: number }> }).scores.map((x) => [x.id, Math.max(0, Math.min(2, Math.round(x.points)))]))
  return { points, byConcept: percentByConcept(calibrationExam(), points) }
}

export async function runCalibrationReplicate(runId: string, lane: SimLane, replicate: number, models: CalibrationModels, transport: SimTransport, options: CalibrationOptions): Promise<CalibrationReplicate> {
  const learnerId = `cal-${lane}-${replicate}`
  const doses = Object.fromEntries(CALIBRATION_CONCEPTS.map((id, i) => [id, doseOf(replicate, i)]))
  let notebook = ''
  const exams: CalibrationExam[] = []
  if (options.examAt.includes(0)) exams.push({ replicate, timepoint: 0, ...await exam(runId, learnerId, 'exam0', '', models, transport) })
  const notebooks: CalibrationReplicate['notebooks'] = []
  for (let session = 1; session <= CALIBRATION_SESSIONS; session++) {
    const messages: SimMessage[] = []
    for (const conceptId of CALIBRATION_CONCEPTS.filter((id) => DOSE_SESSIONS[doses[id]!]!.includes(session))) {
      messages.push({ session, seq: messages.length, role: 'agent', text: explanationOf(conceptId) })
      if (!options.replies) continue
      const reply = await simCall({ ...models.learner, runId, learnerId, callKey: `s${session}:reply:${conceptId}`, role: 'learner',
        prompt: calibrationReplyPrompt({ notebook, messages }) }, transport)
      messages.push({ session, seq: messages.length, role: 'learner', text: reply.text.trim() })
    }
    const seed = `${runId}|${learnerId}`
    // The model sees the notebook after forgetting, as in the experiment.
    const decayed = updateNotebook(notebook, [], lane, seed, session).text
    const r = await simCall({ ...models.learner, runId, learnerId, callKey: `s${session}:notebook`, role: 'notebook', schema: NOTEBOOK_SCHEMA,
      prompt: notebookPrompt({ notebook: decayed, messages, capacity: SIM_LANES[lane].capacity }) }, transport)
    const u = updateNotebook(notebook, (r.json as { entries: NotebookEntry[] }).entries, lane, seed, session)
    notebook = u.text
    notebooks.push({ session, facts: u.facts, added: u.added, overCapacity: u.overCapacity, forgotten: u.forgotten })
    if (options.examAt.includes(session)) exams.push({ replicate, timepoint: session, ...await exam(runId, learnerId, `exam${session}`, notebook, models, transport) })
  }
  return { lane, replicate, doses, exams, notebooks }
}

/** Ceiling controls: the exam answered open-book from the full explanations (is the exam answerable?), and the
 * rubric's own full-credit wording scored as the answer (is the scorer too strict?). */
export async function runCalibrationCeiling(runId: string, models: CalibrationModels, transport: SimTransport) {
  const openBook = await exam(runId, 'ceiling', 'open-book', CALIBRATION_CONCEPTS.map(explanationOf).join('\n\n'), models, transport)
  const reference = await score(runId, 'ceiling', 'reference', calibrationExam().map(({ id, question, rubric }) => ({ id, question, rubric,
    answer: (rubric.match(/2:\s*(.*?)(?:\s1:|$)/)?.[1] ?? rubric).trim() })), models, transport)
  return { openBook: openBook.byConcept, reference: reference.byConcept }
}

export const calibrationCalls = (lanes: number, replicates: number, options: CalibrationOptions, ceiling = false) => {
  const replies = options.replies ? CALIBRATION_DOSES.reduce<number>((n, d) => n + d, 0) : 0
  const perReplicate = replies + CALIBRATION_SESSIONS + 2 * options.examAt.length
  return { perReplicate, ceiling: ceiling ? 3 : 0, total: lanes * replicates * perReplicate + (ceiling ? 3 : 0) }
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const sd = (xs: number[]) => { const m = mean(xs); return xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) : NaN }
/** Per lane: final-exam score by dose (mean, sd over replicates x concepts), the curve by dose at each exam time,
 * dose 0 per concept, and whether the means rise with the dose. */
export function summarizeCalibration(replicates: CalibrationReplicate[]) {
  const lanes = [...new Set(replicates.map((r) => r.lane))]
  return Object.fromEntries(lanes.map((lane) => {
    const reps = replicates.filter((r) => r.lane === lane)
    const times = reps[0]!.exams.map((e) => e.timepoint)
    const at = (r: CalibrationReplicate, t: number) => r.exams.find((e) => e.timepoint === t)!
    const finalByDose = Object.fromEntries(CALIBRATION_DOSES.map((dose) => {
      const xs = reps.flatMap((r) => CALIBRATION_CONCEPTS.filter((id) => r.doses[id] === dose).map((id) => r.exams.at(-1)!.byConcept[id]!))
      return [dose, { mean: mean(xs), sd: sd(xs), n: xs.length, values: xs }]
    }))
    const curveByDose = Object.fromEntries(CALIBRATION_DOSES.map((dose) => [dose, Object.fromEntries(times.map((t) =>
      [t, mean(reps.flatMap((r) => CALIBRATION_CONCEPTS.filter((id) => r.doses[id] === dose).map((id) => at(r, t).byConcept[id]!)))]))]))
    const doseZeroByConcept = Object.fromEntries(reps.map((r) => { const id = CALIBRATION_CONCEPTS.find((c) => r.doses[c] === 0)!; return [id, r.exams.at(-1)!.byConcept[id]!] }))
    const means = CALIBRATION_DOSES.map((d) => finalByDose[d]!.mean)
    const notebooks = reps.flatMap((r) => r.notebooks)
    return [lane, { finalByDose, curveByDose, doseZeroByConcept, monotone: means.every((m, i) => i === 0 || m >= means[i - 1]!),
      overCapacity: notebooks.reduce((n, x) => n + x.overCapacity, 0), forgotten: notebooks.reduce((n, x) => n + x.forgotten, 0), added: notebooks.reduce((n, x) => n + x.added, 0) }]
  }))
}
