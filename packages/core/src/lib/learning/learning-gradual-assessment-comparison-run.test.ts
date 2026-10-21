import { describe, expect, test } from 'bun:test'

import { compareGradualAssessments, sumGradualAssessmentOutputTokens, summarizeGradualAssessment } from './learning-gradual-assessment-comparison-run.js'

const proposal = (conceptId: string, understandingPercent: number | null, confidence: 'insufficient' | 'low' | 'medium' | 'high') => ({
  conceptId,
  understandingPercent,
  confidence,
  demonstrated: understandingPercent === null ? [] : [{}],
  gaps: [{ kind: understandingPercent === null ? 'untested' as const : 'observed_difficulty' as const }],
  needsReview: true,
})

describe('gradual assessment comparison summaries', () => {
  test('sums each actual arm output-token receipt once and keeps unknown nullable', () => {
    expect(sumGradualAssessmentOutputTokens([
      { usage: { outputTokens: 5_512 } },
      { usage: { outputTokens: 31_147 } },
    ])).toBe(36_659)
    expect(sumGradualAssessmentOutputTokens([
      { usage: { outputTokens: 5_512 } },
      { usage: {} },
    ])).toBeNull()
    expect(sumGradualAssessmentOutputTokens([])).toBeNull()
    expect(sumGradualAssessmentOutputTokens([
      { usage: { outputTokens: 5_512 }, outputChars: 999_999 } as never,
      { usage: { outputTokens: 31_147 }, outputChars: 999_999 } as never,
    ])).toBe(36_659)
  })

  test('keeps unknown separate from estimated understanding', () => {
    expect(summarizeGradualAssessment([proposal('a', null, 'insufficient'), proposal('b', 40, 'low')])).toMatchObject({
      proposalCount: 2,
      estimatedConcepts: 1,
      unknownConcepts: 1,
      meanUnderstandingPercent: 40,
      needsReview: 2,
    })
  })

  test('computes paired agreement without treating unknown as zero', () => {
    expect(compareGradualAssessments(
      [proposal('a', null, 'insufficient'), proposal('b', 40, 'low')],
      [proposal('a', null, 'insufficient'), proposal('b', 20, 'low')],
    )).toEqual({
      conceptCount: 2,
      exactUnderstandingAgreement: 1,
      confidenceAgreement: 2,
      jointlyEstimatedConcepts: 1,
      meanAbsoluteUnderstandingDifference: 20,
      lunaEstimatedConcepts: 1,
      agyEstimatedConcepts: 1,
    })
  })

  test('rejects mismatched concept membership', () => {
    expect(() => compareGradualAssessments([proposal('a', null, 'insufficient')], [proposal('b', null, 'insufficient')])).toThrow(/same unique concept IDs/)
  })
})
