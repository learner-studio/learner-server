/**
 * Dose-response calibration of the simulated learner, independent of Learner (docs/specs/simulated-learner-experiment.md,
 * "Calibration"). No hook, agent model or grader: a fixed explanation of a concept is shown to Sam 0, 1, 2 or 4 times
 * across four sessions, Sam replies and keeps the per-topic notebook, and the blind closed-book exam runs after every
 * session. The learner model is fit for the experiment only if the final score rises with the dose and stays near 0
 * at dose 0. Concepts rotate through the doses across replicates (a Latin square), so a concept's difficulty is not
 * read as a dose effect. Every model call is a receipt in learning_sim_calls: a rerun with the same run id is free.
 */
import { HALYARD, HALYARD_EXAM, halyardId, type ExamQuestion } from './learning-sim-halyard.js'
import { simCall, type SimModelChoice, type SimTransport } from './learning-sim-model.js'
import { EXAM_ANSWER_SCHEMA, EXAM_SCORE_SCHEMA, NOTEBOOK_SCHEMA, calibrationReplyPrompt, examAnswerPrompt, examScorePrompt, notebookPrompt, type SimMessage } from './learning-sim-prompts.js'
import { mergeNotebook, parseNotebook, renderNotebook, type NotebookEntry } from './learning-sim-experiment.js'

export const CALIBRATION_CONCEPTS = ['keel-key', 'draft-limit', 'refit', 'slack-window'].map(halyardId)
export const CALIBRATION_DOSES = [0, 1, 2, 4] as const
export const CALIBRATION_SESSIONS = 4
/** Every dose ends in the last session, so the final exam compares doses at equal recency. */
export const DOSE_SESSIONS: Record<number, number[]> = { 0: [], 1: [4], 2: [2, 4], 4: [1, 2, 3, 4] }
export const CALIBRATION_PACE = 1000

export const doseOf = (replicate: number, conceptIndex: number) => CALIBRATION_DOSES[(conceptIndex + replicate) % CALIBRATION_DOSES.length]!
export const calibrationExam = (): ExamQuestion[] => HALYARD_EXAM.filter((x) => CALIBRATION_CONCEPTS.includes(x.conceptId))

export function explanationOf(conceptId: string) {
  const c = (HALYARD.concepts as Array<{ id: string; title: string; summary: string; explanation: string; example: string }>).find((x) => x.id === conceptId)
  if (!c) throw new Error(`Unknown concept ${conceptId}`)
  return `${c.title}: ${c.summary} ${c.explanation} Example: ${c.example}`
}

export type CalibrationModels = { learner: SimModelChoice; scorer: SimModelChoice }
export type CalibrationExam = { replicate: number; timepoint: number; byConcept: Record<string, number>; points: Record<string, number> }
export type CalibrationReplicate = { replicate: number; doses: Record<string, number>; exams: CalibrationExam[]; notebooks: Array<{ session: number; chars: number; written: number; cut: number; topics: string[] }> }

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

export async function runCalibrationReplicate(runId: string, replicate: number, models: CalibrationModels, transport: SimTransport): Promise<CalibrationReplicate> {
  const learnerId = `cal${replicate}`
  const doses = Object.fromEntries(CALIBRATION_CONCEPTS.map((id, i) => [id, doseOf(replicate, i)]))
  let entries: NotebookEntry[] = []
  const exams: CalibrationExam[] = [{ replicate, timepoint: 0, ...await exam(runId, learnerId, 'exam0', '', models, transport) }]
  const notebooks: CalibrationReplicate['notebooks'] = []
  for (let session = 1; session <= CALIBRATION_SESSIONS; session++) {
    const notebook = renderNotebook(entries)
    const messages: SimMessage[] = []
    for (const conceptId of CALIBRATION_CONCEPTS.filter((id) => DOSE_SESSIONS[doses[id]!]!.includes(session))) {
      messages.push({ session, seq: messages.length, role: 'agent', text: explanationOf(conceptId) })
      const reply = await simCall({ ...models.learner, runId, learnerId, callKey: `s${session}:reply:${conceptId}`, role: 'learner',
        prompt: calibrationReplyPrompt({ notebook, messages }) }, transport)
      messages.push({ session, seq: messages.length, role: 'learner', text: reply.text.trim() })
    }
    const r = await simCall({ ...models.learner, runId, learnerId, callKey: `s${session}:notebook`, role: 'notebook', schema: NOTEBOOK_SCHEMA,
      prompt: notebookPrompt({ notebook, messages, pace: CALIBRATION_PACE }) }, transport)
    const changes = (r.json as { entries: NotebookEntry[] }).entries
    entries = mergeNotebook(entries, changes)
    const text = renderNotebook(entries)
    const written = changes.reduce((n, e) => n + e.notes.trim().length, 0)
    const cut = changes.filter((e) => e.notes.trim() && !text.includes(e.notes.trim())).reduce((n, e) => n + e.notes.trim().length, 0)
    notebooks.push({ session, chars: text.length, written, cut, topics: parseNotebook(text).map((e) => e.topic) })
    exams.push({ replicate, timepoint: session, ...await exam(runId, learnerId, `exam${session}`, text, models, transport) })
  }
  return { replicate, doses, exams, notebooks }
}

/** Ceiling controls: the exam answered open-book from the full explanations (is the exam answerable?), and the
 * rubric's own full-credit wording scored as the answer (is the scorer too strict?). */
export async function runCalibrationCeiling(runId: string, models: CalibrationModels, transport: SimTransport) {
  const openBook = await exam(runId, 'ceiling', 'open-book', CALIBRATION_CONCEPTS.map(explanationOf).join('\n\n'), models, transport)
  const reference = await score(runId, 'ceiling', 'reference', calibrationExam().map(({ id, question, rubric }) => ({ id, question, rubric,
    answer: (rubric.match(/2:\s*(.*?)(?:\s1:|$)/)?.[1] ?? rubric).trim() })), models, transport)
  return { openBook: openBook.byConcept, reference: reference.byConcept }
}

export const calibrationCalls = (replicates: number) => {
  const replies = CALIBRATION_DOSES.reduce<number>((n, d) => n + d, 0)
  return { perReplicate: replies + CALIBRATION_SESSIONS + 2 * (CALIBRATION_SESSIONS + 1), ceiling: 3, total: replicates * (replies + CALIBRATION_SESSIONS + 2 * (CALIBRATION_SESSIONS + 1)) + 3 }
}

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
/** Final-exam score by dose (mean over replicates and concepts), the learning curve by dose, dose 0 per concept. */
export function summarizeCalibration(replicates: CalibrationReplicate[]) {
  const finalByDose = Object.fromEntries(CALIBRATION_DOSES.map((dose) => {
    const xs = replicates.flatMap((r) => CALIBRATION_CONCEPTS.filter((id) => r.doses[id] === dose).map((id) => r.exams.at(-1)!.byConcept[id]!))
    return [dose, { mean: mean(xs), n: xs.length, values: xs }]
  }))
  const curveByDose = Object.fromEntries(CALIBRATION_DOSES.map((dose) => [dose, Array.from({ length: CALIBRATION_SESSIONS + 1 }, (_, t) =>
    mean(replicates.flatMap((r) => CALIBRATION_CONCEPTS.filter((id) => r.doses[id] === dose).map((id) => r.exams[t]!.byConcept[id]!))))]))
  const doseZeroByConcept = Object.fromEntries(replicates.map((r) => { const id = CALIBRATION_CONCEPTS.find((c) => r.doses[c] === 0)!; return [id, r.exams.at(-1)!.byConcept[id]!] }))
  const means = CALIBRATION_DOSES.map((d) => finalByDose[d]!.mean)
  const monotone = means.every((m, i) => i === 0 || m >= means[i - 1]!)
  const cut = replicates.flatMap((r) => r.notebooks).reduce((n, x) => n + x.cut, 0)
  return { finalByDose, curveByDose, doseZeroByConcept, monotone, notebookCutChars: cut }
}
