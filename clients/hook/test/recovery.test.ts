import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { liveFeedbackInlineControl } from '@learner/contract'
import { deferLearningTurn, isTransientLearningFailure, resumeLearningTurn } from '../src/recovery.js'

const CATALOG = { catalogVersion: 'test-catalog-v1', catalog: [{ id: 'llm-evidence--authorship', title: 'Evidence authorship' }] }
const input = { sessionId: '11111111-1111-4111-8111-111111111111', turnId: '22222222-2222-4222-8222-222222222222', message: 'I distinguish user evidence from assistant explanations.', foundationFirst: true }
const identity = { sessionId: input.sessionId, turnId: input.turnId, catalogVersion: CATALOG.catalogVersion }
async function fixture(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'learner-hook-recovery-'))
  try { await run(join(dir, 'turn.begin.json')) } finally { await rm(dir, { recursive: true, force: true }) }
}

describe('native Learning hook deferred initialization', () => {
  test('timeout preserves the exact turn and inline instructions without invented history', () => fixture(async (path) => {
    const packet = await deferLearningTurn(path, input, CATALOG)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(input)
    expect(packet.recentFeedback).toEqual([])
    const envelope = liveFeedbackInlineControl(packet, input.sessionId)
    const text = envelope.hookSpecificOutput!.additionalContext
    expect(text).toContain('--submit')
    expect(text).toContain(input.turnId)
    expect(text).toContain('FOUNDATION')
    expect(text.length + 500).toBeLessThan(8000)
  }))

  test('recovery initializes the SAME turn, then removes the local request only after acknowledgement', () => fixture(async (path) => {
    const packet = await deferLearningTurn(path, input, CATALOG)
    const calls: unknown[] = []
    await resumeLearningTurn(path, identity, async (name, data) => { calls.push({ name, data }); return packet })
    expect(calls).toEqual([{ name: 'beginLearningFeedbackTurn', data: input }])
    expect(await readFile(path, 'utf8').catch(() => null)).toBeNull()
    await resumeLearningTurn(path, identity, async () => { throw new Error('Must not replay after acknowledgement') })
  }))

  test('a failed retry retains the exact request; a catalog mismatch does not accept it', () => fixture(async (path) => {
    const packet = await deferLearningTurn(path, input, CATALOG)
    await expect(resumeLearningTurn(path, identity, async () => { throw new Error('offline') })).rejects.toThrow('offline')
    await expect(resumeLearningTurn(path, identity, async () => ({ ...packet, catalogVersion: 'wrong' }))).rejects.toThrow('changed')
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(input)
  }))

  test('another turn cannot consume a deferred request', () => fixture(async (path) => {
    await deferLearningTurn(path, input, CATALOG)
    await expect(resumeLearningTurn(path, { ...identity, turnId: crypto.randomUUID() }, async () => { throw new Error('Must not call API') })).rejects.toThrow('identity mismatch')
  }))

  test('an acknowledged catalog stays omitted; auth and validation errors are not disguised as outages', () => fixture(async (path) => {
    expect((await deferLearningTurn(path, { ...input, catalogVersion: CATALOG.catalogVersion }, CATALOG)).catalog).toBeNull()
    expect(isTransientLearningFailure(new DOMException('timeout', 'TimeoutError'))).toBe(true)
    expect(isTransientLearningFailure(new Error('Learning begin HTTP 503: unavailable'))).toBe(true)
    for (const status of [400, 401, 403, 409]) expect(isTransientLearningFailure(new Error(`Learning begin HTTP ${status}: denied`))).toBe(false)
    expect(isTransientLearningFailure(new Error('schema mismatch'))).toBe(false)
  }))
})
