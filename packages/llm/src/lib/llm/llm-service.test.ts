import { expect, test } from 'bun:test'
import { createLLMTraceId } from './llm-service.js'

test('an LLM trace id keeps the whole run id of its label, so the log line joins to the run', () => {
  const runId = '0f8fad5b-d9cb-469f-a165-70867728950e'
  expect(createLLMTraceId(`Learning concept assessment ${runId}`)).toStartWith(`learning-concept-assessment-${runId}-`)
})

test('the CLI rate-limit governor: off by default; a 429 pauses the pool with doubling jittered backoff, repeated 429s step the cap down', async () => {
  const { CLI_RATE_LIMITED, cliGovernorState, cliPauseMs, disableCliGovernor, enableCliGovernor, getCliMaxConcurrent, noteCliRateLimited, noteCliSuccess } = await import('./llm-limits.js')
  expect(CLI_RATE_LIMITED.test('{"type":"error","message":"exceeded retry limit, last status: 429 Too Many Requests"}')).toBe(true)
  expect(CLI_RATE_LIMITED.test('stream disconnected before completion')).toBe(false)
  // Off: the product's cap and no pause, whatever is noted.
  const productCap = getCliMaxConcurrent()
  expect(noteCliRateLimited(0)).toBe(0)
  expect(cliPauseMs(0)).toBe(0)
  expect(getCliMaxConcurrent()).toBe(productCap)
  let draw = 0.5 // jitter factor 0.5 + draw = 1
  enableCliGovernor({ max: 6, baseMs: 1000, capMs: 5000, random: () => draw })
  expect(getCliMaxConcurrent()).toBe(6)
  expect(noteCliRateLimited(0)).toBe(1000)              // first 429: pause, cap kept
  expect(cliPauseMs(400)).toBe(600)
  expect(cliGovernorState()).toMatchObject({ max: 6, streak: 1, rateLimited: 1, stepDowns: 0 })
  expect(noteCliRateLimited(0)).toBe(2000)              // repeated: doubled, and one step down
  expect(getCliMaxConcurrent()).toBe(5)
  noteCliSuccess()                                      // a success ends the streak
  expect(noteCliRateLimited(10_000)).toBe(1000)
  expect(getCliMaxConcurrent()).toBe(5)
  draw = 1                                              // jitter 1.5x, capped base
  for (let i = 0; i < 6; i++) noteCliRateLimited(10_000)
  expect(cliGovernorState()).toMatchObject({ max: 1, min: 1, rateLimited: 9 })  // never below min
  expect(cliPauseMs(10_000)).toBe(7500)                 // capMs 5000 x 1.5
  draw = 0
  expect(noteCliRateLimited(20_000)).toBe(2500)         // jitter 0.5x
  disableCliGovernor()
  expect(getCliMaxConcurrent()).toBe(productCap)
  expect(cliPauseMs(0)).toBe(0)
})
