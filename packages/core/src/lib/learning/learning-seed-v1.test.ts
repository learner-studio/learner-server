import { describe, expect, test } from 'bun:test'

import { selectSeedV1Pairs, type IndexedSeedV1Turn, type SeedV1ArchivedTurn } from './learning-seed-v1.js'
import { StartLearningClassifierV6Input } from './learning-classifier-v6-schemas.js'
import { SEED_V1_CONTEXT_STRATEGY, SEED_V1_EXPERIMENT_LABEL, THREE_TURN_MAX_BATCH_TOKENS } from './learning-three-turn-context.js'

const item = (index: number, role: 'user' | 'assistant', authorship: SeedV1ArchivedTurn['message']['authorship'], thread = 'thread-1'): IndexedSeedV1Turn => {
  const text = `${role}-${index}`
  return {
    documentId: `doc-${role}-${index}`,
    envelopeHash: `envelope-${role}-${index}`,
    archivedAt: new Date(index * 1_000).toISOString(),
    turn: {
      schemaVersion: 1, provider: 'openai', location: 'local',
      source: { path: '/private/source.jsonl', kind: 'jsonl', device: 1, inode: 2, generation: 0, offset: index },
      thread: { nativeId: thread },
      message: { nativeId: `native-${role}-${index}`, exchangeNativeId: `exchange-${index}`, role, authorship,
        authorshipEvidence: authorship === 'human' ? 'verified human' : `${role} role`, timestamp: new Date(index * 1_000).toISOString(),
        order: index, model: null, cwd: null, text, contentHash: `hash-${text}` },
    },
  }
}

describe('seed V1 frozen-pair admission', () => {
  test('selects exactly the latest 100 complete human pairs in chronological target order', () => {
    const turns: IndexedSeedV1Turn[] = []
    for (let index = 1; index <= 101; index += 1) turns.push(item(index * 3, 'user', 'human'), item(index * 3 + 1, 'assistant', 'agent'))
    const selected = selectSeedV1Pairs(turns)
    expect(selected.pairs).toHaveLength(100)
    expect(selected.pairs[0]!.user.turn.message.text).toBe('user-6')
    expect(selected.pairs.at(-1)!.user.turn.message.text).toBe('user-303')
    expect(selected.pairs.every(({ user, assistant }) => user.turn.thread.nativeId === assistant.turn.thread.nativeId)).toBe(true)
  })

  test('does not skip a user boundary and excludes incomplete or unverified targets', () => {
    const turns: IndexedSeedV1Turn[] = []
    for (let index = 1; index <= 100; index += 1) turns.push(item(index * 4, 'user', 'human'), item(index * 4 + 1, 'assistant', 'agent'))
    turns.push(item(500, 'user', 'human'), item(501, 'user', 'system'), item(502, 'assistant', 'agent'))
    const selected = selectSeedV1Pairs(turns)
    expect(selected.incompleteHumanTargets).toBe(1)
    expect(selected.pairs.some(({ user }) => user.turn.message.text === 'user-500')).toBe(false)
  })

  test('deduplicates only the same native identity and content hash', () => {
    const turns: IndexedSeedV1Turn[] = []
    for (let index = 1; index <= 100; index += 1) turns.push(item(index * 3, 'user', 'human'), item(index * 3 + 1, 'assistant', 'agent'))
    turns.push({ ...turns[0]!, documentId: 'duplicate-envelope' })
    const selected = selectSeedV1Pairs(turns)
    expect(selected.deduplicatedTurns).toBe(200)
    expect(selected.pairs).toHaveLength(100)
  })
})

test('the existing benchmark model chooser accepts AGY for a frozen Seed V1 replay', () => {
  expect(StartLearningClassifierV6Input.parse({
    sampleSize: 100,
    mode: 'prototype-extraction',
    replayRunId: 'bfc9be0e-b98e-4932-bd4b-ce951f460fe4',
    backend: 'agy',
    model: 'gemini-3.7-flash',
    effort: 'medium',
    maxAttempts: 1,
    maxBatchTokens: THREE_TURN_MAX_BATCH_TOKENS,
    experimentLabel: SEED_V1_EXPERIMENT_LABEL,
    contextStrategy: SEED_V1_CONTEXT_STRATEGY,
  })).toMatchObject({ backend: 'agy', model: 'gemini-3.7-flash', effort: 'medium' })
})
