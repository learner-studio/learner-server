import { describe, expect, test } from 'bun:test'

import {
  archiveEnvelope,
  parseAnthropicRecord,
  parseGoogleNativeRow,
  parseOpenAIRecord,
  retainVerifiedTranscriptEnvelope,
  sourceCursorMustReset,
  verifyHindsightArchiveOnlyConfig,
  type SourceIdentity,
} from './transcript-archive.js'

const source: SourceIdentity = {
  path: '/private/transcripts/session.jsonl',
  kind: 'jsonl',
  device: 7,
  inode: 11,
  generation: 0,
  offset: 219,
}

describe('Learning transcript archive envelopes', () => {
  test('preserves exact multiline Unicode text beyond 6000 characters', () => {
    const text = `  first line\n${'東京🙂é'.repeat(1_500)}\nlast line  `
    const line = JSON.stringify({
      type: 'response_item',
      timestamp: '2026-09-05T12:00:00.000Z',
      payload: {
        type: 'message', role: 'user', id: 'msg-native-1',
        content: [{ type: 'input_text', text }],
        internal_chat_message_metadata_passthrough: { turn_id: 'turn-1', content_item_kinds: ['user.text'] },
      },
    })
    const parsed = parseOpenAIRecord(line, source, 9, { sessionId: 'session-1', originator: 'codex-tui' })
    expect(parsed.turn?.message.text).toBe(text)
    expect(parsed.turn!.message.text.length).toBeGreaterThan(6_000)
    const envelope = archiveEnvelope(parsed.turn!)
    expect(JSON.parse(envelope.content).message.text).toBe(text)
  })

  test('accepts the OpenAI session_meta native id field when session_id is absent', () => {
    const parsed = parseOpenAIRecord(JSON.stringify({
      type: 'session_meta', payload: { id: 'native-session-id', originator: 'codex-tui' },
    }), source, 0, {})
    expect(parsed.state.sessionId).toBe('native-session-id')
  })

  test('rejects malformed complete JSON rather than fabricating a record', () => {
    expect(() => parseOpenAIRecord('{not-json', source, 0, {})).toThrow()
    expect(() => parseAnthropicRecord('{not-json', source, 0, {})).toThrow()
  })

  test('replay is stable while a content revision gets a new immutable document id', () => {
    const make = (text: string) => parseOpenAIRecord(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', id: 'same-native-id', content: [{ type: 'output_text', text }] },
    }), source, 10, { sessionId: 'session-1', exchangeId: 'turn-1' }).turn!
    const original = archiveEnvelope(make('exact response'))
    expect(archiveEnvelope(make('exact response'))).toEqual(original)
    expect(archiveEnvelope(make('revised response')).documentId).not.toBe(original.documentId)
  })

  test('never guesses human authorship when Anthropic provenance is absent', () => {
    const parsed = parseAnthropicRecord(JSON.stringify({
      type: 'user', sessionId: 'claude-session', uuid: 'uuid-1',
      message: { role: 'user', content: [{ type: 'text', text: 'keep me exactly' }] },
    }), source, 1, {})
    expect(parsed.turn?.message.role).toBe('user')
    expect(parsed.turn?.message.authorship).toBe('unknown')
    expect(parsed.turn?.message.text).toBe('keep me exactly')
  })

  test('fallback identity includes source generation and byte offset', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'same' }] },
    })
    const first = parseOpenAIRecord(line, source, 0, { sessionId: 's' }).turn!
    const rotated = parseOpenAIRecord(line, { ...source, generation: 1 }, 0, { sessionId: 's' }).turn!
    expect(archiveEnvelope(first).documentId).not.toBe(archiveEnvelope(rotated).documentId)
  })

  test('preserves Google native text while leaving user authorship unknown', () => {
    const varint = (value: number): number[] => {
      const bytes: number[] = []
      do { bytes.push((value & 0x7f) | (value > 0x7f ? 0x80 : 0)); value >>>= 7 } while (value)
      return bytes
    }
    const field = (number: number, text: string): number[] => {
      const bytes = [...Buffer.from(text)]
      return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes]
    }
    const input = new Uint8Array(field(2, '  Google 東京\nexact  '))
    const payload = new Uint8Array([...varint(19 * 8 + 2), ...varint(input.length), ...input])
    const metadata = new Uint8Array(field(12, 'native-google-id'))
    const parsed = parseGoogleNativeRow(
      { idx: 0, step_type: 14, metadata, step_payload: payload },
      'conversation-1', { ...source, kind: 'sqlite', offset: 0 }, {},
    )
    expect(parsed.turn?.message.text).toBe('  Google 東京\nexact  ')
    expect(parsed.turn?.message.authorship).toBe('unknown')
    expect(parsed.turn?.message.nativeId).toBe('native-google-id')
  })

  test('resets cursors on rotation or truncation but not ordinary append', () => {
    const prior = { device: 1, inode: 2, cursor: 500 }
    expect(sourceCursorMustReset(prior, { device: 1, inode: 2, size: 700 })).toBe(false)
    expect(sourceCursorMustReset(prior, { device: 1, inode: 2, size: 200 })).toBe(true)
    expect(sourceCursorMustReset(prior, { device: 1, inode: 3, size: 700 })).toBe(true)
  })

  test('uses archive-only retain fields and verifies terminal original_text before success', async () => {
    const turn = parseOpenAIRecord(JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', id: 'verify-me', content: [{ type: 'output_text', text: '終端 exact' }] },
    }), source, 0, { sessionId: 's' }).turn!
    const expected = archiveEnvelope(turn)
    const requests: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      requests.push({ url: String(input), init })
      return requests.length === 1
        ? new Response(JSON.stringify({ status: 'completed' }), { status: 200 })
        : new Response(JSON.stringify({ original_text: expected.content }), { status: 200 })
    }
    await expect(retainVerifiedTranscriptEnvelope(turn, {
      baseUrl: 'http://127.0.0.1:18925', bank: 'learning-transcript-archive-v1', fetchImpl,
    })).resolves.toEqual({ documentId: expected.documentId, contentHash: expected.contentHash })
    const retain = JSON.parse(String(requests[0]?.init?.body))
    expect(retain.async).toBe(false)
    expect(retain.items[0].update_mode).toBe('replace')
    expect(retain.items[0].provider).toBeUndefined()
    expect(retain.items[0].strategy).toBeUndefined()
    expect(requests[1]?.url).toContain('/documents/')
  })

  test('refuses to checkpoint success when terminal document text differs', async () => {
    const turn = parseOpenAIRecord(JSON.stringify({
      type: 'response_item', payload: { type: 'message', role: 'assistant', id: 'bad', content: [{ type: 'text', text: 'source' }] },
    }), source, 0, { sessionId: 's' }).turn!
    let call = 0
    const fetchImpl = async (): Promise<Response> => ++call === 1
      ? new Response('{}', { status: 200 })
      : new Response(JSON.stringify({ original_text: 'different' }), { status: 200 })
    await expect(retainVerifiedTranscriptEnvelope(turn, { baseUrl: 'http://x', bank: 'b', fetchImpl }))
      .rejects.toThrow('verification mismatch')
  })

  test('fails closed unless the effective Hindsight config is archive-only', async () => {
    const safeVersion = { api_version: '0.9.2', features: { observations: false, bank_config_api: false, store_document_text: true } }
    const safeBank = { config: { retain_extraction_mode: 'chunks', store_document_text: true, enable_observations: false, enable_auto_consolidation: false } }
    let responses = [safeVersion, safeBank]
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify(responses.shift()), { status: 200 })
    await expect(verifyHindsightArchiveOnlyConfig({ baseUrl: 'http://x', bank: 'b', fetchImpl })).resolves.toBeUndefined()
    responses = [safeVersion, { config: { ...safeBank.config, retain_extraction_mode: 'facts' } }]
    await expect(verifyHindsightArchiveOnlyConfig({ baseUrl: 'http://x', bank: 'b', fetchImpl }))
      .rejects.toThrow('archive-only/no-LLM')
  })
})
