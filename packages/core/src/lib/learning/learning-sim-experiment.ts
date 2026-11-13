import { createHash } from 'node:crypto'
import { z } from 'zod'
import { liveFeedbackContext } from '@learner/contract/learning/learning-live-hook.js'
import { LearningPolicySettings } from '@learner/contract/learning/learning-policy.js'
import { loadLearningPolicy } from './learning-policy-settings.js'
import { assessmentAttemptKey, replicateAttemptKey } from './llm-attempt-lease.js'
import { metaDbQuery as q, metaDbWithClient } from '../db-metadata/_shared.js'
import { LearningConceptAssessmentService } from '../../services/learning-concept-assessment.js'
import type { LearningCurriculumStore } from '../../services/learning-curriculum-store.js'
import type { LearningCurriculumGenerationStore } from '../../services/learning-curriculum-generation-store.js'
import type { LearningVectorTurnService } from '../../services/learning-vector-turn-service.js'
import type { AssessmentSource } from './learning-concept-assessment.js'
import { schemasFor } from './learning-live-feedback.js'
import { beginLiveTurn, submitLiveTurnFeedback, type LiveTurnServices } from './learning-live-turn.js'
import { promptAbId } from './learning-prompt-ab.js'
import { conceptsNamedIn, HALYARD, HALYARD_CATALOG, HALYARD_VERSION, halyardCurriculumRows, halyardId, HALYARD_TASKS, HALYARD_TERMS, termRegex, type SimTask } from './learning-sim-halyard.js'
import { HALYARD_FACT_EXAM as HALYARD_EXAM, factSheet } from './learning-sim-facts.js'
import { SIM_LANES, draw, forgetNotebook, renderNotebook, updateNotebook, type NotebookEntry, type Strengths } from './learning-sim-memory.js'
import { HALYARD_LENS, redactReply } from './learning-sim-matcher.js'
import { assertSimCallBudget, codexTransport, simCall, stubGraderLlm, stubTransport, type SimTransport } from './learning-sim-model.js'
import { EXAM_ANSWER_SCHEMA, examAnswerPrompt, EXAM_SCORE_SCHEMA, agentMatchPrompt, agentMatchSchema, agentReplyPrompt, REPLY_SCHEMA, NOTEBOOK_SCHEMA, examScorePrompt, hookExtra, learnerTurnPrompt, notebookPrompt, probePrompt, probeQuestion, type SimMessage } from './learning-sim-prompts.js'

/**
 * The simulated-learner experiment (docs/specs/simulated-learner-experiment.md): a batch workflow fans out one
 * workflow per learner, which runs one workflow per session, which grades each concept through the product's own
 * learningConceptAssessmentWorkflow as a child run. Each function here is one step's body, and every step is
 * idempotent: model calls go through `simCall` receipts, messages are written once per (session, seq, role), and
 * an assessment run is keyed by its request id.
 */
export const SIM_ARMS = ['on', 'off', 'oracle', 'blind'] as const
export { SIM_LANES } from './learning-sim-memory.js'
const Choice = z.object({ model: z.string(), effort: z.string(), timeoutSec: z.number().int().positive() })
export const SimLearnerConfig = z.object({
  runId: z.string().uuid(), learnerId: z.string().regex(/^l\d{2,4}$/),
  arm: z.enum(SIM_ARMS), lane: z.enum(['none', 'slow', 'medium', 'fast']),
  sessions: z.number().int().min(1).max(HALYARD_TASKS.length), turns: z.number().int().min(2).max(6),
  transport: z.enum(['codex', 'stub']),
  learnerModel: Choice, agentModel: Choice, scorerModel: Choice,
  /** Facts reach the agent only through the fact-sheet channel, at most `factBudget` per session; the learner's own
   * random holdout and Latin-square task order (one task per session); sessions `dayGap` days apart on a simulated
   * calendar; no baseline exam (an empty notebook scores 0); only arm `on` grades (its injection reads the grader). */
  heldOut: z.array(z.string()),
  taskOrder: z.array(z.number().int().min(0).max(HALYARD_TASKS.length - 1)),
  factBudget: z.number().int().min(0).max(40),
  dayGap: z.number().positive().max(60),
  /** Revision 8, matched pairs: the k-th learner of every arm in a lane (same holdout block and task order) shares
   * this index, and with it the memory rules' draws (forgetting, prerequisite absorption), so arms on and off of a
   * pair differ only by the arm and the model's own sampling. Absent: draws keyed by learner (older runs, fixtures). */
  pair: z.number().int().min(0).optional(),
  /** Revision 8.5 (review 10 B1, S2): the run's record, the same on every learner of the run and written with it into
   * learning_sim_learners: the commit whose code ran, the call cap, k, whether it is sequential, and the design
   * (arms, lanes, per-arm counts, looks). A resume that differs from it in anything is refused; the frozen-code check
   * and the analysis read it from the database, never from a file. Absent on runs recorded before 8.5. */
  run: z.object({
    commit: z.string(), maxCalls: z.number().int().positive().nullable(), gradingReplicates: z.number().int().min(1), sequential: z.boolean(),
    arms: z.array(z.string()), lanes: z.array(z.string()), perArm: z.record(z.string(), z.record(z.string(), z.number().int().min(0))), looks: z.array(z.number().int()),
  }).optional(),
})
export type SimLearnerConfig = z.infer<typeof SimLearnerConfig>
/** JSON with sorted object keys: a config read back from jsonb has its keys reordered (by length, then bytes). */
export const canon = (x: unknown): string => JSON.stringify(x, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => p.localeCompare(q))) : v) ?? 'undefined'

/** The Learner arms (on, oracle, blind) run the shipped policy with spaced repetition on (the only way revisiting a
 * concept from an earlier session can happen); they differ only in where the mastery numbers come from. */
const SIM_POLICY = LearningPolicySettings.parse({ spacedRepetition: true })
export const heldOutOf = (c: Pick<SimLearnerConfig, 'heldOut'>): ReadonlySet<string> => new Set(c.heldOut)
const taskOf = (c: SimLearnerConfig, session: number): SimTask => HALYARD_TASKS[c.taskOrder[session - 1]!]!
const DAY_MS = 86_400_000
/** The calendar: session s starts (s - 1) x dayGap days after an anchor that puts the last session before the
 * learner was created (so no evidence is ever in the future); `minute` orders events inside a session. */
const anchors = new Map<string, number>()
async function simAt(c: SimLearnerConfig, session: number, minute: number): Promise<Date> {
  const key = `${c.runId}:${c.learnerId}`
  if (!anchors.has(key)) {
    const created = (await q<{ at: Date }>('SELECT created_at AS at FROM learning_sim_learners WHERE run_id=$1 AND learner_id=$2', [c.runId, c.learnerId])).rows[0]?.at
    if (!created) throw new Error(`Learner ${c.learnerId} is not prepared`)
    anchors.set(key, created.getTime() - c.sessions * c.dayGap * DAY_MS)
  }
  return new Date(anchors.get(key)! + (session - 1) * c.dayGap * DAY_MS + minute * 60_000)
}
const minuteOf = { learner: (turn: number) => 10 * turn, agent: (turn: number) => 10 * turn + 5, notebook: (turns: number) => 10 * turns + 30 }

const simUserId = (runId: string, learnerId: string) => `sim-${runId.slice(0, 8)}-${learnerId}`
const sessionKey = (c: SimLearnerConfig, session: number) => `sim-${c.runId.slice(0, 8)}-${c.learnerId}-s${session}`
const conversationId = (c: SimLearnerConfig, session: number) => `conv-${createHash('sha256').update(`${c.runId}:${c.learnerId}:${session}`).digest('hex').slice(0, 16)}`

/** Simulated rows go to a database of their own only: never the owner's `learner` DB, and never the shared
 * learner_test, where a fictional curriculum would be read by every other test file. `learner_sim` is the
 * runner's; `learner_sim_test_<checkout>` is one checkout's test database, so a lane with an unpushed migration
 * never breaks another lane's suite. */
const SIM_DATABASE = /^learner_sim(_test(_[a-z0-9]{8})?)?$/
export async function assertSimDatabase() {
  const name = (await q<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db
  if (!SIM_DATABASE.test(name)) throw new Error(`The simulated-learner experiment runs only on learner_sim, learner_sim_test or learner_sim_test_<checkout>, not ${name}`)
  return name
}

export type SimServices = LiveTurnServices & {
  learningCurriculumStore: Pick<LearningCurriculumStore, 'listGraphs'>
  learningCurriculumGenerationStore: Pick<LearningCurriculumGenerationStore, 'writeCurriculum'>
  llmService: { callLLM(prompt: string, options: Record<string, unknown>): Promise<unknown> }
  /** Replaces the config's transport (the crash test hangs one call with it). */
  simTransport?: SimTransport
  /** Test wiring only (the sim tests' worker installs it; the sim worker never does): the looks a test run takes, and
   * whether every look but the last is recorded "continue" (stub learners have no arm effect, so a real look 1 stops). */
  simTest?: SimTestWiring
}
export type SimTestWiring = { looks: readonly number[]; continueLooks?: boolean }
const transportFor = (s: SimServices, c: SimLearnerConfig): SimTransport => s.simTransport ?? (c.transport === 'stub' ? stubTransport() : codexTransport(s.llmService))
/** The product grader on the stub model, for a stub run that drives the product assessment workflow: installed as the
 * runtime's learningConceptAssessment (tests, `--stub`), it is the only thing that lets a stub learner use that
 * workflow, so a stub run can never reach the paid grader through it. */
const stubGraders = new WeakSet<object>()
export function simStubGrader(store: Pick<LearningCurriculumStore, 'listGraphs'>) {
  const grader = new LearningConceptAssessmentService(store as LearningCurriculumStore, stubGraderLlm as never)
  stubGraders.add(grader)
  return grader
}
/** Grading runs the runtime's grader, so it must match the learner's transport: the real one for codex, the stub one
 * for stub (a stub learner never reaches the paid grader, and a codex learner is never graded by the stub). */
const assertGraderMatches = (c: SimLearnerConfig, runtimeGrader: object) => {
  if ((c.transport === 'stub') !== stubGraders.has(runtimeGrader)) throw new Error(`Learner ${c.learnerId} (${c.transport}) cannot be graded by this runtime's ${stubGraders.has(runtimeGrader) ? 'stub' : 'real'} grader`)
}

// ---------------------------------------------------------------- state

async function readMessages(c: SimLearnerConfig, session: number): Promise<SimMessage[]> {
  return (await q<SimMessage>(`SELECT session,seq,role,text FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2
    AND session=$3 ORDER BY seq,CASE role WHEN 'learner' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END`, [c.runId, c.learnerId, session])).rows
}
const conversationOf = (messages: SimMessage[]) => messages.filter((m) => m.role !== 'notebook')
async function notebookBefore(c: SimLearnerConfig, session: number) {
  return (await q<{ text: string }>(`SELECT text FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND role='notebook' AND session<$3 ORDER BY session DESC LIMIT 1`, [c.runId, c.learnerId, session])).rows[0]?.text ?? ''
}
async function strengthsBefore(c: SimLearnerConfig, session: number): Promise<Strengths> {
  return (await q<{ meta: { strengths?: Strengths } }>(`SELECT meta FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND role='notebook' AND session<$3 ORDER BY session DESC LIMIT 1`, [c.runId, c.learnerId, session])).rows[0]?.meta.strengths ?? {}
}
async function writeMessage(c: SimLearnerConfig, m: SimMessage, meta: Record<string, unknown> = {}, at?: Date) {
  await q(`INSERT INTO learning_sim_messages(run_id,learner_id,session,seq,role,text,meta,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,COALESCE($8::timestamptz,now())) ON CONFLICT DO NOTHING`,
    [c.runId, c.learnerId, m.session, m.seq, m.role, m.text, JSON.stringify(meta), at?.toISOString() ?? null])
  return (await q<{ text: string }>(`SELECT text FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND session=$3 AND seq=$4 AND role=$5`, [c.runId, c.learnerId, m.session, m.seq, m.role])).rows[0]!.text
}

// ---------------------------------------------------------------- steps

export async function prepareSimLearner(s: SimServices, c: SimLearnerConfig) {
  const database = await assertSimDatabase()
  if (c.taskOrder.length !== c.sessions) throw new Error(`Learner ${c.learnerId}: taskOrder needs one task per session`)
  // Written once per curriculum version (concurrent learners would otherwise rewrite it under each other).
  const stored = (await q<{ version: string | null }>(`SELECT provenance->>'version' AS version FROM learning_curricula WHERE id=$1`, [HALYARD.curriculum.id])).rows[0]
  if (stored?.version !== HALYARD_VERSION) await s.learningCurriculumGenerationStore.writeCurriculum(halyardCurriculumRows())
  await pinSimLearner(c)
  return { database, userId: simUserId(c.runId, c.learnerId), sessions: simPlan(c) }
}

/** Writes the learner row once (its config carries the run's record); a learner already there must be equal. */
export async function pinSimLearner(c: SimLearnerConfig) {
  await q(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
    [c.runId, c.learnerId, simUserId(c.runId, c.learnerId), c.arm, c.lane, JSON.stringify(c)])
  const existing = (await q<{ config: SimLearnerConfig }>('SELECT config FROM learning_sim_learners WHERE run_id=$1 AND learner_id=$2', [c.runId, c.learnerId])).rows[0]!.config
  if (canon(SimLearnerConfig.parse(existing)) !== canon(SimLearnerConfig.parse(c))) throw new Error(`Learner ${c.learnerId} of run ${c.runId} already exists with a different configuration`)
}

/** One session's work, in order: from session 2 the blind probe (B6), the conversation and the notebook, then (arm on, every session but the last, where
 * the reading is used) one grading per concept, then the closed-book exam. Flat lists, because the workflow DSL
 * loops over data arrays and takes no nested loop. */
export type SimAction = { kind: 'probe' | 'exam-answer' | 'exam-score' | 'learner' | 'agent' | 'notebook'; session: number; turn: number }
export type SimSessionPlan = { config: SimLearnerConfig; session: number; actions: Array<{ config: SimLearnerConfig; action: SimAction }>
  grades: Array<{ config: SimLearnerConfig; session: number; conceptId: string }> }
export function simPlan(c: SimLearnerConfig): SimSessionPlan[] {
  return Array.from({ length: c.sessions }, (_, i) => {
    const session = i + 1
    const a = (kind: SimAction['kind'], turn = 0) => ({ config: c, action: { kind, session, turn } })
    return { config: c, session,
      actions: [...(session > 1 ? [a('probe')] : []), ...Array.from({ length: c.turns }, (_, t) => [a('learner', t + 1), a('agent', t + 1)]).flat(), a('notebook'), a('exam-answer'), a('exam-score')],
      grades: c.arm === 'on' && session < c.sessions ? HALYARD_CATALOG.concepts.map((x) => ({ config: c, session, conceptId: x.id })) : [] }
  })
}

/** B6's blind probe before session `session`'s first turn: one concept whose facts the channel delivered in an earlier
 * session (a draw keyed by run, learner and session), asked content-free and answered from the notebook that exam
 * session-1 answered from. The answer is a receipt only, never a message: the session's conversation never sees it.
 * It is graded after the learner's last session (`simProbes`), so its reading can never reach an injection. */
export async function simProbe(s: SimServices, c: SimLearnerConfig, session: number) {
  const delivered = (await q<{ ids: string[] | null }>(`SELECT meta->'statedFactIds' AS ids FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND role='agent' AND session<$3`,
    [c.runId, c.learnerId, session])).rows.flatMap((r) => r.ids ?? [])
  const taught = [...new Set(delivered.map((id) => halyardId(id.replace(/-f\d+$/, ''))))].sort()
  if (!taught.length) return { conceptId: null }
  const conceptId = taught[Math.floor(draw(`${c.runId}|${c.learnerId}|probe${session}`) * taught.length)]!
  const title = HALYARD_CATALOG.concepts.find((x) => x.id === conceptId)!.title
  const r = await simCall({ ...c.learnerModel, runId: c.runId, learnerId: c.learnerId, callKey: `s${session}:probe:${conceptId}`, role: 'learner',
    prompt: probePrompt({ notebook: await notebookBefore(c, session), question: probeQuestion(title) }) }, transportFor(s, c))
  return { conceptId, text: r.text }
}
/** The probes answered so far, as gradings. */
export async function simProbes(c: SimLearnerConfig): Promise<SimGrade[]> {
  return (await q<{ call_key: string }>(`SELECT call_key FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND call_key LIKE 's%:probe:%' AND output ? 'text' ORDER BY call_key`, [c.runId, c.learnerId])).rows
    .map((r) => ({ config: c, session: Number(r.call_key.slice(1, r.call_key.indexOf(':'))), conceptId: r.call_key.split(':probe:')[1]!, probe: true }))
}
/** A probe's only evidence: the question and Sam's answer, under the probe's own grading user. */
async function probeEvidence(c: SimLearnerConfig, session: number, conceptId: string) {
  const answer = (await q<{ output: { text: string } }>(`SELECT output FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND call_key=$3`, [c.runId, c.learnerId, `s${session}:probe:${conceptId}`])).rows[0]
  if (!answer?.output.text) return { messages: [], turns: [] }
  const at = (await simAt(c, session, 0)).toISOString()
  const conversation = `${conversationId(c, session)}:probe`
  const ids = [`${c.learnerId}-p${session}-agent`, `${c.learnerId}-p${session}-learner`]
  const messages: AssessmentSource[] = [
    { id: ids[0]!, conversationId: conversation, role: 'assistant', text: probeQuestion(HALYARD_CATALOG.concepts.find((x) => x.id === conceptId)!.title), occurredAt: at },
    { id: ids[1]!, conversationId: conversation, role: 'user', text: answer.output.text, occurredAt: at }]
  return { messages, turns: [{ id: ids[1]!, conversationId: conversation, at, messageIds: ids, linkage: 'explicit' as const }] }
}

export async function simLearnerTurn(s: SimServices, c: SimLearnerConfig, session: number, turn: number) {
  const done = (await readMessages(c, session)).find((m) => m.role === 'learner' && m.seq === turn)
  if (done) return { text: done.text }
  const task = taskOf(c, session)
  const prompt = learnerTurnPrompt({ notebook: await notebookBefore(c, session), task, messages: conversationOf(await readMessages(c, session)), turn, turns: c.turns })
  const r = await simCall({ ...c.learnerModel, runId: c.runId, learnerId: c.learnerId, callKey: `s${session}t${turn}:learner`, role: 'learner', prompt }, transportFor(s, c))
  return { text: await writeMessage(c, { session, seq: turn, role: 'learner', text: r.text.trim() }, {}, await simAt(c, session, minuteOf.learner(turn))) }
}

type TurnMeta = { decision: string; conceptIds: string[]; probe: string | null; injectedChars: number; droppedMatches: number; matches: number
  /** Batch 2's fact channel: the concepts whose sheets the agent saw, the sheet facts it says it stated (within the
   * session's budget), what it asked to read next turn, and the budget left before this turn. */
  sheets?: string[]; statedFactIds?: string[]; overBudget?: number; invalidFacts?: number; lookups?: string[]; budgetLeft?: number; review?: string | null
  /** The channel's matcher (learning-sim-matcher.ts): `statedFactIds` are the facts it found within budget; what the
   * agent claimed, and what it redacted (unoffered or over-budget facts) before the learner read the reply. */
  claimedFactIds?: string[]; unofferedFacts?: string[]; overBudgetFacts?: string[]; redacted?: number
  /** Claimed facts the matcher did not find, placed by the claim (`redactReply`). */
  attributedFacts?: string[]
  /** Review 6 B1: claimed, offered facts the learner never read (their sentence was redacted, or the claim had no
   * sentence to place it in); neither delivered nor over budget. */
  withheldFacts?: string[] }

/** Batch 2's oracle: the live turn reads the learner's TRUE exam score per concept (the exam after the previous session)
 * where the product reads the grader's published estimate. Everything else is the product's own path. */
/** Batch 2's blind arm: the same hook and policy as `on`, but the lookup returns no assessment, so the injection
 * carries no reading of the learner. on minus blind is the part of the effect that the mastery readings cause. */
const blindServices = (s: SimServices): LiveTurnServices => ({ ...s, learningVectorTurns: { lookupAssessments: async () => ({ experimentId: null, assessments: [] }) as never } })
async function oracleServices(s: SimServices, c: SimLearnerConfig, session: number): Promise<LiveTurnServices> {
  const exam = await simExamScore(s, c, session - 1)
  const at = (await simAt(c, session, 0))?.toISOString() ?? new Date().toISOString()
  const assessments = HALYARD_CATALOG.concepts.map((x) => ({ conceptId: x.id, runId: null, status: 'ready' as const, assessedAt: at,
    assessment: { understandingPercent: exam.byConcept[x.id] ?? 0, confidence: 'high', demonstrated: [], gaps: [], misconceptions: [], rationale: 'oracle: the closed-book exam after the previous session' } }))
  return { ...s, learningVectorTurns: { lookupAssessments: async () => ({ experimentId: null, assessments }) as never } }
}
/** The agent metadata of this session's earlier turns, in order. */
async function earlierTurnMeta(c: SimLearnerConfig, session: number, turn: number) {
  return (await q<{ meta: TurnMeta }>(`SELECT meta FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND session=$3 AND role='agent' AND seq<$4 ORDER BY seq`, [c.runId, c.learnerId, session, turn])).rows.map((r) => r.meta)
}

/** The agent's turn. Learner arms: begin the turn and submit the agent's tags through the same server functions
 * the hook's RPCs run, then reply with the hook text and guidance in context. Off: no Learner at all. */
export async function simAgentTurn(s: SimServices, c: SimLearnerConfig, session: number, turn: number) {
  const all = await readMessages(c, session)
  const done = all.find((m) => m.role === 'agent' && m.seq === turn)
  if (done) return { text: done.text }
  const message = all.find((m) => m.role === 'learner' && m.seq === turn)?.text
  if (!message) throw new Error(`Learner message ${session}.${turn} is missing`)
  const before = conversationOf(all).filter((m) => m.seq < turn)
  const task = taskOf(c, session)
  const at = await simAt(c, session, minuteOf.agent(turn))
  const userId = simUserId(c.runId, c.learnerId)
  const transport = transportFor(s, c)
  let extra: string | null = null
  const meta: TurnMeta = { decision: 'none', conceptIds: [], probe: null, injectedChars: 0, droppedMatches: 0, matches: 0 }
  if (c.arm !== 'off') {
    const sessionId = sessionKey(c, session)
    const turnId = promptAbId('sim-turn', c.runId, c.learnerId, String(session), String(turn))
    // The hook acknowledges the catalog after the first submission of a session, so later turns omit it.
    const packet = await beginLiveTurn(userId, { sessionId, turnId, message, foundationFirst: true, catalogVersion: turn > 1 ? HALYARD_CATALOG.version : undefined }, HALYARD_CATALOG, at)
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
    const submitted = await submitLiveTurnFeedback(c.arm === 'oracle' ? await oracleServices(s, c, session) : c.arm === 'blind' ? blindServices(s) : s, userId, { sessionId, turnId, catalogVersion: HALYARD_CATALOG.version, matches: valid as never, taughtConceptIds: turn > 1 ? taught : [] },
      async () => SIM_POLICY, heldOutOf(c), HALYARD_CATALOG, at)
    const stored = (await q<{ probe_concept_id: string | null; review_concept_id: string | null }>('SELECT probe_concept_id,review_concept_id FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3', [userId, sessionId, turnId])).rows[0]
    meta.review = stored?.review_concept_id ?? null
    meta.decision = submitted.guidance.decision
    meta.conceptIds = submitted.guidance.conceptIds
    meta.probe = stored?.probe_concept_id ?? null
    extra = hookExtra(hookContext, submitted.guidance)
    meta.injectedChars = extra.length
  }
  // The fact channel, the same in every arm: the sheets of the concepts the brief or Sam's message names, plus
  // those the agent asked for on its previous turn; at most `factBudget` sheet facts stated per session.
  const earlier = await earlierTurnMeta(c, session, turn)
  const counted = new Set(earlier.flatMap((m) => m.statedFactIds ?? []))
  const budgetLeft = Math.max(0, c.factBudget - counted.size)
  const ids = HALYARD_CATALOG.concepts.map((x) => x.id)
  const sheets = [...new Set([...conceptsNamedIn(task.brief), ...conceptsNamedIn(message), ...(earlier.at(-1)?.lookups ?? [])])].filter((id) => ids.includes(id)).sort()
  const offered = budgetLeft ? sheets.flatMap((id) => factSheet(id).facts.map((f) => f.id)) : []
  const reply = await simCall({ ...c.agentModel, runId: c.runId, learnerId: c.learnerId, callKey: `s${session}t${turn}:reply`, role: 'agent-reply', schema: REPLY_SCHEMA(ids, offered),
    prompt: agentReplyPrompt({ task, messages: before, message, extra, sheets: budgetLeft ? sheets.map(factSheet) : [], budget: { total: c.factBudget, left: budgetLeft }, catalog: HALYARD_CATALOG.concepts.map((x) => ({ id: x.id, title: x.title })) }) }, transport)
  const out = reply.json as { reply: string; statedFactIds: string[]; lookups: string[] }
  // The budget at the channel, arm-blind: the matcher reads the reply itself; what it finds is what was taught. The
  // agent's own list is kept only to measure how well it reports (valid ids, agreement with the matcher).
  const channel = redactReply(out.reply.trim(), new Set(offered), counted, budgetLeft, new Set(out.statedFactIds))
  const claimed = [...new Set(out.statedFactIds)]
  meta.sheets = budgetLeft ? sheets : []
  meta.statedFactIds = channel.budgeted
  meta.claimedFactIds = claimed
  meta.invalidFacts = claimed.filter((id) => !offered.includes(id)).length
  meta.overBudget = channel.overBudget.length
  meta.unofferedFacts = channel.unoffered
  meta.overBudgetFacts = channel.overBudget
  meta.redacted = channel.redacted
  meta.attributedFacts = channel.attributed
  meta.withheldFacts = channel.withheld
  meta.lookups = [...new Set(out.lookups)].filter((id) => ids.includes(id)).slice(0, 2)
  meta.budgetLeft = budgetLeft
  return { text: await writeMessage(c, { session, seq: turn, role: 'agent', text: channel.text }, { ...meta, raw: out.reply.trim() }, at), meta }
}

export async function simNotebook(s: SimServices, c: SimLearnerConfig, session: number) {
  const done = (await readMessages(c, session)).find((m) => m.role === 'notebook')
  if (done) return { chars: done.text.length }
  const previous = await notebookBefore(c, session)
  const { capacity } = SIM_LANES[c.lane]
  const seed = c.pair === undefined ? `${c.runId}|${c.learnerId}` : `${c.runId}|${c.lane}|pair${c.pair}`
  const strengths = await strengthsBefore(c, session)
  // The model sees the notebook after forgetting: the learner does not know what it lost.
  const decayed = renderNotebook(forgetNotebook(previous, strengths, c.lane, seed, session).entries)
  const r = await simCall({ ...c.learnerModel, runId: c.runId, learnerId: c.learnerId, callKey: `s${session}:notebook`, role: 'notebook', schema: NOTEBOOK_SCHEMA,
    prompt: notebookPrompt({ notebook: decayed, messages: conversationOf(await readMessages(c, session)), capacity }) }, transportFor(s, c))
  const entries = (r.json as { entries: NotebookEntry[] }).entries
  // The memory rules: spacing reads the facts the channel delivered this session, within budget.
  const exposed = new Set((await earlierTurnMeta(c, session, c.turns + 1)).flatMap((m) => m.statedFactIds ?? []))
  const u = updateNotebook(previous, strengths, entries, c.lane, seed, session, exposed, HALYARD_LENS)
  return { chars: (await writeMessage(c, { session, seq: 0, role: 'notebook', text: u.text }, { added: u.added, used: u.used, overCapacity: u.overCapacity, forgotten: u.forgotten, facts: u.facts, capacity,
    strengths: u.strengths, strengthened: u.strengthened, unabsorbed: u.unabsorbed }, await simAt(c, session, minuteOf.notebook(c.turns)))).length }
}

export type ExamResult = { timepoint: number; byConcept: Record<string, number>; total: number; points: Record<string, number> }
/** The closed-book exam after `timepoint` sessions, answered from the notebook only. */
export async function simExamAnswer(s: SimServices, c: SimLearnerConfig, timepoint: number) {
  const r = await simCall({ ...c.learnerModel, runId: c.runId, learnerId: c.learnerId, callKey: `exam${timepoint}:answer`, role: 'exam-answer', schema: EXAM_ANSWER_SCHEMA,
    prompt: examAnswerPrompt({ notebook: await notebookBefore(c, timepoint + 1), questions: HALYARD_EXAM }) }, transportFor(s, c))
  return { timepoint, answered: (r.json as { answers: unknown[] }).answers.length }
}

/** Score the answers blind (no arm, notebook or conversation): concept score = points / (2 x questions) as a percent.
 * Timepoint 0 is the empty notebook's 0, never a model call. */
export async function simExamScore(s: SimServices, c: SimLearnerConfig, timepoint: number): Promise<ExamResult> {
  if (timepoint === 0) return examResult(0, {})
  const answered = (await q<{ output: { text: string } }>('SELECT output FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND call_key=$3', [c.runId, c.learnerId, `exam${timepoint}:answer`])).rows[0]
  if (!answered) throw new Error(`Exam ${timepoint} has no answers yet`)
  const parsed = (JSON.parse(answered.output.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')) as { answers: Array<{ id: string; answer: string; guess?: boolean }> }).answers
  const answers = new Map(parsed.map((a) => [a.id, a.answer]))
  const items = HALYARD_EXAM.map(({ id, question, rubric }) => ({ id, question, rubric, answer: answers.get(id) ?? "I don't know" }))
  const scored = await simCall({ ...c.scorerModel, runId: c.runId, learnerId: c.learnerId, callKey: `exam${timepoint}:score`, role: 'exam-score', schema: EXAM_SCORE_SCHEMA,
    prompt: examScorePrompt(items) }, transportFor(s, c))
  // One exam in ten is scored a second time, blind to the first, to measure the scorer's agreement.
  if (doubleScored(c, timepoint)) await simCall({ ...c.scorerModel, runId: c.runId, learnerId: c.learnerId, callKey: `exam${timepoint}:score2`, role: 'exam-score',
    schema: EXAM_SCORE_SCHEMA, prompt: examScorePrompt(items) }, transportFor(s, c))
  return examResult(timepoint, scoredPoints(scored.json as { scores: Array<{ id: string; points: number }> }, parsed))
}
/** Points per question, 0-2; a declared guess scores 0 whatever the scorer gave it. */
export function scoredPoints(scored: { scores: Array<{ id: string; points: number }> }, answers: Array<{ id: string; guess?: boolean }>) {
  const guessed = new Set(answers.filter((a) => a.guess).map((a) => a.id))
  return Object.fromEntries(scored.scores.map((x) => [x.id, guessed.has(x.id) ? 0 : Math.max(0, Math.min(2, Math.round(x.points)))]))
}
/** The double-scored 10%: a deterministic draw per (run, learner, exam). */
export const doubleScored = (c: SimLearnerConfig, timepoint: number) => draw(`${c.runId}|${c.learnerId}|exam${timepoint}|double`) < 0.1
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

/** The retrieval stand-in until the reactive path works on this database: a turn (the learner's message and the
 * agent's reply to it) is candidate evidence for a concept when either names one of the concept's terms. The
 * grader then judges relevance itself, as it does for the vector selection. Newest 50 turns, like `latestTurns`. */
async function simEvidence(c: SimLearnerConfig, conceptId: string, session: number) {
  // Up to the graded session: a grading replayed after later sessions ran (a crash, a rerun) sees what it saw first.
  const all = await q<{ session: number; seq: number; role: string; text: string; created_at: Date }>(`SELECT session,seq,role,text,created_at FROM learning_sim_messages
    WHERE run_id=$1 AND learner_id=$2 AND role<>'notebook' AND session<=$3 ORDER BY session,seq`, [c.runId, c.learnerId, session])
  const pattern = termRegex(HALYARD_TERMS[conceptId] ?? [])
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

type SimGrade = { config: SimLearnerConfig; session: number; conceptId: string; probe?: boolean }
/** The grading's first step: the assessment run for this concept after this session, keyed by its request id (a
 * replay finds it), or null when there is nothing new to grade: no evidence, or the same evidence as the last one. */
/** The advisory lock class of a run's cap (the two-key form, review 10 N1: apart from every single-key lock). */
export const SIM_CAP_LOCK = 0x51ca9
/** Review 9 S-B: the cap check and the reservation in one transaction on one connection, under an advisory lock on
 * the run, so concurrent gradings at the cap cannot both pass. A replayed step finds its own reservation and reserves
 * nothing. `held` (tests only) runs while the lock is held, after the check and before the insert. */
export async function reserveSimGrading(c: Pick<SimLearnerConfig, 'runId' | 'learnerId'>, callKey: string, invocations: number, held?: () => Promise<void>) {
  await metaDbWithClient(async (db) => {
    await db.query('BEGIN')
    try {
      await db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [SIM_CAP_LOCK, c.runId])
      if (!(await db.query('SELECT 1 FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND call_key=$3', [c.runId, c.learnerId, callKey])).rows.length) {
        await assertSimCallBudget(c.runId, invocations, db.query)
        await held?.()
        await db.query(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,duration_ms,attempts,output) VALUES($1,$2,$3,'grader','reserved','',0,0,$4::jsonb)`,
          [c.runId, c.learnerId, callKey, JSON.stringify({ pending: true, invocations })])
      }
      await db.query('COMMIT')
    } catch (error) { await db.query('ROLLBACK'); throw error }
  })
}

export async function prepareSimGrade({ config: c, session, conceptId, probe }: SimGrade, runtimeGrader: LearningConceptAssessmentService) {
  assertGraderMatches(c, runtimeGrader)
  // Each probe is graded under its own user: its reading never joins the learner's, and the product's prepare finds
  // no earlier reading to anchor on (a later probe of the same concept would otherwise see the first one as its prior).
  const userId = probe ? `${simUserId(c.runId, c.learnerId)}-probe-s${session}` : simUserId(c.runId, c.learnerId)
  const evidence = probe ? await probeEvidence(c, session, conceptId) : await simEvidence(c, conceptId, session)
  if (!evidence.turns.length) return { assessmentRunId: null, settled: false, skipped: 'no-evidence' }
  const requestId = `sim:${c.runId}:${c.learnerId}:${probe ? 'p' : 's'}${session}:${conceptId}`
  const previous = (await q<{ ids: string[] }>(`SELECT ARRAY(SELECT e->>'id' FROM jsonb_array_elements(snapshot->'evidence') e) AS ids FROM learning_concept_assessment_runs
    WHERE user_id=$1 AND concept_id=$2 AND request_id<>$3 AND request_id LIKE 'sim:%' ORDER BY created_at DESC LIMIT 1`, [userId, conceptId, requestId])).rows[0]
  if (previous && JSON.stringify(previous.ids) === JSON.stringify(evidence.messages.map((m) => m.id))) return { assessmentRunId: null, settled: false, skipped: 'unchanged-evidence' }
  // Revision 8.3 (review 8 S3): a grading pays the main call and k - 1 replicates, each of which may add one validator
  // repair call that the product's grading path makes with no cap check. Before the run exists, the cap is checked for
  // that worst case (2k) and the 2k is RESERVED as the grading's pending ledger row, so every concurrent slot and a
  // resume see it; recordSimGrade replaces it with the real paid count.
  if (!(await q('SELECT 1 FROM learning_concept_assessment_runs WHERE user_id=$1 AND request_id=$2', [userId, requestId])).rows.length)
    await reserveSimGrading(c, gradeKey({ session, conceptId, probe }), 2 * (await loadLearningPolicy()).gradingReplicates)
  const selector = { selectEvidence: async () => ({ selections: [{ turns: evidence.turns }], messages: evidence.messages }) } as unknown as Pick<LearningVectorTurnService, 'selectEvidence'>
  const { runId } = await runtimeGrader.prepare(userId, conceptId, requestId, selector)
  // Settled (a receipt) when a rerun of the batch finds it: the product workflow is not started a second time.
  return { assessmentRunId: runId, settled: (await q('SELECT 1 FROM learning_concept_assessment_receipts WHERE run_id=$1', [runId])).rows.length > 0, skipped: null }
}

const gradeKey = ({ session, conceptId, probe }: Pick<SimGrade, 'session' | 'conceptId' | 'probe'>) => `${probe ? 'p' : 's'}${session}:grade:${conceptId}`

/** The grading's last step, after the product workflow settled: its gradings (the main one and each prior-blind
 * replicate) become rows of learning_sim_calls, the batch's call count and cap. */
export async function recordSimGrade({ config: c, session, conceptId, probe }: SimGrade, assessmentRunId: string, runtimeGrader: LearningConceptAssessmentService) {
  const run = await runtimeGrader.run(assessmentRunId)
  const key = gradeKey({ session, conceptId, probe })
  type Receipt = { status?: string; inputTokens?: number | null; outputTokens?: number | null; durationMs?: number | null; validatorRetry?: unknown }
  const replicas = (await q<{ replicate: number; receipt: Receipt & { status: string } | null }>(
    'SELECT replicate, receipt FROM learning_concept_assessment_replicates WHERE run_id=$1 ORDER BY replicate', [assessmentRunId])).rows
  const rows = [{ key, status: run.status, receipt: run.receipt as Receipt | null | undefined, lease: assessmentAttemptKey(assessmentRunId) },
    ...replicas.filter((r) => r.receipt).map((r) => ({ key: `${key}:r${r.replicate}`, status: r.receipt!.status, receipt: r.receipt, lease: replicateAttemptKey(assessmentRunId, r.replicate) }))]
  const takeovers = new Map((await q<{ attempt_key: string; takeovers: number }>('SELECT attempt_key, takeovers FROM learning_llm_attempt_leases WHERE attempt_key = ANY($1::text[])',
    [rows.map((r) => r.lease)])).rows.map((r) => [r.attempt_key, r.takeovers]))
  // Paid invocations of each grading: 1, plus 1 for a validator repair (receipt.validatorRetry, revision 8.2), plus 2
  // per lease takeover (review 8 S5, review 9 N6): the dead worker may have paid its call and a repair the final
  // receipt does not show. One that adopted the dead child's answer paid less, so this may over-count, never
  // under-count. The main row replaces the reservation.
  for (const r of rows) {
    const paid = (r.receipt?.validatorRetry ? 2 : 1) + 2 * (takeovers.get(r.lease) ?? 0)
    await q(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,input_tokens,output_tokens,duration_ms,attempts,output) VALUES($1,$2,$3,'grader',$4,$5,$6,$7,$8,$9,$10::jsonb)
      ON CONFLICT (run_id,learner_id,call_key) DO UPDATE SET model=EXCLUDED.model, effort=EXCLUDED.effort, input_tokens=EXCLUDED.input_tokens, output_tokens=EXCLUDED.output_tokens,
        duration_ms=EXCLUDED.duration_ms, attempts=EXCLUDED.attempts, output=EXCLUDED.output WHERE NOT (learning_sim_calls.output ? 'text')`,
      [c.runId, c.learnerId, r.key, c.transport === 'stub' ? `stub-${run.model.model}` : run.model.model, run.model.effort, r.receipt?.inputTokens ?? null, r.receipt?.outputTokens ?? null,
        r.receipt?.durationMs ?? 0, paid, JSON.stringify({ text: JSON.stringify({ assessmentRunId, status: r.status, receiptStatus: r.receipt?.status ?? null }), invocations: paid })])
  }
  const a = run.receipt?.assessment as { understandingPercent?: number | null } | null | undefined
  return { conceptId, assessmentRunId, status: run.status, percent: a?.understandingPercent ?? null }
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
  for (const table of ['learning_sim_calls', 'learning_sim_messages', 'learning_sim_looks', 'learning_sim_learners']) await q(`DELETE FROM public.${table} WHERE run_id=$1`, [runId])
  return pending
}
