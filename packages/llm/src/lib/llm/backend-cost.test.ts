import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repeatIsFree } from './backend-cost.js'

// Repeat-free is decided by how the CLI is billed right now, not by its name (review S1).
const home = (mode: string) => { const dir = mkdtempSync(join(root, 'codex-')); writeFileSync(join(dir, 'auth.json'), JSON.stringify({ auth_mode: mode })); return dir }
const root = mkdtempSync(join(tmpdir(), 'backend-cost-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

test('a subscription CLI is repeat-free; the same CLI on a per-token API key is metered', () => {
  expect(repeatIsFree('codex', { CODEX_HOME: home('chatgpt') })).toBe(true)
  expect(repeatIsFree('codex', { CODEX_HOME: home('apikey') })).toBe(false)
  expect(repeatIsFree('codex', { CODEX_HOME: home('chatgpt'), OPENAI_API_KEY: 'x' })).toBe(false)
  expect(repeatIsFree('claude', {})).toBe(true)
  expect(repeatIsFree('claude', { ANTHROPIC_API_KEY: 'x' })).toBe(false)
  expect(repeatIsFree('gemini', { GEMINI_API_KEY: 'x' })).toBe(false)
  expect(repeatIsFree('agy', {})).toBe(true)
  expect(repeatIsFree('stub', {})).toBe(true) // the simulator's in-process stub calls no provider
})

test('unknown backends, and any the operator declares metered, are never repeated', () => {
  expect(repeatIsFree('typesafe', {})).toBe(false)
  expect(repeatIsFree(null, {})).toBe(false)
  expect(repeatIsFree('claude', { LEARNER_METERED_BACKENDS: 'codex, Claude' })).toBe(false)
})
