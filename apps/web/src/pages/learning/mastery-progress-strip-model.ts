import type { RpcOutput } from '@learner/contract'
import { VERDICT_NONE, VERDICT_ROSE } from '../progress/progress-statistics-model'

type Progress = RpcOutput<'getMasteryProgress'>
type Window = Progress['windows'][number]

const count = (n: number) => n.toLocaleString('en-US')
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}`
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

/**
 * The Progress page's own phrases (progress-statistics-model.ts, `anchoredLine` and `changeLine`), so the
 * strip and the page describe the two graders in the same words (review round 3, B2). The strip's model
 * test checks each one against the page's actual output.
 */
export const LIVE_SCORES = 'each grading starts from the previous score'
export const NOT_EVIDENCE = 'so they are not evidence of learning'
export const MEASURED_TWICE = 'measured twice without the previous score'
export const graderAloneRaises = (meanMove: number) => `the grader alone raises a score about ${signed(meanMove)} points per grading`

/**
 * What the strip's before → now figures are (review round 3, B2): the LIVE grader's scores, the same ones
 * the map shows. Each grading starts from the previous score and the grader alone raises it, so a rise
 * here is not evidence of learning. The prior-blind statistics are on the Progress page.
 */
export function stripScoresLabel(progress: Pick<Progress, 'scores' | 'liveRisePerGrading'>): string {
  const rise = progress.liveRisePerGrading === null ? '' : `; ${graderAloneRaises(progress.liveRisePerGrading)}`
  return `Before → now: your scores from the live grader (${LIVE_SCORES}${rise}), ${NOT_EVIDENCE}. Prior-blind statistics are on the Progress page.`
}

/**
 * The only ▲: concepts whose prior-blind readings rose beyond grader noise. Its tooltip is the Progress
 * page's verdict, caveat included. Review round 3, S3: a per-concept gain tests grader noise only, not
 * the grader's drift over time (that rule covers the Progress page's change and velocity lines), so the
 * badge says so.
 */
export const gainBadge = (n: number) => `▲ ${count(n)} rose beyond grader noise (prior-blind; grader drift not tested)`
export const GAIN_TITLE = `Prior-blind grader: ${VERDICT_ROSE}`

/** First clear readings: an event of the live grader, shown without ▲ and never as a gain. */
export const firstClearText = (n: number) => `${count(n)} first clear ${n === 1 ? 'reading' : 'readings'} (live grader)`

/**
 * The prior-blind line of a window with no ▲: "no verdict yet" when no concept was measured twice without
 * the previous score in it (e.g. one grading per reading), otherwise the page's "not distinguishable from
 * no change" for the concepts that were. Null when the window has a ▲ (the badge says it).
 */
export function priorBlindText(w: Pick<Window, 'up' | 'compared'>): string | null {
  if (w.up > 0) return null
  if (w.compared === 0) return `prior-blind: no verdict yet (no concept ${MEASURED_TWICE})`
  return `prior-blind: ${VERDICT_NONE} (${plural(w.compared, 'concept')} ${MEASURED_TWICE})`
}
