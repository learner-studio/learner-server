import { createHash } from 'node:crypto'

/**
 * `osmosis-concept-holdout` (docs/specs/mastery-notifications.md S6): one concept in five,
 * chosen by hash, is never a teaching target: not the turn's task anchor, not a prerequisite
 * foundation, not a spaced review. Its mastery is still graded, so GrowthBook can compare how
 * held-out and taught concepts move. Assignment is a pure function of the concept id, so it
 * survives restarts and needs no table; the SQL twin below is what GrowthBook's assignment
 * query uses, and a test keeps the two equal.
 */
export const HOLDOUT_EXPERIMENT_KEY = 'osmosis-concept-holdout'
export const HOLDOUT_BUCKETS = 5
/** When the holdout started filtering live turns; earlier teaching is not part of the experiment. */
export const HOLDOUT_STARTED_AT = '2026-10-30T18:05:00.000Z'

/** The first 7 hex digits (28 bits, always a non-negative int in SQL) of md5("<key>:<conceptId>"). */
export function holdoutBucket(conceptId: string): number {
  return parseInt(createHash('md5').update(`${HOLDOUT_EXPERIMENT_KEY}:${conceptId}`).digest('hex').slice(0, 7), 16) % HOLDOUT_BUCKETS
}
export const isHeldOut = (conceptId: string): boolean => holdoutBucket(conceptId) === 0

/** The same assignment in SQL, for a column holding the concept id. */
export const holdoutBucketSql = (column: string) =>
  `(('x' || substr(md5('${HOLDOUT_EXPERIMENT_KEY}:' || ${column}), 1, 7))::bit(28)::int % ${HOLDOUT_BUCKETS})`

export function heldOutConcepts(catalog: ReadonlyArray<{ id: string }>): Set<string> {
  return new Set(catalog.map((c) => c.id).filter(isHeldOut))
}
