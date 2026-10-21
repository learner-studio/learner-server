import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { scanLosslessArchiveReferences } from './lossless-archive-references.js'

const roots: string[] = []
const fixture = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'lossless-reference-'))
  roots.push(root)
  return root
}
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
const line = (value: unknown): string => `${JSON.stringify(value)}\n`

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('lossless archive reference metadata scan', () => {
  test('recognizes supported Codex image fields without returning locator text', async () => {
    const root = await fixture()
    const transcript = join(root, 'sessions', 'session.jsonl')
    const attachment = join(root, 'attachments', 'image.png')
    await mkdir(join(root, 'sessions'), { recursive: true })
    await mkdir(join(root, 'attachments'), { recursive: true })
    await writeFile(attachment, Buffer.from([0, 255, 4]))
    const uri = pathToFileURL(attachment).href
    await writeFile(transcript, line({ type: 'event_msg', payload: { item: { type: 'ImageView', path: uri } } })
      + line({ type: 'response_item', payload: { content: [{ image_url: 'data:image/png;base64,AA==' }] } }))

    const scan = await scanLosslessArchiveReferences({
      sourceId: 'source with spaces', provider: 'codex', sourcePath: transcript,
      approvedRoots: [{ id: 'all', path: root }],
    })

    expect(scan.complete).toBe(true)
    expect(scan.references).toHaveLength(2)
    expect(scan.references[0]).toMatchObject({ resolution: 'available-approved', approvedRootId: 'all', relativePath: join('attachments', 'image.png'), byteLength: 3 })
    expect(scan.references[0]?.locatorDigest).toBe(digest(uri))
    expect(scan.references[1]?.resolution).toBe('embedded')
    expect(scan.references[0]?.provenanceUri).toStartWith('archive-source://source%20with%20spaces#byte=0')
    expect(JSON.stringify(scan.gaps)).not.toContain(attachment)
    expect(JSON.stringify(scan.references.map(({ absolutePath: _absolutePath, ...safe }) => safe))).not.toContain(attachment)
  })

  test('recognizes only explicit Claude attachment and image-result shapes and emits safe gaps', async () => {
    const approved = await fixture()
    const outside = await fixture()
    const transcript = join(approved, 'conversation.jsonl')
    const present = join(approved, 'present.txt')
    const missing = join(approved, 'missing.txt')
    const escaped = join(outside, 'secret.txt')
    await writeFile(present, 'present')
    await writeFile(escaped, 'outside')
    await writeFile(transcript,
      line({ type: 'attachment', attachment: { type: 'file', path: present, files: [{ path: missing }], url: 'https://example.test/file' } })
      + line({ type: 'attachment', attachment: { type: 'compact_file_reference', path: escaped, filename: 'relative.txt' } })
      + line({ type: 'user', toolUseResult: { isImage: true, filePath: present, persistedOutputPath: missing } })
      + line({ type: 'assistant', message: { content: [{ input: { file_path: escaped } }] } }))

    const scan = await scanLosslessArchiveReferences({ sourceId: 'claude-source', provider: 'claude', sourcePath: transcript,
      approvedRoots: [{ id: 'approved', path: approved }] })

    expect(scan.references.filter((item) => item.resolution === 'available-approved')).toHaveLength(2)
    expect(scan.references.some((item) => item.resolution === 'missing')).toBe(true)
    expect(scan.references.some((item) => item.resolution === 'out-of-approved-roots')).toBe(true)
    expect(scan.references.some((item) => item.resolution === 'remote-uri')).toBe(true)
    expect(scan.references.some((item) => item.resolution === 'unsupported')).toBe(true)
    expect(scan.references).toHaveLength(7)
    expect(scan.gaps.map((gap) => gap.code)).toEqual(expect.arrayContaining([
      'missing-reference', 'out-of-approved-roots', 'remote-reference', 'unsupported-reference',
    ]))
    const safeGaps = JSON.stringify(scan.gaps)
    expect(safeGaps).not.toContain(present)
    expect(safeGaps).not.toContain(missing)
    expect(safeGaps).not.toContain(escaped)
  })

  test('keeps an independent cursor at an incomplete record boundary', async () => {
    const root = await fixture()
    const transcript = join(root, 'session.jsonl')
    const first = line({ type: 'event_msg', payload: { item: { type: 'other', padding: 'x'.repeat(25) } } })
    const second = line({ type: 'event_msg', payload: { item: { type: 'ImageView', path: 'data:image/png;base64,AA==' }, padding: 'y'.repeat(25) } })
    await writeFile(transcript, first + second)

    const scan1 = await scanLosslessArchiveReferences({ sourceId: 'cursor', provider: 'codex', sourcePath: transcript,
      approvedRoots: [{ id: 'root', path: root }], maxSourceBytes: 160, maxRecordBytes: 150 })
    expect(scan1.nextOffset).toBe(Buffer.byteLength(first))
    expect(scan1.complete).toBe(false)
    expect(scan1.gaps).toHaveLength(0)

    const scan2 = await scanLosslessArchiveReferences({ sourceId: 'cursor', provider: 'codex', sourcePath: transcript,
      approvedRoots: [{ id: 'root', path: root }], startOffset: scan1.nextOffset, maxSourceBytes: 160, maxRecordBytes: 150 })
    expect(scan2.references).toHaveLength(1)
    expect(scan2.complete).toBe(true)
  })

  test('advances across oversized and malformed records with explicit gaps', async () => {
    const root = await fixture()
    const transcript = join(root, 'session.jsonl')
    const oversized = `${'x'.repeat(180)}\n`
    const malformed = '{bad json}\n'
    const final = line({ type: 'response_item', payload: { image_url: 'data:image/png;base64,AA==' } }).trimEnd()
    await writeFile(transcript, oversized + malformed + final)

    let cursor = 0
    let discarding = false
    const codes: string[] = []
    const references: unknown[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      const scan = await scanLosslessArchiveReferences({ sourceId: 'bounded', provider: 'codex', sourcePath: transcript,
        approvedRoots: [{ id: 'root', path: root }], startOffset: cursor, discardingOversizeRecord: discarding,
        maxSourceBytes: 96, maxRecordBytes: 88 })
      cursor = scan.nextOffset
      discarding = scan.discardingOversizeRecord
      codes.push(...scan.gaps.map((gap) => gap.code))
      references.push(...scan.references)
      if (scan.complete) break
    }
    expect(cursor).toBe(Buffer.byteLength(oversized + malformed + final))
    expect(codes).toEqual(expect.arrayContaining(['oversize-record', 'malformed-record']))
    expect(references).toHaveLength(1)
  })

  test('refuses symlink attachment traversal and excludes AGY tool filesystem arguments', async () => {
    const approved = await fixture()
    const outside = await fixture()
    const target = join(outside, 'target.txt')
    const link = join(approved, 'link.txt')
    const transcript = join(approved, 'conversation.jsonl')
    await writeFile(target, 'target')
    await symlink(target, link)
    await writeFile(transcript, line({ type: 'attachment', attachment: { type: 'file', path: link } }))
    const claude = await scanLosslessArchiveReferences({ sourceId: 'link', provider: 'claude', sourcePath: transcript,
      approvedRoots: [{ id: 'root', path: approved }] })
    expect(claude.references[0]?.resolution).toBe('unsupported')
    expect(claude.gaps[0]?.code).toBe('unsupported-reference')

    await writeFile(transcript, line({ type: 'tool', AbsolutePath: resolve(approved, 'not-an-attachment') }))
    const agy = await scanLosslessArchiveReferences({ sourceId: 'agy', provider: 'antigravity', sourcePath: transcript,
      approvedRoots: [{ id: 'root', path: approved }] })
    expect(agy.references).toHaveLength(0)
    expect(agy.limitations.some((item) => item.includes('AGY'))).toBe(true)
  })

  test('advances a reference-heavy record and reports bounded truncation without starvation', async () => {
    const root = await fixture()
    const transcript = join(root, 'session.jsonl')
    await writeFile(transcript, line({ type: 'attachment', attachment: { type: 'file', files: [
      { path: join(root, 'one') }, { path: join(root, 'two') }, { path: join(root, 'three') },
    ] } }))
    const scan = await scanLosslessArchiveReferences({ sourceId: 'limit', provider: 'claude', sourcePath: transcript,
      approvedRoots: [{ id: 'root', path: root }], maxReferences: 1 })
    expect(scan.references).toHaveLength(1)
    expect(scan.gaps.filter((gap) => gap.code === 'reference-limit')).toHaveLength(1)
    expect(scan.complete).toBe(true)
  })

  test('reports invalid UTF-8 metadata as malformed while preserving cursor progress', async () => {
    const root = await fixture()
    const transcript = join(root, 'session.jsonl')
    await writeFile(transcript, Buffer.concat([
      Buffer.from('{"value":"'), Buffer.from([0xff]), Buffer.from('"}\n'),
      Buffer.from(line({ type: 'response_item', payload: { image_url: 'data:image/png;base64,AA==' } })),
    ]))
    const scan = await scanLosslessArchiveReferences({ sourceId: 'utf8', provider: 'codex', sourcePath: transcript,
      approvedRoots: [{ id: 'root', path: root }] })
    expect(scan.gaps.map((gap) => gap.code)).toContain('malformed-record')
    expect(scan.references).toHaveLength(1)
    expect(scan.complete).toBe(true)
  })

  test('bounds reported gaps and explicitly aggregates overflow', async () => {
    const root = await fixture()
    const transcript = join(root, 'session.jsonl')
    await writeFile(transcript, '{bad}\n'.repeat(400))
    const scan = await scanLosslessArchiveReferences({ sourceId: 'many-gaps', provider: 'codex', sourcePath: transcript,
      approvedRoots: [{ id: 'root', path: root }] })
    expect(scan.gaps).toHaveLength(256)
    expect(scan.gaps.at(-1)).toMatchObject({ code: 'reference-limit' })
    expect(scan.gaps.at(-1)?.reason).toContain('aggregated')
    expect(scan.complete).toBe(true)
  })
})
