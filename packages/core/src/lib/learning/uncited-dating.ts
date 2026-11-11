import { seededRandom } from './mastery-change-statistics.js'

/**
 * How well the 75th-percentile rule dates an UNCITED reading (mastery-notifications.ts READINGS;
 * review N7 and "(c)"). An uncited reading names no message, so it is dated by a quantile of its
 * learner messages' times. The rule can only be scored where the answer is known: on CITED
 * readings, against the newest learner message they cite. This module scores it three ways, all
 * pure and seeded (scripts/uncited-dating-evaluation.ts reads the data):
 * - in sample: each candidate quantile's bias and absolute error over every cited reading;
 * - split half: choose the quantile with the least |bias| on a random half, score it on the other
 *   half (how much tuning on the same readings flattered the choice);
 * - transferred: cited readings cut down to look like uncited ones (a contiguous run of learner
 *   messages with an uncited reading's count and span that still holds the cited message), because
 *   the rule is applied to readings with fewer messages than it was tuned on.
 */

const DAY_MS = 86_400_000

/** One counted reading: its learner messages' times (ms, any order) and, when cited, the newest cited learner message. */
export interface DatingCase { learnerAt: number[]; citedAt: number | null }

/** PostgreSQL percentile_disc: the first value whose cumulative share reaches q. */
export function percentileDisc(sorted: readonly number[], q: number): number {
  if (!sorted.length) throw new Error('percentileDisc of nothing')
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!
}

export interface QuantileScore { quantile: number; n: number; meanDays: number; medianAbsDays: number; meanAbsDays: number }

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN
}

/** Signed errors (days, dated minus cited) of quantile `q` over cited cases with a learner message. */
export function datingErrors(cases: readonly DatingCase[], q: number): number[] {
  return cases.filter((c) => c.citedAt !== null && c.learnerAt.length > 0)
    .map((c) => (percentileDisc([...c.learnerAt].sort((a, b) => a - b), q) - c.citedAt!) / DAY_MS)
}

export function scoreQuantile(cases: readonly DatingCase[], q: number): QuantileScore {
  const e = datingErrors(cases, q)
  return {
    quantile: q, n: e.length, meanDays: e.reduce((a, b) => a + b, 0) / e.length,
    medianAbsDays: median(e.map(Math.abs)), meanAbsDays: e.reduce((a, b) => a + Math.abs(b), 0) / e.length,
  }
}

export interface SplitHalf { splits: number; chosen: Array<{ quantile: number; share: number }>; heldOutBias: { median: number; low: number; high: number } }

/** Choose the least-|bias| quantile on a random half of the cited cases, score its bias on the other half. */
export function splitHalf(cases: readonly DatingCase[], quantiles: readonly number[], splits: number, seed: number): SplitHalf {
  const cited = cases.filter((c) => c.citedAt !== null && c.learnerAt.length > 0)
  const rand = seededRandom(seed)
  const chosen = new Map<number, number>()
  const bias: number[] = []
  for (let s = 0; s < splits; s++) {
    const order = cited.map((c) => ({ c, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.c)
    const half = Math.floor(order.length / 2)
    const tune = order.slice(0, half), test = order.slice(half)
    const best = quantiles.map((q) => ({ q, b: Math.abs(scoreQuantile(tune, q).meanDays) })).sort((a, b) => a.b - b.b || a.q - b.q)[0]!.q
    chosen.set(best, (chosen.get(best) ?? 0) + 1)
    bias.push(scoreQuantile(test, best).meanDays)
  }
  const sorted = [...bias].sort((a, b) => a - b)
  return {
    splits,
    chosen: [...chosen].sort((a, b) => a[0] - b[0]).map(([quantile, n]) => ({ quantile, share: n / splits })),
    heldOutBias: { median: median(bias), low: percentileDisc(sorted, 0.025), high: percentileDisc(sorted, 0.975) },
  }
}

/** The shape of one uncited reading: how many learner messages, over how many days. */
export interface EvidenceShape { messages: number; spanDays: number }

export const shapeOf = (c: DatingCase): EvidenceShape => ({
  messages: c.learnerAt.length, spanDays: c.learnerAt.length ? (Math.max(...c.learnerAt) - Math.min(...c.learnerAt)) / DAY_MS : 0,
})

/**
 * Cited cases cut down to the shape of uncited ones. Each draw takes the shape (message count m and
 * span) of a random uncited reading, then a random run of m consecutive learner messages (by time),
 * from any cited case, that contains the cited message and spans the target within
 * max(`toleranceDays`, `toleranceShare` of it). Matching the count alone is not enough: a run of 5
 * consecutive messages from a cited reading spans under a day where an uncited reading of 5 spans
 * four, and a quantile is only as good as the spread it is taken over. Draws with no matching run
 * are skipped, so the result can hold fewer than `draws`.
 */
export function uncitedLike(cases: readonly DatingCase[], shapes: readonly EvidenceShape[], draws: number, seed: number, toleranceDays = 0.5, toleranceShare = 0.25): DatingCase[] {
  const cited = cases.filter((c) => c.citedAt !== null && c.learnerAt.includes(c.citedAt!)).map((c) => ({ sorted: [...c.learnerAt].sort((a, b) => a - b), citedAt: c.citedAt! }))
  const targets = shapes.filter((t) => t.messages > 0)
  if (!cited.length || !targets.length) return []
  // Every window, by its size: [case, start] pairs that contain the cited message, with their span.
  const windows = new Map<number, Array<{ c: number; start: number; span: number }>>()
  const of = (m: number) => {
    let w = windows.get(m)
    if (w) return w
    w = []
    for (const [ci, c] of cited.entries()) {
      const at = c.sorted.indexOf(c.citedAt)
      for (let start = Math.max(0, at - m + 1); start <= Math.min(at, c.sorted.length - m); start++)
        w.push({ c: ci, start, span: (c.sorted[start + m - 1]! - c.sorted[start]!) / DAY_MS })
    }
    windows.set(m, w)
    return w
  }
  const rand = seededRandom(seed)
  const out: DatingCase[] = []
  for (let d = 0; d < draws; d++) {
    const t = targets[Math.floor(rand() * targets.length)]!
    const tol = Math.max(toleranceDays, toleranceShare * t.spanDays)
    const fit = of(t.messages).filter((w) => Math.abs(w.span - t.spanDays) <= tol)
    if (!fit.length) continue
    const w = fit[Math.floor(rand() * fit.length)]!
    const c = cited[w.c]!
    out.push({ learnerAt: c.sorted.slice(w.start, w.start + t.messages), citedAt: c.citedAt })
  }
  return out
}
