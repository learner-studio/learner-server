import { describe, expect, test } from 'bun:test'
import { nativeConversationOf } from './learning-semantic-index.js'
import { nativeTurnAnchors, reconstructVectorTurns, type VectorMessage } from './learning-vector-turns.js'

const key = (thread: string, role: 'user' | 'assistant', native: string) => `claude:${thread}:${role}:${native}`

describe('Claude-format turns pair by native identity', () => {
  test('the session in a Claude key is the conversation; other keys keep their own rule', () => {
    expect(nativeConversationOf(key('s1', 'user', 'u1'))).toBe('claude:s1')
    expect(nativeConversationOf('codex:t:-:user:m')).toBeUndefined()
  })

  test('a CLI reply walks thinking, tool and tool-result rows back to its human prompt', () => {
    const anchors = nativeTurnAnchors([
      { logicalKey: key('s1', 'user', 'p1'), parentUuid: null, human: true },
      { logicalKey: key('s1', 'assistant', 'think'), parentUuid: 'p1', human: false },
      { logicalKey: key('s1', 'assistant', 'tool'), parentUuid: 'think', human: false },
      { logicalKey: key('s1', 'user', 'result'), parentUuid: 'tool', human: false },
      { logicalKey: key('s1', 'assistant', 'reply'), parentUuid: 'result', human: false },
    ])
    expect(anchors.get(key('s1', 'assistant', 'reply'))).toBe(key('s1', 'user', 'p1'))
  })

  test('identity only: a broken chain or another session links nothing', () => {
    const anchors = nativeTurnAnchors([
      { logicalKey: key('s1', 'user', 'p1'), parentUuid: null, human: true },
      { logicalKey: key('s2', 'assistant', 'reply'), parentUuid: 'p1', human: false },
      { logicalKey: key('s1', 'assistant', 'orphan'), parentUuid: 'missing', human: false },
    ])
    expect(anchors.size).toBe(0)
  })

  test('a revision that re-links a line supersedes the original: the newest row wins', () => {
    const anchors = nativeTurnAnchors([
      { logicalKey: key('c', 'user', 'earlier'), parentUuid: null, human: true },
      { logicalKey: key('c', 'user', 'answer'), parentUuid: 'ctx', human: true },
      { logicalKey: key('c', 'assistant', 'ctx'), parentUuid: 'earlier', human: false },
      { logicalKey: key('c', 'assistant', 'ctx'), parentUuid: 'answer', human: false },
    ])
    expect(anchors.get(key('c', 'assistant', 'ctx'))).toBe(key('c', 'user', 'answer'))
  })

  test('with the anchor and a shared conversation the reply makes an explicit turn', () => {
    const message = (role: 'user' | 'assistant', native: string, correlation: Record<string, unknown> = {}): VectorMessage =>
      ({ id: native, role, text: native, occurredAt: '2026-10-01T10:00:00Z', conversationId: 'claude:s1', logicalKey: key('s1', role, native),
        authorship: role === 'user' ? 'human' : 'agent', correlation, sourceOrder: 0, sourceVersion: 'v' }) as VectorMessage
    const unpaired = reconstructVectorTurns([message('user', 'p1'), message('assistant', 'reply')])
    expect(unpaired.map((t) => t.linkage)).toEqual(['unpaired', 'unpaired'])
    const paired = reconstructVectorTurns([message('user', 'p1'), message('assistant', 'reply', { parentLogicalMessageKey: key('s1', 'user', 'p1') })])
    expect(paired).toHaveLength(1)
    expect(paired[0]!.linkage).toBe('explicit')
  })
})
