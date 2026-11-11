import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { QueryFn as MetaPgQueryFn } from '../../db/handle.js'
import { ASSESSMENT_MODEL, AssessmentSourceSchema, type AssessmentConcept } from './learning-concept-assessment.js'
import { buildIncrementalAssessmentInput, priorBlindPrompt, type IncrementalVariant } from './learning-incremental-assessment.js'
import { LIVE_INCREMENTAL_VARIANT } from './learning-live-incremental-variant.js'
import { blindDrift, t975, type BlindDrift } from './mastery-change-statistics.js'

/**
 * The weekly grader-drift regrade panel (docs/specs/mastery-change-statistics.md, "Drift panel";
 * review round 2 S-b, round 3 S5).
 *
 * Each learner has a FIXED panel of past prior-blind gradings' evidence, chosen once and stored.
 * Every week each item is regraded prior-blind by the shipped grader (the live incremental prompt
 * with its estimate section 'none', the model of ASSESSMENT_MODEL). The drift is the within-item
 * slope of those regrades on calendar time over the last PANEL_WINDOW_WEEKS weekly runs of the
 * current window; a window is one grader (prompt revision + model) and a change starts a new one.
 *
 * Regrades live only in learning_drift_panel_*: never a reading, notification, holdout unit,
 * GrowthBook fact or stall-alarm reading. Evidence text stays in the database (the repo is public):
 * nothing here logs it, and step outputs carry ids and numbers only.
 */

/** Items per learner (the approved proposal: 30 × 8 weeks brackets the drift to about ±0.4 a week). */
export const PANEL_SIZE = 30
/** Weekly runs in the rolling window the slope is fitted over. */
export const PANEL_WINDOW_WEEKS = 8
/** Weekly runs before the drift interval is reported at all: below this the verdict stays withheld. */
export const PANEL_MIN_WEEKS = 4
/** Score levels the panel is stratified over: 0–19, 20–39, 40–59, 60–79, 80–100. */
export const PANEL_LEVELS = 5
/** Names the selection rule; part of the seed, so a rule change can never silently reselect a stored panel. */
export const PANEL_SELECTION_REVISION = 'drift-panel-v1'
/** The grader the panel measures: the shipped live prompt revision and the assessment model. */
export const PANEL_MODEL = `${ASSESSMENT_MODEL.backend}/${ASSESSMENT_MODEL.model}/${ASSESSMENT_MODEL.effort}`
export const panelGraderKey = (variant: IncrementalVariant = LIVE_INCREMENTAL_VARIANT, model = PANEL_MODEL) => `${variant.revision}|${model}`

const DAY_MS = 86_400_000

// ------------------------------------------------------------------ evidence

/** What one past grading saw: the concept, its read-only context turns and its new evidence. */
export const PanelIngredients = z.object({
  concept: z.object({ conceptId: z.string(), title: z.string(), description: z.string(), objectives: z.array(z.string()) }),
  context: z.array(z.object({ at: z.string(), messages: z.array(AssessmentSourceSchema) })),
  evidence: z.array(AssessmentSourceSchema),
})
export type PanelIngredients = z.infer<typeof PanelIngredients>

// Every section of an incremental prompt is one line of JSON (or 'none'): JSON.stringify never emits a raw newline.
const INCREMENTAL_SECTIONS = /\n\n### CONCEPT\n(.+)\n\n### CURRENT PUBLISHED ESTIMATE[^\n]*\n.+\n\n### CONTEXT[^\n]*\n(.+)\n\n### NEW EVIDENCE[^\n]*\n(.+)$/
/** SQL twin of the shape test: the four section headings an incremental prompt carries. */
export const INCREMENTAL_PROMPT_SQL = `position('### CONCEPT' in r.snapshot->>'prompt') > 0 AND position('### CURRENT PUBLISHED ESTIMATE' in r.snapshot->>'prompt') > 0
  AND position('### CONTEXT' in r.snapshot->>'prompt') > 0 AND position('### NEW EVIDENCE' in r.snapshot->>'prompt') > 0`

/**
 * The evidence a frozen incremental prompt holds, read back from the prompt itself (never from the
 * run's evidence list, whose order the live builder may change). Null for any other prompt shape.
 */
export function panelIngredients(prompt: string): PanelIngredients | null {
  const m = INCREMENTAL_SECTIONS.exec(prompt)
  if (!m) return null
  try {
    const [node] = JSON.parse(m[1]!) as Array<AssessmentConcept & { nodeVersion?: string }>
    if (!node) return null
    // The objects stay exactly as the prompt held them (every field, in their order): the schema only checks
    // them, since parsing would drop fields the grader saw (authorship, sourceVersion, ...) and reorder keys.
    const { nodeVersion: _, ...concept } = node
    const ingredients = { concept, context: JSON.parse(m[2]!), evidence: JSON.parse(m[3]!) }
    return PanelIngredients.safeParse(ingredients).success ? ingredients as PanelIngredients : null
  } catch { return null }
}

/**
 * The regrade's input: the CURRENT shipped prompt over the item's evidence, estimate 'none'. For an
 * item whose source ran at the current revision this is exactly the prompt its prior-blind replicate
 * was graded with (`priorBlindPrompt` of the frozen prompt; tested).
 */
export function panelGradingInput(ingredients: PanelIngredients, variant: IncrementalVariant = LIVE_INCREMENTAL_VARIANT) {
  const context = ingredients.context.map((turn, i) => ({ id: `context-${i}`, at: turn.at, messages: turn.messages }))
  return buildIncrementalAssessmentInput(ingredients.concept, ingredients.evidence, null, context, variant)
}

/**
 * Whether the panel's input rebuilt from a frozen live prompt is that prompt with its estimate withheld, byte
 * for byte, after the database round trip the stored ingredients take (jsonb reorders object keys).
 */
export function reproducesPriorBlind(ingredients: PanelIngredients, frozenPrompt: string, variant: IncrementalVariant = LIVE_INCREMENTAL_VARIANT): boolean {
  return panelGradingInput(jsonbRoundTrip(ingredients), variant).prompt === priorBlindPrompt(frozenPrompt)
}
/** What a value reads back as from a jsonb column: object keys ordered by length, then bytewise. */
export function jsonbRoundTrip<T>(value: T): T {
  const order = (v: unknown): unknown => Array.isArray(v) ? v.map(order)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, order(x)])) : v
  return order(value) as T
}

// ------------------------------------------------------------------ selection

export interface PanelCandidate { runId: string; conceptId: string; blindPercent: number }
export interface PanelPick extends PanelCandidate { item: number; level: number }

export const panelLevel = (percent: number) => Math.min(PANEL_LEVELS - 1, Math.max(0, Math.floor(percent / (100 / PANEL_LEVELS))))
const rank = (seed: string, id: string) => createHash('sha256').update(`${seed}|${id}`).digest('hex')

/**
 * Deterministic stratified choice: the score levels take turns (lowest first), so every level gets
 * an equal share until it runs out; inside a level the concept used least so far wins, ties broken
 * by a seeded hash of the run id. The result depends only on the candidate SET and the seed, never
 * on their order. Equal shares across levels, not proportional ones: a drift that differs by level
 * (a ceiling, a floor) is visible only if every level is in the panel.
 */
export function selectPanel(candidates: readonly PanelCandidate[], seed: string, size = PANEL_SIZE): PanelPick[] {
  const byLevel = Array.from({ length: PANEL_LEVELS }, () => [] as Array<PanelCandidate & { rank: string }>)
  const seen = new Set<string>()
  for (const c of candidates) {
    if (seen.has(c.runId)) continue
    seen.add(c.runId)
    byLevel[panelLevel(c.blindPercent)]!.push({ ...c, rank: rank(seed, c.runId) })
  }
  for (const level of byLevel) level.sort((a, b) => a.rank.localeCompare(b.rank))
  const used = new Map<string, number>()
  const picks: PanelPick[] = []
  while (picks.length < size && byLevel.some((l) => l.length)) {
    for (const [level, pool] of byLevel.entries()) {
      if (picks.length >= size || !pool.length) continue
      let best = 0
      for (let i = 1; i < pool.length; i++) if ((used.get(pool[i]!.conceptId) ?? 0) < (used.get(pool[best]!.conceptId) ?? 0)) best = i
      const [chosen] = pool.splice(best, 1)
      used.set(chosen!.conceptId, (used.get(chosen!.conceptId) ?? 0) + 1)
      picks.push({ runId: chosen!.runId, conceptId: chosen!.conceptId, blindPercent: chosen!.blindPercent, item: picks.length, level })
    }
  }
  return picks
}

// ------------------------------------------------------------------ weeks and drift

/** The Monday (UTC) of the week holding `at`, as YYYY-MM-DD: the panel's unit of time. */
export function weekOf(at: Date | number): string {
  const d = new Date(typeof at === 'number' ? at : at.getTime())
  const day = (d.getUTCDay() + 6) % 7
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10)
}
export const weeksBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / (7 * DAY_MS))
export const addWeeks = (week: string, n: number) => new Date(Date.parse(week) + n * 7 * DAY_MS).toISOString().slice(0, 10)

export type PanelGroup = ReadonlyArray<{ weeks: number; percent: number }>

/**
 * A week-clustered slope: each week's mean item-centred residual regressed on the week, with a t
 * interval on (weeks − 2) df from those week means' own scatter. All of a week's regrades run within
 * hours under one grader state, so a shock shared by the whole week (a backend change that day) is
 * one draw, not P; the item-level interval treats it as P and is too narrow when such shocks exist.
 * Null below three weeks.
 */
export function weekClusteredSlope(groups: readonly PanelGroup[]): { slope: number; interval: [number, number]; weeks: number } | null {
  const sums = new Map<number, { s: number; n: number }>()
  for (const g of groups) {
    if (g.length < 2) continue
    const mean = g.reduce((a, x) => a + x.percent, 0) / g.length
    for (const x of g) { const w = sums.get(x.weeks) ?? { s: 0, n: 0 }; w.s += x.percent - mean; w.n++; sums.set(x.weeks, w) }
  }
  const pts = [...sums].map(([w, v]) => ({ w, r: v.s / v.n }))
  if (pts.length < 3) return null
  const wb = pts.reduce((a, p) => a + p.w, 0) / pts.length, rb = pts.reduce((a, p) => a + p.r, 0) / pts.length
  const sxx = pts.reduce((a, p) => a + (p.w - wb) ** 2, 0)
  const slope = pts.reduce((a, p) => a + (p.w - wb) * (p.r - rb), 0) / sxx
  const df = pts.length - 2
  const s2 = pts.reduce((a, p) => a + (p.r - rb - slope * (p.w - wb)) ** 2, 0) / df
  const half = t975(df) * Math.sqrt(s2 / sxx)
  return { slope, interval: [slope - half, slope + half], weeks: pts.length }
}

/**
 * The drift the withholding rule reads (`clearsDrift`, `aggregateChange({ drift })`), from panel
 * regrades: `blindDrift`'s pooled within-item slope and t interval, widened to cover the
 * week-clustered interval too. Interval null (every verdict withheld) below `minWeeks` weekly runs.
 */
export function panelDrift(groups: readonly PanelGroup[], graderSd: number, minWeeks = PANEL_MIN_WEEKS): BlindDrift {
  const weeks = new Set(groups.flatMap((g) => g.map((x) => x.weeks))).size
  const item = blindDrift(groups, graderSd)
  if (weeks < minWeeks || !item.interval) return { ...item, interval: null }
  const clustered = weekClusteredSlope(groups)
  const interval: [number, number] = clustered
    ? [Math.min(item.interval[0], clustered.interval[0]), Math.max(item.interval[1], clustered.interval[1])]
    : item.interval
  return { ...item, interval }
}

// ------------------------------------------------------------------ database

export interface DriftPanelStatus {
  /** Learners with a panel, and their items. */
  panels: number
  items: number
  /** The current grader's window, or null before its first weekly run. */
  window: { id: number; promptRevision: string; model: string; startedWeek: string; reason: string } | null
  /** Weekly runs with at least one regrade in the rolling window, and the latest one. */
  weeks: number
  lastWeek: string | null
  minWeeks: number
  windowWeeks: number
  /** The week the window should reach `minWeeks` runs (one a week from now on); null once it has. */
  boundExpectedWeek: string | null
  /** The week the rolling window should be full; null once it is. */
  fullWindowWeek: string | null
}

type WindowRow = { window_id: string; grader_key: string; prompt_revision: string; model: string; started_week: Date | string; reason: string }
const isoDate = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10))

export async function currentWindow(query: MetaPgQueryFn): Promise<WindowRow | null> {
  return (await query<WindowRow>('SELECT window_id, grader_key, prompt_revision, model, started_week, reason FROM learning_drift_panel_windows ORDER BY window_id DESC LIMIT 1')).rows[0] ?? null
}

/** The window of the grader running now, started (and recorded with its reason) when the grader changed. */
export async function resolveWindow(query: MetaPgQueryFn, week: string, variant: IncrementalVariant = LIVE_INCREMENTAL_VARIANT, model = PANEL_MODEL) {
  const key = panelGraderKey(variant, model)
  const latest = await currentWindow(query)
  if (latest?.grader_key === key) return { windowId: Number(latest.window_id), started: false }
  const reason = latest ? `grader changed from ${latest.grader_key}` : 'first window'
  const row = (await query<{ window_id: string }>(`INSERT INTO learning_drift_panel_windows(grader_key, prompt_revision, model, started_week, reason)
    SELECT $1, $2, $3, $4::date, $5 WHERE NOT EXISTS (SELECT 1 FROM (SELECT grader_key FROM learning_drift_panel_windows ORDER BY window_id DESC LIMIT 1) l WHERE l.grader_key = $1)
    RETURNING window_id`, [key, variant.revision, model, week, reason])).rows[0]
  return { windowId: Number(row?.window_id ?? (await currentWindow(query))!.window_id), started: !!row }
}

/**
 * Choose and store a learner's panel, once. Candidates: the learner's readings with a prior-blind
 * measurement by the panel's model at the live revision whose evidence reads back exactly (below).
 * A stored panel is returned as it is: it is never re-chosen. With no candidate nothing is stored.
 */
export async function selectDriftPanel(query: MetaPgQueryFn, userId: string, size = PANEL_SIZE) {
  const existing = (await query<{ size: number; candidates: number; selection_revision: string; selected_at: Date }>('SELECT size, candidates, selection_revision, selected_at FROM learning_drift_panels WHERE user_id=$1', [userId])).rows[0]
  if (existing) return { userId, created: false, size: existing.size, candidates: existing.candidates, selectionRevision: existing.selection_revision, selectedAt: existing.selected_at.toISOString() }
  // Eligible: the reading's prompt ran at the CURRENT live revision and the panel's input rebuilt from it is
  // byte-identical to the prior-blind prompt its replicates were graded with. On dev 2026-11-11 that is 174 of 182:
  // the rest carry a legacy concept version or an older section layout and are left out rather than approximated.
  const rows = (await query<{ run_id: string; concept_id: string; blind_percent: string; prompt: string }>(`SELECT m.run_id, m.concept_id, m.blind_percent, r.snapshot->>'prompt' prompt
    FROM learning_mastery_readings m JOIN learning_concept_assessment_run_digests d USING (run_id) JOIN learning_concept_assessment_runs r USING (run_id)
    WHERE m.user_id = $1 AND m.blind_percent IS NOT NULL AND d.model = $2 AND d.prompt_revision = $3 AND ${INCREMENTAL_PROMPT_SQL}`, [userId, PANEL_MODEL, LIVE_INCREMENTAL_VARIANT.revision])).rows
  const eligible = new Map<string, { candidate: PanelCandidate; ingredients: PanelIngredients }>()
  for (const r of rows) {
    const ingredients = panelIngredients(r.prompt)
    if (ingredients && reproducesPriorBlind(ingredients, r.prompt)) eligible.set(r.run_id, { candidate: { runId: r.run_id, conceptId: r.concept_id, blindPercent: Number(r.blind_percent) }, ingredients })
  }
  const picks = selectPanel([...eligible.values()].map((e) => e.candidate), `${PANEL_SELECTION_REVISION}|${userId}`, size)
  const items = picks.map((p) => ({ item: p.item, source_run_id: p.runId, concept_id: p.conceptId, level: p.level, source_percent: p.blindPercent, ingredients: eligible.get(p.runId)!.ingredients }))
  // Nothing eligible yet: no panel is stored, so a later selection can still make one.
  if (!items.length) return { userId, created: false, size: 0, candidates: 0, selectionRevision: PANEL_SELECTION_REVISION, selectedAt: null }
  // One statement: the panel and its items appear together or not at all; a concurrent selection loses the insert.
  const inserted = await query(`WITH h AS (INSERT INTO learning_drift_panels(user_id, selection_revision, size, candidates) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING user_id)
    INSERT INTO learning_drift_panel_items(user_id, item, source_run_id, concept_id, level, source_percent, ingredients)
    SELECT h.user_id, x.item, x.source_run_id, x.concept_id, x.level, x.source_percent, x.ingredients
    FROM h, jsonb_to_recordset($5::jsonb) AS x(item int, source_run_id uuid, concept_id text, level int, source_percent numeric, ingredients jsonb)
    RETURNING item`,
    [userId, PANEL_SELECTION_REVISION, items.length, eligible.size, JSON.stringify(items)])
  const stored = (await query<{ size: number; candidates: number; selection_revision: string; selected_at: Date }>('SELECT size, candidates, selection_revision, selected_at FROM learning_drift_panels WHERE user_id=$1', [userId])).rows[0]!
  return { userId, created: inserted.rowCount > 0, size: stored.size, candidates: stored.candidates, selectionRevision: stored.selection_revision, selectedAt: stored.selected_at.toISOString() }
}

/** The items still to regrade this week, at most `cap` gradings a run (counting the week's earlier reservations). */
export async function planWeek(query: MetaPgQueryFn, week: string, cap: number) {
  const done = Number((await query<{ n: string }>('SELECT count(*) n FROM learning_drift_panel_regrades WHERE week = $1::date', [week])).rows[0]!.n)
  const pending = (await query<{ user_id: string; item: number }>(`SELECT i.user_id, i.item FROM learning_drift_panel_items i
    WHERE NOT EXISTS (SELECT 1 FROM learning_drift_panel_regrades g WHERE g.user_id = i.user_id AND g.item = i.item AND g.week = $1::date)
    ORDER BY i.user_id, i.item`, [week])).rows.map((r) => ({ userId: r.user_id, item: r.item }))
  const room = Math.max(0, cap - done)
  return { items: pending.slice(0, room), overCap: Math.max(0, pending.length - room), alreadyThisWeek: done }
}

/** Rolling-window regrades of the current window, grouped by item: what the drift is fitted on. */
export async function windowGroups(query: MetaPgQueryFn, windowId: number, startedWeek: string, windowWeeks = PANEL_WINDOW_WEEKS) {
  const rows = (await query<{ user_id: string; item: number; week: Date | string; percent: string }>(`SELECT user_id, item, week, percent FROM learning_drift_panel_regrades
    WHERE window_id = $1 AND status = 'completed' AND percent IS NOT NULL
      AND week IN (SELECT DISTINCT week FROM learning_drift_panel_regrades WHERE window_id = $1 AND status = 'completed' AND percent IS NOT NULL ORDER BY week DESC LIMIT $2)`,
    [windowId, windowWeeks])).rows
  const groups = new Map<string, Array<{ weeks: number; percent: number }>>()
  const weeks = new Set<string>()
  for (const r of rows) {
    const week = isoDate(r.week)
    weeks.add(week)
    const key = `${r.user_id}|${r.item}`
    ;(groups.get(key) ?? groups.set(key, []).get(key)!).push({ weeks: weeksBetween(startedWeek, week), percent: Number(r.percent) })
  }
  return { groups: [...groups.values()], weeks: [...weeks].sort() }
}

/** The grader's drift from the panel, and the panel's state for the page (why withheld, and until when). */
export async function panelBlindDrift(query: MetaPgQueryFn, graderSd: number, now = new Date()): Promise<{ drift: BlindDrift; panel: DriftPanelStatus }> {
  const counts = (await query<{ panels: string; items: string }>('SELECT (SELECT count(*) FROM learning_drift_panels) panels, (SELECT count(*) FROM learning_drift_panel_items) items')).rows[0]!
  const latest = await currentWindow(query)
  const window = latest && latest.grader_key === panelGraderKey() ? latest : null
  const { groups, weeks } = window ? await windowGroups(query, Number(window.window_id), isoDate(window.started_week)) : { groups: [], weeks: [] }
  const drift = panelDrift(groups, graderSd)
  const thisWeek = weekOf(now)
  const lastWeek = weeks.at(-1) ?? null
  // The next weekly run is this week's when it has not happened yet, else next week's.
  const next = lastWeek === thisWeek ? addWeeks(thisWeek, 1) : thisWeek
  const expected = (target: number) => (weeks.length >= target ? null : addWeeks(next, target - weeks.length - 1))
  return {
    drift,
    panel: {
      panels: Number(counts.panels), items: Number(counts.items),
      window: window ? { id: Number(window.window_id), promptRevision: window.prompt_revision, model: window.model, startedWeek: isoDate(window.started_week), reason: window.reason } : null,
      weeks: weeks.length, lastWeek, minWeeks: PANEL_MIN_WEEKS, windowWeeks: PANEL_WINDOW_WEEKS,
      boundExpectedWeek: Number(counts.items) ? expected(PANEL_MIN_WEEKS) : null,
      fullWindowWeek: Number(counts.items) ? expected(PANEL_WINDOW_WEEKS) : null,
    },
  }
}

// ------------------------------------------------------------------ one regrade

/** The shipped grader's call, as the assessment service exposes it (LearningConceptAssessmentService.gradePrepared). */
export interface PanelGrader {
  gradePrepared(input: ReturnType<typeof panelGradingInput> & { model: typeof ASSESSMENT_MODEL }, label: string): Promise<{
    status: string; assessment: { understandingPercent: number | null } | null; validatorRetry?: { kind: string } | null; [k: string]: unknown }>
}
export const RegradeStatus = z.enum(['completed', 'failed', 'uncertain', 'skipped'])
export type RegradeStatus = z.infer<typeof RegradeStatus>

/**
 * Regrade one panel item for one week. Reserved before the paid call: a replay that finds the
 * reservation without an outcome records 'uncertain' and never pays again, and a recorded outcome is
 * returned as it is (idempotent per item and week). 'skipped' when the grader changed after the week
 * was planned (that week's remaining items wait for next week's run, in the new window).
 */
export async function regradePanelItem(query: MetaPgQueryFn, grader: PanelGrader, input: { userId: string; item: number; week: string; windowId: number }):
  Promise<{ userId: string; item: number; week: string; status: RegradeStatus; percent: number | null; calls: number }> {
  const out = (status: RegradeStatus, percent: number | null = null, calls = 0) => ({ userId: input.userId, item: input.item, week: input.week, status, percent, calls })
  const existing = (await query<{ status: string | null; percent: string | null; calls: number | null }>('SELECT status, percent, calls FROM learning_drift_panel_regrades WHERE user_id=$1 AND item=$2 AND week=$3::date', [input.userId, input.item, input.week])).rows[0]
  if (existing && !existing.status) {
    await query(`UPDATE learning_drift_panel_regrades SET status='uncertain', completed_at=now(), receipt=$4::jsonb WHERE user_id=$1 AND item=$2 AND week=$3::date AND status IS NULL`,
      [input.userId, input.item, input.week, JSON.stringify({ status: 'uncertain', error: 'Reserved and never recorded (the process stopped during the call); not repeated, so never paid twice.' })])
    return out('uncertain')
  }
  if (existing) return out(existing.status as RegradeStatus, existing.percent === null ? null : Number(existing.percent), existing.calls ?? 0)
  const window = await currentWindow(query)
  if (!window || Number(window.window_id) !== input.windowId || window.grader_key !== panelGraderKey()) return out('skipped')
  const row = (await query<{ ingredients: unknown }>('SELECT ingredients FROM learning_drift_panel_items WHERE user_id=$1 AND item=$2', [input.userId, input.item])).rows[0]
  if (!row) throw new Error(`No drift panel item ${input.item} for this learner`)
  const built = panelGradingInput(PanelIngredients.parse(row.ingredients))
  const reserved = await query(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model) VALUES ($1, $2, $3::date, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING item`,
    [input.userId, input.item, input.week, input.windowId, LIVE_INCREMENTAL_VARIANT.revision, PANEL_MODEL])
  if (!reserved.rowCount) return out('uncertain')
  const receipt = await grader.gradePrepared({ ...built, model: ASSESSMENT_MODEL }, `Learning drift panel ${input.week} item ${input.item}`)
  const percent = receipt.status === 'completed' && typeof receipt.assessment?.understandingPercent === 'number' ? receipt.assessment.understandingPercent : null
  const status: RegradeStatus = receipt.status === 'completed' ? 'completed' : 'failed'
  const calls = receipt.validatorRetry ? 2 : 1
  await query(`UPDATE learning_drift_panel_regrades SET status=$4, percent=$5, calls=$6, receipt=$7::jsonb, completed_at=now() WHERE user_id=$1 AND item=$2 AND week=$3::date AND status IS NULL`,
    [input.userId, input.item, input.week, status, percent, calls, JSON.stringify(receipt)])
  return out(status, percent, calls)
}

/** The week's outcome across every panel: what the run's last step reports (numbers only). */
export async function summarizeWeek(query: MetaPgQueryFn, week: string) {
  const rows = (await query<{ status: string | null; n: string; calls: string | null }>('SELECT status, count(*) n, sum(calls) calls FROM learning_drift_panel_regrades WHERE week=$1::date GROUP BY status', [week])).rows
  const n = (s: string | null) => Number(rows.find((r) => r.status === s)?.n ?? 0)
  return { week, completed: n('completed'), failed: n('failed'), uncertain: n('uncertain'), reserved: n(null), calls: rows.reduce((a, r) => a + Number(r.calls ?? 0), 0) }
}
