import { ATTRIBUTION_THRESHOLD, EXAM_FACTS, factsBySentence, factsIn, sentences, type DeliveryPath } from './learning-sim-matcher.js'
import { seeded } from './learning-sim-memory.js'
import { ci, mean, resample, type SimLearnerData } from './learning-sim-analysis.js'

/**
 * The arm-blind delivery judge (design D.6, review B4): after the stop, a model is asked, item by item, whether a
 * delivered sentence window states the sheet fact the channel counted for it. Pure: the seeded sample, the prompt, the
 * schema and the analysis. The workflow step (learning-sim-run.ts `simJudgePlan`, `simJudgeItem`) hands the judge
 * only `blindItem`: the arm, path, learner and fact id stay here, for the analysis.
 */
export const JUDGE_PER_STRATUM = 36
export const JUDGE_PLANTED = 6
const ARMS = ['on', 'off'] as const
const GROUPS = ['matcher', 'attributed'] as const
type Arm = (typeof ARMS)[number]
export type JudgeGroup = (typeof GROUPS)[number]
/** Planned judge calls of a main batch: 4 strata of 36, 6 planted false and 6 planted true pairs. */
export const SIM_JUDGE_CALLS = ARMS.length * GROUPS.length * JUDGE_PER_STRATUM + 2 * JUDGE_PLANTED

type Delivery = { arm: Arm; group: JudgeGroup; path: DeliveryPath; learnerId: string; session: number; turn: number; factId: string; sentence: string; fact: string }
export type JudgeItem = { index: number; sentence: string; fact: string; factId: string }
  & ({ kind: 'delivery' } & Omit<Delivery, 'sentence' | 'fact' | 'factId'> | { kind: 'planted-false' | 'planted-true' })
export type JudgeSample = { items: JudgeItem[]; pathShares: Record<Arm, Record<JudgeGroup, number>> }
/** Every sheet id the agent can cite: the fact ids and the concept ids of EXAM_FACTS, longest first. */
const SHEET_IDS = [...new Set(EXAM_FACTS.flatMap((f) => [f.id, f.conceptId]))].sort((a, b) => b.length - a.length)
const ID = `(?<![\\w-])(?:${SHEET_IDS.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`
/** A bracket that holds only ids ("[keel-key-f1]", "(see keel-key-f1, halyard-core--keel-key)"), with the whitespace before it. */
const BRACKETED_IDS = new RegExp(`\\s*[[(]\\s*(?:see\\s+)?${ID}(?:\\s*[,;]\\s*(?:and\\s+)?${ID})*\\s*[\\])]`, 'gi')
const BARE_ID = new RegExp(`\\s*${ID}`, 'gi')
/**
 * The judge's view of a text (P6 review R4): every sheet id removed, case-insensitively, with the whitespace before it;
 * a bracket that held nothing but ids goes with them. Nothing else is touched: a text without an id is returned as
 * it is (empty brackets, "see", newlines and spacing included), in every arm alike. Only the judge's prompt reads it:
 * the stored reply, the matcher, the sample and its order are computed on the text as delivered.
 */
export const judgeView = (text: string) => {
  const out = text.replace(BRACKETED_IDS, '').replace(BARE_ID, '')
  return out === text || /^\s/.test(text) ? out : out.trimStart()
}
/** What the judge sees: the sentence and the fact, nothing else, each in the judge's view. */
export const blindItem = (x: JudgeItem) => ({ index: x.index, sentence: judgeView(x.sentence), fact: judgeView(x.fact) })

const factById = new Map(EXAM_FACTS.map((f) => [f.id, f]))
/** The window of the delivered text that states `factId` at its path's bar (the bar `unread` checks): the matcher's
 * sentence (with the one before it) for a matched path, the first window at ATTRIBUTION_THRESHOLD for `attributed`. */
function deliveryWindow(text: string, factId: string, path: DeliveryPath) {
  const ss = sentences(text)
  const k = path === 'attributed' ? ss.findIndex((s, i) => factsIn(`${i ? ss[i - 1] : ''} ${s}`, ATTRIBUTION_THRESHOLD).includes(factId))
    : factsBySentence(text).findIndex((x) => x.facts.includes(factId))
  if (k < 0) throw new Error(`delivery ${factId} (${path}) is not stated in its turn's text`)
  return `${k ? ss[k - 1] : ''} ${ss[k]}`.trim()
}
/** The first `k` of a seeded partial shuffle of `xs`. */
function drawK<T>(xs: readonly T[], k: number, r: () => number) {
  const a = [...xs]
  for (let i = 0; i < Math.min(k, a.length); i++) { const j = i + Math.floor(r() * (a.length - i)); [a[i], a[j]] = [a[j]!, a[i]!] }
  return a.slice(0, k)
}

/**
 * The judge's sample, one seeded stream `${runId}|judge`: the stored deliveries of the fast `on` and `off` learners in
 * canonical order (learner, session, turn, delivery order), drawn per arm × path group (`matcher` = matched ∪
 * matched-claimed; `attributed`), 36 each; a short attributed stratum is taken whole and its remainder drawn from the
 * same arm's matcher stratum. Then 6 planted false pairs (a delivered window with a fact of another concept that the
 * window does not state even at 0.4) and 6 planted true pairs (a sheet fact as its own sentence), and the whole list
 * shuffled: `index` is the position. The arm only stratifies. `pathShares` are each arm's own shares of its deliveries.
 */
export function judgeSample(runId: string, data: ReadonlyArray<Pick<SimLearnerData, 'config' | 'agentTurns'>>): JudgeSample {
  const pool: Delivery[] = [...data].filter((d) => d.config.lane === 'fast' && (d.config.arm === 'on' || d.config.arm === 'off'))
    .sort((a, b) => a.config.learnerId.localeCompare(b.config.learnerId))
    .flatMap((d) => [...d.agentTurns].sort((a, b) => a.session - b.session || a.turn - b.turn).flatMap((t) => (t.statedFacts ?? []).map(({ factId, path }) => ({
      arm: d.config.arm as Arm, group: path === 'attributed' ? 'attributed' as const : 'matcher' as const, path, learnerId: d.config.learnerId, session: t.session, turn: t.turn,
      factId, sentence: deliveryWindow(t.text ?? '', factId, path), fact: factById.get(factId)!.fact }))))
  const r = seeded(`${runId}|judge`)
  const drawn: Array<Omit<JudgeItem, 'index'>> = []
  for (const arm of ARMS) {
    const of = (g: JudgeGroup) => pool.filter((x) => x.arm === arm && x.group === g)
    const attributed = drawK(of('attributed'), JUDGE_PER_STRATUM, r)
    const matcher = drawK(of('matcher'), 2 * JUDGE_PER_STRATUM - attributed.length, r)
    drawn.push(...[...matcher, ...attributed].map((x) => ({ kind: 'delivery' as const, ...x })))
  }
  for (const x of drawK(pool, JUDGE_PLANTED, r)) {
    const stated = factsIn(x.sentence, ATTRIBUTION_THRESHOLD)
    const others = EXAM_FACTS.filter((f) => f.conceptId !== factById.get(x.factId)!.conceptId && !stated.includes(f.id))
    const f = others[Math.floor(r() * others.length)]!
    drawn.push({ kind: 'planted-false', sentence: x.sentence, fact: f.fact, factId: f.id })
  }
  for (const f of drawK(EXAM_FACTS, JUDGE_PLANTED, r)) drawn.push({ kind: 'planted-true', sentence: f.fact, fact: f.fact, factId: f.id })
  const items = drawK(drawn, drawn.length, r).map((x, index) => ({ ...x, index }) as JudgeItem)
  const pathShares = Object.fromEntries(ARMS.map((arm) => {
    const mine = pool.filter((x) => x.arm === arm)
    return [arm, Object.fromEntries(GROUPS.map((g) => [g, mine.filter((x) => x.group === g).length / mine.length]))]
  })) as JudgeSample['pathShares']
  return { items, pathShares }
}

/** The judge's prompt: the sentence and the fact, never the arm, a learner, the run or a fact id. */
export function judgePrompt(x: { sentence: string; fact: string }) {
  return [
    'You check one statement against one fact. Decide whether the TEXT states the FACT: the same claim, not only the same topic. Text that leaves out part of the fact, or says something different, does not state it.',
    `FACT:\n<<<\n${x.fact}\n>>>`,
    `TEXT:\n<<<\n${x.sentence}\n>>>`,
    'Return JSON {"states":"yes"} or {"states":"no"}.',
  ].join('\n\n')
}
export const JUDGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['states'], properties: { states: { type: 'string', enum: ['yes', 'no'] } } }
export type JudgeAnswer = 'yes' | 'no'
/** Review R1: the reply must be one of the schema's two answers before its receipt is written. */
export const judgeAccepts = (json: unknown) => ['yes', 'no'].includes((json as { states?: unknown } | null)?.states as string)

const Z95 = 1.959964
/** Wilson 95% interval of k of n. */
function wilson(k: number, n: number) {
  if (!n) return [NaN, NaN] as const
  const p = k / n, d = 1 + Z95 ** 2 / n, c = (p + Z95 ** 2 / (2 * n)) / d, h = (Z95 * Math.sqrt(p * (1 - p) / n + Z95 ** 2 / (4 * n * n))) / d
  return [Math.max(0, c - h), Math.min(1, c + h)] as const
}

/**
 * The judge's rows and withhold rules (design D.6): per stratum, the false-delivery share (the judge said "no") with its
 * Wilson 95% interval; each arm's share weighted by its own path shares, and on − off with a 4,000-draw percentile
 * bootstrap (each stratum resampled, seed `${runId}|judge|bootstrap`). Withheld: when on's weighted share exceeds off's
 * with a 95% lower bound > 0; when the judge says "yes" to more than 2 of the 6 planted false pairs or "no" to more than
 * 2 of the 6 planted true pairs (untrusted); when an item has no answer. `answers[i]` is item i's answer; anything but
 * "yes" or "no" (none, a failed item's null, any other string) is unanswered (review R1).
 */
export function judgeAnalysis(runId: string, sample: JudgeSample, raw: ReadonlyArray<string | null | undefined>) {
  const withheld: string[] = []
  const answers = raw.map((a) => (a === 'yes' || a === 'no' ? a : undefined))
  const missing = sample.items.filter((x) => answers[x.index] === undefined).length
  if (missing) withheld.push(`judge incomplete: ${missing} of ${sample.items.length} items unanswered`)
  const answered = new Map(ARMS.flatMap((arm) => GROUPS.map((g) => [`${arm}|${g}`, sample.items.flatMap((x) => (x.kind === 'delivery' && x.arm === arm && x.group === g && answers[x.index] ? [answers[x.index] === 'no' ? 1 : 0] : []))])))
  const flags = (arm: Arm, g: JudgeGroup) => answered.get(`${arm}|${g}`)!
  const strata = ARMS.flatMap((arm) => GROUPS.map((group) => {
    const f = flags(arm, group), k = f.reduce((a, b) => a + b, 0), [lo, hi] = wilson(k, f.length)
    return { arm, group, n: f.length, falseDeliveries: k, share: f.length ? k / f.length : NaN, lo, hi }
  }))
  const weighted = (arm: Arm, share: (g: JudgeGroup) => number) => GROUPS.reduce((s, g) => s + (sample.pathShares[arm][g] ? sample.pathShares[arm][g] * share(g) : 0), 0)
  const point = (arm: Arm) => weighted(arm, (g) => mean(flags(arm, g)))
  const r = seeded(`${runId}|judge|bootstrap`), draws: number[] = []
  for (let b = 0; b < 4000; b++) draws.push(ARMS.map((arm) => weighted(arm, (g) => mean(resample(flags(arm, g), r)))).reduce((on, off) => on - off))
  const [lo, hi] = ci(draws)
  if (lo > 0) withheld.push('judge: on false-delivery share above off')
  const said = (kind: JudgeItem['kind'], a: JudgeAnswer) => sample.items.filter((x) => x.kind === kind && answers[x.index] === a).length
  const planted = { falseSaidYes: said('planted-false', 'yes'), trueSaidNo: said('planted-true', 'no') }
  if (planted.falseSaidYes > 2) withheld.push(`judge untrusted: yes to more than 2 of ${JUDGE_PLANTED} planted false pairs`)
  if (planted.trueSaidNo > 2) withheld.push(`judge untrusted: no to more than 2 of ${JUDGE_PLANTED} planted true pairs`)
  return { strata, weighted: { on: point('on'), off: point('off'), diff: point('on') - point('off'), lo, hi }, planted, withheld }
}
