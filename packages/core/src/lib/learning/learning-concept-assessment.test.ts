import { describe, expect, test } from 'bun:test'
import { assessmentAutomationEnabled, assessmentTriggerDue, buildConceptAssessmentInput, sameAssessmentConcept, type LearningConceptAssessment } from './learning-concept-assessment.js'
import { LocalVariablesService } from '../../runtime/types.js'
import { validateGradualAssessment } from './learning-gradual-assessment.js'
import { resolveRetrievalLookup } from './learning-playground-retrieval.js'
import { LearningPlaygroundInput, LearningPlaygroundLookupOutput } from './learning-playground.js'
import {providedAssessmentHash} from './learning-concept-assessment.js'

const concept = { conceptId: 'hashing', title: 'Hashing', description: 'Hash tables and collisions', objectives: ['Explain collisions'] }
const evidence = [{ id: 'human-1', conversationId: 'chat', role: 'user', text: 'Two different keys can share a bucket.', occurredAt: '2026-09-06T00:00:00Z' },
  { id: 'agent-1', conversationId: 'chat', role: 'assistant', text: 'This is called a collision.', occurredAt: '2026-09-06T00:00:01Z' }]
const built = buildConceptAssessmentInput(concept, evidence, null)
const proposal = { conceptId: 'hashing', nodeVersion: built.nodeVersion, understandingPercent: 30, confidence: 'low' as const,
  demonstrated: [{ sourceId: 'human-1', quote: evidence[0]!.text, description: 'Recognizes shared buckets.' }],
  gaps: [{ kind: 'untested' as const, description: 'Collision resolution is untested.', sourceId: null, quote: null }], nextCheck: 'How would you handle this collision?', needsReview: true as const }
const cache: LearningConceptAssessment = { conceptId: 'hashing', assessment: proposal, runId: 'run', assessedAt: '2026-09-06T00:00:02Z', status: 'ready' }

describe('retrieval-driven review-only assessment', () => {
  test('live same-evidence refresh skips duplicate spend but experiments remain independent',()=>{
    expect(providedAssessmentHash('same-evidence',null,'run-a',true)).toBe(providedAssessmentHash('same-evidence',{updatedPrior:true},'run-b',true))
    expect(providedAssessmentHash('new-evidence',null,'run-a',true)).not.toBe(providedAssessmentHash('same-evidence',null,'run-b',true))
    expect(providedAssessmentHash('same-evidence',null,'run-a')).not.toBe(providedAssessmentHash('same-evidence',null,'run-b'))
  })
  test('JSONB key order does not invalidate semantic concept identity; content changes do', () => {
    expect(sameAssessmentConcept(concept,{objectives:concept.objectives,description:concept.description,title:concept.title,conceptId:concept.conceptId})).toBe(true)
    for(const changed of [{...concept,title:'Changed'},{...concept,description:'Changed'},{...concept,objectives:['Changed']},{...concept,conceptId:'other'}]) expect(sameAssessmentConcept(concept,changed)).toBe(false)
  })
  test('automation accepts actual JSON-decoded LocalVariablesService booleans and fails closed otherwise', async () => {
    const key = 'LEARNING_ASSESSMENT_TEST_OPT_IN'
    const previous = process.env[key]
    try {
      process.env[key] = 'true'
      const actual: unknown = await new LocalVariablesService().get(key)
      expect(actual).toBe(true)
      expect(assessmentAutomationEnabled(actual)).toBe(true)
      expect(assessmentAutomationEnabled('true')).toBe(true)
      for (const value of [false, 'false', undefined, null, 1, '1', 'yes', 'TRUE', {}]) expect(assessmentAutomationEnabled(value)).toBe(false)
    } finally { if (previous === undefined) delete process.env[key]; else process.env[key] = previous }
  })
  test('original assistant context is retained but never accepted as a human quote', () => {
    expect(built.prompt).toContain(evidence[1]!.text)
    expect(built.context.nodeStates[0]!.understandingPercent).toBeNull()
    expect(validateGradualAssessment({ proposals: [proposal] }, built.context)).toHaveLength(1)
    expect(() => validateGradualAssessment({ proposals: [{ ...proposal, demonstrated: [{ ...proposal.demonstrated[0], sourceId: 'agent-1', quote: evidence[1]!.text }] }] }, built.context)).toThrow('Unknown human source')
    expect(() => validateGradualAssessment({ proposals: [{ ...proposal, demonstrated: [{ ...proposal.demonstrated[0], quote: 'a fabricated quote' }] }] }, built.context)).toThrow('Non-exact')
  })
  test('concept/objectives and evidence changes invalidate frozen versions, cache scores do not create fresh evidence', () => {
    expect(buildConceptAssessmentInput({ ...concept, objectives: ['Apply collision resolution'] }, evidence, null).nodeVersion).not.toBe(built.nodeVersion)
    expect(buildConceptAssessmentInput(concept, [{ ...evidence[0]!, text: 'Changed source' }], null).inputHash).not.toBe(built.inputHash)
    expect(buildConceptAssessmentInput(concept, evidence, proposal).inputHash).toBe(built.inputHash)
    expect(buildConceptAssessmentInput(concept, evidence, proposal).prompt).toBe(built.prompt)
  })
  test('empty and unchanged input never becomes a count or age trigger', () => {
    const old = '2026-01-01T00:00:00Z'
    expect(assessmentTriggerDue({ newIndexedMessages: 0, oldestPendingAt: old })).toBe(false)
    expect(assessmentTriggerDue({ newIndexedMessages: 20, oldestPendingAt: new Date().toISOString() })).toBe(true)
    expect(assessmentTriggerDue({ newIndexedMessages: 1, oldestPendingAt: old })).toBe(true)
    expect(assessmentTriggerDue({ newIndexedMessages: 1, oldestPendingAt: new Date().toISOString() })).toBe(false)
  })
  test('cached evidence enters the response only through current retrieval overlap; no classifier call', () => {
    const result = LearningPlaygroundLookupOutput.parse(resolveRetrievalLookup({ fixtureId: 'live' }, [{ messageId: 'human-1' }], [cache]))
    expect(result.decision).toBe('influence')
    expect(result.context).toContain('needsReview')
    expect(result.invocationCount).toBe(0)
    expect(result.classification.status).toBe('not_requested')
    expect(resolveRetrievalLookup({ fixtureId: 'live' }, [{ messageId: 'unrelated' }], [cache]).decision).toBe('no_context')
    expect(resolveRetrievalLookup({ fixtureId: 'live' }, [{ messageId: 'human-1' }], [{ ...cache, status: 'stale' }]).context).toBe('')
    expect(resolveRetrievalLookup({ fixtureId: 'live' }, [], [], 'offline').decision).toBe('fail_open')
  })
  test('retrieval mode supports every existing response provider', () => {
    for (const provider of ['codex','claude','agy']) expect(LearningPlaygroundInput.safeParse({ provider, contextMode: 'retrieval', fixtureId: 'live', mode: 'live', scenario: 'influence', message: 'Explain hash tables', requestId: '3d799a31-51e2-43f7-a803-766d860a4512' }).success).toBe(true)
  })
  test('unknown estimates route through immutable input sources without inventing demonstration or gap citations', () => {
    const unknown = { ...cache, sourceIds: ['human-1'], assessment: { ...proposal, understandingPercent: null, confidence: 'insufficient' as const, demonstrated: [] } }
    const result = resolveRetrievalLookup({ fixtureId: 'live' }, [{ messageId: 'human-1' }], [unknown])
    expect(result.decision).toBe('influence')
    expect(result.context).toContain('"understandingPercent":null')
    expect(result.context).toContain('"demonstrated":[]')
    expect(result.context).toContain(proposal.nextCheck)
    expect(result.invocationCount).toBe(0)
    expect(resolveRetrievalLookup({ fixtureId: 'live' }, [{ messageId: 'unrelated' }], [unknown]).decision).toBe('no_context')
    expect(resolveRetrievalLookup({ fixtureId: 'live' }, [{ messageId: 'human-1' }], [{ ...unknown, sourceIds: [] }]).decision).toBe('no_context')
  })
})
