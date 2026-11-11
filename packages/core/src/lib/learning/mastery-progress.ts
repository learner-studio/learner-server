import type { QueryFn as MetaPgQueryFn } from '../../db/handle.js'
import { isHeldOut } from './learning-concept-holdout.js'
import { readReviewHistory, reviewQueue } from './learning-spaced-repetition.js'
import { BLIND_GAIN, EVIDENCE_HISTORY, GAIN_MIN_POINTS, gainParams, learnerBlindNoise } from './mastery-notifications.js'
import type { MeasurementNoise } from './mastery-change-statistics.js'

/** The Osmosis Map's progress strip (docs/specs/mastery-notifications.md S5). */
export const PROGRESS_WINDOWS = [{ window: '24h', days: 1 }, { window: '7d', days: 7 }, { window: '30d', days: 30 }] as const

export interface MasteryProgress {
  windows: Array<{ window: (typeof PROGRESS_WINDOWS)[number]['window']; beforePercent: number; nowPercent: number; up: number }>
  due: number
}

/**
 * Curriculum % at a time: the mean over `conceptIds` of each concept's latest counted
 * (medium/high, one per origin) reading by then; a concept with none counts as 0, so the
 * figure only moves when readings do. `up` counts concepts with a gain or a first clear
 * reading in the window: positive only, like the notifications themselves.
 *
 * Time here is EVIDENCE time (migration 0018), not grading time: "by then" means the
 * learner had said it by then, "latest" is the reading resting on the newest evidence, and a
 * gain is a prior-blind measurement over the mean of the blind ones on older evidence (BLIND_GAIN). Gradings dated at the same time are one
 * measurement (their mean, mastery-notifications.ts MEASUREMENTS), and only a measurement citing
 * a learner message counts as up; an uncited one moves the level only. A conversation from six weeks ago that
 * is graded today moves the figure six weeks ago, not today. So `nowPercent` can differ
 * from the mean of the map's scores, which show the most recently GRADED reading.
 */
/** `scores`: the learner's mastery scores as the live turn reads them (`assessmentScores` over `lookupAssessments`). */
export async function masteryProgress(query: MetaPgQueryFn, userId: string, conceptIds: readonly string[], scores: ReadonlyMap<string, number>, now = new Date(), noise?: MeasurementNoise): Promise<MasteryProgress> {
  const ids = [...new Set(conceptIds)]
  if (!ids.length) return { windows: PROGRESS_WINDOWS.map(({ window }) => ({ window, beforePercent: 0, nowPercent: 0, up: 0 })), due: 0 }
  const rows = (await query<{ at: Date; total: string; up: string }>(
    `WITH history AS (${EVIDENCE_HISTORY}),
     scoped AS (SELECT * FROM history WHERE concept_id = ANY($2::text[])),
     times AS (SELECT $3::timestamptz AS at, NULL::timestamptz AS since UNION ALL
               SELECT $3::timestamptz - make_interval(days => d), $3::timestamptz - make_interval(days => d) FROM unnest($4::int[]) d)
     SELECT t.at,
       (SELECT COALESCE(sum(l.pct), 0) FROM (
          SELECT DISTINCT ON (concept_id) understanding_percent AS pct FROM scoped
          WHERE evidence_at <= t.at AND understanding_percent IS NOT NULL ORDER BY concept_id, evidence_at DESC) l) AS total,
       (SELECT count(DISTINCT concept_id) FROM scoped
          WHERE t.since IS NOT NULL AND evidence_at > t.since AND evidence_at <= $3::timestamptz AND cited
            AND ((clear AND NOT had_clear) OR ${BLIND_GAIN({ e2: '$5', g2: '$6', credit: '$7' }, GAIN_MIN_POINTS, 'scoped', 'scoped.blind_runs')})) AS up
     FROM times t`,
    [userId, ids, now.toISOString(), PROGRESS_WINDOWS.map((w) => w.days), ...gainParams(noise ?? (await learnerBlindNoise(query, userId)).noise)])).rows
  const mean = (row: { total: string } | undefined) => row ? Math.round(Number(row.total) / ids.length * 10) / 10 : 0
  const nowRow = rows.find((r) => r.at.getTime() === now.getTime())
  const windows = PROGRESS_WINDOWS.map(({ window, days }) => {
    const row = rows.find((r) => r.at.getTime() === now.getTime() - days * 86_400_000)
    return { window, beforePercent: mean(row), nowPercent: mean(nowRow), up: Number(row?.up ?? 0) }
  })
  return { windows, due: await dueForReview(query, userId, ids, now, scores) }
}

/** The spaced-review queue (same rule and scores as the live turn) restricted to the curriculum, held-out concepts excluded. */
async function dueForReview(query: MetaPgQueryFn, userId: string, ids: string[], now: Date, scores: ReadonlyMap<string, number>): Promise<number> {
  const history = await readReviewHistory(query, userId, now)
  // A due count, not the next review: whether it was already offered today does not matter.
  const queue = reviewQueue({ now, history: { exposures: history.exposures, offered: new Set() }, scores: new Map(scores), edges: [], catalogIds: ids, turnConceptIds: [], excluded: new Set(ids.filter(isHeldOut)) })
  return queue.length
}
