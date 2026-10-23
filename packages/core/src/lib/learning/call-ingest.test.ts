import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { DesktopCallTranscript, IngestCall, ReadAiCallPayload, type CallSpeech } from '@learner/contract'
import { callTurns } from './learner-desktop-transcripts.js'
import { attributeSpeakers, callRecord, callTranscript, desktopSpeech, ingestSpeech, sameMeeting } from './call-ingest.js'

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
  sessionId: 'otter-42', startedAt: at(0), participants: [{ name: 'Grace Hopper' }, { name: 'Ben Pollack' }],
  lines: [
    { speaker: 'Grace Hopper', text: 'How does the fill line scale?', at: at(65_000) },
    { speaker: 'Ben Pollack', text: 'Batch size is the constraint.', at: at(70_000), endAt: at(80_000) },
  ],
} })

const row = (item: IngestCall, names = ['Ben Pollack'], emails: string[] = [], claimed: string[] | null = null) => {
  const { source, speech } = ingestSpeech(item)
  return callTranscript(callRecord(source, speech), attributeSpeakers(speech, { names, emails }, claimed))
}

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

// A Read.ai call where the learner joined by email and their lines carry no name.
const call = (participants: CallSpeech['participants'], speakers: string[]) => IngestCall.parse({ format: 'speech', source: 'readai', call: {
  sessionId: `s-${speakers.join('-')}`, startedAt: at(0), participants,
  lines: speakers.map((speaker, i) => ({ speaker, text: `line ${i} by ${speaker}`, at: at(i * 1000) })),
} })
const ben = { name: null, email: 'Learner@Example.com' }

describe('attribution: names, then a person\'s choice, then elimination', () => {
  test('the learner present by email, and every other participant speaking under their own name: the one stray label is the learner', () => {
    const r = row(call([{ name: 'Linus Pauling', email: null }, ben], ['Linus Pauling', 'UNKNOWN_SPEAKER', 'Linus Pauling']), [], ['learner@example.com'])
    expect(r.utterances.filter((u) => u.learner).map((u) => u.speaker)).toEqual(['UNKNOWN_SPEAKER'])
    expect(r.metadata).toMatchObject({ attribution: 'inferred', learner_speakers: ['UNKNOWN_SPEAKER'] })
    expect(r).toMatchObject({ benPresent: true, benSpoke: true })
  })

  test('a silent participant could own the stray label too, so nothing is inferred: present, unattributed, not graded', () => {
    const r = row(call([ben, { name: 'Alan Turing', email: null }, { name: 'Ada Lovelace', email: null }], ['Ada Lovelace', 'UNKNOWN_SPEAKER']), [], ['learner@example.com'])
    expect(r.metadata.attribution).toBe('unattributed')
    expect(r).toMatchObject({ benPresent: true, benSpoke: false })
  })

  test('two stray labels are ambiguous even when everyone else is accounted for', () => {
    const r = row(call([{ name: 'Linus Pauling', email: null }, ben], ['Linus Pauling', 'UNKNOWN_SPEAKER', 'Conference Room']), [], ['learner@example.com'])
    expect(r.metadata.attribution).toBe('unattributed')
  })

  test('a person\'s choice for the call beats names and inference; an empty choice means the learner did not speak', () => {
    const speech = call([{ name: 'Linus Pauling', email: null }, ben], ['Linus Pauling', 'Ben Pollack', 'UNKNOWN_SPEAKER'])
    expect(row(speech, ['Ben Pollack'], [], ['UNKNOWN_SPEAKER']).utterances.filter((u) => u.learner).map((u) => u.speaker)).toEqual(['UNKNOWN_SPEAKER'])
    expect(row(speech, ['Ben Pollack'], [], []).benSpoke).toBe(false)
    expect(row(speech, ['Ben Pollack']).metadata.attribution).toBe('named')
  })

  test('nobody matching the identity is absent, not unattributed', () => {
    const r = row(call([{ name: 'Linus Pauling', email: null }], ['Linus Pauling', 'UNKNOWN_SPEAKER']), ['Ben Pollack'], ['learner@example.com'])
    expect(r.metadata.attribution).toBe('absent')
    expect(r.benPresent).toBe(false)
  })

  test('a device-attributed row is re-attributed by the server rules, keeping its call id and filename', () => {
    const device = DesktopCallTranscript.parse({
      callId: '0b7f6d64-2f53-4c6f-9d0f-5b0b6f0c9a11', sessionId: 'readai_20261022_acme_sync', filename: '2026-10-22 - Acme Sync.docx',
      meetingTitle: 'Acme Sync', eventTime: at(0), participants: ['Grace Hopper', 'learner@example.com'], isDemo: false, callCategory: 'work', cleanTranscript: 'x',
      utterances: [{ speaker: 'Grace Hopper', text: 'Scale?', at: at(0), learner: true }, { speaker: 'Ben Pollack', text: 'Batch size.', at: at(1000), learner: false }],
      metadata: { source: 'readai_docx_import_v2' },
    })
    const speech = desktopSpeech(device)
    const r = callTranscript(callRecord('readai_docx_import_v2', speech, device.callId), attributeSpeakers(speech, { names: ['Ben Pollack'], emails: [] }, null))
    expect(r.utterances.map((u) => [u.speaker, u.learner])).toEqual([['Grace Hopper', false], ['Ben Pollack', true]])
    expect(r).toMatchObject({ callId: device.callId, filename: device.filename, callCategory: 'work' })
    expect(speech.participants).toEqual([{ name: 'Grace Hopper', email: null }, { name: null, email: 'learner@example.com' }])
  })
})

describe('sameMeeting: one meeting from two sources', () => {
  const webhook = { title: 'Globex / Initech POC Sync', at: '2026-09-03T21:02:10Z' }
  test('the same title, spelled with other punctuation and case, starting within the window', () => {
    expect(sameMeeting(webhook, { title: 'globex _ initech poc sync', at: '2026-09-03T21:00:00Z' })).toBe(true)
  })
  test('a recurring meeting a day later, another title, or no title at all is a different meeting', () => {
    expect(sameMeeting(webhook, { title: webhook.title, at: '2026-09-04T21:00:00Z' })).toBe(false)
    expect(sameMeeting(webhook, { title: 'Acme Sync', at: webhook.at })).toBe(false)
    expect(sameMeeting({ title: ' ', at: webhook.at }, { title: '', at: webhook.at })).toBe(false)
  })
})
