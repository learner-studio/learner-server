import type { RpcOutput } from '@learner/contract'

type Progress = RpcOutput<'getMasteryProgress'>

const count = (n: number) => n.toLocaleString('en-US')
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}`

/**
 * What the strip's before → now figures are (review round 3, B2). They are the LIVE grader's scores,
 * the same ones the map shows: each grading starts from the previous score and raises it a little on
 * its own, so a rise here is not evidence of learning. The prior-blind statistics are on the Progress page.
 */
export function stripScoresLabel(progress: Pick<Progress, 'scores' | 'liveRisePerGrading'>): string {
  const rise = progress.liveRisePerGrading === null ? 'and can rise on its own' : `and rises about ${signed(progress.liveRisePerGrading)} points per grading on its own`
  return `Live scores (live grader: each grading starts from the previous score ${rise}), so a rise here is not evidence of learning. Prior-blind statistics: Progress page.`
}

/** The only ▲: prior-blind gains beyond grader noise. */
export const gainBadge = (n: number) => `▲ ${count(n)} beyond grader noise (prior-blind)`

/** First clear readings: an event of the live grader, shown without ▲ and not as a gain. */
export const firstClearText = (n: number) => `${count(n)} first clear ${n === 1 ? 'reading' : 'readings'} (live grader)`
