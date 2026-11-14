import { expect, test } from 'bun:test'
import { callWithRetries, SimCallFailed, type SimTransport } from './learning-sim-model.js'
import { JUDGE_SCHEMA, judgeAccepts } from './learning-sim-judge.js'

// Review rev10-p6 R1: a schema'd reply the call's `accept` refuses is handled like an unparseable one (asked once more,
// then a non-capacity failure), so a value outside the judge's enum never becomes an insert-once receipt.
test('callWithRetries: a reply its accept check refuses is asked once more, then fails', async () => {
  const replies = (texts: string[]) => { let k = 0; return Object.assign(async () => ({ text: texts[Math.min(k++, texts.length - 1)]!, model: 'm', inputTokens: null, outputTokens: null }), { backend: 'stub' }) as SimTransport }
  const spec = { model: 'm', effort: 'low', timeoutSec: 1, runId: 'r', learnerId: 'judge', callKey: 'judge:0', role: 'judge' as const, prompt: 'p', schema: JUDGE_SCHEMA, accept: judgeAccepts }
  const call = (t: SimTransport) => callWithRetries(spec, t, {} as never, async () => {}, async () => {}, async () => {})
  expect(await call(replies(['{"states":"Yes"}', '{"states":"no"}']))).toMatchObject({ result: { text: '{"states":"no"}' }, attempts: 2 })
  const failed = await call(replies(['{"states":"maybe"}'])).catch((e: unknown) => e)
  expect(failed).toBeInstanceOf(SimCallFailed)
  expect((failed as SimCallFailed).capacity).toBe(false)
  expect((failed as SimCallFailed).final).toBe(true) // re-review B1: known, and no retry changes it
  expect(await call(replies(['{"states":"yes"}']))).toMatchObject({ attempts: 1 })
})
