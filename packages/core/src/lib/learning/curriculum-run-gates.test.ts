import { describe, expect, test } from 'bun:test'
import { canApproveRun, canRebuildRun } from './curriculum-run-gates.js'
import { CURRICULUM_RUN_STATUSES } from './curriculum-generation-types.js'

describe('who may approve an outline', () => {
  test('a run waiting on a person may be approved', () => {
    expect(canApproveRun('awaiting-approval', true).allowed).toBe(true)
  })

  test('a run whose build died may be approved again', () => {
    // Measured 2026-09-09: a build workflow refused its own start payload on a
    // schema mismatch, the run stopped at `inferring`, and the only way back
    // was an UPDATE by hand. The learner's decision was still good; only the
    // machinery failed.
    expect(canApproveRun('failed', true).allowed).toBe(true)
  })

  test('a failed run with no outline is not approvable, and says why', () => {
    // Nothing to retry: this one has to go back to the search.
    const verdict = canApproveRun('failed', false)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('no outline')
  })

  test('a run still working is refused, naming the state it is in', () => {
    expect(canApproveRun('outlining', true)).toEqual({ allowed: false, reason: 'it is outlining, not awaiting approval' })
  })

  test('a completed run is refused, so approving twice cannot rebuild a tree in use', () => {
    expect(canApproveRun('completed', true).allowed).toBe(false)
  })

  test('a rejected run is refused: turning it down is a decision, not a pause', () => {
    expect(canApproveRun('rejected', true).allowed).toBe(false)
  })

  test('every status is decided, so a new one cannot default to approvable', () => {
    // The enum is the contract. A status added without a decision here would
    // otherwise fall through to whichever branch happened to match.
    const allowed = CURRICULUM_RUN_STATUSES.filter((status) => canApproveRun(status, true).allowed)
    expect([...allowed].sort()).toEqual(['awaiting-approval', 'failed'])
  })
})

describe('who may rebuild a tree from an outline already approved', () => {
  test('a completed run may be rebuilt — that is the whole point of the gate', () => {
    // The case approval refuses on purpose. After the concept generator itself
    // changes, the lessons are still right and only what hangs beneath them
    // needs writing again.
    expect(canRebuildRun('completed', true).allowed).toBe(true)
  })

  test('a failed run may be rebuilt too, so a dead build is not a dead end', () => {
    expect(canRebuildRun('failed', true).allowed).toBe(true)
  })

  test('a run awaiting approval is refused, and is pointed at approval instead', () => {
    const verdict = canRebuildRun('awaiting-approval', true)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('approve it instead')
  })

  test('a build in flight is refused, because two builds write the same rows', () => {
    const verdict = canRebuildRun('inferring', true)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('race')
  })

  test('no outline means nothing to rebuild from', () => {
    expect(canRebuildRun('completed', false)).toEqual({ allowed: false, reason: 'it has no outline to build from' })
  })

  test('every status is decided here too', () => {
    const allowed = CURRICULUM_RUN_STATUSES.filter((status) => canRebuildRun(status, true).allowed)
    expect([...allowed].sort()).toEqual(['completed', 'failed'])
  })
})
