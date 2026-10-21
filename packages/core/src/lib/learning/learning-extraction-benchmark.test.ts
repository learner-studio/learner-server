import assert from 'node:assert/strict'
import test from 'node:test'

import { COMPUTER_SCIENCE } from '../../functions/learning/computer-science-seed.js'
import {
  extractionPrompt,
  buildBenchmarkCandidatePool,
  parseExtraction,
  retrieveOntologyCandidates,
  sanitizeBenchmarkContext,
  selectSeededBenchmarkSubset,
  selectBenchmarkSample,
  type BenchmarkCaseSnapshot,
} from './learning-extraction-benchmark.js'
import type { ConversationTurn } from '../../functions/learning/get-conversation-history.js'

const conceptId = 'architecture-event-systems--message-queue'
const snapshot: BenchmarkCaseSnapshot = {
  context: [
    { id: 'a1', role: 'assistant', text: 'A queue decouples producers from consumers.', timestamp: '2026-09-04T00:00:00.000Z' },
    { id: 'u1', role: 'user', text: 'I want to understand queues.', timestamp: '2026-09-04T00:00:01.000Z' },
  ],
  current: {
    id: 'u2', threadId: 'thread-1', exchangeId: 'exchange-2', agent: 'Codex', provider: 'openai', role: 'user',
    authorship: 'human', authorshipEvidence: 'fixture', text: 'A queue helps a producer continue while a slower consumer catches up.',
    timestamp: '2026-09-04T00:00:02.000Z', model: null, cwd: '/root/example-workspace',
  },
  contextCompleteness: { assistantTurns: 'complete', toolOutput: 'unavailable', taskOutcome: 'unavailable', receiptContext: 'unavailable' },
  ontologyCandidateIds: [conceptId],
}

const valid = () => ({
  contextCompleteness: snapshot.contextCompleteness,
  ontologyRetrieval: { strategy: 'bounded-lexical-v1', candidateConceptIds: snapshot.ontologyCandidateIds, totalOntologyConcepts: COMPUTER_SCIENCE.concepts.length },
  episode: { boundary: 'continue', objective: 'Understand queues', activity: 'learning', confidence: 0.8, reason: 'The learner continues the queue topic.' },
  spans: [{ conceptId, quote: 'A queue helps a producer continue while a slower consumer catches up.', source: 'current_learner', directness: 'explicit', relationship: 'learner_evidence', confidence: 0.8 }],
  evidence: [{
    disposition: 'accepted', conceptId, quote: 'A queue helps a producer continue while a slower consumer catches up.', evidenceKind: 'explanation', assessment: 'supports', assistanceLevel: 'scaffolded', confidence: 0.7,
    acceptance: { decision: 'accept', confidence: 0.7, reason: 'The explanation is correct but follows visible scaffolding.' },
    mastery: { estimate: 'partial', score: 0.45, confidence: 0.65, reason: 'One scaffolded explanation supports partial understanding.' },
  }],
  overallConfidence: 0.72,
  notes: 'Exact quotes and conservative assistance.',
})

test('extraction prompt makes continuation, task context, assistance, and exact quote rules explicit', () => {
  const prompt = extractionPrompt(snapshot)
  assert.match(prompt, /Default the episode boundary to continue/)
  assert.match(prompt, /task context, never evidence/)
  assert.match(prompt, /exact, unchanged, contiguous substring/)
  assert.match(prompt, /scaffolded or answer_visible/)
  assert.match(prompt, /Positive applied evidence/)
  assert.ok(prompt.length < 15_000)
})

test('snapshot-aware parsing accepts grounded spans and evidence', () => {
  const parsed = parseExtraction(JSON.stringify(valid()), snapshot)
  assert.equal(parsed.spans[0]?.source, 'current_learner')
  assert.equal(parsed.evidence[0]?.assistanceLevel, 'scaffolded')
})

test('benchmark context removes duplicate source turns before inference', () => {
  const context = sanitizeBenchmarkContext(snapshot.current, [
    ...snapshot.context,
    { id: 'u1-copy', role: 'user', text: ' I want  to understand queues. ', timestamp: '2026-09-04T00:00:01.500Z' },
    { id: 'u2-copy', role: 'user', text: snapshot.current.text, timestamp: '2026-09-04T00:00:01.900Z' },
  ])
  assert.deepEqual(context.map((turn) => turn.id), ['a1', 'u1'])
})

const corpusTurn = (overrides: Partial<ConversationTurn> & Pick<ConversationTurn, 'id' | 'provider' | 'text'>): ConversationTurn => ({
  threadId: `thread-${overrides.provider}`,
  threadTitle: 'Fixture thread',
  exchangeId: `exchange-${overrides.id}`,
  sourceRecordId: `fixture:${overrides.id}`,
  sourceOrder: Number(overrides.id.replace(/\D/g, '')) || 0,
  agent: 'fixture',
  location: 'local',
  role: 'user',
  authorship: 'human',
  authorshipEvidence: 'provider-native human submission fixture',
  timestamp: `2026-09-04T00:00:${String(Number(overrides.id.replace(/\D/g, '')) || 0).padStart(2, '0')}.000Z`,
  model: null,
  cwd: '/root/example-workspace',
  ...overrides,
})

test('candidate pool excludes agent-authored turns and deduplicates normalized learner text across providers', () => {
  const candidates = buildBenchmarkCandidatePool([
    corpusTurn({ id: 'g1', provider: 'google', text: 'Explain queue backpressure.' }),
    corpusTurn({ id: 'a1', provider: 'anthropic', text: '  explain   queue backpressure. ' }),
    corpusTurn({ id: 'o1', provider: 'openai', text: 'Design an idempotent worker.' }),
    corpusTurn({ id: 'o2', provider: 'openai', text: 'Agent generated request', authorship: 'agent', authorshipEvidence: 'sidechain' }),
  ])
  assert.equal(candidates.length, 2)
  assert.ok(candidates.every((item) => item.current.authorship === 'human'))
})

test('provider round robin continues after a smaller provider is exhausted', () => {
  const candidates = buildBenchmarkCandidatePool([
    corpusTurn({ id: 'g1', provider: 'google', text: 'Google concept one' }),
    corpusTurn({ id: 'g2', provider: 'google', text: 'Google concept two' }),
    corpusTurn({ id: 'g3', provider: 'google', text: 'Google concept three' }),
    corpusTurn({ id: 'a1', provider: 'anthropic', text: 'Anthropic concept one' }),
    corpusTurn({ id: 'a2', provider: 'anthropic', text: 'Anthropic concept two' }),
    corpusTurn({ id: 'a3', provider: 'anthropic', text: 'Anthropic concept three' }),
    corpusTurn({ id: 'o1', provider: 'openai', text: 'OpenAI concept one' }),
    corpusTurn({ id: 'o2', provider: 'openai', text: 'OpenAI concept two' }),
    corpusTurn({ id: 'o3', provider: 'openai', text: 'OpenAI concept three' }),
    corpusTurn({ id: 'o4', provider: 'openai', text: 'OpenAI concept four' }),
  ])
  const selected = selectBenchmarkSample(candidates, 10)
  assert.equal(selected.length, 10)
  assert.equal(selected.filter((item) => item.current.provider === 'openai').length, 4)
  const first = selectSeededBenchmarkSubset(selected, 4, 'audit-seed')
  const replay = selectSeededBenchmarkSubset(selected, 4, 'audit-seed')
  const different = selectSeededBenchmarkSubset(selected, 4, 'different-seed')
  assert.deepEqual(first.map((item) => item.current.id), replay.map((item) => item.current.id))
  assert.notDeepEqual(first.map((item) => item.current.id), different.map((item) => item.current.id))
})

test('snapshot-aware parsing rejects altered quotes and non-current learner evidence', () => {
  const altered = valid()
  altered.spans[0]!.quote = 'producer continues while a slower consumer catches up'
  assert.throws(() => parseExtraction(JSON.stringify(altered), snapshot), /exact contiguous substring/)

  const wrongSource = valid()
  wrongSource.spans[0]!.source = 'assistant' as 'current_learner'
  assert.throws(() => parseExtraction(JSON.stringify(wrongSource), snapshot), /Learner evidence and misconceptions/)
})

test('snapshot-aware parsing restores whitespace-only quote differences to the exact source slice', () => {
  const wrapped: BenchmarkCaseSnapshot = {
    ...snapshot,
    current: { ...snapshot.current, text: 'the invariant must be\n  unmistakably labeled candidate or rejected' },
  }
  const extraction = valid()
  extraction.spans[0]!.quote = 'must be unmistakably labeled candidate or rejected'
  extraction.evidence[0]!.quote = 'must be unmistakably labeled candidate or rejected'
  const parsed = parseExtraction(JSON.stringify(extraction), wrapped)
  assert.equal(parsed.spans[0]!.quote, 'must be\n  unmistakably labeled candidate or rejected')
  assert.equal(parsed.evidence[0]!.quote, 'must be\n  unmistakably labeled candidate or rejected')
})

test('inferred concept mappings are confidence capped', () => {
  const inferred = valid()
  inferred.spans[0]!.directness = 'inferred'
  inferred.spans[0]!.confidence = 0.9
  assert.throws(() => parseExtraction(JSON.stringify(inferred), snapshot), /cannot exceed 0.65/)
})

test('bounded ontology retrieval returns relevant concepts without sending the full ontology', () => {
  const candidates = retrieveOntologyCandidates(snapshot, 12)
  assert.ok(candidates.includes(conceptId))
  assert.ok(candidates.length <= 12)
  assert.ok(candidates.length < COMPUTER_SCIENCE.concepts.length)
})

test('candidate evidence cannot assert demonstrated mastery', () => {
  const candidate = valid()
  candidate.evidence[0]!.disposition = 'candidate'
  candidate.evidence[0]!.acceptance.decision = 'review'
  assert.throws(() => parseExtraction(JSON.stringify(candidate), snapshot), /cannot assert demonstrated mastery/)
})

test('assistance stays unclear when assistant context is incomplete', () => {
  const incompleteSnapshot = { ...snapshot, contextCompleteness: { ...snapshot.contextCompleteness, assistantTurns: 'partial' as const } }
  const extraction = valid()
  extraction.contextCompleteness = incompleteSnapshot.contextCompleteness
  assert.throws(() => parseExtraction(JSON.stringify(extraction), incompleteSnapshot), /Assistance must be unclear/)
})
