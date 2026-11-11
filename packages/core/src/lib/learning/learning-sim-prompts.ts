import type { ExamQuestion, SimTask } from './learning-sim-halyard.js'
import { HALYARD_MANUAL } from './learning-sim-halyard.js'
import type { FactSheet } from './learning-sim-facts.js'

/**
 * Prompts of the simulated-learner experiment (docs/specs/simulated-learner-experiment.md). What each role sees
 * is the validity argument, so it is spelled out here:
 *  - the learner, writing a message: its own notebook, the task brief, its own earlier messages this session and
 *    ONLY the agent's latest reply (so it writes from memory, not by restating the session's explanation). Never
 *    the manual, the exam, the arm, or Learner's injected text. The notebook update reads the whole session.
 *  - the agent: the Halyard manual of concept names in EVERY arm, the budgeted fact sheets, the brief and the
 *    conversation; in the Learner arms also the hook's text and the returned guidance.
 *  - the exam scorer: questions, rubric and answers. Never the arm, the notebook or the conversation.
 */
export type SimMessage = { session: number; seq: number; role: 'learner' | 'agent' | 'notebook'; text: string }

const conversation = (messages: SimMessage[]) => messages.length
  ? messages.map((m) => `[${m.role === 'learner' ? 'Sam' : 'Agent'}]: ${m.text}`).join('\n\n')
  : '(nothing yet)'
const notebookBlock = (notebook: string) => notebook.trim() ? `<<<\n${notebook}\n>>>` : '(empty: this is Sam\'s first session with Halyard; Sam knows nothing about it yet)'

const SAM = 'You are role-playing Sam, a backend developer at Northwind Freight, in a chat with an AI coding agent. Northwind recently adopted Halyard, its event-pipeline runtime.'
const MEMORY = 'What Sam knows about Halyard is ONLY what is in Sam\'s notebook below and what the agent just said. Sam has never read Halyard\'s documentation. Do not use or invent Halyard facts from anywhere else: when Sam does not know something, Sam asks, or reasons from what was said, and may be wrong.'

/** What Sam sees while writing: Sam's own messages and the agent's latest reply, never the earlier explanations. */
const sessionForSam = (messages: SimMessage[]) => {
  const latest = messages.filter((m) => m.role === 'agent').at(-1)
  return conversation(messages.filter((m) => m.role === 'learner' || m === latest))
}

export function learnerTurnPrompt(input: { notebook: string; task: SimTask; messages: SimMessage[]; turn: number; turns: number }) {
  const position = input.turn === 1
    ? 'Open the session: tell the agent what you need help with, in your own words.'
    : 'Continue the work: react to the agent\'s latest reply, make the decisions the task needs from you, answer any question the agent asked you, and ask about what you need to understand. Do not repeat or paraphrase the agent\'s explanation: say what you will do, what you are unsure of and what you need, from what you know.'
  return [SAM, MEMORY,
    `SAM'S NOTEBOOK (written by Sam after earlier sessions):\n${notebookBlock(input.notebook)}`,
    `TODAY'S TASK (from Sam's lead):\n${input.task.brief}`,
    `THIS SESSION SO FAR (Sam's own messages and the agent's latest reply):\n${sessionForSam(input.messages)}`,
    `This is message ${input.turn} of ${input.turns} from Sam in this session. ${position}`,
    'Write 2-6 sentences of plain text, as Sam would type in a chat. No role label, no quotes around it.',
  ].join('\n\n')
}

/** B6's blind probe: a content-free question about one concept before the session's first turn, answered from the
 * notebook alone (no conversation exists yet, so the answer cannot restate one). */
export const probeQuestion = (title: string) => `Before we start: in your own words, how does ${title} work in Halyard, and when would you use it?`
export function probePrompt(input: { notebook: string; question: string }) {
  return [SAM, 'What Sam knows about Halyard is ONLY what is in Sam\'s notebook below. Sam has never read Halyard\'s documentation. Do not use or invent Halyard facts from anywhere else: when the notebook does not cover something, Sam says so, and may be wrong.',
    `SAM'S NOTEBOOK (written by Sam after earlier sessions):\n${notebookBlock(input.notebook)}`,
    `Before today's work starts, the agent asks:\n${input.question}`,
    'Answer in 2-5 sentences of plain text, as Sam would type in a chat. No role label, no quotes around it.',
  ].join('\n\n')
}

export const NOTEBOOK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['entries'],
  properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['topic', 'facts'], properties: { topic: { type: 'string' }, facts: { type: 'array', items: { type: 'string' } } } } } },
}
/** Sam's notebook is facts per topic. The model returns only NEW facts, most important first; the caller keeps
 * the old ones and enforces the learner's capacity (learning-sim-memory.ts). */
export function notebookPrompt(input: { notebook: string; messages: SimMessage[]; capacity: number }) {
  return [SAM,
    `The session just ended. Update Sam's personal notebook about Halyard. It is the ONLY thing Sam will remember about Halyard in future sessions: anything not in it is forgotten. The notebook is a list of short facts, grouped by topic (a Halyard term or idea). Sam may only write what Sam actually learned from today's conversation.`,
    `TODAY'S CONVERSATION:\n${conversation(input.messages)}`,
    `CURRENT NOTEBOOK:\n${notebookBlock(input.notebook)}`,
    `Sam can take in at most ${input.capacity} characters of new notes from one session, all new facts together. Choose what matters most to Sam's work, most important first, and leave the rest out. Each fact is one short sentence. Do not repeat a fact already in the notebook.`,
    'Return JSON {"entries":[{"topic","facts":[...]}]} with only the NEW facts (use the existing topic name when a fact belongs to it). Facts are kept whole, in the order given, until the character budget is spent; a fact that does not fit is lost entirely.',
  ].join('\n\n')
}

/** The exam: every answer says whether it is a guess, and a declared guess scores 0 (yes/no items are guessable). */
export const EXAM_ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answers'],
  properties: { answers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'answer', 'guess'], properties: { id: { type: 'string' }, answer: { type: 'string' }, guess: { type: 'boolean' } } } } },
}
export function examAnswerPrompt(input: { notebook: string; questions: ExamQuestion[] }) {
  return [SAM,
    'Sam is taking a closed-book quiz about Halyard. Sam may use ONLY Sam\'s notebook below: Sam has no other knowledge of Halyard. When the notebook does not state the answer, answer "I don\'t know", or give a best guess and set guess to true; set guess to false only when the notebook states the answer. A guess earns no points. One or two sentences per answer.',
    `NOTEBOOK:\n${notebookBlock(input.notebook)}`,
    `QUESTIONS:\n${JSON.stringify(input.questions.map(({ id, question }) => ({ id, question })))}`,
    'Return JSON {"answers":[{"id","answer","guess"}]} with one answer for every question id.',
  ].join('\n\n')
}

export const EXAM_SCORE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['scores'],
  properties: { scores: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'points', 'note'], properties: { id: { type: 'string' }, points: { type: 'integer', enum: [0, 1, 2] }, note: { type: 'string' } } } } },
}
export function examScorePrompt(items: Array<{ id: string; question: string; rubric: string; answer: string }>) {
  return [
    'You are scoring a short-answer quiz about a software system called Halyard. For each item, compare the answer with the rubric and award 0, 1 or 2 points exactly as the rubric says. Judge meaning, not wording or spelling. A correct answer marked as a guess still earns its points; "I don\'t know" earns 0; an answer that states the rubric\'s facts together with a contradicting claim earns at most 1. Score every item independently of the others. Keep each note to a few words.',
    `ITEMS:\n${JSON.stringify(items)}`,
    'Return JSON {"scores":[{"id","points","note"}]} with one score for every item id.',
  ].join('\n\n')
}

export const agentMatchSchema = (conceptIds: string[]) => ({
  type: 'object', additionalProperties: false, required: ['matches', 'taughtConceptIds'],
  properties: {
    matches: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['conceptId', 'quote', 'relationship', 'outcome', 'reason', 'remainingGap'], properties: {
      conceptId: { type: 'string', enum: conceptIds }, quote: { type: 'string' },
      relationship: { type: 'string', enum: ['mention', 'task_context', 'learner_evidence', 'misconception'] },
      outcome: { type: 'string', enum: ['demonstrated', 'partial', 'unclear', 'not_assessed'] },
      reason: { type: 'string' }, remainingGap: { type: ['string', 'null'] } } } },
    taughtConceptIds: { type: 'array', items: { type: 'string', enum: conceptIds } },
  },
})
/** The submission half of the hook's turn: in the real CLI the agent runs `--submit` with this JSON; here it
 * returns the JSON and the harness submits it through the same server function. */
export function agentMatchPrompt(input: { hookContext: string; task: SimTask; messages: SimMessage[]; message: string; previousReply: string | null; catalogIds: string[] }) {
  return [
    'You are an AI coding agent pairing with Sam, a developer. A Learning hook added the context below to this turn. Do ONLY its submission step now: produce the feedback JSON for Sam\'s CURRENT message. In this environment you return the JSON here instead of calling the transport; it is delivered for you, and you will write your reply to Sam afterwards.',
    `HOOK CONTEXT:\n${input.hookContext}`,
    `TASK BRIEF (what Sam's lead sent Sam):\n${input.task.brief}`,
    `CONVERSATION SO FAR:\n${conversation(input.messages)}`,
    `YOUR PREVIOUS RESPONSE (taughtConceptIds may name only concepts it actually explained):\n${input.previousReply ?? '(none: first turn)'}`,
    `CURRENT DEVELOPER MESSAGE:\n<<<\n${input.message}\n>>>`,
    `CATALOG IDS:${input.catalogIds.join(',')}`,
    'Return JSON {"matches":[...],"taughtConceptIds":[...]}. Each quote must be an exact substring of the current developer message. Use remainingGap only with outcome "partial"; otherwise null.',
  ].join('\n\n')
}

/** `statedFactIds` is an enum of the fact ids offered this turn (an empty array when none is offered). */
export const REPLY_SCHEMA = (conceptIds: string[], factIds: string[]) => ({
  type: 'object', additionalProperties: false, required: ['reply', 'statedFactIds', 'lookups'],
  properties: { reply: { type: 'string' }, statedFactIds: factIds.length ? { type: 'array', items: { type: 'string', enum: factIds } } : { type: 'array', maxItems: 0, items: { type: 'string' } },
    lookups: { type: 'array', items: { type: 'string', enum: conceptIds } } },
})
/**
 * The agent: a manual of concept names only (HALYARD_MANUAL), never an exam answer. Facts come only from the fact sheets of the
 * concepts the brief or Sam's message names and of the concepts the agent asked to read (`lookups`) on its previous
 * turn, under a per-session budget of facts it may state. Identical in every arm; a Learner arm adds only `extra`
 * (the hook's text and guidance), which the agent is free to use or ignore.
 */
export function agentReplyPrompt(input: { task: SimTask; messages: SimMessage[]; message: string; extra: string | null; sheets: FactSheet[]; budget: { total: number; left: number }; catalog: Array<{ id: string; title: string }> }) {
  const sheets = input.sheets.length
    ? input.sheets.map((s) => `${s.title} (${s.conceptId}):\n${s.facts.map((f) => `- [${f.id}] ${f.fact}`).join('\n')}`).join('\n\n')
    : '(none this turn)'
  return [
    'You are an AI coding agent pairing with Sam, a developer at Northwind Freight, inside their repository. Halyard is the company\'s event-pipeline runtime; its reference is below. Help with the task: investigate, explain what you find, and propose and write the concrete changes (code, config, commands). You cannot run commands in this chat; write what should be run. Keep each reply under about 300 words.',
    HALYARD_MANUAL,
    `TEACHING BUDGET: Sam can absorb only about ${input.budget.total} new Halyard facts per session, so you may state at most ${input.budget.total} facts from the fact sheets per session. ${input.budget.left} of this session's budget is left. Choose which facts help Sam most, for the task and for understanding Halyard. A fact taught in an earlier session counts again if you restate it. Before Sam reads your reply, any sentence that states a sheet fact beyond the budget, or a Halyard fact not on this turn's sheets, is removed. List the ids of the sheet facts you state in statedFactIds.`,
    `FACT SHEETS available this turn (the concepts named in the brief or in Sam's message, and those you asked to read last turn):\n${sheets}`,
    `To read other concepts' fact sheets on your NEXT turn, put up to 2 concept ids in lookups. Concepts: ${input.catalog.map((c) => `${c.id} (${c.title})`).join(', ')}.`,
    `TASK BRIEF (what Sam's lead sent Sam):\n${input.task.brief}`,
    ...(input.extra ? [input.extra] : []),
    `CONVERSATION SO FAR:\n${conversation(input.messages)}`,
    `SAM'S MESSAGE:\n${input.message}`,
    'Return JSON {"reply","statedFactIds","lookups"}: reply is your message to Sam.',
  ].join('\n\n')
}

/** The Learner arms: what the hook injected and what the transport returned, exactly as the agent would see them. */
export const hookExtra = (hookContext: string, guidance: unknown) =>
  `LEARNING HOOK CONTEXT for this turn (added by the Learning hook):\n${hookContext}\n\nThe Learning transport returned this guidance for Sam's current message (you already submitted):\n${JSON.stringify(guidance)}`
