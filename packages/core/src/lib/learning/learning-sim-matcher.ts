import { HALYARD_FACT_SHEETS } from './learning-sim-facts.js'
import { HALYARD_CATALOG, HALYARD_EDGES, HALYARD_TERMS } from './learning-sim-halyard.js'
import type { MemoryLens } from './learning-sim-memory.js'

/**
 * The arm-blind fact matcher (docs/specs/simulated-learner-experiment.md): maps any text to the 104
 * exam facts by content-token coverage, with no knowledge of the arm, the policy or what the agent claims. It
 * enforces the teaching budget at the channel (`redactReply`), measures what each session actually taught, detects
 * re-exposure for the memory model, and is the leak test of every arm's base prompt (`examLeaks`).
 *
 * A text window (a sentence plus the one before it) states a fact when it holds at least `threshold` of the fact's
 * content tokens (lowercased, crude-stemmed, stop words out) and names the fact's concept (a term or the title) or
 * carries a code token unique to the fact, or when it holds 85% of them outright (see `factsIn`). Lexical, so it can
 * miss a loose paraphrase: what it misses reaches the learner unbudgeted, and the pre-registered unbudgeted-knowledge
 * check (learning-sim-analysis.ts, `unbudgetedAt`: exam facts right that the channel never delivered) measures it.
 */
const STOP = new Set(('a an the is are was were be been of to in and or by for with as its it it\'s that this these those on at no not when only any every from which what who whose ' +
  'how why can may must do does did has have had will would should so than then there their they them its into out over under same each per').split(' '))
const stem = (t: string) => t.length > 5 && t.endsWith('ing') ? t.slice(0, -3) : t.length > 4 && t.endsWith('ed') ? t.slice(0, -2) : t.length > 4 && t.endsWith('es') ? t.slice(0, -2) : t.length > 3 && t.endsWith('s') ? t.slice(0, -1) : t
const NUMBER_WORDS: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', twelve: '12', twenty: '20', thirty: '30', sixty: '60' }
const contentTokens = (text: string) => [...new Set(text.toLowerCase().replace(/[^a-z0-9_=%<>+ -]/g, ' ').replace(/[-]/g, ' ').split(/\s+/).map((t) => NUMBER_WORDS[t] ?? t)
  .filter((t) => (t.length > 1 || /[0-9]/.test(t)) && !STOP.has(t)).map(stem))]
const termRegex = (terms: string[]) => new RegExp(`(^|[^a-z0-9_])(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i')

type ExamFact = { id: string; conceptId: string; fact: string; answer: string; tokens: string[]; unique: string[]; term: RegExp }
const all = HALYARD_FACT_SHEETS.flatMap((s) => s.facts.map((f, i) => ({ id: `${s.conceptId.split('--')[1]}-f${i + 1}`, conceptId: s.conceptId, fact: f.fact, answer: f.answer, tokens: contentTokens(f.fact) })))
const df = new Map<string, number>()
for (const f of all) for (const t of f.tokens) df.set(t, (df.get(t) ?? 0) + 1)
/** Every exam fact with its tokens; `unique` are tokens no other fact has that look like codes or numbers. */
export const EXAM_FACTS: ExamFact[] = all.map((f) => ({ ...f, unique: f.tokens.filter((t) => df.get(t) === 1 && /[0-9_=]|^[a-z]+_[a-z]+$/.test(t)), term: termRegex(HALYARD_TERMS[f.conceptId] ?? []) }))

export const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean)
const coverage = (need: string[], have: Set<string>) => need.length ? need.filter((t) => have.has(t)).length / need.length : 0

/** Concept names that count as naming a fact's concept: its terms and its title. */
const conceptNamed = new Map(HALYARD_CATALOG.concepts.map((c) => [c.id, termRegex([c.title, ...(HALYARD_TERMS[c.id] ?? [])])]))
/**
 * The exam facts a window states, by fact id. A fact matches at `threshold` coverage when the window names its
 * concept (a term, the title or one of its unique code tokens), or at 0.85 coverage without a name. Facts overlap
 * (a short fact's words are often inside a longer one's), so matches are taken largest first and a smaller one is
 * kept only if at least half of its covered tokens are not already explained by the facts kept before it.
 */
export function factsIn(window: string, threshold = 0.6): string[] {
  const have = new Set(contentTokens(window))
  const hits = EXAM_FACTS.map((f) => ({ f, covered: f.tokens.filter((t) => have.has(t)) }))
    .filter(({ f, covered }) => { const c = covered.length / f.tokens.length; return c >= 0.85 || (c >= threshold && (conceptNamed.get(f.conceptId)!.test(window) || f.unique.some((u) => have.has(u)))) })
    .sort((a, b) => b.covered.length - a.covered.length || a.f.id.localeCompare(b.f.id))
  const explained = new Set<string>()
  const kept: string[] = []
  for (const { f, covered } of hits) {
    if (covered.filter((t) => !explained.has(t)).length * 2 < covered.length) continue
    kept.push(f.id)
    for (const t of covered) explained.add(t)
  }
  // A window that gives a question's answer with its concept named teaches that fact whatever else it says, unless
  // the answer's words are all inside a fact already found there (a sheet fact that contains another's answer).
  for (const f of ANSWERABLE) {
    const need = isCode(f.answer) ? [f.answer.toLowerCase()] : answerTokens(f)
    if (!kept.includes(f.id) && answers(f, window, have) && !(need.length && need.every((t) => explained.has(t)))) kept.push(f.id)
  }
  return kept
}
/** Answers that are only a concept's name: the catalog every arm needs names them, so no prompt can hide them. */
const titleWords = new Set(HALYARD_CATALOG.concepts.flatMap((c) => contentTokens(c.title)))
export const TITLE_ANSWERS = EXAM_FACTS.filter((f) => { const t = contentTokens(f.answer); return t.length > 0 && t.every((x) => titleWords.has(x)) && t.length <= 2 }).map((f) => f.id)
const isCode = (answer: string) => /^[A-Z][A-Z_]{2,}$/.test(answer)
const answerTokens = (f: ExamFact) => contentTokens(f.answer.replace(/^(yes|no)\b[;,]?/i, ''))
/** Whether `window` gives `f`'s answer: its concept named, and the answer's content tokens at `threshold` (an error
 * code in its own case; a bare yes/no answer by its fact's tokens). */
function answers(f: ExamFact, window: string, have: Set<string>, threshold = 0.8) {
  if (!conceptNamed.get(f.conceptId)!.test(window)) return false
  if (isCode(f.answer)) return new RegExp(`\\b${f.answer}\\b`).test(window)
  const need = answerTokens(f)
  return coverage(need.length ? need : f.tokens, have) >= threshold
}
/** Facts found by their answer as well as by their statement: answers specific enough not to fire on any sentence
 * that names the concept (an error code, a number, or two content tokens or more), never a concept's own name. */
const ANSWERABLE = EXAM_FACTS.filter((f) => !TITLE_ANSWERS.includes(f.id)).filter((f) => isCode(f.answer) || answerTokens(f).some((t) => /[0-9]/.test(t)) || answerTokens(f).length >= 2)

/** Facts stated sentence by sentence (each sentence read with the one before it, for "it"/"that" references). */
export function factsBySentence(text: string, threshold = 0.6) {
  const ss = sentences(text)
  return ss.map((s, i) => ({ sentence: s, facts: factsIn(`${i ? ss[i - 1] : ''} ${s}`, threshold).filter((id) => factsIn(s, threshold).includes(id) || !factsIn(ss[i - 1] ?? '', threshold).includes(id)) }))
}

export const REDACTED = '[…]'
/**
 * The budget at the channel: walks the reply in order and keeps a sentence only if every fact it states was offered
 * on this turn and fits the session's remaining budget (a fact already counted this session is free to repeat).
 * Any other sentence is replaced by REDACTED before the learner sees the reply.
 */
export function redactReply(reply: string, offered: ReadonlySet<string>, alreadyCounted: ReadonlySet<string>, budgetLeft: number) {
  const counted = new Set(alreadyCounted)
  let left = budgetLeft
  const kept: string[] = [], budgeted: string[] = [], unoffered: string[] = [], overBudget: string[] = []
  let redacted = 0
  for (const { sentence, facts } of factsBySentence(reply)) {
    const outside = facts.filter((id) => !offered.has(id))
    const fresh = facts.filter((id) => offered.has(id) && !counted.has(id))
    if (outside.length || fresh.length > left) {
      unoffered.push(...outside)
      if (!outside.length) overBudget.push(...fresh)
      redacted++
      if (kept.at(-1) !== REDACTED) kept.push(REDACTED)
      continue
    }
    for (const id of fresh) { counted.add(id); budgeted.push(id) }
    left -= fresh.length
    kept.push(sentence)
  }
  return { text: kept.join(' '), budgeted, unoffered: [...new Set(unoffered)], overBudget: [...new Set(overBudget)], redacted }
}

/**
 * The leak test: exam ids whose answer (its content tokens; a bare yes/no answer is checked by its fact) is at least
 * `threshold` present in one window of `text` that also names the question's concept. Title answers are exempt.
 */
export function examLeaks(text: string, threshold = 0.8) {
  const ss = sentences(text)
  const windows = ss.map((s, i) => `${i ? ss[i - 1] : ''} ${s}`)
  return EXAM_FACTS.filter((f) => !TITLE_ANSWERS.includes(f.id)).filter((f) => windows.some((w) => answers(f, w, new Set(contentTokens(w)), threshold))).map((f) => f.id)
}

const factById = new Map(EXAM_FACTS.map((f) => [f.id, f]))
/** The memory rules' view of a note through this matcher (learning-sim-memory.ts, `updateNotebook`). */
export const HALYARD_LENS: MemoryLens = {
  tag: (note) => factsIn(note),
  conceptOf: (id) => factById.get(id)!.conceptId,
  prerequisites: (conceptId) => HALYARD_EDGES.filter(([, to]) => to === conceptId).map(([from]) => from),
}
