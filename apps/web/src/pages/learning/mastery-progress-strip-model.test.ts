import { describe, expect, test } from 'bun:test'
import { firstClearText, gainBadge, stripScoresLabel } from './mastery-progress-strip-model'

describe('Osmosis Map progress strip (review round 3, B2)', () => {
  test('names the grader its before → now figures come from, and that they rise on their own', () => {
    const label = stripScoresLabel({ scores: 'live', liveRisePerGrading: 2.146 })
    expect(label).toContain('Live scores (live grader')
    expect(label).toContain('rises about +2.1 points per grading on its own')
    expect(label).toContain('not evidence of learning')
    expect(stripScoresLabel({ scores: 'live', liveRisePerGrading: null })).toContain('can rise on its own')
  })

  test('the ▲ is a prior-blind gain beyond noise; a first clear reading is named as the live grader\'s and carries no ▲', () => {
    expect(gainBadge(3)).toBe('▲ 3 beyond grader noise (prior-blind)')
    expect(firstClearText(1)).toBe('1 first clear reading (live grader)')
    expect(firstClearText(2)).toBe('2 first clear readings (live grader)')
    expect(firstClearText(2)).not.toContain('▲')
  })
})
