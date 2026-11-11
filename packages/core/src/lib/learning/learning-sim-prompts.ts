import { createHash } from 'node:crypto'
import type { ExamQuestion, SimTask } from './learning-sim-halyard.js'
import { HALYARD_MANUAL } from './learning-sim-halyard.js'

/**
 * Prompts of the simulated-learner experiment (docs/specs/simulated-learner-experiment.md). What each role sees
 * is the validity argument, so it is spelled out here:
 *  - the learner: its own notebook, the task brief and this session's conversation. Never the manual, the exam,
 *    the arm, or Learner's injected text.
 *  - the agent: the Halyard manual in EVERY arm (as a coding agent knows a real tool), the brief and the
 *    conversation; in the Learner arms also the hook's text and the returned guidance, in the control arm an
 *    irrelevant text of the same length instead.
 *  - the exam scorer: questions, rubric and answers. Never the arm, the notebook or the conversation.
 */
export type SimMessage = { session: number; seq: number; role: 'learner' | 'agent' | 'notebook'; text: string }

const conversation = (messages: SimMessage[]) => messages.length
  ? messages.map((m) => `[${m.role === 'learner' ? 'Sam' : 'Agent'}]: ${m.text}`).join('\n\n')
  : '(nothing yet)'
const notebookBlock = (notebook: string) => notebook.trim() ? `<<<\n${notebook}\n>>>` : '(empty: this is Sam\'s first session with Halyard; Sam knows nothing about it yet)'

const SAM = 'You are role-playing Sam, a backend developer at Northwind Freight, in a chat with an AI coding agent. Northwind recently adopted Halyard, its event-pipeline runtime.'
const MEMORY = 'What Sam knows about Halyard is ONLY what is in Sam\'s notebook below and what was said earlier in this conversation. Sam has never read Halyard\'s documentation. Do not use or invent Halyard facts from anywhere else: when Sam does not know something, Sam asks, or reasons from what was said, and may be wrong.'

export function learnerTurnPrompt(input: { notebook: string; task: SimTask; messages: SimMessage[]; turn: number; turns: number }) {
  const position = input.turn === 1
    ? 'Open the session: tell the agent what you need help with, in your own words.'
    : input.turn === input.turns
      ? 'This is Sam\'s LAST message of the session: state your decision and your reasoning to the agent in your own words, as your lead asked. Say why, not only what.'
      : 'Continue the work: react to what the agent said, make the decisions the task needs from you, answer any question the agent asked you, and ask about what you need to understand.'
  return [SAM, MEMORY,
    `SAM'S NOTEBOOK (written by Sam after earlier sessions):\n${notebookBlock(input.notebook)}`,
    `TODAY'S TASK (from Sam's lead):\n${input.task.brief}`,
    `CONVERSATION SO FAR:\n${conversation(input.messages)}`,
    `This is message ${input.turn} of ${input.turns} from Sam in this session. ${position}`,
    'Write 2-6 sentences of plain text, as Sam would type in a chat. No role label, no quotes around it.',
  ].join('\n\n')
}

/** Calibration only: Sam's reply to an explanation, with no agent answering back (the dose stays the explanation). */
export function calibrationReplyPrompt(input: { notebook: string; messages: SimMessage[] }) {
  return [SAM, MEMORY,
    `SAM'S NOTEBOOK (written by Sam after earlier sessions):\n${notebookBlock(input.notebook)}`,
    `CONVERSATION SO FAR:\n${conversation(input.messages)}`,
    'The agent just explained a Halyard concept to Sam. Reply in 2-4 sentences of plain text, as Sam would type in a chat: say in your own words what you understood, and ask about anything that is unclear. No role label.',
  ].join('\n\n')
}

export const NOTEBOOK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['entries'],
  properties: { entries: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['topic', 'notes'], properties: { topic: { type: 'string' }, notes: { type: 'string' } } } } },
}
/** Sam's notebook is one entry per topic. The model returns only the entries it adds or rewrites; every
 * other entry is kept verbatim by the caller, so nothing Sam learned is ever cut for space. */
export function notebookPrompt(input: { notebook: string; messages: SimMessage[]; pace: number }) {
  return [SAM,
    `The session just ended. Update Sam's personal notebook about Halyard. It is the ONLY thing Sam will remember about Halyard in future sessions: anything not in it is forgotten. The notebook has one entry per topic (a Halyard term or idea). Sam writes in Sam's own words, for future work with Halyard, and may only write what Sam actually learned from today's conversation or already had in the notebook.`,
    `TODAY'S CONVERSATION:\n${conversation(input.messages)}`,
    `CURRENT NOTEBOOK:\n${notebookBlock(input.notebook)}`,
    `Return JSON {"entries":[{"topic","notes"}]} with ONLY the entries to add or rewrite: a new topic, or an existing topic (same name) whose notes today's conversation changed or extended; for an existing topic, give its complete new notes. Leave out every entry that did not change: it is kept exactly as it is. Sam takes notes at a steady pace: about ${input.pace} characters of new or rewritten notes in total for this session.`,
  ].join('\n\n')
}

export const EXAM_ANSWER_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['answers'],
  properties: { answers: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'answer'], properties: { id: { type: 'string' }, answer: { type: 'string' } } } } },
}
export function examAnswerPrompt(input: { notebook: string; questions: ExamQuestion[] }) {
  return [SAM,
    'Sam is taking a closed-book quiz about Halyard. Sam may use ONLY Sam\'s notebook below: Sam has no other knowledge of Halyard. When the notebook does not cover a question, answer "I don\'t know", or give a best guess and say it is a guess. One or two sentences per answer.',
    `NOTEBOOK:\n${notebookBlock(input.notebook)}`,
    `QUESTIONS:\n${JSON.stringify(input.questions.map(({ id, question }) => ({ id, question })))}`,
    'Return JSON {"answers":[{"id","answer"}]} with one answer for every question id.',
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

export function agentReplyPrompt(input: { task: SimTask; messages: SimMessage[]; message: string; extra: string | null }) {
  return [
    'You are an AI coding agent pairing with Sam, a developer at Northwind Freight, inside their repository. Halyard is the company\'s event-pipeline runtime; its reference manual is below. Help with the task: investigate, explain what you find, and propose and write the concrete changes (code, config, commands). You cannot run commands in this chat; write what should be run. Keep each reply under about 300 words.',
    HALYARD_MANUAL,
    `TASK BRIEF (what Sam's lead sent Sam):\n${input.task.brief}`,
    ...(input.extra ? [input.extra] : []),
    `CONVERSATION SO FAR:\n${conversation(input.messages)}`,
    `SAM'S MESSAGE:\n${input.message}`,
    'Write your reply to Sam.',
  ].join('\n\n')
}

/** The Learner arms: what the hook injected and what the transport returned, exactly as the agent would see them. */
export const hookExtra = (hookContext: string, guidance: unknown) =>
  `LEARNING HOOK CONTEXT for this turn (added by the Learning hook):\n${hookContext}\n\nThe Learning transport returned this guidance for Sam's current message (you already submitted):\n${JSON.stringify(guidance)}`

const FILLER = [
  'Field notes on alpine cushion plants. Cushion plants grow as dense, low domes that trap warm air and reduce water loss in exposed, windy sites. A single cushion of moss campion can be several decades old and expands only a few millimetres each year.',
  'Many cushion species flower early in the short season, often before the surrounding snow has fully melted. Their tight structure also collects wind-blown soil and seeds, so a cushion can host insects and smaller plants that would not survive on bare scree nearby.',
  'Surveys usually record cushion diameter, the share of dead tissue, and the number of associated species. Repeated surveys at fixed plots show how cushions respond to warmer summers, grazing and trampling along hiking paths.',
  'In botanical drawings the cushion outline is traced first, then individual rosettes are added at the margin, where growth is most active. Herbarium sheets rarely show the whole cushion, so field photographs with a scale bar are kept alongside them.',
  'Seeds collected from cushion plants are cleaned, dried to a low moisture content and stored cold. Germination trials compare seeds with and without a period of moist chilling, which many alpine species need before they sprout.',
  'Volunteer days at the field station include weeding invasive grasses, repairing marker posts, and entering plot data. The station library lends identification keys, hand lenses and pressed reference specimens for the common genera.',
]
/** Irrelevant text of exactly `length` characters (the negative control), deterministic per turn. */
export function irrelevantText(length: number, seed: string) {
  if (length <= 0) return ''
  const start = parseInt(createHash('md5').update(seed).digest('hex').slice(0, 6), 16) % FILLER.length
  let text = 'ADDITIONAL CONTEXT for this turn:\n'
  for (let i = start; text.length < length; i++) text += FILLER[i % FILLER.length] + '\n\n'
  return text.slice(0, length)
}
