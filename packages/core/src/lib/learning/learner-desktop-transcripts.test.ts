import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exposureIsVisible } from '../../services/learning-exposure-service.js'
import { projectCliExposureRecord } from './learning-exposure-cli.js'
import { callTurns, desktopSpoolRoot, desktopTranscriptLines, writeDesktopTranscript } from './learner-desktop-transcripts.js'

const project = (line: string, i: number) =>
  projectCliExposureRecord('claude', JSON.parse(line), { sourceId: 'src', versionId: 'v', sourceOrder: i })

describe('learner-desktop transcripts', () => {
  test('call utterances: the learner is the human user, everyone else is labelled context', () => {
    const turns = callTurns([
      { speaker: 'Ana Ruiz', text: 'Can you walk us through it?', at: '2026-10-01T10:00:01Z', learner: false },
      { speaker: 'Ben Pollack', text: 'Sure.', at: '2026-10-01T10:00:05Z', learner: true },
      { speaker: 'Ben Pollack', text: 'Next point.', at: '2026-10-01T10:00:09Z', learner: true },
      { speaker: 'Ana Ruiz', text: 'Thanks', at: '2026-10-01T11:02:03Z', learner: false },
    ])
    expect(turns.map((t) => t.role)).toEqual(['assistant', 'user', 'assistant'])
    expect(turns[1]!.text).toBe('Sure.\nNext point.')
    expect(turns[0]!.text).toBe('Ana Ruiz: Can you walk us through it?')
  })

  test('call context points forward to the learner turn it prompted; a chat reply points back', () => {
    const turns = callTurns([
      { speaker: 'Ana', text: 'Question one?', at: '2026-10-01T10:00:00Z', learner: false },
      { speaker: 'Raj', text: 'And a follow-up.', at: '2026-10-01T10:00:02Z', learner: false },
      { speaker: 'Ben', text: 'Answer.', at: '2026-10-01T10:00:05Z', learner: true },
      { speaker: 'Ana', text: 'Thanks.', at: '2026-10-01T10:00:09Z', learner: false },
    ])
    const call = desktopTranscriptLines('ben-mbp', 'call', 'c1', turns).lines.map((l) => JSON.parse(l))
    expect(call[0].parentUuid).toBe(call[2].uuid)
    expect(call[1].parentUuid).toBe(call[2].uuid)
    // After the last learner turn there is nothing to answer: the plain chain.
    expect(call[3].parentUuid).toBe(call[2].uuid)
    const chat = desktopTranscriptLines('ben-mbp', 'chat', 'd1', [
      { role: 'user', text: 'Q', at: '2026-10-01T10:00:00Z' }, { role: 'assistant', text: 'A', at: '2026-10-01T10:00:01Z' },
    ]).lines.map((l) => JSON.parse(l))
    expect(chat[1].parentUuid).toBe(chat[0].uuid)
  })

  test('spooled lines project into visible, human-authored observations — the input scoring reads', () => {
    const { lines } = desktopTranscriptLines('ben-mbp', 'chat', 'ai-vault:chatgpt:abc', [
      { role: 'user', text: 'How does a B-tree split?', at: '2026-10-01T10:00:00Z' },
      { role: 'assistant', text: 'When a node overflows…', at: '2026-10-01T10:00:05Z' },
    ])
    const [user, assistant] = lines.map(project)
    expect(user).toMatchObject({ direction: 'user_to_model', authorship: 'human', stage: 'received' })
    expect(assistant).toMatchObject({ direction: 'model_to_user', authorship: 'agent' })
    expect(exposureIsVisible(user!)).toBe(true)
    expect(exposureIsVisible(assistant!)).toBe(true)
  })

  test('append-only: a grown document appends; an edited one gets a revision file; a resend is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'desktop-spool-'))
    const a = { role: 'user' as const, text: 'one', at: '2026-10-01T10:00:00Z' }
    const b = { role: 'assistant' as const, text: 'two', at: '2026-10-01T10:00:01Z' }
    expect((await writeDesktopTranscript(root, 'ben-mbp', 'chat', 'd1', [a])).status).toBe('created')
    expect((await writeDesktopTranscript(root, 'ben-mbp', 'chat', 'd1', [a])).status).toBe('unchanged')
    const grown = await writeDesktopTranscript(root, 'ben-mbp', 'chat', 'd1', [a, b])
    expect(grown.status).toBe('appended')
    expect((await readFile(grown.file, 'utf8')).trim().split('\n')).toHaveLength(2)
    expect((await writeDesktopTranscript(root, 'ben-mbp', 'chat', 'd1', [{ ...a, text: 'edited' }, b])).status).toBe('revised')
    const dir = join(desktopSpoolRoot(root), 'ben-mbp', 'chat')
    expect((await readdir(dir)).filter((n) => n.endsWith('.jsonl'))).toHaveLength(2)
    // Nothing half-written ever sits inside the archived root.
    expect((await readdir(dir)).some((n) => n.endsWith('.tmp'))).toBe(false)
  })
})
