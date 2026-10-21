import assert from 'node:assert/strict'
import test from 'node:test'
import { CLASSIFIER_V6_CATALOG, batchClassifierV6Cases, classifierV6Prompt, parseClassifierV6Batch, parseClassifierV6BatchIndependently, classifierV6OutputSchema } from './learning-classifier-v6.js'
import type { BenchmarkCaseSnapshot } from './learning-extraction-benchmark.js'

const snapshot: BenchmarkCaseSnapshot = {
  current: { id: 'u1', threadId: 't1', exchangeId: 'e1', agent: 'Codex', provider: 'openai', role: 'user', authorship: 'human', authorshipEvidence: 'fixture',
    text: 'Explain abstraction.\n  Explain encapsulation.', timestamp: '2026-09-04T00:00:00Z', model: null, cwd: null },
  context: [{ id: 'a1', role: 'assistant', text: 'We can discuss abstraction.', timestamp: '2026-09-03T23:59:59Z' }],
  contextCompleteness: { assistantTurns: 'partial', toolOutput: 'unavailable', taskOutcome: 'unavailable', receiptContext: 'unavailable' },
  ontologyCandidateIds: [],
}
const cases = [{ caseId: 'case1', snapshot }]
const concept = CLASSIFIER_V6_CATALOG.find((item) => item.title === 'Abstraction')!
const valid = () => ({ results: [{ caseId: 'case1', classification: {
  matches: [{ conceptId: concept.ref, quote: 'Explain abstraction.', relationship: 'task_context', evidenceKind: 'insufficient', assessment: 'indeterminate', reason: 'A request to explain abstraction.' }],
  assistance: 'unclear', status: 'provisional',
} }] })

test('v6 native output schema constrains the unchanged response shape, concepts and batch size', () => {
  const schema = JSON.parse(JSON.stringify(classifierV6OutputSchema(cases)))
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['results'])
  const results = schema.properties.results
  assert.equal(results.minItems, 1)
  assert.equal(results.maxItems, 1)
  assert.deepEqual(results.items.properties.caseId.enum, ['case1'])
  const classification = results.items.properties.classification
  assert.equal(classification.additionalProperties, false)
  assert.deepEqual(classification.required, ['matches', 'assistance', 'status'])
  assert.deepEqual(classification.properties.matches.items.properties.conceptId.enum, CLASSIFIER_V6_CATALOG.map(item => item.ref))
  assert.deepEqual(classification.properties.matches.items.required, ['conceptId', 'quote', 'relationship', 'evidenceKind', 'assessment', 'reason'])
  assert.equal(classification.properties.matches.items.additionalProperties, false)
  assert.equal(classification.properties.status.const, 'provisional')
  assert.throws(() => classifierV6OutputSchema([]), /nonempty/)
  assert.throws(() => classifierV6OutputSchema([...cases, ...cases]), /unique/)
})

test('v6 supplies every flat label exactly once and maps short refs to canonical IDs', () => {
  const prompt = classifierV6Prompt(cases)
  assert.equal(CLASSIFIER_V6_CATALOG.length, 470)
  for (const concept of CLASSIFIER_V6_CATALOG) assert.ok(prompt.includes(`${concept.ref} | ${concept.title}`))
  assert.match(prompt, /educational learning system/)
  assert.match(prompt, /2–5/)
  assert.match(prompt, /exactly one concise sentence of at most 35 words/)
  assert.match(prompt, /mention a limitation only when material/)
  assert.match(prompt, /Do not call tools, run commands, inspect files, browse, ask questions, or delegate/)
  assert.equal(parseClassifierV6Batch(JSON.stringify(valid()), cases)[0]?.classification.matches[0]?.conceptId, concept.id)
})

test('v6 rejects unknown keys at every object level, missing fields, and invalid enums', () => {
  for (const mutate of [
    (data: ReturnType<typeof valid>) => Object.assign(data, { extra: true }),
    (data: ReturnType<typeof valid>) => Object.assign(data.results[0]!, { extra: true }),
    (data: ReturnType<typeof valid>) => Object.assign(data.results[0]!.classification, { mastery: 1 }),
    (data: ReturnType<typeof valid>) => Object.assign(data.results[0]!.classification.matches[0]!, { confidence: 1 }),
    (data: ReturnType<typeof valid>) => { data.results[0]!.classification.matches[0]!.assessment = 'mastered' },
  ]) { const data = valid(); mutate(data); assert.throws(() => parseClassifierV6Batch(data, cases)) }
  assert.throws(() => parseClassifierV6Batch({ results: [{ caseId: 'case1' }] }, cases))
})

test('v6 rejects unknown concepts, duplicate concepts, and duplicate or missing cases', () => {
  const unknown = valid(); unknown.results[0]!.classification.matches[0]!.conceptId = 'not-on-list'
  assert.throws(() => parseClassifierV6Batch(unknown, cases), /not on the supplied list/)
  const duplicate = valid(); duplicate.results[0]!.classification.matches.push(duplicate.results[0]!.classification.matches[0]!)
  assert.throws(() => parseClassifierV6Batch(duplicate, cases), /Duplicate concept/)
  assert.throws(() => parseClassifierV6Batch({ results: [] }, cases))
  assert.throws(() => parseClassifierV6Batch({ results: [valid().results[0], valid().results[0]] }, [...cases, { caseId: 'case2', snapshot }]), /duplicate case/)
})

test('v6 requires exact quotes from the correct learner, without whitespace repair', () => {
  for (const quote of ['We can discuss abstraction.', 'Explain abstraction. Explain encapsulation.']) {
    const data = valid(); data.results[0]!.classification.matches[0]!.quote = quote
    assert.throws(() => parseClassifierV6Batch(data, cases), /exact substring/)
  }
  assert.throws(() => parseClassifierV6Batch(valid(), [{ caseId: 'case1', snapshot: { ...snapshot, current: { ...snapshot.current, authorship: 'agent' } } }]), /human-authored/)
})

test('v6 repairs only AGY literal JSON quote escapes when they map to an exact source slice', () => {
  const quotedSnapshot = { ...snapshot, current: { ...snapshot.current, text: 'Call it "abstraction" here.' } }
  const data = valid()
  data.results[0]!.classification.matches[0]!.quote = '"abstraction"'.replaceAll('"', '\\"')
  const parsed = parseClassifierV6Batch(data, [{ caseId: 'case1', snapshot: quotedSnapshot }])
  assert.equal(parsed[0]?.classification.matches[0]?.quote, '"abstraction"')
  data.results[0]!.classification.matches[0]!.quote = '\\"not present\\"'
  assert.throws(() => parseClassifierV6Batch(data, [{ caseId: 'case1', snapshot: quotedSnapshot }]), /exact substring/)
})

test('v6 correction feedback identifies every failing case instead of mixing their quotes', () => {
  const first = valid().results[0]!
  first.classification.matches[0]!.quote = 'invented first quote'
  const second = structuredClone(first)
  second.caseId = 'case2'
  second.classification.matches[0]!.quote = 'invented second quote'
  assert.throws(() => parseClassifierV6Batch({ results: [first, second] }, [...cases, { caseId: 'case2', snapshot }]), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /case1/)
    assert.match(error.message, /case2/)
    assert.match(error.message, /invented first quote/)
    assert.match(error.message, /invented second quote/)
    return true
  })
})

test('v6 independent validation retains valid siblings and quarantines only invalid rows', () => {
  const first = valid().results[0]!
  const second = structuredClone(first)
  second.caseId = 'case2'
  second.classification.matches[0]!.quote = 'invented second quote'
  const parsed = parseClassifierV6BatchIndependently(
    { results: [first, second] },
    [...cases, { caseId: 'case2', snapshot }],
  )
  assert.deepEqual(parsed.accepted.map((item) => item.caseId), ['case1'])
  assert.equal(parsed.accepted[0]?.classification.matches[0]?.conceptId, concept.id)
  assert.equal(parsed.quarantined.length, 1)
  assert.equal(parsed.quarantined[0]?.caseId, 'case2')
  assert.match(parsed.quarantined[0]?.error ?? '', /exact substring/)
})

test('v6 allows abstention and more than five supported tags, but rejects contradictory evidence fields', () => {
  const empty = valid(); empty.results[0]!.classification.matches = []
  assert.equal(parseClassifierV6Batch(empty, cases)[0]?.classification.matches.length, 0)
  const many = valid(); const match = many.results[0]!.classification.matches[0]!
  many.results[0]!.classification.matches = CLASSIFIER_V6_CATALOG.slice(0, 6).map((item) => ({ ...match, conceptId: item.ref }))
  assert.equal(parseClassifierV6Batch(many, cases)[0]?.classification.matches.length, 6)
  const contradiction = valid(); contradiction.results[0]!.classification.matches[0]!.assessment = 'supports'
  assert.throws(() => parseClassifierV6Batch(contradiction, cases), /indeterminate/)
})

test('v6 rejects Markdown wrappers and keeps batch prompts below the reserved ceiling', () => {
  assert.throws(() => parseClassifierV6Batch('```json\n' + JSON.stringify(valid()) + '\n```', cases))
  const large = Array.from({ length: 50 }, (_, i) => ({ caseId: String(i), snapshot: { ...snapshot, current: { ...snapshot.current, text: 'x'.repeat(6_000) } } }))
  const batches = batchClassifierV6Cases(large)
  assert.ok(batches.length > 1)
  assert.equal(batches.flat().length, 50)
  for (const batch of batches) assert.ok(Buffer.byteLength(classifierV6Prompt(batch)) + 40_000 <= 200_000)
})
