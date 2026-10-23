import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { DesktopCallTranscript, IngestCall, ReadAiCallPayload } from '@learner/contract'
import { callTurns } from './learner-desktop-transcripts.js'
import { callTranscript, ingestSpeech } from './call-ingest.js'

const t0 = Date.parse('2026-10-22T23:01:50Z')
const at = (ms: number) => new Date(t0 + ms).toISOString()
const readAi = IngestCall.parse({ format: 'readai', payload: {
  session_id: '01M5JX1KZE6V6HYJ6BHQ3D1MCS',
  title: 'Acme Sync',
  start_time: '2026-10-22T19:01:50-04:00',
  platform: 'meet',
  owner: { email: 'beth@example.com' },
  participants: [{ name: 'Grace Hopper', email: 'beth@example.com' }, { email: 'ben@example.com' }],
  transcript: { speakers: [{ name: 'Grace Hopper' }], speaker_blocks: [
    { start_time: t0 + 65_000, end_time: t0 + 66_000, speaker: { name: 'Grace Hopper' }, words: 'How does the fill line scale?' },
    { start_time: t0 + 61_000, end_time: t0 + 62_000, speaker: { name: 'UNKNOWN_SPEAKER' }, words: 'Hi all.' },
    { start_time: t0 + 70_000, end_time: t0 + 80_000, speaker: { name: 'Ben Pollack' }, words: 'Batch size is the constraint.' },
    { start_time: t0 + 81_000, end_time: t0 + 85_500, speaker: { name: 'Ben Pollack' }, words: 'So we split it.' },
    { start_time: t0 + 90_000, end_time: t0 + 91_000, speaker: { name: 'Grace Hopper' }, words: '   ' },
  ] },
  _biztools: { ignored: true },
} })
// The same call from some other provider, already normalised.
const neutral = IngestCall.parse({ format: 'speech', source: 'otter', call: {
  sessionId: 'otter-42', startedAt: at(0), participants: ['Grace Hopper', 'Ben Pollack'],
  lines: [
    { speaker: 'Grace Hopper', text: 'How does the fill line scale?', at: at(65_000) },
    { speaker: 'Ben Pollack', text: 'Batch size is the constraint.', at: at(70_000), endAt: at(80_000) },
  ],
} })

const row = (item: IngestCall, speakers = ['Ben Pollack']) => { const { source, speech } = ingestSpeech(item); return callTranscript(source, speech, speakers) }

describe('call ingest: any provider → one parser', () => {
  test('a Read.ai payload becomes a valid call row keyed on its session, with a stable call id', () => {
    const call = row(readAi)
    expect(DesktopCallTranscript.safeParse(call).success).toBe(true)
    expect(call).toMatchObject({ sessionId: '01M5JX1KZE6V6HYJ6BHQ3D1MCS', eventTime: '2026-10-22T23:01:50.000Z', filename: 'readai/01M5JX1KZE6V6HYJ6BHQ3D1MCS' })
    expect(row(readAi).callId).toBe(call.callId)
    expect(call.metadata).toMatchObject({ source: 'readai', owner_email: 'beth@example.com' })
  })

  test('lines go in spoken order, empty blocks drop, and only the learner is designated (name match ignores case and spacing)', () => {
    const call = row(readAi, ['  ben   POLLACK '])
    expect(call.utterances.map((u) => [u.speaker, u.learner])).toEqual([
      ['UNKNOWN_SPEAKER', false], ['Grace Hopper', false], ['Ben Pollack', true], ['Ben Pollack', true],
    ])
    expect(call.cleanTranscript.split('\n')[0]).toBe('(01:01) UNKNOWN_SPEAKER: Hi all.')
    expect(call).toMatchObject({ benSpoke: true, benPresent: true, benTotalSpeechSec: 15 })
    expect(call.participants).toEqual(['Grace Hopper', 'ben@example.com'])
  })

  test('the learner answers what was said before: either provider yields the same turn shape', () => {
    const fromReadAi = callTurns(row(readAi).utterances).filter((t) => t.role === 'user').map((t) => t.text)
    const fromOther = callTurns(row(neutral).utterances).filter((t) => t.role === 'user').map((t) => t.text)
    expect(fromReadAi).toEqual(['Batch size is the constraint.\nSo we split it.'])
    expect(fromOther).toEqual(['Batch size is the constraint.'])
    expect(row(neutral)).toMatchObject({ filename: 'otter/otter-42', benSpoke: true, benTotalSpeechSec: 10 })
  })

  test('a call where the learner never speaks has no learner line; no configured name means no learner at all', () => {
    expect(row(readAi, ['Someone Else']).utterances.some((u) => u.learner)).toBe(false)
    expect(row(readAi, []).benSpoke).toBe(false)
  })

  test('the wire schema accepts fields Read.ai adds: no Read.ai object forbids extra keys', () => {
    // The framework runtime validates against the JSON Schema, which (unlike zod's parse) rejects
    // unknown keys on a closed object; real payloads carry first_name, speakers, _biztools, ...
    const closed: string[] = []
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== 'object') return
      if ((node as Record<string, unknown>).additionalProperties === false) closed.push(path || '<root>')
      for (const [k, v] of Object.entries(node)) walk(v, `${path}/${k}`)
    }
    walk(z.toJSONSchema(ReadAiCallPayload), '')
    expect(closed).toEqual([])
  })
})
