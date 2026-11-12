import { HALYARD_FACT_SHEETS } from './learning-sim-facts.js'
import { HALYARD_CATALOG, HALYARD_EDGES, HALYARD_TERMS, termRegex } from './learning-sim-halyard.js'
import type { MemoryLens } from './learning-sim-memory.js'

/**
 * The arm-blind fact matcher (docs/specs/simulated-learner-experiment.md): maps any text to the 64 scored (revision 8; 104 before)
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
// A placeholder such as <name> is not content: an answer "halyard unmoor <name>" is given by "halyard unmoor depot-sync".
const contentTokens = (text: string) => [...new Set(text.toLowerCase().replace(/<[a-z_-]+>/g, ' ').replace(/[^a-z0-9_=%<>+ -]/g, ' ').replace(/[-]/g, ' ').split(/\s+/).map((t) => NUMBER_WORDS[t] ?? t)
  .filter((t) => (t.length > 1 || /[0-9]/.test(t)) && !STOP.has(t)).map(stem))]

type ExamFact = { id: string; conceptId: string; fact: string; answer: string; tokens: string[]; unique: string[]; term: RegExp }
const all = HALYARD_FACT_SHEETS.flatMap((s) => s.facts.map((f) => ({ id: f.id, conceptId: s.conceptId, fact: f.fact, answer: f.answer, tokens: contentTokens(f.fact) })))
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

const factById = new Map(EXAM_FACTS.map((f) => [f.id, f]))
export const REDACTED = '[…]'
/**
 * The budget at the channel: walks the reply in order and keeps a sentence only if every fact it states was offered
 * on this turn and fits the session's remaining budget (a fact already counted this session is free to repeat).
 * Any other sentence is replaced by REDACTED before the learner sees the reply.
 */
export function redactReply(reply: string, offered: ReadonlySet<string>, alreadyCounted: ReadonlySet<string>, budgetLeft: number, claimed: ReadonlySet<string> = new Set()) {
  const counted = new Set(alreadyCounted)
  let left = budgetLeft
  const unoffered: string[] = [], overBudget: string[] = [], withheld: string[] = []
  let redacted = 0
  const bySentence = factsBySentence(reply)
  // The agent's claim is believed (the matcher is lexical and misses paraphrase, the pilot's main leak): a claimed
  // fact the matcher did not find anywhere is placed in the sentence that holds most of its tokens not already
  // explained by the facts found there (the first on a tie), and is budgeted or redacted there like any other.
  const found = new Set(bySentence.flatMap((x) => x.facts))
  const attributed = [...claimed].filter((x) => !found.has(x) && factById.has(x))
  for (const id of attributed) {
    const need = factById.get(id)!.tokens
    const score = bySentence.map((x) => {
      const explained = new Set(x.facts.flatMap((f) => factById.get(f)?.tokens ?? []))
      return coverage(need, new Set(contentTokens(x.sentence).filter((t) => !explained.has(t))))
    })
    const best = score.indexOf(Math.max(0, ...score))
    if (best >= 0 && score[best]! > 0) bySentence[best]!.facts.push(id)
    // Review 6 B1: a claim with no sentence to place it in was not read by the learner; it is withheld, not lost.
    else withheld.push(id)
  }
  // One piece per raw sentence: kept (with the facts it budgeted) or redacted.
  const pieces: Array<{ sentence: string; budgeted: string[] } | null> = []
  const redact = (facts: string[], fresh: string[]) => {
    const outside = facts.filter((id) => !offered.has(id))
    unoffered.push(...outside)
    if (!outside.length) overBudget.push(...fresh)
    // Review 6 B1: a claimed fact in a redacted sentence that is not recorded as over budget was withheld (the
    // learner read "[…]"); recorded so the channel gate accounts for it.
    withheld.push(...facts.filter((id) => claimed.has(id) && offered.has(id) && !counted.has(id) && !(outside.length === 0 && fresh.includes(id))))
    redacted++
    pieces.push(null)
  }
  for (const { sentence, facts } of bySentence) {
    const outside = facts.filter((id) => !offered.has(id))
    const fresh = facts.filter((id) => offered.has(id) && !counted.has(id))
    if (outside.length || fresh.length > left) { redact(facts, fresh); continue }
    for (const id of fresh) counted.add(id)
    left -= fresh.length
    pieces.push({ sentence, budgeted: fresh })
  }
  // Review 6 B2: join without merging. A piece that ends a sentence (or the marker, which has no words) is followed by
  // a space, any other line by a newline, so the delivered text splits into these pieces again (a piece after the
  // marker carries it as a prefix). Then re-match it: a piece in
  // which the matcher now finds a fact this reply did not budget and the session had not counted is redacted too
  // (and its budget returned), until the delivered text states nothing beyond the record.
  const render = () => {
    const out: string[] = []
    for (const p of pieces) { const t = p ? p.sentence : REDACTED; if (!p && out.at(-1) === REDACTED) continue; out.push(t) }
    return out.reduce((text, t, k) => k === 0 ? t : `${text}${/[.!?]$/.test(out[k - 1]!) || out[k - 1] === REDACTED ? ' ' : '\n'}${t}`, '')
  }
  // Until nothing changes: every pass that changes anything redacts at least one kept piece, so it ends.
  for (;;) {
    const keptIdx = pieces.map((p, k) => (p ? k : -1)).filter((k) => k >= 0)
    const reread = factsBySentence(render())
    let changed = false
    for (const { sentence, facts } of reread) {
      const stray = facts.filter((id) => !counted.has(id))
      if (!stray.length) continue
      const bare = sentence.startsWith(`${REDACTED} `) ? sentence.slice(REDACTED.length + 1) : sentence
      // The piece it is, or (should a join still merge) every kept piece inside it: never left in place.
      const exact = keptIdx.filter((x) => pieces[x]?.sentence === bare)
      for (const k of exact.length ? exact : keptIdx.filter((x) => pieces[x] && bare.includes(pieces[x]!.sentence))) {
        for (const id of pieces[k]!.budgeted) { counted.delete(id); left++; if (claimed.has(id)) withheld.push(id) }
        pieces[k] = null
        redacted++
        changed = true
      }
      const outside = stray.filter((id) => !offered.has(id))
      unoffered.push(...outside)
      if (!outside.length) overBudget.push(...stray)
    }
    if (!changed) break
  }
  const budgeted = pieces.flatMap((p) => p?.budgeted ?? [])
  const over = [...new Set(overBudget)].filter((id) => !budgeted.includes(id) && !alreadyCounted.has(id))
  return { text: render(), budgeted, unoffered: [...new Set(unoffered)], overBudget: over, redacted, attributed,
    withheld: [...new Set(withheld)].filter((id) => !budgeted.includes(id) && !over.includes(id)) }
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

/** The memory rules' view of a note through this matcher (learning-sim-memory.ts, `updateNotebook`). */
export const HALYARD_LENS: MemoryLens = {
  tag: (note) => factsIn(note),
  conceptOf: (id) => factById.get(id)!.conceptId,
  prerequisites: (conceptId) => HALYARD_EDGES.filter(([, to]) => to === conceptId).map(([from]) => from),
}
