import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { sql } from 'kysely'

import { getKysely } from '../db.js'
import { LearningTranscriptArchiveService } from './learning-transcript-archive-service.js'

const cleanupPaths: string[] = []
const cleanupRows: string[] = []

afterEach(async () => {
  const kysely = await getKysely()
  for (const path of cleanupRows.splice(0)) {
    await sql`DELETE FROM learning_transcript_archive_checkpoints WHERE source_path = ${path}`.execute(kysely)
  }
  for (const path of cleanupPaths.splice(0)) await rm(path, { recursive: true, force: true })
})

/**
 * Stands in for Hindsight: answers the archive-only safety probe as a correctly
 * configured server would, and fails any other call. These tests are about
 * checkpoints, so they must never reach the real archive on :18925.
 */
const fakeHindsight = async (input: string): Promise<Response> => {
  if (input.endsWith('/version')) {
    return Response.json({ api_version: '0.9.2', features: { observations: false, bank_config_api: false, store_document_text: true } })
  }
  if (input.endsWith('/config')) {
    return Response.json({ config: { retain_extraction_mode: 'chunks', store_document_text: true, enable_observations: false, enable_auto_consolidation: false } })
  }
  throw new Error(`unexpected Hindsight call in a checkpoint test: ${input}`)
}

const fixtureService = async (openaiContent: string, maxBytesPerSource = 4 * 1024 * 1024) => {
  const root = await mkdtemp(join(tmpdir(), 'learning-archive-scan-'))
  cleanupPaths.push(root)
  const openaiRoot = join(root, 'openai')
  const anthropicRoot = join(root, 'anthropic')
  const googleRoot = join(root, 'google')
  await Promise.all([mkdir(openaiRoot), mkdir(anthropicRoot), mkdir(googleRoot)])
  const sourcePath = join(openaiRoot, 'session.jsonl')
  cleanupRows.push(sourcePath)
  await writeFile(sourcePath, openaiContent, { mode: 0o600 })
  const kysely = await getKysely()
  return {
    kysely,
    sourcePath,
    service: new LearningTranscriptArchiveService(kysely, {
      baseUrl: 'http://127.0.0.1:18925',
      bank: 'learning-transcript-archive-v1',
      openaiRoot,
      anthropicRoot,
      googleRoot,
      maxSourcesPerRun: 1,
      maxMessagesPerRun: 1,
      maxBytesPerSource,
      fetchImpl: fakeHindsight,
    }),
  }
}

const checkpoint = async (sourcePath: string) => {
  const kysely = await getKysely()
  const result = await sql<{ sourceCursor: string; lastError: string | null }>`
    SELECT source_cursor AS "sourceCursor", last_error AS "lastError"
      FROM learning_transcript_archive_checkpoints
     WHERE source_path = ${sourcePath}
  `.execute(kysely)
  return result.rows[0]
}

describe('LearningTranscriptArchiveService JSONL checkpoints', () => {
  test('pins a new source at the malformed complete line and durably records the error', async () => {
    const fixture = await fixtureService('{not-json}\n')
    const result = await fixture.service.scan()
    expect(result.errors).toHaveLength(1)
    const stored = await checkpoint(fixture.sourcePath)
    expect(Number(stored?.sourceCursor)).toBe(0)
    expect(stored?.lastError).toContain('Malformed complete JSONL record at byte 0')
  })

  test('does not mistake a fixed read boundary for EOF after advancing an earlier line', async () => {
    const first = `${JSON.stringify({ type: 'session_meta', payload: { id: 's', padding: 'x'.repeat(200) } })}\n`
    const second = JSON.stringify({ harmless: true })
    const third = '{}\n'
    const fixture = await fixtureService(`${first}${second}\n${third}`, Buffer.byteLength(first + second))
    const result = await fixture.service.scan()
    expect(result.errors).toEqual([])
    const stored = await checkpoint(fixture.sourcePath)
    expect(Number(stored?.sourceCursor)).toBe(Buffer.byteLength(first))
  })
})
