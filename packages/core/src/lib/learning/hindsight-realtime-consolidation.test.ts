import { afterEach, describe, expect, test } from 'bun:test'

import {
  HINDSIGHT_REALTIME_CONSOLIDATION_DEFAULT_FACT_COUNT,
  HINDSIGHT_REALTIME_CONSOLIDATION_DEFAULT_MAX_AGE_MS,
  hindsightRealtimeConsolidationConfig,
  pollNativeConsolidation,
  submitNativeConsolidation,
} from './hindsight-realtime-consolidation.js'

const saved = { ...process.env }
afterEach(() => { process.env = { ...saved } })

describe('Hindsight realtime consolidation boundary', () => {
  test('is disabled by default while retaining conservative thresholds', () => {
    delete process.env.LEARNING_HINDSIGHT_REALTIME_CONSOLIDATION_ENABLED
    process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
    expect(hindsightRealtimeConsolidationConfig()).toMatchObject({
      enabled: false, bankId: null, baseUrl: null, factCount: HINDSIGHT_REALTIME_CONSOLIDATION_DEFAULT_FACT_COUNT,
      maxAgeMs: HINDSIGHT_REALTIME_CONSOLIDATION_DEFAULT_MAX_AGE_MS,
    })
  })

  test('submits one scoped native async request and requires its operation ID', async () => {
    const calls: Request[] = []
    const operationId = '5e2525a6-0a75-4c4c-8fde-130ea5ffc154'
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(new Request(input, init)); return new Response(JSON.stringify({ operation_id: operationId }), { status: 200 })
    }
    await expect(submitNativeConsolidation({ enabled: true, factCount: 50, maxAgeMs: 1, deadlineMs: 1, bankId: 'experiment-bank', baseUrl: 'http://native' }, 'experiment-bank', ['bt-experiment:run'], fetchImpl as typeof fetch)).resolves.toBe(operationId)
    expect(calls).toHaveLength(1)
    expect(await calls[0]!.json()).toEqual({ observation_scopes: [['bt-experiment:run']] })
  })

  test('polling accepts only a native terminal or active status', async () => {
    const operationId = '5e2525a6-0a75-4c4c-8fde-130ea5ffc154'
    const fetchImpl = async () => new Response(JSON.stringify({ status: 'completed', error_message: null }), { status: 200 })
    await expect(pollNativeConsolidation({ enabled: true, factCount: 50, maxAgeMs: 1, deadlineMs: 1, bankId: 'experiment-bank', baseUrl: 'http://native' }, 'experiment-bank', operationId, fetchImpl as unknown as typeof fetch)).resolves.toEqual({ operationId, status: 'completed', error: null })
  })
})
