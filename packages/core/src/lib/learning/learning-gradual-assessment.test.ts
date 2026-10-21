import { describe, expect, test } from 'bun:test'
import { gradualAssessmentPrompt, gradualAssessmentSchema, validateGradualAssessment } from './learning-gradual-assessment.js'

const conceptId = 'control-group'
const nodeVersion = 'a'.repeat(64)
const context = {
  nodeStates: [{ conceptId, nodeVersion, understandingPercent: null }],
  humanTextBySourceId: { h1: 'The page components differ, so this is not a fair comparison.', h2: 'I think different components cannot affect the comparison.' },
}
const unknown = () => ({ conceptId, nodeVersion, understandingPercent: null, confidence: 'insufficient', demonstrated: [],
  gaps: [{ kind: 'untested', description: 'Independent experiment design is untested.', sourceId: null, quote: null }],
  nextCheck: 'Which components would you keep fixed?', needsReview: true })
const limited = () => ({ ...unknown(), understandingPercent: 30, confidence: 'low', demonstrated: [{ description: 'Identifies unequal components as a confound.', sourceId: 'h1', quote: 'The page components differ, so this is not a fair comparison.' }] })
const validate = (value: unknown) => validateGradualAssessment({ proposals: [value] }, context)

describe('gradual educational assessment v5 prior-blind attribution', () => {
  test('rejects new estimates outside five-point increments', () => {
    expect(() => validate({ ...limited(), understandingPercent: 32 })).toThrow()
  })
  test('supports unknown without mechanically assigning a score', () => {
    expect(validate(unknown())[0]?.understandingPercent).toBeNull()
    expect(validate({ ...unknown(), understandingPercent: 0, confidence: 'low' })[0]?.understandingPercent).toBe(0)
  })
  test('accepts a limited evidence-linked percentage and separates confidence', () => {
    expect(validate(limited())[0]?.understandingPercent).toBe(30)
    expect(validate({ ...limited(), confidence: 'high', understandingPercent: 65 })[0]?.understandingPercent).toBe(65)
  })
  test('rejects unknown sources, stale nodes and non-exact quotes without classifying evidence', () => {
    expect(() => validate({ ...limited(), nodeVersion: 'b'.repeat(64) })).toThrow(/stale/)
    expect(() => validate({ ...limited(), demonstrated: [{ ...limited().demonstrated[0], sourceId: 'assistant-1' }] })).toThrow(/Unknown human source/)
    expect(validate({ ...limited(), demonstrated: [{ ...limited().demonstrated[0], sourceId: 'h2', quote: context.humanTextBySourceId.h2 }] })).toHaveLength(1)
    expect(() => validate({ ...limited(), demonstrated: [{ ...limited().demonstrated[0], quote: 'A paraphrase.' }] })).toThrow(/Non-exact/)
  })
  test('a quote matches across whitespace runs but never across a stitch of non-adjacent text', () => {
    const spaced = { ...context, humanTextBySourceId: { ...context.humanTextBySourceId, h3: 'they go in a vector store.  but there are\n\nlevels. Later I said something else entirely.' } }
    const quoted = (quote: string) => validateGradualAssessment({ proposals: [{ ...limited(), demonstrated: [{ ...limited().demonstrated[0], sourceId: 'h3', quote }] }] }, spaced)
    // The model collapsed a double space and a paragraph break: same words, same order, same span.
    expect(quoted('a vector store. but there are levels.')).toHaveLength(1)
    expect(quoted(' a vector store.\tbut there are  levels. ')).toHaveLength(1)
    // Stitching two non-adjacent sentences is a real misquotation and stays rejected.
    expect(() => quoted('a vector store. Later I said something else entirely.')).toThrow(/Non-exact/)
    expect(() => quoted('a vectorstore.')).toThrow(/Non-exact/)
    expect(() => quoted('   ')).toThrow()
  })
  test('cannot present an untested gap as observed difficulty without evidence', () => {
    expect(() => validate({ ...unknown(), gaps: [{ ...unknown().gaps[0], kind: 'observed_difficulty' }] })).toThrow(/requires a source/)
    expect(() => validate({ ...unknown(), gaps: [{ ...unknown().gaps[0], sourceId: 'h1', quote: 'The page components differ' }] })).toThrow(/Untested/)
    expect(validate({ ...unknown(), understandingPercent: 0, confidence: 'low', gaps: [{ kind: 'observed_difficulty', description: 'A specific misconception.', sourceId: 'h2', quote: context.humanTextBySourceId.h2 }] })[0]?.understandingPercent).toBe(0)
  })
  test('rejects missing/duplicate nodes, out-of-range scores and promotion', () => {
    expect(() => validateGradualAssessment({ proposals: [] }, context)).toThrow(/exactly one/)
    expect(() => validateGradualAssessment({ proposals: [unknown(), unknown()] }, context)).toThrow(/exactly one/)
    expect(() => validate({ ...limited(), understandingPercent: 101 })).toThrow()
    expect(() => validate({ ...limited(), needsReview: false })).toThrow()
  })
  test('same model-independent prompt/schema carries full context and excluded-text caution', () => {
    const input = { nodeStates: context.nodeStates, nativeObservations: ['native summary'], evidence: ['human and assistant pair'] }
    const prompt = gradualAssessmentPrompt(input)
    expect(prompt).toBe(gradualAssessmentPrompt(input))
    expect(prompt).toContain('AND from every descriptive claim')
    expect(prompt).toContain('user may paste agent explanations or outside sources')
    expect(prompt).not.toContain('Above 40 requires')
    expect(prompt).toContain('human and assistant pair')
    expect(JSON.stringify(gradualAssessmentSchema([conceptId]))).toContain('understandingPercent')
    expect(() => gradualAssessmentSchema([conceptId, conceptId])).toThrow(/unique/)
  })
  test('shared prompt strips prior estimates and rationales while preserving concept meaning',()=>{
    const base={conceptId,nodeVersion,title:'Control groups',description:'Hold conditions equal',objectives:['Identify confounds'],breadcrumbs:['Experiments','Controls']}
    const input={nodeStates:[base],nativeObservations:[],evidence:['Exact supplied source']}
    const blinded=gradualAssessmentPrompt({...input,nodeStates:[{...base,understandingPercent:95,assessment:{rationale:'SECRET_PRIOR_RATIONALE',understandingPercent:95},mastery:{score:1}}]})
    expect(blinded).toBe(gradualAssessmentPrompt(input))
    expect(blinded).not.toContain('SECRET_PRIOR_RATIONALE')
    const supplied=JSON.parse(blinded.split('INPUT:\n')[1]!)
    expect(supplied.nodeStates).toEqual([base])
    expect(supplied.evidence).toEqual(input.evidence)
    expect(blinded).toContain('meaningfully applying or adapting earlier guidance')
    expect(blinded).toContain('assistance and outcome are unknown')
    expect(blinded).toContain('Do not infer independence, a successful outcome, or an observed failure')
  })
  test('defines concept scope and attribution without requiring formal explanations or observed execution', () => {
    const prompt = gradualAssessmentPrompt({ nodeStates: context.nodeStates, nativeObservations: [], evidence: [] })
    expect(prompt).toContain('Assess the supplied leaf concept')
    expect(prompt).toContain('Relevance means')
    expect(prompt).toContain('Authorship means')
    expect(prompt).toContain('Independence means')
    expect(prompt).toContain('Depth means')
    expect(prompt).toContain('polished wording alone does not prove copying')
    expect(prompt).toContain('A request containing a substantive constraint, diagnosis or justified decision may demonstrate that reasoning')
    expect(prompt).toContain('identify assistance only when the supplied context supports it')
    expect(prompt).toContain('missing outcome evidence does not invalidate that reasoning')
    expect(prompt).toContain('do not output a separate reasoning trace or additional fields')
    expect(prompt).toContain('Use one assessment call')
  })
})
