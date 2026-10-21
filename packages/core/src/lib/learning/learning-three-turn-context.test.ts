import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ConversationTurn } from '../../functions/learning/get-conversation-history.js'
import { StartLearningClassifierV6Input } from './learning-classifier-v6-schemas.js'
import {
  batchClassifierV6CasesForConfig,
  classifierV6Prompt,
  classifierV6PromptForConfig,
} from './learning-classifier-v6.js'
import type { BenchmarkCaseSnapshot } from './learning-extraction-benchmark.js'
import {
  assertOnePairSequence,
  assertThreeTurnSequence,
  buildOnePairSequence,
  buildThreeTurnSequences,
  ONE_PAIR_CONTEXT_STRATEGY,
  ONE_PAIR_EXPERIMENT_LABEL,
  SEED_V1_CONTEXT_STRATEGY,
  THREE_TURN_CONTEXT_STRATEGY,
  THREE_TURN_EFFECTIVE_BATCH_BYTE_CEILING,
  THREE_TURN_EXPERIMENT_LABEL,
  THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
} from './learning-three-turn-context.js'

const turn = (
  id: string,
  role: 'user' | 'assistant',
  text: string,
  timestamp: string,
): ConversationTurn => ({
  id,
  threadId: 'native-thread',
  threadTitle: 'Native thread',
  exchangeId: `provider-advisory-${id}`,
  sourceRecordId: `fixture:${id}`,
  sourceOrder: Number(timestamp.slice(-3, -1)),
  agent: 'Codex',
  provider: 'openai',
  location: 'local',
  role,
  authorship: role === 'user' ? 'human' : 'agent',
  authorshipEvidence: role === 'user' ? 'fixture human provenance' : 'fixture assistant role',
  text,
  timestamp,
  model: role === 'assistant' ? 'gpt-5.6-luna' : null,
  cwd: '/root/example-workspace',
})

const completeTurns = [
  turn('u1', 'user', 'before learner', '2026-09-01T00:00:01Z'),
  turn('a1-draft', 'assistant', 'draft response', '2026-09-01T00:00:02Z'),
  turn('a1', 'assistant', 'final before response', '2026-09-01T00:00:03Z'),
  turn('u2', 'user', 'central learner target', '2026-09-01T00:00:04Z'),
  turn('a2', 'assistant', 'target response', '2026-09-01T00:00:05Z'),
  turn('u3', 'user', 'future learner', '2026-09-01T00:00:06Z'),
  turn('a3', 'assistant', 'future response', '2026-09-01T00:00:07Z'),
]

test('three-turn builder uses adjacent user boundaries and the final assistant before the next user', () => {
  const [sequence] = buildThreeTurnSequences(completeTurns)
  assert.ok(sequence)
  assertThreeTurnSequence(sequence)
  assert.deepEqual(sequence.messages.map(({ sequenceNumber, section, contextRelation, role, id }) => (
    { sequenceNumber, section, contextRelation, role, id }
  )), [
    { sequenceNumber: 1, section: 'before', contextRelation: 'prior', role: 'user', id: 'u1' },
    { sequenceNumber: 2, section: 'before', contextRelation: 'prior', role: 'assistant', id: 'a1' },
    { sequenceNumber: 3, section: 'target', contextRelation: 'target', role: 'user', id: 'u2' },
    { sequenceNumber: 4, section: 'target', contextRelation: 'target', role: 'assistant', id: 'a2' },
    { sequenceNumber: 5, section: 'after', contextRelation: 'retrospective_future', role: 'user', id: 'u3' },
    { sequenceNumber: 6, section: 'after', contextRelation: 'retrospective_future', role: 'assistant', id: 'a3' },
  ])
})

test('three-turn builder neither skips an incomplete user boundary nor duplicates replayed source IDs', () => {
  const incomplete = [completeTurns[0]!, completeTurns[2]!, completeTurns[3]!, completeTurns[5]!, completeTurns[6]!]
  assert.equal(buildThreeTurnSequences(incomplete).length, 0)
  assert.equal(buildThreeTurnSequences([...completeTurns, ...completeTurns]).length, 1)
})

test('three-turn chronology uses native source order when timestamps tie', () => {
  const tied = completeTurns.map((item, sourceOrder) => ({
    ...item,
    timestamp: '2026-09-01T00:00:00Z',
    sourceOrder,
  }))
  const sequence = buildThreeTurnSequences(tied)[0]!
  assertThreeTurnSequence(sequence)
  sequence.messages[3]!.sourceOrder = sequence.messages[2]!.sourceOrder
  assert.throws(() => assertThreeTurnSequence(sequence), /source order/)
})

const sequence = buildThreeTurnSequences(completeTurns)[0]!
const snapshot: BenchmarkCaseSnapshot = {
  current: {
    id: 'u2', threadId: 'native-thread', exchangeId: 'provider-advisory-u2', agent: 'Codex', provider: 'openai',
    role: 'user', authorship: 'human', authorshipEvidence: 'fixture human provenance', text: 'central learner target',
    timestamp: '2026-09-01T00:00:04Z', model: null, cwd: '/root/example-workspace',
  },
  context: [
    { id: 'u1', role: 'user', text: 'before learner', timestamp: '2026-09-01T00:00:01Z' },
    { id: 'a1', role: 'assistant', text: 'final before response', timestamp: '2026-09-01T00:00:03Z' },
  ],
  contextCompleteness: { assistantTurns: 'partial', toolOutput: 'unavailable', taskOutcome: 'unavailable', receiptContext: 'unavailable' },
  ontologyCandidateIds: [],
  threeTurnSequence: sequence,
}

test('prompt selector preserves legacy output and makes retrospective context explicit', () => {
  const cases = [{ caseId: 'case-1', snapshot }]
  assert.equal(classifierV6PromptForConfig(cases, {}), classifierV6Prompt(cases))
  const prompt = classifierV6PromptForConfig(cases, { contextStrategy: THREE_TURN_CONTEXT_STRATEGY })
  assert.match(prompt, /Classify and quote ONLY message 3/)
  assert.match(prompt, /Messages 5 and 6 are retrospective future context/)
  assert.match(prompt, /Never count message 4, 5, or 6 as prior assistance/)
  assert.equal(createHash('sha256').update(classifierV6Prompt(cases)).digest('hex'), 'd826a3b856e9095bd1c12ca339b859b848377045cc3f1a98d0e2881dc664a65b')
})

test('one-pair ablation retains only the exact target user and response with native provenance', () => {
  const pair = buildOnePairSequence(sequence)
  assertOnePairSequence(pair)
  assert.deepEqual(pair.messages.map(({ id, role, text, sourceRecordId, authorship }) => ({ id, role, text, sourceRecordId, authorship })), [
    { id: 'u2', role: 'user', text: 'central learner target', sourceRecordId: 'fixture:u2', authorship: 'human' },
    { id: 'a2', role: 'assistant', text: 'target response', sourceRecordId: 'fixture:a2', authorship: 'agent' },
  ])
  const { threeTurnSequence: _removedSourceSequence, ...snapshotWithoutSequence } = snapshot
  const onePairSnapshot: BenchmarkCaseSnapshot = {
    ...snapshotWithoutSequence,
    context: [],
    onePairSequence: pair,
  }
  const cases = [{ caseId: 'case-1', snapshot: onePairSnapshot }]
  const prompt = classifierV6PromptForConfig(cases, { contextStrategy: ONE_PAIR_CONTEXT_STRATEGY })
  assert.ok(prompt.startsWith(classifierV6Prompt(cases)))
  assert.match(prompt, /Classify and quote ONLY message 1/)
  assert.doesNotMatch(prompt, /before learner|future learner|future response/)
})

test('three-turn protocol accepts only frozen pilot/full inputs and batches with exact schema reserve', () => {
  const base = {
    sampleSize: 50,
    mode: 'prototype-extraction' as const,
    model: 'gpt-5.6-luna' as const,
    effort: 'xhigh' as const,
    maxAttempts: 1,
    maxBatchTokens: 400_000,
    experimentLabel: THREE_TURN_EXPERIMENT_LABEL,
    contextStrategy: THREE_TURN_CONTEXT_STRATEGY,
  }
  assert.equal(StartLearningClassifierV6Input.parse(base).effort, 'xhigh')
  assert.throws(() => StartLearningClassifierV6Input.parse({ ...base, sampleSize: 2 }))
  assert.throws(() => StartLearningClassifierV6Input.parse({ ...base, maxAttempts: 2 }))
  const batches = batchClassifierV6CasesForConfig([{ caseId: 'case-1', snapshot }], {
    contextStrategy: THREE_TURN_CONTEXT_STRATEGY,
    effectiveBatchByteCeiling: THREE_TURN_EFFECTIVE_BATCH_BYTE_CEILING,
    nativeSchemaReserveTokens: THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
  })
  assert.equal(batches.length, 1)
  const providerBatches = batchClassifierV6CasesForConfig(Array.from({ length: 11 }, (_, index) => ({ caseId: `provider-case-${index}`, snapshot })), {
    contextStrategy: THREE_TURN_CONTEXT_STRATEGY,
    effectiveBatchByteCeiling: THREE_TURN_EFFECTIVE_BATCH_BYTE_CEILING,
    nativeSchemaReserveTokens: THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
    providerMaxCasesPerBatch: 10,
  })
  assert.deepEqual(providerBatches.map((batch) => batch.length), [10, 1])

  const onePair = StartLearningClassifierV6Input.parse({
    ...base,
    replayRunId: 'e9de6bcb-ba81-4dc5-929e-a22ad91aca98',
    experimentLabel: ONE_PAIR_EXPERIMENT_LABEL,
    contextStrategy: ONE_PAIR_CONTEXT_STRATEGY,
    effort: 'medium',
  })
  assert.equal(onePair.contextStrategy, ONE_PAIR_CONTEXT_STRATEGY)
  assert.throws(() => StartLearningClassifierV6Input.parse({ ...onePair, replayRunId: undefined }))
})

test('Seed V1 Flash High keeps all 100 cases in one configured 400K batch', () => {
  const learner = { ...sequence.messages[2]!, sequenceNumber: 1, section: 'target' as const, contextRelation: 'target' as const }
  const response = { ...sequence.messages[3]!, sequenceNumber: 2, section: 'target' as const, contextRelation: 'target' as const }
  const cases = Array.from({ length: 100 }, (_, index) => ({ caseId: `seed-${index}`, snapshot: {
    ...snapshot,
    seedV1PairSequence: { strategy: SEED_V1_CONTEXT_STRATEGY, messages: [
      { ...learner, id: `human-${index}` },
      { ...response, id: `assistant-${index}` },
    ] as [typeof learner, typeof response] },
    current: { ...snapshot.current, id: `human-${index}` },
  } }))
  const batches = batchClassifierV6CasesForConfig(cases, {
    contextStrategy: SEED_V1_CONTEXT_STRATEGY,
    effectiveBatchByteCeiling: 400_000,
    nativeSchemaReserveTokens: THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
  })
  assert.deepEqual(batches.map(batch => batch.length), [100])
  const prompt = classifierV6PromptForConfig(cases, { contextStrategy: SEED_V1_CONTEXT_STRATEGY })
  assert.match(prompt, /post-target assistant response remains in the immutable audit snapshot but is deliberately omitted/)
  assert.ok(Buffer.byteLength(prompt) < 200_000)
  assert.doesNotMatch(prompt, /ORDERED SEED V1 PAIRS/)
})
