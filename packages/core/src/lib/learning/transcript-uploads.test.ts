import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendUploadedTranscript, UploadTranscriptInput } from './transcript-uploads.js'

const root = mkdtempSync(join(tmpdir(), 'learner-uploads-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const chunk = (offset: number, content: string, path = 'proj/a.jsonl') =>
  ({ provider: 'claude' as const, clientId: 'laptop', path, offset, content, sha256: createHash('sha256').update(content).digest('hex') })
const file = (path = 'proj/a.jsonl') => readFileSync(join(root, 'claude', 'laptop', path), 'utf8')

describe('transcript uploads', () => {
  test('appends at the held size and replays a resent chunk without writing it twice', async () => {
    expect(await appendUploadedTranscript(root, chunk(0, '{"a":1}\n'))).toEqual({ size: 8, appended: 8, replayed: false })
    expect(await appendUploadedTranscript(root, chunk(8, '{"b":2}\n'))).toEqual({ size: 16, appended: 8, replayed: false })
    expect(await appendUploadedTranscript(root, chunk(8, '{"b":2}\n'))).toEqual({ size: 16, appended: 0, replayed: true })
    // A chunk overlapping the end appends only what is new.
    expect(await appendUploadedTranscript(root, chunk(8, '{"b":2}\n{"c":3}\n'))).toEqual({ size: 24, appended: 8, replayed: false })
    expect(file()).toBe('{"a":1}\n{"b":2}\n{"c":3}\n')
  })

  test('refuses a gap, a disagreeing chunk and a bad digest', async () => {
    await expect(appendUploadedTranscript(root, chunk(100, 'x\n', 'proj/b.jsonl'))).rejects.toThrow(/gap/)
    await appendUploadedTranscript(root, chunk(0, 'one\n', 'proj/b.jsonl'))
    await expect(appendUploadedTranscript(root, chunk(0, 'two\n', 'proj/b.jsonl'))).rejects.toThrow(/differs/)
    await expect(appendUploadedTranscript(root, { ...chunk(4, 'x\n', 'proj/b.jsonl'), sha256: '0'.repeat(64) })).rejects.toThrow(/sha256/)
    expect(file('proj/b.jsonl')).toBe('one\n')
  })

  test('only relative .jsonl paths inside the spool are accepted', () => {
    for (const path of ['../etc/passwd.jsonl', '/abs.jsonl', 'a/../b.jsonl', 'a/b.txt', 'a//b.jsonl']) {
      expect(UploadTranscriptInput.safeParse(chunk(0, '', path)).success).toBe(false)
    }
    expect(UploadTranscriptInput.safeParse(chunk(0, '', '-home-me-repo/0b9c.jsonl')).success).toBe(true)
  })
})
