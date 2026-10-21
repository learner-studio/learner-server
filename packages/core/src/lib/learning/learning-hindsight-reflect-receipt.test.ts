import { test, expect } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeReflectQuery, readOptionalPrivateJson, validateNativeReflectHttp, writeImmutablePrivateJson } from './learning-hindsight-reflect-receipt.js'

const context = { nodeStates: [{ conceptId: 'concept', nodeVersion: 'a'.repeat(64), understandingPercent: null }], humanTextBySourceId: { human: 'Queues decouple producers from consumers.' } }
const proposal = { conceptId: 'concept', nodeVersion: 'a'.repeat(64), understandingPercent: null, confidence: 'insufficient', demonstrated: [], gaps: [{ kind: 'untested', description: 'Application is untested.', sourceId: null, quote: null }], nextCheck: 'Explain a queue tradeoff.', needsReview: true }

test('reflect prompt includes the exact nullable domain schema inside the done answer contract', () => {
  const prompt = nativeReflectQuery(context, [], [])
  expect(prompt).toContain('done.answer')
  expect(prompt).toContain('"anyOf"')
  expect(prompt).toContain('"const":true')
  expect(prompt).toContain('"conceptId"')
})

test('validates native JSON against exact node/source constraints without fence or quote repair', () => {
  const response = JSON.stringify({ text: JSON.stringify({ proposals: [proposal] }) })
  expect(validateNativeReflectHttp(200, response, context).proposals).toHaveLength(1)
  expect(() => validateNativeReflectHttp(200, JSON.stringify({ text: '```json\n{}\n```' }), context)).toThrow()
  expect(() => validateNativeReflectHttp(200, JSON.stringify({ text: JSON.stringify({ proposals: [{ ...proposal, understandingPercent: '50' }] }) }), context)).toThrow()
  expect(() => validateNativeReflectHttp(200, JSON.stringify({ text: JSON.stringify({ proposals: [{ ...proposal, demonstrated: [{ description: 'Borrowed answer.', sourceId: 'assistant', quote: 'Queues' }] }] }) }), context)).toThrow('Unknown human source')
})

test('raw failures remain immutable and corrupt receipts never become missing receipts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'learning-reflect-receipt-test-'))
  try {
    const path = join(dir, 'raw.json')
    expect(await readOptionalPrivateJson(path)).toBeNull()
    await writeImmutablePrivateJson(path, { status: 200, responseText: 'not JSON' })
    expect(() => validateNativeReflectHttp(200, 'not JSON', context)).toThrow()
    expect(await readFile(path, 'utf8')).toContain('not JSON')
    await expect(writeImmutablePrivateJson(path, { overwritten: true })).rejects.toThrow()
    const invalid = join(dir, 'bad.json')
    // Deliberately invalid bytes are a test fixture, not a production repair path.
    const { writeFile } = await import('node:fs/promises')
    await writeFile(invalid, '{')
    await expect(readOptionalPrivateJson(invalid)).rejects.toThrow()
  } finally { await rm(dir, { recursive: true, force: true }) }
})
