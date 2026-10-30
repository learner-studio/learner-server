import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { canonicalSemanticMessage, hindsightStoredForm, LEARNING_BGE_TOKENIZER, semanticHash, semanticOperationId, tokenizeSemanticText, readHindsightIndexOperationStatus } from './learning-semantic-index.js'
import type { ExposureObservation } from './learning-exposure-schemas.js'

const observation = (text: string): ExposureObservation => ({
  schemaVersion: 1, observationId: randomUUID(), hook: 'test.canonical-index', observedAt: '2026-09-06T10:00:00.000Z',
  logicalMessageKey: `test:${randomUUID()}`, direction: 'user_to_model', stage: 'received', authorship: 'human', visibility: 'intended',
  correlation: { codexThreadId: 'canonical-real-conversation' }, parts: [{ ordinal: 0, type: 'text', text, captureStatus: 'embedded' }], gaps: [],
})

describe('canonical semantic index source identity', () => {
  test('recognizes native HTTP200 not_found before deciding whether to submit a stable retain operation', async () => {
    expect(await readHindsightIndexOperationStatus(Response.json({ operation_id: 'fac9fd3a-d3e7-40d6-abbc-67f5b298fe76', status: 'not_found' }))).toBe('not_found')
    expect(await readHindsightIndexOperationStatus(new Response('', { status: 404 }))).toBe('not_found')
    expect(await readHindsightIndexOperationStatus(Response.json({ status: 'processing' }))).toBe('processing')
    expect(await readHindsightIndexOperationStatus(Response.json({ status: 'completed' }))).toBe('completed')
    await expect(readHindsightIndexOperationStatus(Response.json({}))).rejects.toThrow()
    await expect(readHindsightIndexOperationStatus(new Response('', { status: 503 }))).rejects.toThrow('HTTP 503')
  })
  test('preserves long text beyond the canonical query preview ceiling and role provenance', () => {
    const text = 'Original user context. '.repeat(600) + 'Unique final learning claim.'
    const input = observation(text)
    const message = canonicalSemanticMessage(input, randomUUID())
    expect(message.text).toBe(text)
    expect(message.text.length).toBeGreaterThan(8192)
    expect(message.role).toBe('user')
    expect(message.conversationId).toBe('canonical-real-conversation')
    expect(message.sourceSha256).toBe(semanticHash(text))
    expect(canonicalSemanticMessage(input, message.rawVersionId).messageId).toBe(message.messageId)
    expect(canonicalSemanticMessage({ ...input, parts: [{ ...input.parts[0]!, text: `${text} revised` }] }, message.rawVersionId).messageId).not.toBe(message.messageId)
    expect(canonicalSemanticMessage({ ...input, direction: 'model_to_user', authorship: 'agent' }, message.rawVersionId).role).toBe('assistant')
  })
  test('keeps part offsets and flags omitted payloads instead of silently indexing previews', () => {
    const input = observation('🙂 first')
    input.parts.push({ ordinal: 3, type: 'text', text: 'second\n', captureStatus: 'embedded' })
    const message = canonicalSemanticMessage(input, randomUUID())
    expect(message.parts.map(part => message.text.slice(part.startOffset, part.endOffset))).toEqual(['🙂 first', 'second\n'])
    expect(canonicalSemanticMessage({ ...input, parts: [{ ordinal: 0, type: 'text', textOmitted: true, textLength: 10000, captureStatus: 'embedded' }] }, randomUUID()).unsupported).toBe(true)
  })
  test('reuses operation identity for lost acknowledgements and separates changed requests', () => {
    const id = semanticOperationId('immutable-chunk-set')
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/)
    expect(semanticOperationId('immutable-chunk-set')).toBe(id)
    expect(semanticOperationId('different-chunk-set')).not.toBe(id)
  })
})

const tokenizerTest = existsSync(LEARNING_BGE_TOKENIZER) ? test : test.skip
tokenizerTest('installed BGE tokenizer certifies every Unicode and long-message slice without dropping bytes', async () => {
  const text = '🙂 naïve 中文 code_with_underscores {"key":123} '.repeat(400) + '\n\t  Final source tail.  '
  const result = await tokenizeSemanticText(text)
  expect(result.tokenizerSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(result.chunks.length).toBeGreaterThan(10)
  expect(result.chunks.every(chunk => chunk.tokenCount <= 480)).toBe(true)
  expect(result.chunks.map(chunk => text.slice(chunk.startOffset, chunk.endOffset)).join('')).toBe(text)
  expect(result.chunks.at(-1)?.endOffset).toBe(text.length)
  expect(result.chunks.every(chunk => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text.slice(chunk.startOffset, chunk.endOffset)))).toBe(true)
}, 10000)

describe("hindsightStoredForm mirrors Hindsight's retain sanitizer", () => {
  // The vendored pattern itself, run by Python, so a Hindsight upgrade that changes it fails here.
  const wrapper = fileURLToPath(new URL('../../../../../vendor/hindsight/hindsight_api/engine/llm_wrapper.py', import.meta.url))
  const python = `import ast, json, re, sys
line = next(l for l in open(sys.argv[1]) if l.startswith('_UNSAFE_TEXT_RE = re.compile('))
pattern = re.compile(ast.literal_eval(line.split('re.compile(', 1)[1].rsplit(')', 1)[0]))
print(json.dumps([pattern.sub('', t) for t in json.load(sys.stdin)]))`
  const samples = ['reference.\f\fScore', 'tab\tnew\nline\r\nend', 'nul\u0000 bell\u0007 esc\u001b del\u007f vt\u000b',
    'emoji 😀 kept', 'lone high \ud83d here', 'lone low \ude00 here', 'plain text', '']

  test('equals the vendored Python sanitizer on control characters, CR/LF/tab and surrogates', () => {
    const run = Bun.spawnSync(['python3', '-c', python, wrapper], { stdin: Buffer.from(JSON.stringify(samples)) })
    expect(run.stderr.toString()).toBe('')
    const expected = JSON.parse(run.stdout.toString()) as string[]
    expect(samples.map(hindsightStoredForm)).toEqual(expected)
    // Positive control: the samples do exercise the stripping, and keep what must survive.
    expect(expected[0]).toBe('reference.Score')
    expect(expected[1]).toBe(samples[1])
    expect(expected[3]).toBe('emoji 😀 kept')
    expect(expected[4]).toBe('lone high  here')
  })
})
