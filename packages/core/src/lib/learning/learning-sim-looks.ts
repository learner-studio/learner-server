/**
 * Revision 8.1 (review 7 B2): the sequential batch's looks are durable. Each efficacy look is written once, when it is
 * taken, and never re-taken or revised: a later start adopts the recorded decisions and resumes at the first block
 * without one. A look reads only the learners of the blocks it covers, and the learners of a block already looked at
 * are never started again. Revision 8.5 (review 10 S2): the record is the database (learning_sim_looks, keyed by run
 * and look), not a file under the runner's --out.
 */
import { metaDbQuery as q } from '../db-metadata/_shared.js'
import type { LookDecision } from './learning-sim-sequential.js'

/** `forced`: a stub run's look recorded as "continue" by --stub-continue (the runner's e2e), never a real run's. */
export type RecordedLook = { look: number; plannedPairs: number; decision: LookDecision; failedChecks: string[]; learners: string[]; at: string; forced?: true }

/** Writes look k of the run unless it exists; returns what is recorded (the existing look wins: never revised). */
export async function recordLook(runId: string, look: Omit<RecordedLook, 'at'>): Promise<RecordedLook> {
  await q(`INSERT INTO learning_sim_looks(run_id,look,entry) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`, [runId, look.look, JSON.stringify({ ...look, at: new Date().toISOString() })])
  return (await q<{ entry: RecordedLook }>('SELECT entry FROM learning_sim_looks WHERE run_id=$1 AND look=$2', [runId, look.look])).rows[0]!.entry
}

/** The recorded looks of a run, in order (look 1, 2, ... until the first missing). */
export async function readLooks(runId: string): Promise<RecordedLook[]> {
  const rows = (await q<{ look: number; entry: RecordedLook }>('SELECT look, entry FROM learning_sim_looks WHERE run_id=$1 ORDER BY look', [runId])).rows
  return rows.filter((r, i) => r.look === i + 1).map((r) => r.entry)
}

/** Where a sequential batch stands: stopped (a recorded look stopped it, or every block was looked at), or the block to
 * run next (the one after the recorded looks, all "continue"). */
export function sequencePosition(recorded: RecordedLook[], blocks: number): { stopped: true; by: string } | { stopped: false; block: number } {
  for (const l of recorded) {
    if (l.failedChecks.length) return { stopped: true, by: `a pre-registered check failed at look ${l.look}` }
    if (l.decision !== 'continue') return { stopped: true, by: `look ${l.look}: ${l.decision}` }
  }
  return recorded.length >= blocks ? { stopped: true, by: 'every block was looked at' } : { stopped: false, block: recorded.length }
}

/** The learners a look at block b reads: those of blocks 0..b, never a later block's (which may be mid-run). */
export function lookLearners<T extends { config: { learnerId: string } }>(data: T[], blocks: Array<Array<{ learnerId: string }>>, b: number): T[] {
  const ids = new Set(blocks.slice(0, b + 1).flat().map((c) => c.learnerId))
  return data.filter((d) => ids.has(d.config.learnerId))
}
