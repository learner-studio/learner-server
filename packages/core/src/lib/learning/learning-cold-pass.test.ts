import { describe, expect, test } from 'bun:test'
import { coldChainPrior, coldPassResult } from './learning-incremental-assessment.js'
import { coldVectorParts, type VectorMessage, type VectorTurn } from './learning-vector-turns.js'
import { LIVE_COLD_SLICES, VectorTurnConfig, assessmentPriorMode } from './learning-vector-turn-schemas.js'

const message = (id: string, at: string, size = 10): VectorMessage => ({ id, conversationId: 'c', role: 'user', text: 'x'.repeat(size), occurredAt: at, sourceVersion: '1' } as VectorMessage)
// Two conversations interleaved in time: selection order groups by conversation, a cold pass replays by time.
const turns: VectorTurn[] = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, conversationId: i % 2 ? 'b' : 'a', at: `2026-10-${String(i + 1).padStart(2, '0')}T00:00:00Z`, messageIds: [`m${i}`], linkage: 'explicit' }))
const messages = new Map(turns.map(t => [t.messageIds[0]!, message(t.messageIds[0]!, t.at)]))
const assessment = (percent: number) => ({ understandingPercent: percent })
const receipt = (status: string, percent: number | null = null) => ({ status, assessment: percent === null ? null : assessment(percent) })

describe('cold live pass (the v2-cold arm)', () => {
  test('every matching turn, in time order, as four slices of near-equal turn count', () => {
    const shuffled = [...turns].sort((a, b) => a.conversationId.localeCompare(b.conversationId))
    const { parts } = coldVectorParts(shuffled, messages, 400_000, LIVE_COLD_SLICES)
    expect(parts).toEqual([['m0', 'm1', 'm2'], ['m3', 'm4', 'm5'], ['m6', 'm7'], ['m8', 'm9']])
    expect(coldVectorParts(turns.slice(0, 2), messages, 400_000, LIVE_COLD_SLICES).parts).toEqual([['m0'], ['m1']])
    expect(coldVectorParts([], messages, 400_000, LIVE_COLD_SLICES).parts).toEqual([])
  })
  test('a slice over the input budget is packed into several parts without reordering or truncation', () => {
    const big = new Map(turns.map(t => [t.messageIds[0]!, message(t.messageIds[0]!, t.at, 6_000)]))
    const { parts } = coldVectorParts(turns, big, 30_000, LIVE_COLD_SLICES)
    expect(parts.flat()).toEqual(turns.flatMap(t => t.messageIds))
    expect(parts.length).toBeGreaterThan(LIVE_COLD_SLICES)
  })
  test('increment 0 has no prior; later ones take the RAW last completed estimate and skip failed increments', () => {
    expect(coldChainPrior([], 0)).toBeNull()
    expect(coldChainPrior([{ part: 0, receipt: receipt('completed', 30) }, { part: 1, receipt: receipt('failed') }], 2)).toEqual(assessment(30))
    expect(coldChainPrior([{ part: 0, receipt: receipt('completed', 30) }, { part: 1, receipt: receipt('no_evidence') }, { part: 2, receipt: receipt('completed', 45) }], 3)).toEqual(assessment(45))
    expect(coldChainPrior([{ part: 0, receipt: receipt('failed') }], 1)).toBeNull()
    expect(() => coldChainPrior([{ part: 0, receipt: null }], 1)).toThrow(/receipt/)
    expect(() => coldChainPrior([{ part: 1, receipt: receipt('completed', 30) }], 2)).toThrow(/receipt/)
  })
  test('the pass publishes the last completed increment; it fails only when none completed', () => {
    const run = (status: string, percent: number | null = null, i = 0) => ({ part: i, runId: `r${i}`, receipt: receipt(status, percent) })
    expect(coldPassResult([run('completed', 30, 0), run('failed', null, 1)], 2)).toEqual({ status: 'completed', runId: 'r0', assessment: assessment(30) })
    expect(coldPassResult([run('completed', 30, 0), run('completed', 50, 1)], 2)).toEqual({ status: 'completed', runId: 'r1', assessment: assessment(50) })
    expect(coldPassResult([run('no_evidence', null, 0)], 1)).toEqual({ status: 'completed', runId: 'r0', assessment: null })
    expect(coldPassResult([run('failed', null, 0), run('failed', null, 1)], 2).status).toBe('failed')
    expect(coldPassResult([run('completed', 30, 0)], 2).status).toBe('pending')
    // No matching turns: nothing to grade, nothing to publish, and the generation still settles.
    expect(coldPassResult([], 0)).toEqual({ status: 'completed', runId: null, assessment: null })
  })
  test('prior mode is recorded per run; legacy configs without it keep their warm behaviour', () => {
    expect(VectorTurnConfig.parse({ purpose: 'live', incremental: true }).priorMode).toBeUndefined()
    expect(VectorTurnConfig.parse({ purpose: 'live', incremental: true, priorMode: 'cold' }).priorMode).toBe('cold')
    expect(VectorTurnConfig.safeParse({ priorMode: 'tepid' }).success).toBe(false)
    // LEARNING_ASSESSMENT_PRIOR_MODE: cold unless warm is chosen deliberately; anything else refuses to run.
    expect(assessmentPriorMode(undefined)).toBe('cold')
    expect(assessmentPriorMode('')).toBe('cold')
    expect(assessmentPriorMode('warm')).toBe('warm')
    expect(() => assessmentPriorMode('Warm')).toThrow(/LEARNING_ASSESSMENT_PRIOR_MODE/)
  })
})
