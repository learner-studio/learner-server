import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { z } from 'zod'
import type { CallSpeech, DesktopCallTranscript } from '@learner/contract'
import { metaDbQuery } from '../db-metadata/_shared.js'
import { callRecord } from './call-ingest.js'
import { claimCallSpeakers, ingestCalls, listCallsNeedingAttribution, saveCallIdentity, type CallPipelineDeps } from './call-pipeline.js'

// The pipeline end to end on learner_test, with call_transcripts (the habits DB) held in memory
// and the spool in a scratch directory: what is stored, what is graded, and what a choice recovers.
describe.skipIf(!process.env.TEST_DATABASE_URL)('call pipeline (learner_test)', () => {
  type Row = z.infer<typeof DesktopCallTranscript>
  let stored: Map<string, Row>
  let root: string
  const deps = (): CallPipelineDeps => ({
    uploadRoot: root,
    habits: {
      recordCallTranscripts: async (_clientId, calls) => {
        let accepted = 0, updated = 0, unchanged = 0
        for (const c of calls) {
          const held = stored.get(c.sessionId)
          if (!held) accepted++
          else if (JSON.stringify(held) === JSON.stringify(c)) unchanged++
          else updated++
          stored.set(c.sessionId, c)
        }
        return { accepted, updated, unchanged }
      },
      callsStartingNear: async (sessionId, at, windowMs) => [...stored.values()]
        .filter((c) => c.sessionId !== sessionId && Math.abs(Date.parse(c.eventTime) - Date.parse(at)) <= windowMs)
        .map((c) => ({ sessionId: c.sessionId, title: c.meetingTitle, at: c.eventTime })),
    },
  })
  const speech = (sessionId: string, title: string, startedAt: string, speakers: string[]): CallSpeech => ({
    sessionId, title, startedAt, participants: [{ name: 'Ada Lovelace' }, { name: 'Alan Turing' }, { email: 'learner@example.com' }], isDemo: false, metadata: {},
    lines: speakers.map((speaker, i) => ({ speaker, text: `${speaker} says ${i}`, at: new Date(Date.parse(startedAt) + i * 1000).toISOString() })),
  })
  const learnerTurns = async () => {
    const dir = join(root, 'desktop', 'biztools', 'call')
    const files = await readdir(dir).catch(() => [] as string[])
    const lines = (await Promise.all(files.map((f) => readFile(join(dir, f), 'utf8')))).join('').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    return lines.filter((l) => l.type === 'user').map((l) => l.message.content)
  }
  const clean = async () => {
    await metaDbQuery(`DELETE FROM learning_call_speech`)
    await metaDbQuery(`DELETE FROM learning_call_identity`)
  }
  beforeEach(async () => {
    await clean()
    stored = new Map()
    root = await mkdtemp(join(tmpdir(), 'call-pipeline-'))
    await saveCallIdentity({ names: ['Ben Pollack'], emails: ['learner@example.com'] }, 'test')
  })
  afterAll(clean)

  test('the same meeting from a second source is set aside, not stored or graded; a resend of the first is not a duplicate', async () => {
    const first = callRecord('readai', speech('01WEBHOOK', 'Fundraising Updates', '2026-10-21T15:00:00Z', ['Ada Lovelace', 'Ben Pollack']))
    expect(await ingestCalls(deps(), 'biztools', [first])).toMatchObject({ accepted: 1, duplicates: 0 })
    const docx = callRecord('readai_docx_import_v2', speech('readai_20261021_fundraising_updates', 'Fundraising  updates', '2026-10-21T15:20:00Z', ['Ada Lovelace', 'Ben Pollack']))
    expect(await ingestCalls(deps(), 'biztools', [docx])).toMatchObject({ accepted: 0, duplicates: 1 })
    expect([...stored.keys()]).toEqual(['01WEBHOOK'])
    expect(await ingestCalls(deps(), 'biztools', [docx])).toMatchObject({ duplicates: 1 })
    expect(await ingestCalls(deps(), 'biztools', [first])).toMatchObject({ unchanged: 1, duplicates: 0 })
    expect(await learnerTurns()).toEqual(['Ben Pollack says 1'])
  })

  test('an ambiguous call waits for a person; claiming the label grades those lines, and remembering it settles the next call by name', async () => {
    const ambiguous = callRecord('readai', speech('01AMBIGUOUS', 'Fundraising Updates', '2026-10-14T15:00:00Z', ['Ada Lovelace', 'Ben (iPhone)', 'Ben (iPhone)']))
    expect(await ingestCalls(deps(), 'biztools', [ambiguous])).toMatchObject({ accepted: 1, notGraded: 1 })
    const [waiting] = await listCallsNeedingAttribution()
    expect(waiting).toMatchObject({ sessionId: '01AMBIGUOUS', attribution: 'unattributed' })
    expect(waiting!.speakers.map((s) => [s.label, s.lines])).toEqual([['Ben (iPhone)', 2], ['Ada Lovelace', 1]])

    expect(await claimCallSpeakers(deps(), { sessionId: '01AMBIGUOUS', speakers: ['Ben (iPhone)'], remember: true }, 'test')).toEqual({ reattributed: 1 })
    expect(stored.get('01AMBIGUOUS')).toMatchObject({ benSpoke: true, benTurns: 1, metadata: { attribution: 'claimed' } })
    expect(await learnerTurns()).toEqual(['Ben (iPhone) says 1\nBen (iPhone) says 2'])
    expect(await listCallsNeedingAttribution()).toEqual([])

    const next = callRecord('readai', speech('01NEXTWEEK', 'Fundraising Updates', '2026-10-21T15:00:00Z', ['Ben (iPhone)', 'Ada Lovelace']))
    await ingestCalls(deps(), 'biztools', [next])
    expect(stored.get('01NEXTWEEK')).toMatchObject({ benSpoke: true, metadata: { attribution: 'named' } })
  })

  test('a claim must name a speaker on that call', async () => {
    await ingestCalls(deps(), 'biztools', [callRecord('readai', speech('01X', 'T', '2026-10-14T15:00:00Z', ['Ada Lovelace']))])
    await expect(claimCallSpeakers(deps(), { sessionId: '01X', speakers: ['Nobody'], remember: false }, 'test')).rejects.toThrow(/not a speaker/)
  })

  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })
})
