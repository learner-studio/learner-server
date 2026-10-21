import { describe, expect, test } from 'bun:test'
import { threeStepAssessmentPrompt, threeStepNodeState, validateThreeStepAssessment } from './learning-three-step-proof.js'

const conceptId = 'architecture-event-systems--idempotency'
const state = threeStepNodeState(conceptId)
const context = { nodeStates: [state], evidenceByConcept: { [conceptId]: [
  { sourceId: 'human-1', relationship: 'learner_evidence' }, { sourceId: 'human-2', relationship: 'misconception' },
] } }

describe('three-step node assessment', () => {
  test('accepts a source-grounded review-only improvement proposal', () => {
    expect(validateThreeStepAssessment({ proposals: [{ conceptId, nodeVersion: state.nodeVersion, decision: 'improvement', proposedScore: 0.2,
      needsReview: false, reason: 'One source demonstrates the concept.', supportingSourceIds: ['human-1'], counterevidenceSourceIds: [], limitations: [] }] }, context)).toHaveLength(1)
  })
  test('rejects assistant/foreign evidence, stale versions, duplicate evidence, and unreviewed counterevidence', () => {
    const base = { conceptId, nodeVersion: state.nodeVersion, decision: 'improvement', proposedScore: 0.2, needsReview: false,
      reason: 'Unsupported.', supportingSourceIds: ['assistant-1'], counterevidenceSourceIds: [], limitations: [] }
    expect(() => validateThreeStepAssessment({ proposals: [base] }, context)).toThrow(/foreign source/)
    expect(() => validateThreeStepAssessment({ proposals: [{ ...base, nodeVersion: '0'.repeat(64), supportingSourceIds: ['human-1'] }] }, context)).toThrow(/Stale/)
    expect(() => validateThreeStepAssessment({ proposals: [{ ...base, supportingSourceIds: ['human-1', 'human-1'] }] }, context)).toThrow(/Duplicate/)
    expect(() => validateThreeStepAssessment({ proposals: [{ ...base, supportingSourceIds: ['human-1'], counterevidenceSourceIds: ['human-2'] }] }, context)).toThrow(/requires review/)
    expect(() => validateThreeStepAssessment({ proposals: [{ ...base, supportingSourceIds: ['human-1', 'human-2'] }] }, context)).toThrow(/all be learner evidence/)
    expect(() => validateThreeStepAssessment({ proposals: [{ ...base, supportingSourceIds: ['human-1'], counterevidenceSourceIds: ['human-1'], needsReview: true }] }, context)).toThrow(/disjoint/)
  })
  test('unchanged remains scoreless and accepts abstention', () => {
    expect(validateThreeStepAssessment({ proposals: [{ conceptId, nodeVersion: state.nodeVersion, decision: 'unchanged', proposedScore: null,
      needsReview: true, reason: 'Insufficient evidence.', supportingSourceIds: [], counterevidenceSourceIds: [], limitations: ['weak evidence'] }] }, context)[0]?.proposedScore).toBeNull()
  })
  test('assessment prompt includes native observation text, frozen sources, and pasted-report caution', () => {
    const prompt = threeStepAssessmentPrompt({ consolidation: { nativeObservations: [{ text: 'native observation alpha' }] }, nodeStates: [state],
      evidence: [{ current: { id: 'human-1', text: 'operator evidence' }, response: { id: 'assistant-1', text: 'assistant context' } }] })
    expect(prompt).toContain('native observation alpha')
    expect(prompt).toContain('operator evidence')
    expect(prompt).toContain('assistant context')
    expect(prompt).toContain('copied from a prior assistant report')
  })
})
