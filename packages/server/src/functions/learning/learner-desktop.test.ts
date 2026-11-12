import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ServiceUnavailableError } from '@learner/core/runtime/errors.js'
import { getSpeakingCoachDesign, SPEAKING_COACH_EXPERIMENT } from './learner-desktop.function.js'

// The Speaking Coach design over HTTPS RPC, read from a fake GrowthBook: only design fields come back,
// only the read key is sent, and an outage is a prompt 503 that names the cause.
const dir = mkdtempSync(join(process.env.TMPDIR ?? '/var/tmp', 'gb-design-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const READ_KEY = 'secret_readonly_fake'
const seen: string[] = []
const fake = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname
    seen.push(`${request.headers.get('authorization')} ${path}`)
    const body: Record<string, unknown> = {
      [`/api/v1/experiments/${SPEAKING_COACH_EXPERIMENT}`]: { experiment: {
        id: SPEAKING_COACH_EXPERIMENT, trackingKey: 'monologue_streak', name: 'Coach', status: 'running', results: 'not design',
        variations: [{ variationId: '0', key: 'baseline', name: 'Toast', description: 'd' }, { variationId: '1', key: 'caw_audio', name: 'Sounds' }],
        phases: [{ name: 'old', dateStarted: '2026-09-12T00:00:00Z' }, { name: 'now', dateStarted: '2026-11-10T15:00:16Z', trafficSplit: [] }],
        settings: { goals: [{ metricId: 'fact__turn' }], secondaryMetrics: [{ metricId: 'met_legacy' }], guardrails: [] } } },
      '/api/v1/fact-metrics/fact__turn': { factMetric: { name: 'Mean turn', numerator: { factTableId: 'ftb_coach' }, denominator: { factTableId: 'ftb_coach' } } },
      '/api/v1/metrics/met_legacy': { metric: { name: 'Legacy' } },
      '/api/v1/fact-tables/ftb_coach': { factTable: { sql: 'SELECT secret', columns: [{ column: 'cue_30' }, { column: 'turn_duration_sec' }, { column: 'gone', deleted: true }] } },
    }
    return body[path] ? Response.json(body[path]) : new Response('no', { status: path.includes('down') ? 500 : 404 })
  },
})
afterAll(() => fake.stop(true))
const config = (name: string, lines: string[]) => {
  const file = join(dir, name)
  writeFileSync(file, lines.join('\n'))
  return { config: { growthbookReadEnvFile: file } } as never
}
const read = (services: never) => getSpeakingCoachDesign.func(services, {}, {} as never)

describe('getSpeakingCoachDesign', () => {
  test('returns the design only, read with the read key, and serves the cache after', async () => {
    const services = config('ok.env', [`LEARNER_GROWTHBOOK_READ_KEY=${READ_KEY}`, `LEARNER_GROWTHBOOK_READ_URL=http://127.0.0.1:${fake.port}/`])
    expect(await read(services)).toEqual({
      experimentId: SPEAKING_COACH_EXPERIMENT, trackingKey: 'monologue_streak', name: 'Coach', status: 'running',
      phase: { name: 'now', dateStarted: '2026-11-10T15:00:16Z' },
      variations: [{ key: 'baseline', name: 'Toast', description: 'd' }, { key: 'caw_audio', name: 'Sounds', description: '' }],
      metrics: [{ id: 'fact__turn', name: 'Mean turn', role: 'goal' }, { id: 'met_legacy', name: 'Legacy', role: 'secondary' }],
      variables: ['cue_30', 'turn_duration_sec'],
    })
    expect(seen.every((line) => line.startsWith(`Bearer ${READ_KEY} /api/v1/`))).toBe(true)
    const calls = seen.length
    await read(services)
    expect(seen.length).toBe(calls)
  })

  test('unconfigured, unreachable or failing GrowthBook is a 503 naming the cause', async () => {
    await expect(read(config('none.env', []))).rejects.toThrow(/LEARNER_GROWTHBOOK_READ_KEY is not in/)
    const closed = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = closed.port
    closed.stop(true)
    const down = read(config('closed.env', [`LEARNER_GROWTHBOOK_READ_KEY=${READ_KEY}`, `LEARNER_GROWTHBOOK_READ_URL=http://127.0.0.1:${port}`]))
    await expect(down).rejects.toBeInstanceOf(ServiceUnavailableError)
    await expect(down).rejects.toThrow(/did not answer experiments/)
    await expect(read(config('500.env', [`LEARNER_GROWTHBOOK_READ_KEY=${READ_KEY}`, `LEARNER_GROWTHBOOK_READ_URL=http://127.0.0.1:${fake.port}/down`]))).rejects.toThrow(/HTTP 500/)
  })

  test('a GrowthBook that never answers fails in 5 s instead of hanging', async () => {
    const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
    const started = Date.now()
    await expect(read(config('hang.env', [`LEARNER_GROWTHBOOK_READ_KEY=${READ_KEY}`, `LEARNER_GROWTHBOOK_READ_URL=http://127.0.0.1:${hang.port}`]))).rejects.toThrow(/no reply in 5 s/)
    expect(Date.now() - started).toBeLessThan(7000)
    hang.stop(true)
  }, 10_000)
})
