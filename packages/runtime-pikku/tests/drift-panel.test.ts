import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { rpcService } from '@pikku/core/rpc'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { driftTestDatabaseUrl } from '@learner/core/lib/learning/grader-drift-panel.test-db.js'
import {
  addWeeks, jsonbRoundTrip, panelBlindDrift, panelGraderKey, planWeek, regradePanelItem, resolveWindow, selectDriftPanel, weekOf, windowGroups,
} from '@learner/core/lib/learning/grader-drift-panel.js'
import { ASSESSMENT_MODEL } from '@learner/core/lib/learning/learning-concept-assessment.js'
import { buildIncrementalAssessmentInput, incrementalVariant } from '@learner/core/lib/learning/learning-incremental-assessment.js'
import { LIVE_INCREMENTAL_VARIANT } from '@learner/core/lib/learning/learning-live-incremental-variant.js'
import { loadLearningPolicy, saveLearningPolicy } from '@learner/core/lib/learning/learning-policy-settings.js'
import { FALLBACK_ANCHORED_SD, FALLBACK_BLIND_SD, graderNoise, type GraderNoiseComponents } from '@learner/core/lib/learning/grader-noise.js'
import { holdoutReport, masteryChanges } from '@learner/core/lib/learning/mastery-change.js'
import { masteryNotifications } from '@learner/core/lib/learning/mastery-notifications.js'
import { readReactiveGradingHealth } from '@learner/core/lib/learning/learning-reactive-health.js'
import { LearningConceptAssessmentService } from '@learner/core/services/learning-concept-assessment.js'

/**
 * learningDriftPanelWorkflow end to end under the framework runtime, on this checkout's OWN database
 * (grader-drift-panel.test-db.ts) and its own queue schema: queued steps on pg-boss, the SHIPPED grading
 * call (LearningConceptAssessmentService.gradePrepared: validator, one repair retry) with a fake model.
 * Every text is synthetic. Fixture learners have per-run ids; weeks are per run, so reruns never collide.
 */
const url = await driftTestDatabaseUrl()
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

/**
 * Remove fixture learners' panel rows (LIKE pattern on the user id). Their readings stay: assessment runs and
 * receipts are immutable by trigger, and without a panel they are never regraded.
 */
async function purgeFixtures(query: (sql: string, params?: unknown[]) => Promise<unknown>, users: string) {
  for (const t of ['learning_drift_panel_regrades', 'learning_drift_panel_items', 'learning_drift_panels']) await query(`DELETE FROM ${t} WHERE user_id LIKE $1`, [users])
}

const NOISE: GraderNoiseComponents = {
  blind: { sd: FALLBACK_BLIND_SD, df: 329, groups: 100, source: 'measured' },
  anchored: { sd: FALLBACK_ANCHORED_SD, df: 501, groups: 100, source: 'measured' },
  drift: { gradings: 0, meanMove: null, sdMove: null, equal: null, up: null, down: null },
  blindDrift: { perWeek: 0, interval: [-0.1, 0.1], gradings: 100, groups: 40, sxxWeeks2: 1e4 },
}

describe.skipIf(!url)('drift panel workflow, framework runtime (learner_drift_test_<checkout>)', () => {
  process.env.LEARNER_DATABASE_URL = url!
  process.env.DATABASE_URL = url!
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  const bossSchema = `${BOSS_SCHEMA_PREFIX}${Math.floor(Date.now() / 1000)}_${randomUUID().slice(0, 8)}`
  process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = bossSchema
  delete process.env.LEARNER_SCHEDULES_ENABLED
  setRuntimeRole('learning-worker')
  const fake = fakeModel()
  const booted = (async () => {
    await import('../.pikku/pikku-bootstrap.gen.js')
    const { createConfig } = await import('../src/config.js')
    const { createSingletonServices } = await import('../src/services.js')
    const services = await createSingletonServices(await createConfig())
    // The shipped grading service, on the fake model.
    ;(services as { learningConceptAssessment: unknown }).learningConceptAssessment = new LearningConceptAssessmentService(services.learningCurriculumStore, fake.llm as never)
    // This checkout's database only: drop the drift fixtures any earlier run left (a killed run skips its afterAll),
    // since the weekly run regrades EVERY panel.
    await purgeFixtures(services.db.query.bind(services.db) as never, 'drift-%')
    const { updatedAt: _, ...policy } = await loadLearningPolicy()
    priorPolicy = policy
    await services.backgroundJobs.start()
    return services
  })()
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
    await purgeFixtures(services.db.query.bind(services.db) as never, user)
    await services.backgroundJobs.stop()
    const { Client } = await import('pg')
    const client = new Client({ connectionString: url! })
    await client.connect()
    try {
      const stale = (await client.query<{ name: string }>(`SELECT nspname AS name FROM pg_namespace WHERE starts_with(nspname, $1)`, [BOSS_SCHEMA_PREFIX])).rows
        .map((r) => r.name).filter((name) => name === bossSchema || Number(name.slice(BOSS_SCHEMA_PREFIX.length).split('_')[0]) < Date.now() / 1000 - 3600)
      for (const name of stale) await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
    } finally { await client.end() }
  }, 60_000)

  /** One past prior-blind reading as the live grader leaves it: run (digest by trigger) and completed receipt. */
  const seedReading = async (userId: string, i: number, percent: number, opts: { shape?: 'live' | 'v5' } = {}) => {
    const conceptId = `drift-c${i}-${userId.slice(6, 14)}`
    const concept = jsonbRoundTrip({ conceptId, title: `Synthetic concept ${i}`, description: 'Made up for the drift panel test.', objectives: ['explain', 'apply'] })
    const evidence = [jsonbRoundTrip({ id: `m-${i}-${userId}`, role: 'user', text: `Synthetic learner message number ${i} about caching`, occurredAt: '2026-11-02T10:00:00.000Z', conversationId: 'conv' })]
    const built = buildIncrementalAssessmentInput(concept, evidence, null, [], LIVE_INCREMENTAL_VARIANT)
    const prompt = opts.shape === 'v5' ? `Learning assessment.\n\nINPUT:\n${JSON.stringify({ nodeStates: [concept], evidence })}` : built.prompt
    const runId = randomUUID()
    await q(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at) VALUES($1,$2,$1,$3,$4,$1,$5::jsonb,now() - interval '20 days')`,
      [runId, userId, conceptId, built.nodeVersion, JSON.stringify({ prompt, evidence, schema: built.schema, context: built.context, prior: null, model: ASSESSMENT_MODEL, promptRevision: LIVE_INCREMENTAL_VARIANT.revision })])
    await q(`INSERT INTO learning_concept_assessment_receipts(run_id,receipt,completed_at) VALUES($1,$2::jsonb,now() - interval '20 days')`, [runId, JSON.stringify({ status: 'completed',
      completedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), assessment: { conceptId, understandingPercent: percent, confidence: 'medium',
        demonstrated: [{ quote: 'Synthetic', sourceId: evidence[0]!.id, description: 'd' }], gaps: [], nextCheck: 'n', needsReview: true } })])
    return runId
  }
  const runWeek = async (w: string) => {
    const services = await booted
    const rpc = rpcService.getContextRPCService(services, {}, false)
    const { runId } = await services.workflowService.startWorkflow('learningDriftPanelWorkflow', { week: w }, { type: 'internal' }, rpc)
    let run = await services.workflowRunService.getRun(runId)
    for (const deadline = Date.now() + 100_000; run && !['completed', 'failed', 'cancelled'].includes(run.status) && Date.now() < deadline;) {
      await Bun.sleep(300)
      run = await services.workflowRunService.getRun(runId)
    }
    expect(run?.inline).toBeFalsy()
    return { run: run!, steps: await services.workflowRunService.getRunSteps(runId) }
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
    await purgeFixtures(query as never, other)
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

  test('a reservation without an outcome (the process died mid-call) is recorded uncertain and never paid again', async () => {
    await q(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model) VALUES ($1, 3, $2::date, $3, 'r', 'm')`, [user, week(1), window0])
    const calls = fake.state.calls
    const grader = (await booted).learningConceptAssessment as never
    expect((await regradePanelItem(query, grader, { userId: user, item: 3, week: week(1), windowId: window0 })).status).toBe('uncertain')
    expect((await regradePanelItem(query, grader, { userId: user, item: 3, week: week(1), windowId: window0 })).status).toBe('uncertain')
    expect(fake.state.calls).toBe(calls)
    await q('DELETE FROM learning_drift_panel_regrades WHERE user_id=$1 AND week=$2::date', [user, week(1)])
  })

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

  test('week of: the run in progress names this Monday', () => {
    expect(weekOf(new Date('2026-11-12T08:00:00Z'))).toBe('2026-11-09')
  })
})
