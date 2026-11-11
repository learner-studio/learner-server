import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { QueryFn } from '../../db/handle.js'
import { FALLBACK_ANCHORED_SD, FALLBACK_BLIND_SD, type GraderNoiseComponents } from './grader-noise.js'
import { countedMeasurements, currentHoldoutPhase, holdoutReport, masteryChanges } from './mastery-change.js'
import { aggregateChange, conceptChanges, evidenceNoise, holdoutEffect, measurementNoise, probeHoldoutReadings, probeHoldoutUnits, type CountedReading } from './mastery-change-statistics.js'
import { simMeasurements, simulateLearner } from './mastery-known-truth.js'
import { seedSimLearner } from './mastery-known-truth-seed.js'

// The known-truth study's learners written as real rows (mastery-known-truth-seed.ts) and read back
// through the server's own SQL: what the database measures must be exactly what the simulator says
// it measured, or the four-lane e2e would be checking a different learner. Rolled back.
const NOISE: GraderNoiseComponents = {
  blind: { sd: FALLBACK_BLIND_SD, df: 329, groups: 100, source: 'measured' },
  anchored: { sd: FALLBACK_ANCHORED_SD, df: 501, groups: 100, source: 'measured' },
  drift: { gradings: 0, meanMove: null, sdMove: null, equal: null, up: null, down: null },
  blindDrift: { perWeek: 0, interval: [-0.1, 0.1], gradings: 100, groups: 40, sxxWeeks2: 1e4 },
}
/** Equal up to summation order: numbers to 9 significant digits. */
const round = (v: unknown): unknown => typeof v === 'number' ? Number(v.toPrecision(9)) : Array.isArray(v) ? v.map(round)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x)])) : v
describe.skipIf(!process.env.TEST_DATABASE_URL)('known-truth learners seeded as rows (learner_test)', () => {
  let client: Client
  let query: QueryFn
  beforeEach(async () => {
    client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    await client.query('BEGIN')
    query = (async (text: string, params?: ReadonlyArray<unknown>) => {
      const r = await client.query(text, params ? [...params] : [])
      return { rows: r.rows, rowCount: r.rowCount ?? 0 }
    }) as QueryFn
  })
  afterEach(async () => { await client.query('ROLLBACK'); await client.end() })

  for (const k of [1, 3]) test(`k = ${k}: the server's SQL measures exactly what the simulator measured, and computes the same statistics`, async () => {
    const s = simulateLearner({ lane: 'fast', seed: 11, k, concepts: 40, taughtReadMultiplier: 2, probesPerWeek: 0.25 })
    const phase = await currentHoldoutPhase(query)
    const seeded = await seedSimLearner(query, s, { phaseStartedAt: Date.parse(phase.startedAt), tag: randomUUID().slice(0, 8) })
    const toDb = (r: CountedReading) => ({ ...r, conceptId: seeded.concepts.get(r.conceptId)!, at: r.at + seeded.origin })
    const sim = simMeasurements(s)
    const key = (r: CountedReading) => `${r.conceptId}@${r.at}`
    const shape = (rs: CountedReading[]) => rs.map((r) => ({ key: key(r), percent: Math.round(r.percent * 1e6) / 1e6, replicates: r.replicates, runs: r.runs ?? 1, gradings: r.gradings, probe: !!r.probe, firstProbe: !!r.firstProbe })).sort((a, b) => a.key.localeCompare(b.key))
    const db = await countedMeasurements(query, seeded.userId, { probesSince: phase.startedAt })
    expect(db.blind.length).toBeGreaterThan(20)
    expect(shape(db.blind)).toEqual(shape(sim.blind.map(toDb)))
    expect(shape(db.anchored)).toEqual(shape(sim.anchored.map(toDb)))
    // At k = 1 a probe answer is blind only when it is the concept's first reading; the shapes above already match the simulator's.
    expect(db.blind.some((r) => r.probe)).toBe(sim.blind.some((r) => r.probe))
    if (k > 1) expect(db.blind.some((r) => r.firstProbe)).toBe(true)

    // The statistics over the database equal the statistics over the simulator's own measurements.
    const now = new Date(seeded.end)
    // Uncited readings were seeded (dated by their learner messages' 75th percentile) and still land on the simulated time.
    expect((await query<{ n: string }>(`SELECT count(*) n FROM learning_mastery_readings WHERE user_id = $1 AND evidence_basis = 'evidence_set'`, [seeded.userId])).rows[0]!.n).not.toBe('0')
    const out = await masteryChanges(query, seeded.userId, { sinceDays: null }, now, NOISE)
    const noise = measurementNoise(FALLBACK_BLIND_SD, evidenceNoise(sim.blind.map(toDb), FALLBACK_BLIND_SD))
    expect(out.noise.evidenceSd).toBe(noise.evidenceSd)
    expect(round(out.aggregate)).toEqual(round(aggregateChange(conceptChanges(sim.blind.map(toDb), noise), { drift: NOISE.blindDrift, promptRevisions: out.aggregate.nConcepts ? 1 : 0 })))
    const report = await holdoutReport(query, seeded.userId, NOISE, now)
    const assignment = { startedAt: Date.parse(phase.startedAt), isHeldOut: (id: string) => [...seeded.concepts].some(([simId, dbId]) => dbId === id && s.heldOut.has(simId)) }
    const firstProbed = new Set(s.readings.filter((r) => r.probe).map((r) => seeded.concepts.get(r.conceptId)!))
    const probeReadings = probeHoldoutReadings(sim.blind.map(toDb), firstProbed, assignment)
    const u = probeHoldoutUnits(sim.blind.map(toDb), firstProbed, assignment)
    const pairs = conceptChanges(probeReadings, noise).map((c) => ({ baseline: c.from, followUp: c.to }))
    if (!sim.blind.some((r) => r.firstProbe)) expect(report.probe).toBeNull()
    else expect(round(report.probe)).toEqual(round(holdoutEffect(u.units, u, 0.2, pairs, { adjustForGradings: false, adjustForElapsed: true, now: now.getTime() })))
  })
})
