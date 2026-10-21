import { describe, expect, test } from 'bun:test'
import {
  applyRelevanceVerdicts,
  buildRelevancePrompt,
  describeRelevanceRefusal,
  RELEVANCE_SCHEMA,
  CurriculumRelevanceVerdicts,
} from './curriculum-relevance.js'
import type { CurriculumCandidate, CurriculumObjectivePlan } from './curriculum-generation-types.js'

const candidate = (sourceId: string, title: string, summary = ''): CurriculumCandidate =>
  ({
    sourceId, title, summary, provider: 'mit-ocw', url: `https://ocw.mit.edu/${sourceId}`,
    licence: 'CC BY-NC-SA 4.0', attribution: 'MIT OpenCourseWare', syllabusUrl: '', matchReason: '',
  }) as CurriculumCandidate

const plan: CurriculumObjectivePlan = {
  domain: 'algorithms', scale: 'course', queries: ['algorithms'], providers: ['mit-ocw'],
  restated: 'Learn how algorithms are designed and analysed.',
}

describe('the prompt asks about the subject, not the words', () => {
  const prompt = buildRelevancePrompt('I want to understand algorithms', plan, [
    candidate('mit-ocw:6-006', 'Introduction to Algorithms', 'Asymptotics, sorting, graphs.'),
    candidate('mit-ocw:2-003', 'Dynamics'),
  ])

  test('every candidate is listed with the sourceId the model must answer with', () => {
    expect(prompt).toContain('mit-ocw:6-006')
    expect(prompt).toContain('mit-ocw:2-003')
  })

  test('a candidate with no published description says so rather than showing a blank', () => {
    // An empty line reads as an omission and invites the model to skip the row;
    // a skipped row is a dropped candidate, which is a worse default than a
    // judged one.
    expect(prompt).toContain('(none published)')
  })

  test('the objective and the restated objective both reach the model', () => {
    expect(prompt).toContain('I want to understand algorithms')
    expect(prompt).toContain('Learn how algorithms are designed and analysed.')
  })

  test('the schema handed to the model is the contract that validates the reply', () => {
    // Derived with z.toJSONSchema from the same Zod object the parse uses, so
    // the shape the model is told to produce cannot drift from the shape we
    // then reject it for not producing. Asserted by round-tripping a reply the
    // schema describes through the parser.
    expect(JSON.stringify(RELEVANCE_SCHEMA)).toContain('teachesObjective')
    const reply = { verdicts: [{ sourceId: 'mit-ocw:6-006', teachesObjective: true, reason: 'yes' }] }
    expect(CurriculumRelevanceVerdicts.parse(reply).verdicts.length).toBe(1)
    expect(() => CurriculumRelevanceVerdicts.parse({ verdicts: [{ sourceId: 'x', teachesObjective: true }] })).toThrow()
  })
})

describe('applying the verdicts', () => {
  const candidates = [
    candidate('mit-ocw:6-006', 'Introduction to Algorithms'),
    candidate('mit-ocw:2-003', 'Dynamics'),
    candidate('mit-ocw:6-438', 'Algorithms for Inference'),
  ]

  test('only the courses judged to teach the subject survive', () => {
    const { kept } = applyRelevanceVerdicts(candidates, [
      { sourceId: 'mit-ocw:6-006', teachesObjective: true, reason: 'It is the introductory algorithms course.' },
      { sourceId: 'mit-ocw:2-003', teachesObjective: false, reason: 'It teaches rigid-body mechanics.' },
      { sourceId: 'mit-ocw:6-438', teachesObjective: false, reason: 'It teaches probabilistic inference.' },
    ])
    expect(kept.map((c) => c.sourceId)).toEqual(['mit-ocw:6-006'])
  })

  test('the rejected courses keep their reasons, in search order', () => {
    const { dropped } = applyRelevanceVerdicts(candidates, [
      { sourceId: 'mit-ocw:6-006', teachesObjective: true, reason: 'yes' },
      { sourceId: 'mit-ocw:2-003', teachesObjective: false, reason: 'It teaches rigid-body mechanics.' },
      { sourceId: 'mit-ocw:6-438', teachesObjective: false, reason: 'It teaches probabilistic inference.' },
    ])
    expect(dropped.map((d) => d.candidate.sourceId)).toEqual(['mit-ocw:2-003', 'mit-ocw:6-438'])
    expect(dropped[0]!.reason).toBe('It teaches rigid-body mechanics.')
  })

  test('a candidate the model never answered for is dropped, not kept', () => {
    // An unasked question is not a cleared one. Keeping it would restore
    // exactly the failure this gate exists to stop: material nobody judged
    // reaching the outline prompt.
    const { kept, dropped } = applyRelevanceVerdicts(candidates, [
      { sourceId: 'mit-ocw:6-006', teachesObjective: true, reason: 'yes' },
    ])
    expect(kept.map((c) => c.sourceId)).toEqual(['mit-ocw:6-006'])
    expect(dropped.map((d) => d.candidate.sourceId)).toEqual(['mit-ocw:2-003', 'mit-ocw:6-438'])
    expect(dropped[0]!.reason).toContain('no verdict')
  })

  test('a verdict for a sourceId that was never a candidate cannot smuggle one in', () => {
    const { kept } = applyRelevanceVerdicts([candidate('mit-ocw:6-006', 'Introduction to Algorithms')], [
      { sourceId: 'mit-ocw:6-006', teachesObjective: true, reason: 'yes' },
      { sourceId: 'mit-ocw:18-01', teachesObjective: true, reason: 'invented' },
    ])
    expect(kept.length).toBe(1)
  })

  test('every candidate rejected leaves nothing kept, which is what the step throws on', () => {
    const { kept } = applyRelevanceVerdicts(candidates, candidates.map((c) => ({
      sourceId: c.sourceId, teachesObjective: false, reason: 'unrelated',
    })))
    expect(kept).toEqual([])
  })
})

describe('the refusal a learner reads', () => {
  test('it names each course and the reason it was refused', () => {
    const message = describeRelevanceRefusal('I want to understand algorithms', [
      { candidate: candidate('mit-ocw:2-003', 'Dynamics'), reason: 'It teaches rigid-body mechanics.' },
    ])
    expect(message).toContain('I want to understand algorithms')
    expect(message).toContain('Dynamics')
    expect(message).toContain('rigid-body mechanics')
  })
})
