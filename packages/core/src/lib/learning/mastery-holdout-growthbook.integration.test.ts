import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { QueryFn } from '../../db/handle.js'
import { countedMeasurements, currentHoldoutPhase } from './mastery-change.js'
import { probeHoldoutUnits } from './mastery-change-statistics.js'
import { HOLDOUT_PROBE_FACT_COLUMNS, holdoutProbeFactSql } from './mastery-holdout-growthbook.js'
import { simulateLearner } from './mastery-known-truth.js'
import { seedSimLearner } from './mastery-known-truth-seed.js'

// GrowthBook analyses osmosis-concept-holdout from learning_blind_measurements (migration 0034, a
// copy of the server's MEASUREMENTS + probe rule) through holdoutProbeFactSql. Both must measure
// exactly what the Progress page measures, or GrowthBook reports a different experiment. Rolled back.
const six = (v: number) => Math.round(v * 1e6) / 1e6
describe.skipIf(!process.env.TEST_DATABASE_URL)('osmosis-concept-holdout in GrowthBook (learner_test)', () => {
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

  for (const [lane, k] of [['none', 3], ['fast', 3], ['fast', 1]] as const) test(`${lane}, k = ${k}: the function returns the server's prior-blind measurements, and the fact table its probe units`, async () => {
    const s = simulateLearner({ lane, seed: 5, k, concepts: 40, taughtReadMultiplier: 2, probesPerWeek: 1 })
    const phase = await currentHoldoutPhase(query)
    const startedAt = Date.parse(phase.startedAt)
    const seeded = await seedSimLearner(query, s, { phaseStartedAt: startedAt, tag: randomUUID().slice(0, 8) })

    const server = (await countedMeasurements(query, seeded.userId, { probesSince: phase.startedAt })).blind
    const fn = (await query<{ concept_id: string; evidence_at: Date; blind_percent: string; blind_gradings: number; blind_runs: number; gradings: number; probe: boolean; first_probe: boolean }>(
      'SELECT * FROM learning_blind_measurements($1, $2) ORDER BY concept_id, evidence_at', [seeded.userId, phase.startedAt])).rows
    expect(server.length).toBeGreaterThan(20)
    expect(fn.map((r) => ({ conceptId: r.concept_id, at: r.evidence_at.getTime(), percent: six(Number(r.blind_percent)), replicates: r.blind_gradings, runs: r.blind_runs, gradings: r.gradings, probe: r.probe, firstProbe: r.first_probe })))
      .toEqual(server.map((r) => ({ conceptId: r.conceptId, at: r.at, percent: six(r.percent), replicates: r.replicates!, runs: r.runs!, gradings: r.gradings!, probe: !!r.probe, firstProbe: !!r.firstProbe })))

    // At k = 1 a probe answer is an anchored grading (the concept was read before): no probe unit.
    if (k === 1) { expect(server.some((r) => r.probe)).toBe(false); return }
    const rows = (await query<Record<string, unknown> & { concept_id: string; timestamp: Date; probe_percent: number; probe_answer: number }>(holdoutProbeFactSql(seeded.userId, phase.startedAt))).rows
    expect(Object.keys(rows[0] ?? {})).toEqual([...HOLDOUT_PROBE_FACT_COLUMNS])
    const firstProbed = new Set((await query<{ c: string }>("SELECT DISTINCT probe_concept_id c FROM learning_live_feedback_turns WHERE user_id = $1 AND probe_outcome = 'delivered'", [seeded.userId])).rows.map((r) => r.c))
    const u = probeHoldoutUnits(server, firstProbed, { startedAt, isHeldOut: () => false }).units
    expect(u.length).toBeGreaterThan(5)
    const after = rows.filter((r) => r.timestamp.getTime() >= startedAt), before = rows.filter((r) => r.timestamp.getTime() < startedAt)
    const byConcept = (rs: typeof rows) => rs.map((r) => [r.concept_id, six(r.probe_percent)] as const).sort((a, b) => a[0].localeCompare(b[0]))
    expect(byConcept(after)).toEqual(u.map((x) => [x.conceptId, six(x.followUp)] as const).sort((a, b) => a[0].localeCompare(b[0])))
    expect(byConcept(before)).toEqual(u.map((x) => [x.conceptId, six(x.baseline)] as const).sort((a, b) => a[0].localeCompare(b[0])))
    expect(rows.every((r) => r.probe_answer === 1)).toBe(true)
  })

  test('the read-only GrowthBook role may read the readings view (lost when 0031 recreated it) and run the function, and still cannot read the tables behind it', async () => {
    const role = (await query<{ n: number }>("SELECT count(*)::int n FROM pg_roles WHERE rolname = 'learner_growthbook'")).rows[0]!.n
    // CI's throwaway Postgres has no such role; the migration grants only where it exists.
    if (!role) return
    const can = (await query<{ view: boolean; fn: boolean; runs: boolean; turns: boolean; receipts: boolean; definer: boolean }>(`SELECT
      has_table_privilege('learner_growthbook', 'learning_mastery_readings', 'SELECT') view,
      has_function_privilege('learner_growthbook', 'learning_blind_measurements(text, timestamptz)', 'EXECUTE') fn,
      has_table_privilege('learner_growthbook', 'learning_concept_assessment_runs', 'SELECT') runs,
      has_table_privilege('learner_growthbook', 'learning_live_feedback_turns', 'SELECT') turns,
      has_table_privilege('learner_growthbook', 'learning_concept_assessment_receipts', 'SELECT') receipts,
      (SELECT prosecdef FROM pg_proc WHERE proname = 'learning_blind_measurements') definer`)).rows[0]!
    expect(can).toEqual({ view: true, fn: true, runs: false, turns: false, receipts: false, definer: true })
  })
})
