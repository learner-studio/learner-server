import { createHash } from 'node:crypto'
import { z } from 'zod'
import { liveFeedbackContext } from '@learner/contract/learning/learning-live-hook.js'
import { LearningPolicySettings } from '@learner/contract/learning/learning-policy.js'
import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { LearningConceptAssessmentService } from '../../services/learning-concept-assessment.js'
import type { LearningCurriculumStore } from '../../services/learning-curriculum-store.js'
import type { LearningCurriculumGenerationStore } from '../../services/learning-curriculum-generation-store.js'
import type { LearningVectorTurnService } from '../../services/learning-vector-turn-service.js'
import type { AssessmentSource } from './learning-concept-assessment.js'
import { schemasFor } from './learning-live-feedback.js'
import { beginLiveTurn, submitLiveTurnFeedback, type LiveTurnServices } from './learning-live-turn.js'
import { promptAbId } from './learning-prompt-ab.js'
import { HALYARD, HALYARD_CATALOG, HALYARD_VERSION, halyardCurriculumRows, HALYARD_HELD_OUT, HALYARD_TASKS, HALYARD_TERMS } from './learning-sim-halyard.js'
import { HALYARD_FACT_EXAM as HALYARD_EXAM } from './learning-sim-facts.js'
import { SIM_LANES, forgetNotebook, parseNotebook, renderNotebook, updateNotebook, type NotebookEntry } from './learning-sim-memory.js'
import { assertSimCallBudget, codexTransport, simCall, stubGraderLlm, stubTransport, type SimTransport } from './learning-sim-model.js'
import { EXAM_ANSWER_SCHEMA, EXAM_SCORE_SCHEMA, agentMatchPrompt, agentMatchSchema, agentReplyPrompt, examAnswerPrompt, NOTEBOOK_SCHEMA, examScorePrompt, hookExtra, irrelevantText, learnerTurnPrompt, notebookPrompt, type SimMessage } from './learning-sim-prompts.js'

/**
 * The simulated-learner experiment (docs/specs/simulated-learner-experiment.md): one durable workflow per
 * simulated learner; each function here is one step's body. Steps are idempotent: model calls go through
 * `simCall` receipts, messages are written once per (session, seq), and grading goes through the product's
 * own assessment service, whose request ids and paid-attempt fence never pay twice for the same evidence.
 */
export const SIM_ARMS = ['on', 'off', 'control', 'randomized', 'frozen'] as const
export { SIM_LANES } from './learning-sim-memory.js'
const Choice = z.object({ model: z.string(), effort: z.string(), timeoutSec: z.number().int().positive() })
export const SimLearnerConfig = z.object({
  runId: z.string().uuid(), learnerId: z.string().regex(/^l\d{2,4}$/),
  arm: z.enum(SIM_ARMS), lane: z.enum(['slow', 'medium', 'fast']),
  sessions: z.number().int().min(1).max(HALYARD_TASKS.length), turns: z.number().int().min(2).max(6),
  transport: z.enum(['codex', 'stub']),
  learnerModel: Choice, agentModel: Choice, scorerModel: Choice,
  /** Completed readings regraded on identical evidence, for the grader's test-retest noise. */
  retests: z.number().int().min(0).max(10).default(0),
  /** Grade synthetic assistant-only explanations: the grader must award this learner nothing. */
  leakageProbe: z.boolean().default(false),
})
export type SimLearnerConfig = z.infer<typeof SimLearnerConfig>

/** The policy of each Learner arm. `on` is the product as shipped; `randomized` is the turn-level
 * randomized arm with blind probes; `control` runs `on`'s policy but its agent never sees the result;
 * `frozen` is `on` with a learner who keeps no notebook, so its knowledge between sessions cannot change
 * (zero by construction): whatever Learner reports there is the pipeline's own drift (the grader ratchet). */
export const ARM_POLICY: Record<Exclude<SimLearnerConfig['arm'], 'off'>, LearningPolicySettings> = {
  on: LearningPolicySettings.parse({}),
  control: LearningPolicySettings.parse({}),
  randomized: LearningPolicySettings.parse({ randomizedInjection: true, injectionRate: 60, blindProbes: true, probeRate: 40 }),
  frozen: LearningPolicySettings.parse({}),
}

export const simUserId = (runId: string, learnerId: string) => `sim-${runId.slice(0, 8)}-${learnerId}`
const sessionKey = (c: SimLearnerConfig, session: number) => `sim-${c.runId.slice(0, 8)}-${c.learnerId}-s${session}`
const conversationId = (c: SimLearnerConfig, session: number) => `conv-${createHash('sha256').update(`${c.runId}:${c.learnerId}:${session}`).digest('hex').slice(0, 16)}`

/** Simulated rows go to a database of their own only: never the owner's `learner` DB, and never the shared
 * learner_test, where a fictional curriculum would be read by every other test file. `learner_sim` is the
 * runner's; `learner_sim_test_<checkout>` is one checkout's test database, so a lane with an unpushed migration
 * never breaks another lane's suite. */
export const SIM_DATABASE = /^learner_sim(_test(_[a-z0-9]{8})?)?$/
export async function assertSimDatabase() {
  const name = (await q<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db
  if (!SIM_DATABASE.test(name)) throw new Error(`The simulated-learner experiment runs only on learner_sim, learner_sim_test or learner_sim_test_<checkout>, not ${name}`)
  return name
}

export type SimServices = LiveTurnServices & {
  learningCurriculumStore: Pick<LearningCurriculumStore, 'listGraphs'>
  learningCurriculumGenerationStore: Pick<LearningCurriculumGenerationStore, 'writeCurriculum'>
  llmService: { callLLM(prompt: string, options: Record<string, unknown>): Promise<unknown> }
}
const transportFor = (s: SimServices, c: SimLearnerConfig): SimTransport => c.transport === 'stub' ? stubTransport() : codexTransport(s.llmService)
/** The product grader, with its LLM transport swapped for the stub in the suite (the default stays the service's). */
const graderFor = (s: SimServices, c: SimLearnerConfig) =>
  new LearningConceptAssessmentService(s.learningCurriculumStore as LearningCurriculumStore, (c.transport === 'stub' ? stubGraderLlm : s.llmService) as never)
/** The product grader on the stub model, for a stub run that drives the product assessment workflow: installed as the
 * runtime's learningConceptAssessment (tests, `--stub`), it is the only thing that lets a stub learner use that
 * workflow, so a stub run can never reach the paid grader through it. */
const stubGraders = new WeakSet<object>()
export function simStubGrader(store: Pick<LearningCurriculumStore, 'listGraphs'>) {
  const grader = new LearningConceptAssessmentService(store as LearningCurriculumStore, stubGraderLlm as never)
  stubGraders.add(grader)
  return grader
}
/** A learner grades through the product workflow when it is in a Learner arm (every arm but off) and the runtime's grader
 * matches its transport: the real one for codex, the stub one for stub. */
export const simGradesViaWorkflow = (c: SimLearnerConfig, runtimeGrader: object) =>
  c.arm !== 'off' && (c.transport === 'codex' ? !stubGraders.has(runtimeGrader) : stubGraders.has(runtimeGrader))

// ---------------------------------------------------------------- state

export async function readMessages(c: SimLearnerConfig, filter: { session?: number; upTo?: number } = {}): Promise<SimMessage[]> {
  return (await q<SimMessage>(`SELECT session,seq,role,text FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2
    AND ($3::int IS NULL OR session=$3) ORDER BY session,seq,CASE role WHEN 'learner' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END`, [c.runId, c.learnerId, filter.session ?? null])).rows
}
const conversationOf = (messages: SimMessage[]) => messages.filter((m) => m.role !== 'notebook')
async function notebookBefore(c: SimLearnerConfig, session: number) {
  return (await q<{ text: string }>(`SELECT text FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND role='notebook' AND session<$3 ORDER BY session DESC LIMIT 1`, [c.runId, c.learnerId, session])).rows[0]?.text ?? ''
}
async function writeMessage(c: SimLearnerConfig, m: SimMessage, meta: Record<string, unknown> = {}) {
  await q(`INSERT INTO learning_sim_messages(run_id,learner_id,session,seq,role,text,meta) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
    [c.runId, c.learnerId, m.session, m.seq, m.role, m.text, JSON.stringify(meta)])
  return (await q<{ text: string }>(`SELECT text FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND session=$3 AND seq=$4 AND role=$5`, [c.runId, c.learnerId, m.session, m.seq, m.role])).rows[0]!.text
}

// ---------------------------------------------------------------- steps

export async function prepareSimLearner(s: SimServices, c: SimLearnerConfig) {
  const database = await assertSimDatabase()
  // Written once per curriculum version (concurrent learners would otherwise rewrite it under each other).
  const stored = (await q<{ version: string | null }>(`SELECT provenance->>'version' AS version FROM learning_curricula WHERE id=$1`, [HALYARD.curriculum.id])).rows[0]
  if (stored?.version !== HALYARD_VERSION) await s.learningCurriculumGenerationStore.writeCurriculum(halyardCurriculumRows())
  await q(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
    [c.runId, c.learnerId, simUserId(c.runId, c.learnerId), c.arm, c.lane, JSON.stringify(c)])
  const existing = (await q<{ config: SimLearnerConfig }>('SELECT config FROM learning_sim_learners WHERE run_id=$1 AND learner_id=$2', [c.runId, c.learnerId])).rows[0]!.config
  if (JSON.stringify(SimLearnerConfig.parse(existing)) !== JSON.stringify(c)) throw new Error(`Learner ${c.learnerId} of run ${c.runId} already exists with a different configuration`)
  return { database, userId: simUserId(c.runId, c.learnerId), catalogVersion: HALYARD_CATALOG.version, heldOut: [...HALYARD_HELD_OUT].sort(), actions: simActions(c) }
}

/** The learner's whole run as one ordered list. The workflow walks it in a single loop: the framework's
 * inspector registers only the steps of a single-level loop, and its DSL has no counted loops. */
export type SimAction = { kind: 'exam-answer' | 'exam-score' | 'learner' | 'agent' | 'notebook' | 'grade'; session: number; turn: number; conceptId: string }
export function simActions(c: SimLearnerConfig): SimAction[] {
  const a = (kind: SimAction['kind'], session: number, turn = 0, conceptId = ''): SimAction => ({ kind, session, turn, conceptId })
  const actions = [a('exam-answer', 0), a('exam-score', 0)]
  for (let session = 1; session <= c.sessions; session++) {
    for (let turn = 1; turn <= c.turns; turn++) actions.push(a('learner', session, turn), a('agent', session, turn))
    actions.push(a('notebook', session))
    for (const concept of HALYARD_CATALOG.concepts) actions.push(a('grade', session, 0, concept.id))
    actions.push(a('exam-answer', session), a('exam-score', session))
  }
  return actions
}

export async function simLearnerTurn(s: SimServices, c: SimLearnerConfig, session: number, turn: number) {
  const done = (await readMessages(c, { session })).find((m) => m.role === 'learner' && m.seq === turn)
  if (done) return { text: done.text }
  const task = HALYARD_TASKS[session - 1]!
  const prompt = learnerTurnPrompt({ notebook: await notebookBefore(c, session), task, messages: conversationOf(await readMessages(c, { session })), turn, turns: c.turns })
  const r = await simCall({ ...c.learnerModel, runId: c.runId, learnerId: c.learnerId, callKey: `s${session}t${turn}:learner`, role: 'learner', prompt }, transportFor(s, c))
  return { text: await writeMessage(c, { session, seq: turn, role: 'learner', text: r.text.trim() }) }
}

type TurnMeta = { decision: string; conceptIds: string[]; probe: string | null; injectedChars: number; droppedMatches: number; matches: number }

/** The agent's turn. Learner arms: begin the turn and submit the agent's tags through the same server functions
 * the hook's RPCs run, then reply with the hook text and guidance in context (control: irrelevant text of the
 * same length instead). Off: no Learner at all. */
export async function simAgentTurn(s: SimServices, c: SimLearnerConfig, session: number, turn: number) {
  const all = await readMessages(c, { session })
  const done = all.find((m) => m.role === 'agent' && m.seq === turn)
  if (done) return { text: done.text }
  const message = all.find((m) => m.role === 'learner' && m.seq === turn)?.text
  if (!message) throw new Error(`Learner message ${session}.${turn} is missing`)
  const before = conversationOf(all).filter((m) => m.seq < turn)
  const task = HALYARD_TASKS[session - 1]!
  const userId = simUserId(c.runId, c.learnerId)
  const transport = transportFor(s, c)
  let extra: string | null = null
  const meta: TurnMeta = { decision: 'none', conceptIds: [], probe: null, injectedChars: 0, droppedMatches: 0, matches: 0 }
  if (c.arm !== 'off') {
    const sessionId = sessionKey(c, session)
    const turnId = promptAbId('sim-turn', c.runId, c.learnerId, String(session), String(turn))
    // The hook acknowledges the catalog after the first submission of a session, so later turns omit it.
    const packet = await beginLiveTurn(userId, { sessionId, turnId, message, foundationFirst: true, catalogVersion: turn > 1 ? HALYARD_CATALOG.version : undefined }, HALYARD_CATALOG)
    const hookContext = liveFeedbackContext(packet, sessionId, { separateCatalog: false, submissionCommand: 'Submission: return the feedback JSON when asked; this harness delivers it to the Learning transport.' }).hookSpecificOutput.additionalContext
    const ids = HALYARD_CATALOG.concepts.map((x) => x.id)
    const previousReply = before.filter((m) => m.role === 'agent').at(-1)?.text ?? null
    const tagged = await simCall({ ...c.agentModel, runId: c.runId, learnerId: c.learnerId, callKey: `s${session}t${turn}:match`, role: 'agent-match', schema: agentMatchSchema(ids),
      prompt: agentMatchPrompt({ hookContext, task, messages: before, message, previousReply, catalogIds: ids }) }, transport)
    const raw = tagged.json as { matches: Array<Record<string, unknown>>; taughtConceptIds: string[] }
    // The real agent corrects a validation mistake once, then continues; here an invalid tag is dropped and counted.
    const { LiveFeedbackMatch } = schemasFor(HALYARD_CATALOG)
    const valid = raw.matches.map(({ remainingGap, ...m }) => (remainingGap ? { ...m, remainingGap } : m))
      .filter((m) => LiveFeedbackMatch.safeParse(m).success && message.includes(String(m.quote)))
      .filter((m, i, list) => list.findIndex((x) => x.conceptId === m.conceptId) === i)
    meta.droppedMatches = raw.matches.length - valid.length
    meta.matches = valid.length
    const taught = [...new Set(raw.taughtConceptIds.filter((id) => ids.includes(id)))]
    const submitted = await submitLiveTurnFeedback(s, userId, { sessionId, turnId, catalogVersion: HALYARD_CATALOG.version, matches: valid as never, taughtConceptIds: turn > 1 ? taught : [] },
      async () => ARM_POLICY[c.arm as Exclude<typeof c.arm, 'off'>], HALYARD_HELD_OUT, HALYARD_CATALOG)
    const stored = (await q<{ probe_concept_id: string | null }>('SELECT probe_concept_id FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3', [userId, sessionId, turnId])).rows[0]
    meta.decision = submitted.guidance.decision
    meta.conceptIds = submitted.guidance.conceptIds
    meta.probe = stored?.probe_concept_id ?? null
    const real = hookExtra(hookContext, submitted.guidance)
    extra = c.arm === 'control' ? irrelevantText(real.length, turnId) : real
    meta.injectedChars = extra.length
  }
  const reply = await simCall({ ...c.agentModel, runId: c.runId, learnerId: c.learnerId, callKey: `s${session}t${turn}:reply`, role: 'agent-reply',
    prompt: agentReplyPrompt({ task, messages: before, message, extra }) }, transport)
  return { text: await writeMessage(c, { session, seq: turn, role: 'agent', text: reply.text.trim() }, meta), meta }
}

export async function simNotebook(s: SimServices, c: SimLearnerConfig, session: number) {
  const done = (await readMessages(c, { session })).find((m) => m.role === 'notebook')
  if (done) return { chars: done.text.length }
  const previous = await notebookBefore(c, session)
  // The frozen arm keeps nothing: no model call, an empty notebook, so every exam stays at the baseline.
  if (c.arm === 'frozen') return { chars: (await writeMessage(c, { session, seq: 0, role: 'notebook', text: '' }, { added: 0, overCapacity: 0, forgotten: 0, facts: 0, cut: 0, frozen: true })).length }
  const { capacity } = SIM_LANES[c.lane]
  // The model sees the notebook after forgetting: the learner does not know what it lost.
  const decayed = renderNotebook(forgetNotebook(parseNotebook(previous), SIM_LANES[c.lane].forget, `${c.runId}|${c.learnerId}`, session).entries)
  const r = await simCall({ ...c.learnerModel, runId: c.runId, learnerId: c.learnerId, callKey: `s${session}:notebook`, role: 'notebook', schema: NOTEBOOK_SCHEMA,
    prompt: notebookPrompt({ notebook: decayed, messages: conversationOf(await readMessages(c, { session })), capacity }) }, transportFor(s, c))
  const u = updateNotebook(previous, (r.json as { entries: NotebookEntry[] }).entries, c.lane, `${c.runId}|${c.learnerId}`, session)
  return { chars: (await writeMessage(c, { session, seq: 0, role: 'notebook', text: u.text }, { added: u.added, used: u.used, overCapacity: u.overCapacity, forgotten: u.forgotten, facts: u.facts, cut: 0, capacity })).length }
}

export type ExamResult = { timepoint: number; byConcept: Record<string, number>; total: number; points: Record<string, number> }
/** The closed-book exam after `timepoint` sessions (0 = baseline), answered from the notebook only. */
export async function simExamAnswer(s: SimServices, c: SimLearnerConfig, timepoint: number) {
  const r = await simCall({ ...c.learnerModel, runId: c.runId, learnerId: c.learnerId, callKey: `exam${timepoint}:answer`, role: 'exam-answer', schema: EXAM_ANSWER_SCHEMA,
    prompt: examAnswerPrompt({ notebook: await notebookBefore(c, timepoint + 1), questions: HALYARD_EXAM }) }, transportFor(s, c))
  return { timepoint, answered: (r.json as { answers: unknown[] }).answers.length }
}

/** Score the answers blind (no arm, notebook or conversation): concept score = points / (2 x questions) as a percent. */
export async function simExamScore(s: SimServices, c: SimLearnerConfig, timepoint: number): Promise<ExamResult> {
  const answered = (await q<{ output: { text: string } }>('SELECT output FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND call_key=$3', [c.runId, c.learnerId, `exam${timepoint}:answer`])).rows[0]
  if (!answered) throw new Error(`Exam ${timepoint} has no answers yet`)
  const answers = new Map((JSON.parse(answered.output.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')) as { answers: Array<{ id: string; answer: string }> }).answers.map((a) => [a.id, a.answer]))
  const items = HALYARD_EXAM.map(({ id, question, rubric }) => ({ id, question, rubric, answer: answers.get(id) ?? "I don't know" }))
  const scored = await simCall({ ...c.scorerModel, runId: c.runId, learnerId: c.learnerId, callKey: `exam${timepoint}:score`, role: 'exam-score', schema: EXAM_SCORE_SCHEMA,
    prompt: examScorePrompt(items) }, transportFor(s, c))
  const points = Object.fromEntries((scored.json as { scores: Array<{ id: string; points: number }> }).scores.map((x) => [x.id, Math.max(0, Math.min(2, Math.round(x.points)))]))
  return examResult(timepoint, points)
}
export function examResult(timepoint: number, points: Record<string, number>): ExamResult {
  const byConcept: Record<string, number> = {}
  for (const concept of HALYARD_CATALOG.concepts) {
    const questions = HALYARD_EXAM.filter((x) => x.conceptId === concept.id)
    byConcept[concept.id] = Math.round(100 * questions.reduce((n, x) => n + (points[x.id] ?? 0), 0) / (2 * questions.length))
  }
  const total = Math.round(Object.values(byConcept).reduce((a, b) => a + b, 0) / HALYARD_CATALOG.concepts.length)
  return { timepoint, byConcept, total, points }
}

// ---------------------------------------------------------------- grading

const termPattern = (terms: string[]) => new RegExp(`(^|[^a-z0-9_])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i')
/** The retrieval stand-in until the reactive path works on this database: a turn (the learner's message and the
 * agent's reply to it) is candidate evidence for a concept when either names one of the concept's terms. The
 * grader then judges relevance itself, as it does for the vector selection. Newest 50 turns, like `latestTurns`. */
export async function simEvidence(c: SimLearnerConfig, conceptId: string) {
  const all = await q<{ session: number; seq: number; role: string; text: string; created_at: Date }>(`SELECT session,seq,role,text,created_at FROM learning_sim_messages
    WHERE run_id=$1 AND learner_id=$2 AND role<>'notebook' ORDER BY session,seq`, [c.runId, c.learnerId])
  const pattern = termPattern(HALYARD_TERMS[conceptId] ?? [])
  const turns = new Map<string, { learner?: (typeof all.rows)[number]; agent?: (typeof all.rows)[number] }>()
  for (const row of all.rows) {
    const key = `${row.session}:${row.seq}`
    turns.set(key, { ...turns.get(key), [row.role]: row })
  }
  const relevant = [...turns.values()].filter((t) => t.learner && (pattern.test(t.learner.text) || (t.agent && pattern.test(t.agent.text)))).slice(-50)
  const messages: AssessmentSource[] = []
  const selected = relevant.map((t) => {
    const ids: string[] = []
    for (const row of [t.learner!, t.agent].filter(Boolean) as Array<(typeof all.rows)[number]>) {
      const id = `${c.learnerId}-s${row.session}-t${row.seq}-${row.role}`
      ids.push(id)
      messages.push({ id, conversationId: conversationId(c, row.session), role: row.role === 'learner' ? 'user' : 'assistant', text: row.text, occurredAt: row.created_at.toISOString() })
    }
    return { id: ids[0]!, conversationId: conversationId(c, t.learner!.session), at: t.learner!.created_at.toISOString(), messageIds: ids, linkage: 'explicit' as const }
  })
  return { messages, turns: selected }
}

export type GradeOutcome = { conceptId: string; runId: string | null; status: string; percent: number | null; confidence: string | null; evidenceTurns: number; skipped?: 'unchanged-evidence' | 'no-evidence'
  /** Through the product workflow: the prior-blind gradings it combined, and their mean (the statistics' measurement). */
  workflowRunId?: string; replicates?: number; blindMeanPercent?: number | null }
/** Starts and reads the product's learningConceptAssessmentWorkflow; the server step supplies it (core cannot reach the
 * framework). With it, a grading runs exactly as a manual assessment does: plan replicates, grade, the prior-blind
 * replicates the policy asks for, combine, publish. */
export type SimAssessmentWorkflow = { start(runId: string): Promise<string>; status(workflowRunId: string): Promise<string | null> }
const TERMINAL = ['completed', 'failed', 'cancelled']
/** One product workflow per assessment run: a retried sim step finds the workflow it started and waits on it. */
async function awaitAssessmentWorkflow(flow: SimAssessmentWorkflow, runId: string) {
  const prior = (await q<{ workflow_run_id: string }>(`SELECT workflow_run_id FROM learner_workflow_runs WHERE workflow='learningConceptAssessmentWorkflow'
    AND input::jsonb->>'runId'=$1 ORDER BY created_at DESC LIMIT 1`, [runId])).rows[0]
  const id = prior?.workflow_run_id ?? await flow.start(runId)
  for (;;) {
    const status = await flow.status(id)
    if (status && TERMINAL.includes(status)) return id
    await new Promise((r) => setTimeout(r, 2000))
  }
}
/** Grade one concept after a session through the product's manual assessment path (prepare, execute, publish),
 * when its candidate evidence changed since its last grading; the reactive path re-grades only concepts with new
 * arrivals too. One concept per step keeps every step far inside the queue's job expiry. */
/** Every grading is a row in learning_sim_calls (the batch's call count and cap); a stored row means it already ran. */
async function graderCallStored(c: SimLearnerConfig, callKey: string) {
  return Boolean((await q('SELECT 1 FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND call_key=$3', [c.runId, c.learnerId, callKey])).rows.length)
}
async function recordGraderCall(c: SimLearnerConfig, callKey: string, runId: string, run: { status: string; model: { model: string; effort: string }; receipt?: { inputTokens?: number | null; outputTokens?: number | null; durationMs?: number | null; status?: string } | null }) {
  await q(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,input_tokens,output_tokens,duration_ms,attempts,output) VALUES($1,$2,$3,'grader',$4,$5,$6,$7,$8,1,$9::jsonb) ON CONFLICT DO NOTHING`,
    [c.runId, c.learnerId, callKey, c.transport === 'stub' ? `stub-${run.model.model}` : run.model.model, run.model.effort, run.receipt?.inputTokens ?? null, run.receipt?.outputTokens ?? null,
      run.receipt?.durationMs ?? 0, JSON.stringify({ text: JSON.stringify({ assessmentRunId: runId, status: run.status, receiptStatus: run.receipt?.status ?? null }) })])
}

export async function simGradeConcept(s: SimServices, c: SimLearnerConfig, session: number, conceptId: string, flow?: SimAssessmentWorkflow): Promise<GradeOutcome> {
  const userId = simUserId(c.runId, c.learnerId)
  const evidence = await simEvidence(c, conceptId)
  const ids = evidence.messages.map((m) => m.id)
  if (!evidence.turns.length) return { conceptId, runId: null, status: 'skipped', percent: null, confidence: null, evidenceTurns: 0, skipped: 'no-evidence' }
  const requestId = `sim:${c.runId}:${c.learnerId}:s${session}:${conceptId}`
  const previous = (await q<{ ids: string[] }>(`SELECT ARRAY(SELECT e->>'id' FROM jsonb_array_elements(snapshot->'evidence') e) AS ids FROM learning_concept_assessment_runs
    WHERE user_id=$1 AND concept_id=$2 AND request_id<>$3 AND request_id LIKE 'sim:%' ORDER BY created_at DESC LIMIT 1`, [userId, conceptId, requestId])).rows[0]
  if (previous && JSON.stringify(previous.ids) === JSON.stringify(ids)) return { conceptId, runId: null, status: 'skipped', percent: null, confidence: null, evidenceTurns: evidence.turns.length, skipped: 'unchanged-evidence' }
  if (!await graderCallStored(c, `s${session}:grade:${conceptId}`)) await assertSimCallBudget(c.runId)
  const grader = graderFor(s, c)
  const selector = { selectEvidence: async () => ({ selections: [{ turns: evidence.turns }], messages: evidence.messages }) } as unknown as Pick<LearningVectorTurnService, 'selectEvidence'>
  const { runId } = await grader.prepare(userId, conceptId, requestId, selector)
  const key = `s${session}:grade:${conceptId}`
  const workflowRunId = flow ? await awaitAssessmentWorkflow(flow, runId) : undefined
  if (!flow) {
    await grader.execute(runId)
    await grader.publish(runId)
  }
  const run = await grader.run(runId)
  const a = run.receipt?.assessment as { understandingPercent?: number | null; confidence?: string } | null | undefined
  await recordGraderCall(c, key, runId, run as never)
  if (!flow) return { conceptId, runId, status: run.status, percent: a?.understandingPercent ?? null, confidence: a?.confidence ?? null, evidenceTurns: evidence.turns.length }
  const replicas = (await q<{ replicate: number; receipt: { status: string; inputTokens?: number | null; outputTokens?: number | null; durationMs?: number | null } | null }>(
    'SELECT replicate, receipt FROM learning_concept_assessment_replicates WHERE run_id=$1 ORDER BY replicate', [runId])).rows
  for (const r of replicas) if (r.receipt) await recordGraderCall(c, `${key}:r${r.replicate}`, runId, { status: r.receipt.status, model: run.model, receipt: r.receipt } as never)
  const summary = (await q<{ replicates: number; mean_percent: string | null }>('SELECT replicates, mean_percent FROM learning_concept_assessment_replicate_summaries WHERE run_id=$1', [runId])).rows[0]
  return { conceptId, runId, status: run.status, percent: a?.understandingPercent ?? null, confidence: a?.confidence ?? null, evidenceTurns: evidence.turns.length,
    workflowRunId, replicates: summary?.replicates ?? 0, blindMeanPercent: summary?.mean_percent == null ? null : Number(summary.mean_percent) }
}

/** Test-retest: regrade the evidence of up to `n` completed readings, unchanged, as experiment runs (which never
 * replace the live estimate). Same grader, same prompt, same evidence: the spread is the grader's own noise. */
export async function simRetest(s: SimServices, c: SimLearnerConfig) {
  if (!c.retests) return []
  const userId = simUserId(c.runId, c.learnerId)
  const grader = graderFor(s, c)
  const originals = (await q<{ run_id: string; concept_id: string; percent: number; confidence: string }>(`SELECT r.run_id,r.concept_id,(t.receipt#>>'{assessment,understandingPercent}')::int percent,t.receipt#>>'{assessment,confidence}' confidence
    FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.user_id=$1 AND r.request_id LIKE 'sim:%' AND t.receipt->>'status'='completed'
    AND t.receipt#>>'{assessment,understandingPercent}' IS NOT NULL ORDER BY r.created_at DESC LIMIT $2`, [userId, c.retests])).rows
  const out = []
  for (const o of originals) {
    const run = await grader.run(o.run_id)
    const concept = await grader.concept(o.concept_id)
    const key = `retest:${o.run_id}`
    if (!await graderCallStored(c, key)) await assertSimCallBudget(c.runId)
    const retestId = await grader.prepareProvided(userId, concept, `sim-retest:${c.runId}:${c.learnerId}:${o.run_id}`, run.evidence, null, `sim-retest:${c.runId}:${c.learnerId}:${o.run_id}`)
    await grader.execute(retestId)
    const again = await grader.run(retestId)
    await recordGraderCall(c, key, retestId, again as never)
    const a = again.receipt?.assessment as { understandingPercent?: number | null; confidence?: string } | null | undefined
    out.push({ conceptId: o.concept_id, originalRunId: o.run_id, retestRunId: retestId, original: o.percent, originalConfidence: o.confidence, retest: a?.understandingPercent ?? null, retestConfidence: a?.confidence ?? null, status: again.status })
  }
  return out
}

/** Leakage probe: the agent explains a concept fully and the learner only acknowledges. The grader excludes
 * assistant text, so this must earn the learner nothing (null, insufficient, or a near-zero estimate). */
export async function simLeakageProbe(s: SimServices, c: SimLearnerConfig) {
  if (!c.leakageProbe) return []
  const userId = simUserId(c.runId, c.learnerId)
  const grader = graderFor(s, c)
  // The evidence must be identical when the step runs again (a resume), or the grader's fence rejects it.
  const at = (await q<{ at: Date }>('SELECT created_at AS at FROM learning_sim_learners WHERE run_id=$1 AND learner_id=$2', [c.runId, c.learnerId])).rows[0]!.at.toISOString()
  const out = []
  for (const concept of HALYARD.concepts.slice(0, 3)) {
    const evidence: AssessmentSource[] = [
      { id: `leak-${concept.id}-u1`, conversationId: 'leak', role: 'user', text: 'Can you sort out the pipeline change for me?', occurredAt: at },
      { id: `leak-${concept.id}-a1`, conversationId: 'leak', role: 'assistant', text: `Here is how ${concept.title} works. ${concept.summary} ${concept.explanation} Example: ${concept.example}`, occurredAt: at },
      { id: `leak-${concept.id}-u2`, conversationId: 'leak', role: 'user', text: 'ok thanks, go ahead and apply it.', occurredAt: at },
    ]
    const key = `leak:${concept.id}`
    if (!await graderCallStored(c, key)) await assertSimCallBudget(c.runId)
    const runId = await grader.prepareProvided(userId, await grader.concept(concept.id), `sim-leak:${c.runId}:${c.learnerId}:${concept.id}`, evidence, null, `sim-leak:${c.runId}:${c.learnerId}:${concept.id}`)
    await grader.execute(runId)
    const run = await grader.run(runId)
    await recordGraderCall(c, key, runId, run as never)
    const a = run.receipt?.assessment as { understandingPercent?: number | null; confidence?: string } | null | undefined
    out.push({ conceptId: concept.id, status: run.status, percent: a?.understandingPercent ?? null, confidence: a?.confidence ?? null })
  }
  return out
}

/** The learner's record for the analysis: exams by timepoint and Learner's live readings (the view). */
export async function simSummary(s: SimServices, c: SimLearnerConfig) {
  // Every exam is re-read from its receipts (no model call is repeated).
  const exams: ExamResult[] = []
  for (let t = 0; t <= c.sessions; t++) exams.push(await simExamScore(s, c, t))
  const userId = simUserId(c.runId, c.learnerId)
  const readings = (await q<{ concept_id: string; understanding_percent: string | null; confidence: string; completed_at: Date; evidence_at: Date }>(
    `SELECT concept_id,understanding_percent,confidence,completed_at,evidence_at FROM learning_mastery_readings WHERE user_id=$1 ORDER BY completed_at`, [userId])).rows
  const calls = (await q<{ role: string; n: number; input: number | null; output: number | null; ms: number }>(`SELECT role,count(*)::int n,sum(input_tokens)::int input,sum(output_tokens)::int output,sum(duration_ms)::int ms
    FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 GROUP BY role ORDER BY role`, [c.runId, c.learnerId])).rows
  return { runId: c.runId, learnerId: c.learnerId, arm: c.arm, lane: c.lane, userId, exams: exams.map((e) => ({ timepoint: e.timepoint, total: e.total, byConcept: e.byConcept })),
    readings: readings.map((r) => ({ conceptId: r.concept_id, percent: r.understanding_percent === null ? null : Number(r.understanding_percent), confidence: r.confidence, completedAt: r.completed_at.toISOString() })), calls }
}

/** Removes a run: its sim rows and every row of its simulated users (any table with a user_id column). Guarded
 * like every write: only on a sim database. Tables are retried until no pass makes progress, so
 * foreign-key order does not matter. The grader's runs are immutable by trigger and stay (with what references
 * them); their table names are returned. */
export async function deleteSimRun(runId: string): Promise<string[]> {
  await assertSimDatabase()
  const prefix = `sim-${runId.slice(0, 8)}-%`
  const tables = (await q<{ table_name: string }>(`SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema='public' AND c.column_name='user_id' AND t.table_type='BASE TABLE'`)).rows.map((r) => r.table_name)
  let pending = tables
  for (let pass = 0; pending.length && pass < 10; pass++) {
    const failed: string[] = []
    for (const table of pending) {
      try { await q(`DELETE FROM public."${table}" WHERE user_id LIKE $1`, [prefix]) } catch { failed.push(table) }
    }
    const stuck = failed.length === pending.length
    pending = failed
    if (stuck) break
  }
  for (const table of ['learning_sim_calls', 'learning_sim_messages', 'learning_sim_learners']) await q(`DELETE FROM public.${table} WHERE run_id=$1`, [runId])
  return pending
}
