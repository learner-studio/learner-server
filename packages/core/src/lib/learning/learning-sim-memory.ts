/**
 * The simulated learner's memory between sessions (docs/specs/simulated-learner-experiment.md, "Learner memory").
 *
 * The notebook is a list of facts per topic. Two numbers make a learner slow, medium or fast, and code enforces
 * both, so a lane is a property of the learner rather than a persona the model may ignore:
 *
 * - capacity: how many characters of NEW notes the learner takes in per session. The model is told the budget and
 *   lists its most important facts first; facts are kept whole, in order, until the budget is spent, and a fact
 *   that does not fit is recorded as `overCapacity`, never truncated. A budget in characters, not a count of facts,
 *   because the model packs several facts into one sentence when it is given a count (calibration 34b55389).
 * - forget: the chance that a stored fact is gone by the next session. Deterministic per (seed, topic, fact,
 *   session), so a replay forgets exactly the same facts.
 *
 * A fact the learner restates is not new and costs no capacity. Nothing written within capacity is ever cut.
 */
import { createHash } from 'node:crypto'

export const SIM_LANES = {
  slow: { capacity: 100, forget: 0.08 },
  medium: { capacity: 200, forget: 0.05 },
  fast: { capacity: 400, forget: 0.02 },
} as const
export type SimLane = keyof typeof SIM_LANES
export type NotebookEntry = { topic: string; facts: string[] }

const key = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase()

/** Stored as markdown: `### topic` then one `- fact` per line. Plain text from older runs becomes one fact per line. */
export function parseNotebook(text: string): NotebookEntry[] {
  const facts = (block: string) => block.split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean)
  const entries: NotebookEntry[] = []
  const parts = text.split(/^### (.+)$/m)
  if (parts[0]!.trim()) entries.push({ topic: 'notes', facts: facts(parts[0]!) })
  for (let i = 1; i < parts.length; i += 2) entries.push({ topic: parts[i]!.trim(), facts: facts(parts[i + 1] ?? '') })
  return entries.filter((e) => e.facts.length)
}
export const renderNotebook = (entries: NotebookEntry[]) => entries.filter((e) => e.facts.length).map((e) => `### ${e.topic}\n${e.facts.map((f) => `- ${f}`).join('\n')}`).join('\n\n')
export const factCount = (entries: NotebookEntry[]) => entries.reduce((n, e) => n + e.facts.length, 0)

/** A uniform number in [0, 1) from a string: the same input always gives the same draw. */
export const draw = (s: string) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16) / 2 ** 32

export function forgetNotebook(entries: NotebookEntry[], rate: number, seed: string, session: number) {
  let forgotten = 0
  const kept = entries.map((e) => ({ topic: e.topic, facts: e.facts.filter((f) => {
    const gone = draw(`${seed}|${key(e.topic)}|${key(f)}|${session}`) < rate
    if (gone) forgotten++
    return !gone
  }) })).filter((e) => e.facts.length)
  return { entries: kept, forgotten }
}

/** Adds the new facts in the order given while their characters fit in `capacity`; a restated fact is free; the
 * first fact that does not fit and every fact after it are over capacity. */
export function learnNotebook(entries: NotebookEntry[], additions: NotebookEntry[], capacity: number) {
  const merged = entries.map((e) => ({ topic: e.topic, facts: [...e.facts] }))
  let added = 0
  let used = 0
  let overCapacity = 0
  let full = false
  for (const addition of additions) {
    const topic = addition.topic.replace(/\s+/g, ' ').trim()
    if (!topic) continue
    for (const raw of addition.facts) {
      const fact = raw.replace(/\s+/g, ' ').trim()
      if (!fact) continue
      let entry = merged.find((e) => key(e.topic) === key(topic))
      if (entry?.facts.some((f) => key(f) === key(fact))) continue
      if (full || used + fact.length > capacity) { full = true; overCapacity++; continue }
      if (!entry) { entry = { topic, facts: [] }; merged.push(entry) }
      entry.facts.push(fact)
      used += fact.length
      added++
    }
  }
  return { entries: merged, added, used, overCapacity }
}

/** One session's update: forget since the last session, then learn up to capacity from the model's list. */
export function updateNotebook(previous: string, additions: NotebookEntry[], lane: SimLane, seed: string, session: number) {
  const { capacity, forget } = SIM_LANES[lane]
  const decayed = forgetNotebook(parseNotebook(previous), forget, seed, session)
  const learned = learnNotebook(decayed.entries, additions, capacity)
  return { text: renderNotebook(learned.entries), facts: factCount(learned.entries), added: learned.added, used: learned.used, overCapacity: learned.overCapacity, forgotten: decayed.forgotten }
}
