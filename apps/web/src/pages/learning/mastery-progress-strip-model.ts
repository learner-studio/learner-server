import type { RpcOutput } from '@learner/contract'

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
 * What the strip's before → now figures are (review round 3, B2; strip review N1): the LIVE grader's scores,
 * the same ones the map shows. Each grading starts from the previous score and the grader alone raises it,
 * so a rise here is not evidence of learning. The view follows it with a link to the Progress page.
 */
export function stripScoresLabel(progress: Pick<Progress, 'scores' | 'liveRisePerGrading'>): string {
  const rise = progress.liveRisePerGrading === null ? '' : `, and ${graderAloneRaises(progress.liveRisePerGrading)}`
  return `Before → now are the live grader’s scores: ${LIVE_SCORES}${rise}, ${NOT_EVIDENCE}.`
}

/** The link after the label (strip review N1): the prior-blind statistics, named by the grader they come from. */
export const PROGRESS_LINK_TEXT = 'Measured change (prior-blind grader) →'

/**
 * The only ▲ (strip review S2): prior-blind rises beyond grader noise OUT OF the concepts compared, so
 * "3 of 60" can be read against the ~5 % a null learner produces. The glyph is rendered aria-hidden (N3).
 */
export const gainText = (up: number, compared: number) => `${count(up)} of ${count(compared)} rose beyond grader noise (prior-blind)`

/** First clear readings: an event of the live grader, shown as plain text, without ▲ and never as a gain. */
export const firstClearText = (n: number) => `${count(n)} first clear ${n === 1 ? 'reading' : 'readings'} (live grader)`

export const NO_VERDICT = 'prior-blind: no verdict yet'
export const DRIFT_UNMEASURED = 'grader drift not measured'

/** Whether a window shows the ▲: a prior-blind rise beyond noise, and the gain rule not withheld for drift (strip review B1). */
export const showsGain = (w: Pick<Window, 'up'>, withheld: boolean) => w.up > 0 && !withheld

/** The Progress page's phrase for a rise beyond noise that the drift rule withholds (`changeLine`). */
export const NOT_BEYOND_DRIFT = 'not beyond the grader’s possible drift'

/**
 * The prior-blind line of a window (strip review B1, S1). `gainsWithheld` (drift not measured): "no verdict
 * yet (grader drift not measured)", with "N of M rose beyond grader noise" when it holds some back. Drift measured: rises
 * beyond noise that do not clear it (`withheldForDrift`, the server's `blindGain`) get "no verdict yet: N of M
 * rose beyond grader noise, not beyond the grader's possible drift", beside a ▲ or instead of one; then nothing measured twice is
 * "no verdict yet", and otherwise "no rise beyond grader noise" (`up` counts rises only, so a window where
 * concepts FELL is not "no change"). Null beside a ▲ with nothing withheld (the ▲ carries its denominator).
 */
export function priorBlindText(w: Pick<Window, 'up' | 'compared' | 'withheldForDrift'>, gainsWithheld: boolean): string | null {
  // Strip re-review B-R2a: "N of M rose beyond grader noise", with the same denominator as the ▲.
  const rose = (n: number) => `: ${count(n)} of ${count(w.compared)} rose beyond grader noise`
  if (gainsWithheld) return w.withheldForDrift > 0 ? `${NO_VERDICT}${rose(w.withheldForDrift)} (${DRIFT_UNMEASURED})` : `${NO_VERDICT} (${DRIFT_UNMEASURED})`
  if (w.withheldForDrift > 0) return `${NO_VERDICT}${rose(w.withheldForDrift)}, ${NOT_BEYOND_DRIFT}`
  if (showsGain(w, gainsWithheld)) return null
  if (w.compared === 0) return `${NO_VERDICT} (no concept ${MEASURED_TWICE})`
  return `prior-blind: no rise beyond grader noise (${plural(w.compared, 'concept')} ${MEASURED_TWICE})`
}

/**
 * Strip review N1: when every window says the same thing (today: "no verdict yet" three times), the strip
 * says it once. Returns that shared line, or null when the windows differ or any shows a ▲.
 */
export function sharedPriorBlindText(windows: ReadonlyArray<Pick<Window, 'up' | 'compared' | 'withheldForDrift'>>, withheld: boolean): string | null {
  const lines = windows.map((w) => priorBlindText(w, withheld))
  return lines.length > 0 && !windows.some((w) => showsGain(w, withheld)) && lines.every((l) => l !== null && l === lines[0]) ? lines[0]! : null
}
