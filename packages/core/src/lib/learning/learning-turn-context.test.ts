import { describe, expect, test } from 'bun:test'

import { LearningExtractionSchema } from './learning-extraction-benchmark.js'
import { buildShadowPacket } from './learning-turn-context.js'

describe('Learning turn context shadow policy', () => {
  test('never activates injection while reporting a grounded misconception recommendation', () => {
    const extraction = LearningExtractionSchema.parse({
      contextCompleteness: { assistantTurns: 'complete', toolOutput: 'unavailable', taskOutcome: 'unavailable', receiptContext: 'unavailable' },
      ontologyRetrieval: { strategy: 'bounded-lexical-v1', candidateConceptIds: ['systems-distributed--durable-queues'], totalOntologyConcepts: 470 },
      episode: { boundary: 'continue', objective: 'Reason about queues', activity: 'learning', confidence: 0.9, reason: 'same objective' },
      spans: [{ conceptId: 'systems-distributed--durable-queues', quote: 'queue', source: 'current_learner', directness: 'explicit', relationship: 'misconception', confidence: 0.9 }],
      evidence: [{
        disposition: 'accepted', conceptId: 'systems-distributed--durable-queues', quote: 'queue', evidenceKind: 'misconception', assessment: 'contradicts', assistanceLevel: 'independent', confidence: 0.9,
        acceptance: { decision: 'accept', confidence: 0.9, reason: 'explicit claim' },
        mastery: { estimate: 'uncertain', score: 0.2, confidence: 0.9, reason: 'misconception' },
      }],
      overallConfidence: 0.9, notes: '',
    })
    const packet = buildShadowPacket(extraction)
    expect(packet.action).toBe('none')
    expect(packet.wouldInject).toBe('misconception_correction')
    expect(packet.activationGate.eligible).toBe(false)
  })
})
