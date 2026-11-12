import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { rpcService } from '@pikku/core/rpc'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import {
  addWeeks, currentWindow, jsonbRoundTrip, panelBlindDrift, panelGraderKey, planWeek, regradePanelItem, resolveWindow, selectDriftPanel, summarizeWeek, weekOf, windowGroups,
} from '@learner/core/lib/learning/grader-drift-panel.js'
import { ensureWeekRun } from '@learner/server/functions/learning/learning-drift-panel.function.js'
import { incrementalVariant, priorBlindPrompt } from '@learner/core/lib/learning/learning-incremental-assessment.js'
import { LIVE_INCREMENTAL_VARIANT } from '@learner/core/lib/learning/learning-live-incremental-variant.js'
import { loadLearningPolicy, saveLearningPolicy } from '@learner/core/lib/learning/learning-policy-settings.js'
import { FALLBACK_ANCHORED_SD, FALLBACK_BLIND_SD, graderNoise, type GraderNoiseComponents } from '@learner/core/lib/learning/grader-noise.js'
import { holdoutReport, masteryChanges } from '@learner/core/lib/learning/mastery-change.js'
import { masteryNotifications } from '@learner/core/lib/learning/mastery-notifications.js'
import { readReactiveGradingHealth } from '@learner/core/lib/learning/learning-reactive-health.js'
import { LearningConceptAssessmentService } from '@learner/core/services/learning-concept-assessment.js'
import { purgeDriftFixtures, seedDriftReading } from './fixtures/drift-seed.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * learningDriftPanelWorkflow end to end under the framework runtime, on this checkout's OWN database
 * (own-test-database.ts) and its own queue schema: queued steps on pg-boss, the SHIPPED grading
 * call (LearningConceptAssessmentService.gradePrepared: validator, one repair retry) with a fake model.
 * Every text is synthetic. Fixture learners have per-run ids; weeks are per run, so reruns never collide.
 */
const url = await ownTestDatabaseUrl('drift')
const BOSS_SCHEMA_PREFIX = 'learner_pikku_boss_test_drift_'

/** A fake model for the incremental prompt: cites the first human message, a grade fixed by the prompt's evidence and the call count. */
const fakeModel = () => {
  const state = { calls: 0 }
  const llm = {
    async callLLMWithStructuredOutput(params: { prompt: string; parseFn: (value: unknown) => unknown; callOptions?: { onUsage?: (u: Record<string, unknown>) => void } }) {
      state.calls++
      const evidence = JSON.parse(params.prompt.slice(params.prompt.indexOf('\n', params.prompt.indexOf('### NEW EVIDENCE')) + 1)) as Array<{ id: string; role: string; text: string }>
      const concept = JSON.parse(params.prompt.slice(params.prompt.indexOf('\n', params.prompt.indexOf('### CONCEPT')) + 1, params.prompt.indexOf('\n\n### CURRENT'))) as Array<{ conceptId: string }>
      const human = evidence.find((e) => e.role === 'user')!
      const percent = 5 * ((parseInt(createHash('sha256').update(human.text).digest('hex').slice(0, 4), 16) % 12) + 2)
      params.callOptions?.onUsage?.({ inputTokens: Math.ceil(params.prompt.length / 4), outputTokens: 100 })
      return params.parseFn(JSON.stringify({ proposals: [{ conceptId: concept[0]!.conceptId, understandingPercent: percent, confidence: 'medium',
        demonstrated: [{ description: 'synthetic', sourceId: human.id, quote: human.text.slice(0, 12) }], gaps: [], nextCheck: 'synthetic', needsReview: true }] }))
    },
  }
  return { state, llm }
}

const NOISE: GraderNoiseComponents = {
  blind: { sd: FALLBACK_BLIND_SD, df: 329, groups: 100, source: 'measured' },
  anchored: { sd: FALLBACK_ANCHORED_SD, df: 501, groups: 100, source: 'measured' },
  drift: { gradings: 0, meanMove: null, sdMove: null, equal: null, up: null, down: null },
  blindDrift: { perWeek: 0, interval: [-0.1, 0.1], gradings: 100, groups: 40, sxxWeeks2: 1e4 },
}

describe.skipIf(!url)('drift panel workflow, framework runtime (learner_drift_test_<checkout>)', () => {
  const fake = fakeModel()
  const runtime = bootRuntime({ databaseUrl: url!, schemaPrefix: BOSS_SCHEMA_PREFIX, prepare: async (services) => {
    // The shipped grading service, on the fake model.
    services.learningConceptAssessment = new LearningConceptAssessmentService(services.learningCurriculumStore, fake.llm as never)
    // This checkout's database only: drop the drift fixtures any earlier run left (a killed run skips its afterAll),
    // since the weekly run regrades EVERY panel.
    await purgeDriftFixtures(services.db.query.bind(services.db) as never, 'drift-%')
    const { updatedAt: _, ...policy } = await loadLearningPolicy()
    priorPolicy = policy
  } })
  const booted = runtime.booted
  let priorPolicy: Parameters<typeof saveLearningPolicy>[0] | null = null
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await (await booted).db.query(sql, params)) as unknown as { rows: T[]; rowCount: number }
  const query = ((sql: string, params?: unknown[]) => q(sql, params)) as never

  // Weeks of their own for this run (a Monday 1000+ weeks back plus a random offset), so the week keys never collide across runs.
  const base = addWeeks('2000-01-03', Math.floor(Math.random() * 5000))
  const week = (n: number) => addWeeks(base, n)
  const user = `drift-${randomUUID()}`

  afterAll(async () => {
    const services = await booted
    if (priorPolicy) await saveLearningPolicy(priorPolicy, 'drift-panel-test')
    await purgeDriftFixtures(services.db.query.bind(services.db) as never, user)
    await runtime.stop()
  }, 60_000)

  const seedReading = async (userId: string, i: number, percent: number, opts: { shape?: 'live' | 'v5' } = {}) => (await seedDriftReading(q, userId, i, percent, opts)).runId
  const runWeek = async (w: string) => {
    const runId = await runtime.start('learningDriftPanelWorkflow', { week: w })
    const run = await runtime.awaitRun(runId)
    expect(run?.inline).toBeFalsy()
    return { run: run!, steps: await (await booted).workflowRunService.getRunSteps(runId) }
  }
  const setPolicy = async (update: { driftPanel?: boolean; driftPanelCallCap?: number }) => saveLearningPolicy(update, 'drift-panel-test')
  // Everything that reads readings, for the exclusion proofs: the same `now` and noise before and after.
  const now = new Date()
  const consumers = async (userId: string) => ({
    changes: await masteryChanges(query, userId, { sinceDays: null }, now, NOISE),
    notifications: await masteryNotifications(query, userId, { since: null, limit: 100 }),
    holdout: await holdoutReport(query, userId, NOISE, now),
    growthbook: (await q(`SELECT * FROM learning_blind_measurements($1, $2::timestamptz) ORDER BY concept_id, evidence_at`, [userId, '2000-01-01'])).rows,
    stallReading: (await readReactiveGradingHealth(userId, query, now)).grading.lastReadingAt,
    assessmentRows: (await q(`SELECT (SELECT count(*) FROM learning_concept_assessment_runs WHERE user_id=$1) runs,
      (SELECT count(*) FROM learning_concept_assessment_receipts t JOIN learning_concept_assessment_runs r USING (run_id) WHERE r.user_id=$1) receipts,
      (SELECT count(*) FROM learning_concept_assessment_replicates p JOIN learning_concept_assessment_runs r USING (run_id) WHERE r.user_id=$1) replicates,
      (SELECT count(*) FROM learning_concept_assessment_replicate_summaries s JOIN learning_concept_assessment_runs r USING (run_id) WHERE r.user_id=$1) summaries`, [userId])).rows,
  })

  let before: Awaited<ReturnType<typeof consumers>>
  test('selection: stratified over the eligible readings, stored once, never re-chosen', async () => {
    await booted
    for (let i = 0; i < 12; i++) await seedReading(user, i, [10, 30, 50, 70][i % 4]!)
    await seedReading(user, 99, 50, { shape: 'v5' }) // not the live prompt shape: never a candidate
    const first = await selectDriftPanel(query, user, 8)
    expect(first).toMatchObject({ created: true, size: 8, candidates: 12 })
    const items = (await q<{ item: number; source_run_id: string; level: number }>('SELECT item, source_run_id, level FROM learning_drift_panel_items WHERE user_id=$1 ORDER BY item', [user])).rows
    expect(items.map((i) => i.level).sort()).toEqual([0, 0, 1, 1, 2, 2, 3, 3])
    // More readings later change nothing: the stored panel is returned as it is.
    await seedReading(user, 50, 90)
    expect(await selectDriftPanel(query, user, 8)).toMatchObject({ created: false, size: 8, candidates: 12, selectedAt: first.selectedAt })
    expect((await q('SELECT item, source_run_id, level FROM learning_drift_panel_items WHERE user_id=$1 ORDER BY item', [user])).rows).toEqual(items)
    before = await consumers(user)
  }, 60_000)

  test('two selections at once: one stores the panel, the other gets it, and both see the same items', async () => {
    const other = `drift-${randomUUID()}`
    for (let i = 0; i < 6; i++) await seedReading(other, i, 20 * (i % 5))
    const [a, b] = await Promise.all([selectDriftPanel(query, other, 4), selectDriftPanel(query, other, 4)])
    expect([a.created, b.created].sort()).toEqual([false, true])
    expect(a.selectedAt).toBe(b.selectedAt)
    expect((await q('SELECT count(*)::int n FROM learning_drift_panel_items WHERE user_id=$1', [other])).rows[0]).toEqual({ n: 4 })
    await purgeDriftFixtures(query as never, other)
  }, 60_000)

  let window0 = 0
  test('week 0 through the real workflow: one durable step per item, the shipped grading call, results in the panel table only', async () => {
    await setPolicy({ driftPanel: true, driftPanelCallCap: 60 })
    // A fresh window for this run: another grader first, then the live one again (also the restart path).
    await resolveWindow(query, week(0), incrementalVariant(['A different instruction paragraph for the test.']))
    const live = await resolveWindow(query, week(0))
    expect(live.started).toBe(true)
    window0 = live.windowId
    const calls = fake.state.calls
    const { run, steps } = await runWeek(week(0))
    expect(run.status).toBe('completed')
    expect(run.output).toMatchObject({ week: week(0), enabled: true, planned: 8, overCap: 0, completed: 8, failed: 0, uncertain: 0, calls: 8 })
    expect(fake.state.calls - calls).toBe(8)
    // The framework names a repeated step `name`, `name#1`, ... : one durable step per item.
    expect(steps.filter((s) => s.stepName.startsWith('Regrade one panel item prior-blind') && s.status === 'succeeded')).toHaveLength(8)
    // Step names are fixed text: no user id reaches the stored run or its tooling.
    expect([...new Set(steps.map((s) => s.stepName.replace(/#\d+$/, '')))].sort()).toEqual(['Count this week of regrades', 'Plan this week of panel regrades', 'Regrade one panel item prior-blind'])
    const rows = (await q<{ status: string; percent: string; window_id: string; prompt_revision: string }>('SELECT status, percent, window_id, prompt_revision FROM learning_drift_panel_regrades WHERE user_id=$1 AND week=$2::date', [user, week(0)])).rows
    expect(rows.every((r) => r.status === 'completed' && r.percent !== null && Number(r.window_id) === window0 && r.prompt_revision === LIVE_INCREMENTAL_VARIANT.revision)).toBe(true)
  }, 120_000)

  test('exclusions: readings, notifications, holdout, GrowthBook facts and the stall alarm\'s reading are unchanged by the regrades', async () => {
    const after = await consumers(user)
    expect(after.changes).toEqual(before.changes)
    expect(after.notifications).toEqual(before.notifications)
    expect(after.holdout).toEqual(before.holdout)
    expect(after.growthbook).toEqual(before.growthbook)
    expect(after.stallReading).toEqual(before.stallReading)
    expect(after.assessmentRows).toEqual(before.assessmentRows)
    // The fixtures are real readings (the comparison is not of empty sets).
    expect(before.growthbook.length).toBeGreaterThan(0)
    // GrowthBook's read-only role, where it exists, can read none of the panel's tables.
    const role = (await q('SELECT 1 FROM pg_roles WHERE rolname = $1', ['learner_growthbook'])).rowCount
    if (role) for (const t of ['learning_drift_panels', 'learning_drift_panel_items', 'learning_drift_panel_regrades', 'learning_drift_panel_windows'])
      expect((await q<{ ok: boolean }>(`SELECT has_table_privilege('learner_growthbook', $1, 'SELECT') ok`, [t])).rows[0]!.ok).toBe(false)
  }, 60_000)

  test('idempotent per item and week: a second run of the same week regrades nothing and pays nothing', async () => {
    const calls = fake.state.calls
    const { run } = await runWeek(week(0))
    expect(run.output).toMatchObject({ planned: 0, completed: 8, calls: 8 })
    expect(await regradePanelItem(query, (await booted).learningConceptAssessment as never, { userId: user, item: 0, week: week(0), windowId: window0 })).toMatchObject({ status: 'completed', calls: 1 })
    expect(fake.state.calls).toBe(calls)
  }, 120_000)

  test('an orphaned reservation (owner gone): uncertain while the backend is metered, then finished once when it is repeat-free (restart safety)', async () => {
    // No lease and older than the insert grace: written by a process that is gone.
    await q(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model, reserved_at) VALUES ($1, 3, $2::date, $3, 'r', 'm', now() - interval '1 hour')`, [user, week(41), window0])
    const calls = fake.state.calls
    const grader = (await booted).learningConceptAssessment as never
    process.env.LEARNER_METERED_BACKENDS = 'codex'
    try {
      for (let i = 0; i < 2; i++) expect((await regradePanelItem(query, grader, { userId: user, item: 3, week: week(41), windowId: window0 })).status).toBe('uncertain')
    } finally { delete process.env.LEARNER_METERED_BACKENDS }
    expect(fake.state.calls).toBe(calls)
    // Recorded, and its started call counted as spend.
    expect((await q('SELECT status, calls FROM learning_drift_panel_regrades WHERE user_id=$1 AND item=3 AND week=$2::date', [user, week(41)])).rows[0]).toEqual({ status: 'uncertain', calls: 1 })
    // 'uncertain' is not final: on a repeat-free backend (codex, a local child) the next replay finishes the call, once.
    for (let i = 0; i < 2; i++) expect(await regradePanelItem(query, grader, { userId: user, item: 3, week: week(41), windowId: window0 })).toMatchObject({ status: 'completed', calls: 1 })
    expect(fake.state.calls).toBe(calls + 1)
    expect((await q(`SELECT action FROM learning_llm_attempt_reclaims WHERE attempt_key=$1`, [`drift:${user}:3:${week(41)}`])).rows).toEqual([{ action: 'takeover' }])
    await q('DELETE FROM learning_drift_panel_regrades WHERE user_id=$1 AND week=$2::date', [user, week(41)])
  })

  test('a failed week leaves reservations without an outcome: the page names them, and the next run of the week plans them first and finishes them (review round 3, R3-B1)', async () => {
    // The page reads on the Thursday of week 43; it counts only that open week's reservations over a day old.
    const at = new Date(Date.parse(`${week(43)}T12:00:00Z`) + 3 * 86_400_000)
    const reserve = (item: number, status: string | null, ageMs = 2 * 86_400_000, w = week(43)) => q(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model, status, calls, reserved_at)
      VALUES ($1, $2, $3::date, $4, 'r', 'm', $5, $6, $7::timestamptz)`, [user, item, w, window0, status, status ? 1 : null, new Date(at.getTime() - ageMs)])
    await reserve(4, null)
    await reserve(5, 'uncertain')
    await reserve(6, null, 3_600_000) // fresh: still in flight, not unhealed (review round 4, S2)
    await reserve(4, null, 9 * 86_400_000, week(42)) // a past week's miss is accepted, not unhealed (review round 4, S1)
    expect((await panelBlindDrift(query, FALLBACK_BLIND_SD, at)).panel.unfinished).toBe(2)
    // The run's lease reads reserved_at against the real clock: back to two days ago in real time, probes gone.
    await q(`DELETE FROM learning_drift_panel_regrades WHERE user_id=$1 AND (week=$2::date OR item=6)`, [user, week(42)])
    await q(`UPDATE learning_drift_panel_regrades SET reserved_at = now() - interval '2 days' WHERE user_id=$1 AND week=$2::date`, [user, week(43)])
    expect((await planWeek(query, week(43), 2)).items).toEqual([{ userId: user, item: 4 }, { userId: user, item: 5 }])
    const calls = fake.state.calls
    expect((await runWeek(week(43))).run.output).toMatchObject({ planned: 8, completed: 8, uncertain: 0, reserved: 0 })
    expect(fake.state.calls - calls).toBe(8)
    expect((await panelBlindDrift(query, FALLBACK_BLIND_SD, at)).panel.unfinished).toBe(0)
    await q('DELETE FROM learning_drift_panel_regrades WHERE user_id=$1 AND week=$2::date', [user, week(43)])
  }, 120_000)

  test('the call cap bounds the gradings a run starts, counting the week\'s earlier ones; off, nothing runs', async () => {
    await setPolicy({ driftPanelCallCap: 3 })
    const calls = fake.state.calls
    const first = await runWeek(week(1))
    expect(first.run.output).toMatchObject({ planned: 3, overCap: 5, completed: 3 })
    expect(fake.state.calls - calls).toBe(3)
    expect(await planWeek(query, week(1), 3)).toMatchObject({ items: [], overCap: 5, alreadyThisWeek: 3 })
    await setPolicy({ driftPanel: false, driftPanelCallCap: 60 })
    const off = await runWeek(week(2))
    expect(off.run.output).toMatchObject({ enabled: false, planned: 0, completed: 0 })
    expect(fake.state.calls - calls).toBe(3)
    await setPolicy({ driftPanel: true })
  }, 240_000)

  test('drift: withheld (no interval) until 4 weekly runs, then measured; the page learns when to expect it', async () => {
    const grader = (await booted).learningConceptAssessment as never
    // Week 1 has 3 items so far (the cap): finish it, and week 2, directly. Week 0 is done.
    for (const w of [1, 2]) for (let item = 0; item < 8; item++) await regradePanelItem(query, grader, { userId: user, item, week: week(w), windowId: window0 })
    const at = (w: number) => new Date(Date.parse(week(w)) + 86_400_000)
    const three = await panelBlindDrift(query, FALLBACK_BLIND_SD, at(2))
    // Other runs of this file left other learners' panels; only this run's window counts, so the weeks are this run's.
    expect(three.panel.window?.id).toBe(window0)
    expect([three.panel.weeks, three.drift.interval, three.panel.boundExpectedWeek, three.panel.fullWindowWeek]).toEqual([3, null, week(3), week(7)])
    for (let item = 0; item < 8; item++) await regradePanelItem(query, grader, { userId: user, item, week: week(3), windowId: window0 })
    const four = await panelBlindDrift(query, FALLBACK_BLIND_SD, at(3))
    expect(four.panel.weeks).toBe(4)
    expect(four.drift.interval).not.toBeNull()
    expect([four.panel.boundExpectedWeek, four.panel.fullWindowWeek]).toEqual([null, week(7)])
    // graderNoise, which every page and verdict reads, takes its drift from the panel and passes the panel's state on.
    const noise = await graderNoise(query)
    expect(noise.driftPanel?.window?.id).toBe(window0)
    expect(noise.blindDrift).toEqual((await panelBlindDrift(query, noise.blind.sd)).drift)
    // The fake grades each item the same every week: no drift, and the interval says so.
    expect(four.drift.perWeek).toBeCloseTo(0, 9)
  }, 120_000)

  test('a prompt revision or model change starts a new window: the old regrades no longer count, and the change is recorded', async () => {
    const other = incrementalVariant(['Another made-up instruction paragraph.'])
    const changed = await resolveWindow(query, week(5), other)
    expect(changed.started).toBe(true)
    const recorded = (await q<{ reason: string; grader_key: string }>('SELECT reason, grader_key FROM learning_drift_panel_windows WHERE window_id=$1', [changed.windowId])).rows[0]!
    expect(recorded).toEqual({ reason: `grader changed from ${panelGraderKey()}`, grader_key: panelGraderKey(other) })
    // The code's grader is still the live one, so it has no window now: unmeasured.
    expect((await panelBlindDrift(query, FALLBACK_BLIND_SD)).drift.interval).toBeNull()
    // A planned item of the old window is skipped, never graded under the wrong grader.
    expect((await regradePanelItem(query, (await booted).learningConceptAssessment as never, { userId: user, item: 0, week: week(5), windowId: window0 })).status).toBe('skipped')
    const back = await resolveWindow(query, week(6))
    expect(back.windowId).toBeGreaterThan(changed.windowId)
    const fresh = await panelBlindDrift(query, FALLBACK_BLIND_SD)
    expect([fresh.panel.window?.id, fresh.panel.weeks, fresh.drift.interval]).toEqual([back.windowId, 0, null])
    // A change mid-week: one item was already regraded that week under the old grader. The new window's
    // fit must not pool it, even though the week is one the new window also has.
    await q(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model, status, percent, calls, completed_at)
      VALUES ($1, 1, $2::date, $3, 'old', 'old', 'completed', 50, 1, now())`, [user, week(6), window0])
    expect((await regradePanelItem(query, (await booted).learningConceptAssessment as never, { userId: user, item: 0, week: week(6), windowId: back.windowId })).status).toBe('completed')
    const pooled = await windowGroups(query, back.windowId, week(6))
    expect([pooled.groups.length, pooled.weeks]).toEqual([1, [week(6)]])
  }, 60_000)

  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  const sourcePrompt = async (item: number) => (await q<{ prompt: string }>(`SELECT r.snapshot->>'prompt' prompt FROM learning_drift_panel_items i
    JOIN learning_concept_assessment_runs r ON r.run_id = i.source_run_id WHERE i.user_id=$1 AND i.item=$2`, [user, item])).rows[0]!.prompt
  const live = async () => (await resolveWindow(query, week(20))).windowId

  test('the bytes sent to the grader are the bytes selection verified, every field kept; a tampered item is refused before any call (review B1)', async () => {
    const real = (await booted).learningConceptAssessment as { gradePrepared: (input: { prompt: string }, label: string) => Promise<unknown> }
    const sent: string[] = []
    const spy = { gradePrepared: (input: { prompt: string }, label: string) => (sent.push(input.prompt), real.gradePrepared(input, label)) }
    const w = await live()
    expect((await regradePanelItem(query, spy as never, { userId: user, item: 1, week: week(20), windowId: w })).status).toBe('completed')
    expect(sha(sent[0]!)).toBe(sha(priorBlindPrompt(await sourcePrompt(1))))
    for (const field of ['"authorship"', '"sourceVersion"', '"sourceOrder"', '"logicalKey"', '"correlation"']) expect(sent[0]).toContain(field)
    // Item 2 loses a field in storage: refused, recorded failed with no call, and the reason kept.
    await q(`UPDATE learning_drift_panel_items SET ingredients = jsonb_set(ingredients, '{evidence,0}', (ingredients #> '{evidence,0}') - 'authorship') WHERE user_id=$1 AND item=2`, [user])
    const calls = fake.state.calls
    expect(await regradePanelItem(query, spy as never, { userId: user, item: 2, week: week(20), windowId: w })).toMatchObject({ status: 'failed', calls: 0 })
    expect(fake.state.calls).toBe(calls)
    expect(sent).toHaveLength(1)
    expect((await q(`SELECT status, calls, receipt->>'status' kind, receipt->>'error' error FROM learning_drift_panel_regrades WHERE user_id=$1 AND item=2 AND week=$2::date`, [user, week(20)])).rows[0])
      .toEqual({ status: 'failed', calls: 0, kind: 'refused', error: 'evidence sections differ from the verified prior-blind prompt' })
  }, 60_000)

  test('a replay while the call is in flight waits for it instead of stamping uncertain: paid once, one outcome (review S1, restart safety)', async () => {
    const real = (await booted).learningConceptAssessment as { gradePrepared: (input: unknown, label: string) => Promise<unknown> }
    let entered!: () => void
    const inCall = new Promise<void>((resolve) => { entered = resolve })
    const slow = { gradePrepared: async (input: unknown, label: string) => { entered(); await Bun.sleep(300); return real.gradePrepared(input, label) } }
    const w = await live()
    const first = regradePanelItem(query, slow as never, { userId: user, item: 3, week: week(21), windowId: w })
    await inCall
    // The live owner holds the lease: the replay waits for its outcome.
    expect((await regradePanelItem(query, real as never, { userId: user, item: 3, week: week(21), windowId: w })).status).toBe('completed')
    expect((await first).status).toBe('completed')
    const row = (await q<{ status: string; percent: string | null; calls: number }>('SELECT status, percent, calls FROM learning_drift_panel_regrades WHERE user_id=$1 AND item=3 AND week=$2::date', [user, week(21)])).rows[0]!
    expect([row.status, row.percent !== null, row.calls]).toEqual(['completed', true, 1])
  }, 60_000)

  test('a grading that throws is recorded failed and the week goes on; a completed grading without a score stays completed (review S3)', async () => {
    const w = await live()
    const throws = { gradePrepared: async () => { throw new Error('backend exploded') } }
    expect(await regradePanelItem(query, throws as never, { userId: user, item: 4, week: week(22), windowId: w })).toMatchObject({ status: 'failed', calls: 1 })
    expect((await q(`SELECT status, receipt->>'error' error FROM learning_drift_panel_regrades WHERE user_id=$1 AND item=4 AND week=$2::date`, [user, week(22)])).rows[0])
      .toEqual({ status: 'failed', error: 'grading threw: Error: backend exploded' })
    const noScore = { gradePrepared: async () => ({ status: 'completed', assessment: { understandingPercent: null } }) }
    expect(await regradePanelItem(query, noScore as never, { userId: user, item: 5, week: week(22), windowId: w })).toMatchObject({ status: 'completed', percent: null })
    // A grading whose answer needed the validator's repair retry cost two calls.
    const retried = { gradePrepared: async () => ({ status: 'completed', assessment: { understandingPercent: 40 }, validatorRetry: { kind: 'repair' } }) }
    expect(await regradePanelItem(query, retried as never, { userId: user, item: 6, week: week(26), windowId: w })).toMatchObject({ status: 'completed', percent: 40, calls: 2 })
    // A database error while building the input is recorded as a refusal (no call), never thrown out of the step.
    const flaky = ((sql: string, params?: unknown[]) => sql.includes('JOIN learning_concept_assessment_runs r ON r.run_id = i.source_run_id') ? Promise.reject(new TypeError('connection reset')) : query(sql, params)) as never
    const before = fake.state.calls
    expect(await regradePanelItem(flaky, (await booted).learningConceptAssessment as never, { userId: user, item: 7, week: week(26), windowId: w })).toMatchObject({ status: 'failed', calls: 0 })
    expect(fake.state.calls).toBe(before)
    expect((await q(`SELECT receipt->>'error' error FROM learning_drift_panel_regrades WHERE user_id=$1 AND item=7 AND week=$2::date`, [user, week(26)])).rows[0]).toEqual({ error: 'could not build the input: TypeError' })
    // An outstanding reservation shows in the week's count as reserved.
    await q(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model) VALUES ($1, 6, $2::date, $3, 'r', 'm')`, [user, week(22), w])
    expect(await summarizeWeek(query, week(22))).toMatchObject({ completed: 1, failed: 1, reserved: 1 })
  }, 60_000)

  test('through the workflow, a refused item does not end the week; a failed week run is retried by the next call (review S3)', async () => {
    await live()
    const services = await booted
    const rpc = rpcService.getContextRPCService(services, {}, false)
    // Item 2 is still tampered (above): the week completes with it recorded failed.
    const { run } = await runWeek(week(23))
    expect(run.status).toBe('completed')
    expect(run.output).toMatchObject({ planned: 8, completed: 7, failed: 1 })
    const a = await ensureWeekRun(services.workflowService as never, rpc, week(23), { type: 'internal' })
    expect(a.existing).toBe(true)
    await q(`UPDATE learner_workflow_runs SET status='failed' WHERE workflow='learningDriftPanelWorkflow' AND input::jsonb->>'week'=$1`, [week(23)])
    const b = await ensureWeekRun(services.workflowService as never, rpc, week(23), { type: 'internal' })
    expect(b.existing).toBe(false)
    let again = await services.workflowRunService.getRun(b.workflowRunId)
    for (const deadline = Date.now() + 60_000; again && again.status === 'running' && Date.now() < deadline;) { await Bun.sleep(300); again = await services.workflowRunService.getRun(b.workflowRunId) }
    // The retry regrades only what is still pending: nothing, so it pays nothing.
    expect(again?.output).toMatchObject({ planned: 0, completed: 7, failed: 1 })
  }, 120_000)

  test('under the cap learners take turns, in an order that rotates weekly: none is starved (review S2)', async () => {
    const others = [`drift-${randomUUID()}`, `drift-${randomUUID()}`]
    for (const other of others) { for (let i = 0; i < 4; i++) await seedReading(other, i, 20 * i); await selectDriftPanel(query, other, 4) }
    const plan = await planWeek(query, week(24), 6)
    const share = (items: Array<{ userId: string }>, who: string) => items.filter((x) => x.userId === who).length
    expect([user, ...others].map((who) => share(plan.items, who))).toEqual([2, 2, 2])
    // Each learner's share is its first items, the same ones every week (what a within-item slope needs).
    expect(plan.items.filter((x) => x.userId === others[0]).map((x) => x.item)).toEqual([0, 1])
    // A cap below one round: in any 3 consecutive weeks each of the 3 learners goes first exactly once, in a fixed turn.
    const firsts: string[] = []
    for (let n = 30; n < 36; n++) firsts.push((await planWeek(query, week(n), 1)).items[0]!.userId)
    expect(new Set(firsts.slice(0, 3)).size).toBe(3)
    expect(firsts.slice(3)).toEqual(firsts.slice(0, 3))
    for (const other of others) await purgeDriftFixtures(query as never, other)
  }, 120_000)

  test('the rolling window takes the LATEST 8 weeks with a score; a stale window is withheld; per-band drift is reported (review S4, S6)', async () => {
    const w = await live()
    const at = (n: number) => new Date(Date.parse(week(n)) + 86_400_000)
    for (let n = 40; n < 50; n++) for (let item = 0; item < 8; item++)
      await q(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model, status, percent, calls, completed_at)
        VALUES ($1, $2, $3::date, $4, 'r', 'm', 'completed', $5, 1, now())`, [user, item, week(n), w, 30 + 5 * item + (n % 3)])
    // A completed grading without a score is no data point: its week does not enter the window.
    await q(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model, status, percent, calls, completed_at)
      VALUES ($1, 0, $2::date, $3, 'r', 'm', 'completed', NULL, 1, now())`, [user, week(50), w])
    const g = await windowGroups(query, w, week(20))
    expect(g.weeks).toEqual(Array.from({ length: 8 }, (_, k) => week(42 + k)))
    const fresh = await panelBlindDrift(query, FALLBACK_BLIND_SD, at(50))
    expect([fresh.panel.stale, fresh.drift.interval !== null]).toEqual([false, true])
    expect(fresh.panel.bands.map((b) => b.level)).toEqual([0, 1, 2, 3])
    expect(fresh.panel.bandsDisagree).toBe(false)
    // Two weeks without a run is still current; three is stale.
    expect((await panelBlindDrift(query, FALLBACK_BLIND_SD, at(51))).panel.stale).toBe(false)
    // Three weeks with no new run (panel off, or runs failing): the old slope no longer clears verdicts.
    const stale = await panelBlindDrift(query, FALLBACK_BLIND_SD, at(52))
    expect([stale.panel.stale, stale.drift.interval]).toEqual([true, null])
  }, 120_000)

  test('a window of another grader key measures nothing and grades nothing, even with weeks of data (review N1: m19, m21)', async () => {
    const other = incrementalVariant(['Yet another made-up instruction paragraph.'])
    const changed = (await resolveWindow(query, week(60), other)).windowId
    for (let n = 60; n < 65; n++) for (let item = 0; item < 4; item++)
      await q(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model, status, percent, calls, completed_at)
        VALUES ($1, $2, $3::date, $4, 'r', 'm', 'completed', $5, 1, now())`, [user, item, week(n), changed, 40 + n])
    const now = new Date(Date.parse(week(64)) + 86_400_000)
    const d = await panelBlindDrift(query, FALLBACK_BLIND_SD, now)
    expect([d.panel.window, d.drift.interval]).toEqual([null, null])
    // The current window's id, but not the code's grader: skipped, no call.
    const calls = fake.state.calls
    expect((await regradePanelItem(query, (await booted).learningConceptAssessment as never, { userId: user, item: 5, week: week(65), windowId: changed })).status).toBe('skipped')
    expect(fake.state.calls).toBe(calls)
    await resolveWindow(query, week(66))
    // A window recorded under the first build's key (no input revision: the stripped-input week) is another grader.
    await q(`INSERT INTO learning_drift_panel_windows(grader_key, prompt_revision, model, started_week, reason) VALUES ($1, $2, $3, $4::date, 'first build')`,
      [`${LIVE_INCREMENTAL_VARIANT.revision}|${(await currentWindow(query))!.model}`, LIVE_INCREMENTAL_VARIANT.revision, (await currentWindow(query))!.model, week(67)])
    expect((await panelBlindDrift(query, FALLBACK_BLIND_SD)).panel.window).toBeNull()
    const restarted = await resolveWindow(query, week(68))
    expect(restarted.started).toBe(true)
  }, 60_000)

  test('jsonbRoundTrip orders keys exactly as Postgres jsonb does', async () => {
    const value = { b: 1, aa: 2, a: 3, B: 4, ab: { zz: 1, y: 2, Z: 3, é: 4, e: 5 }, é: 5, Z: [{ kk: 1, k: 2 }] }
    const db = (await q<{ v: string }>('SELECT $1::jsonb::text v', [JSON.stringify(value)])).rows[0]!.v
    expect(JSON.stringify(JSON.parse(db))).toBe(JSON.stringify(jsonbRoundTrip(value)))
  })

  test('week of: the run in progress names this Monday', () => {
    expect(weekOf(new Date('2026-11-12T08:00:00Z'))).toBe('2026-11-09')
  })
})
