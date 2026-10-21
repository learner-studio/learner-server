import { mock, test, expect } from 'bun:test'
import { CLASSIFIER_V6_CATALOG_HASH } from './learning-classifier-v6.js'

let cap = 1
let calls = 0
let status = 'pending'
let audit = { judged: false, classifierVersion: 6, attempts: [] }
const snapshot = {
  current: { role: 'user', authorship: 'human', text: 'Explain abstraction.' }, context: [],
}
mock.module('./learning-extraction-benchmark.js', () => ({
  loadBenchmarkCases: async () => [{ case_id: 'case1', status, judge_output: audit, input_snapshot: snapshot }],
}))
mock.module('../db-metadata/_shared.js', () => ({
  metaDbQuery: async (sql: string) => sql.includes("a->>'raw'") ? { rows: [] } : ({ rows: [{ status: 'running', config: {
    benchmarkVersion: 6, catalogHash: CLASSIFIER_V6_CATALOG_HASH,
    model: 'gpt-5.6-luna', backend: 'codex', effort: 'medium', maxBatchTokens: 200000, maxAttempts: cap,
  } }] }),
  metaDbWithClient: async (fn: (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => fn({
    query: async (sql, params = []) => {
      if (sql.startsWith('SELECT status')) return { rows: [{ status: 'running' }] }
      if (sql.startsWith('UPDATE learning_extraction_benchmark_cases SET status=$3')) {
        status = String(params[2]); audit = JSON.parse(String(params[3]))
      }
      return { rows: [], rowCount: 1 }
    },
  }),
}))
const { runClassifierV6Attempt } = await import('./learning-classifier-v6-run.js')
const llm = { callLLMWithStructuredOutput: async () => { calls++; throw new Error('Deliberately rejected output') } }

test('one-attempt budget persists failure and forbids paid calls on correction or replay', async () => {
  cap = 1; calls = 0; status = 'pending'; audit = { judged: false, classifierVersion: 6, attempts: [] }
  const first = await runClassifierV6Attempt(llm, 'run1', 1)
  expect(first.failed).toBe(1)
  expect(status).toBe('failed')
  await runClassifierV6Attempt(llm, 'run1', 1)
  for (const attempt of [2, 3, 4]) expect((await runClassifierV6Attempt(llm, 'run1', attempt)).attempted).toBe(0)
  expect(calls).toBe(1)
})

test('four-attempt default behavior still permits a bounded correction', async () => {
  cap = 4; calls = 0; status = 'pending'; audit = { judged: false, classifierVersion: 6, attempts: [] }
  await runClassifierV6Attempt(llm, 'run2', 1)
  expect(status).toBe('pending')
  await runClassifierV6Attempt(llm, 'run2', 2)
  expect(calls).toBe(2)
})
