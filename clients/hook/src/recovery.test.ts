import { expect, test } from 'bun:test'
import { retryTransient } from './recovery.js'

// A learner-api restart refuses connections for a few seconds; an idempotent submit is retried across it.
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms } } }
const refused = () => Object.assign(new Error('Unable to connect'), { name: 'ConnectionRefused' })

test('transient failures during a restart are retried until the server answers', async () => {
  let calls = 0
  const c = clock()
  expect(await retryTransient(async () => { if (++calls < 4) throw refused(); return 'ok' }, c)).toBe('ok')
  expect(calls).toBe(4)
})

test('HTTP 5xx is transient; a 4xx or a validation error is not retried', async () => {
  let calls = 0
  await expect(retryTransient(async () => { calls++; throw new Error('HTTP 400: bad input') }, clock())).rejects.toThrow('HTTP 400')
  expect(calls).toBe(1)
  calls = 0
  expect(await retryTransient(async () => { if (++calls < 2) throw new Error('HTTP 502: bad gateway'); return 1 }, clock())).toBe(1)
})

test('the retry is bounded: a server that stays down fails within the budget', async () => {
  const c = clock()
  let calls = 0
  await expect(retryTransient(async () => { calls++; throw refused() }, { ...c, budgetMs: 45_000 })).rejects.toThrow('Unable to connect')
  expect(c.now()).toBeLessThanOrEqual(45_000)
  expect(calls).toBeGreaterThan(5)
})
