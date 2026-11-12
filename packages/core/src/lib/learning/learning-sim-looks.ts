/**
 * Revision 8.1 (review 7 B2): the sequential batch's looks are durable. Each efficacy look is written once, when it is
 * taken (`look-<k>.json` in the run's directory, created exclusively like config.json), and never re-taken or
 * revised: a later start adopts the recorded decisions and resumes at the first block without one. A look reads only
 * the learners of the blocks it covers, and the learners of a block already looked at are never started again.
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { LookDecision } from './learning-sim-sequential.js'

export type RecordedLook = { look: number; plannedPairs: number; decision: LookDecision; failedChecks: string[]; learners: string[]; at: string }

/** Writes look k unless it exists; returns what is recorded (the existing look wins, so a look is never revised). */
export async function recordLook(dir: string, look: Omit<RecordedLook, 'at'>): Promise<RecordedLook> {
  const path = `${dir}/look-${look.look}.json`
  try {
    const entry = { ...look, at: new Date().toISOString() }
    await writeFile(path, JSON.stringify(entry, null, 2), { flag: 'wx' })
    return entry
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error
    return JSON.parse(await readFile(path, 'utf8')) as RecordedLook
  }
}

/** The recorded looks of a run, in order (look 1, 2, ... until the first missing). */
export async function readLooks(dir: string): Promise<RecordedLook[]> {
  const out: RecordedLook[] = []
  for (let k = 1; ; k++) {
    const text = await readFile(`${dir}/look-${k}.json`, 'utf8').catch(() => null)
    if (text === null) return out
    out.push(JSON.parse(text) as RecordedLook)
  }
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
