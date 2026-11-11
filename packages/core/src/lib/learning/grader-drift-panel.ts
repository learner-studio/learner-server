import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { QueryFn as MetaPgQueryFn } from '../../db/handle.js'
import { ASSESSMENT_MODEL, AssessmentSourceSchema, type AssessmentConcept } from './learning-concept-assessment.js'
import { buildIncrementalAssessmentInput, priorBlindPrompt, type IncrementalVariant } from './learning-incremental-assessment.js'
import { LIVE_INCREMENTAL_VARIANT } from './learning-live-incremental-variant.js'
import { blindDrift, t975, type BlindDrift } from './mastery-change-statistics.js'
import { driftAttemptKey, driveAttempt, pgLeaseStore } from './llm-attempt-lease.js'
import type { DurableCallPlan } from '@learner/llm/lib/cli/durable-cli-call.js'

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
const PANEL_WINDOW_WEEKS = 8
/** Weekly runs before the drift interval is reported at all: below this the verdict stays withheld. */
export const PANEL_MIN_WEEKS = 4
/** Score levels the panel is stratified over: 0–19, 20–39, 40–59, 60–79, 80–100. */
export const PANEL_LEVELS = 5
/** Names the selection rule; part of the seed, so a rule change can never silently reselect a stored panel. */
const PANEL_SELECTION_REVISION = 'drift-panel-v1'
/** The grader the panel measures: the shipped live prompt revision and the assessment model. */
export const PANEL_MODEL = `${ASSESSMENT_MODEL.backend}/${ASSESSMENT_MODEL.model}/${ASSESSMENT_MODEL.effort}`
/**
 * How the panel turns stored ingredients into the prompt it pays for. Part of the grader key, so a change to it
 * starts a new window instead of reading as drift. v2 (review round 1, B1): v1 sent the schema-PARSED objects,
 * which dropped authorship, sourceVersion, sourceOrder, logicalKey and correlation.* (about 45 % of the bytes):
 * week 2026-11-09 on dev was graded that way and stays in its own window.
 */
export const PANEL_INPUT_REVISION = 'panel-input-v2'
export const panelGraderKey = (variant: IncrementalVariant = LIVE_INCREMENTAL_VARIANT, model = PANEL_MODEL) => `${variant.revision}|${model}|${PANEL_INPUT_REVISION}`
/** A window whose latest weekly run is more than this many weeks old measures nothing: its drift is stale, so withheld. */
const PANEL_STALE_WEEKS = 2

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
const INCREMENTAL_PROMPT_SQL = `position('### CONCEPT' in r.snapshot->>'prompt') > 0 AND position('### CURRENT PUBLISHED ESTIMATE' in r.snapshot->>'prompt') > 0
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
/** What a value reads back as from a jsonb column: object keys ordered by UTF-8 byte length, then bytewise (checked against Postgres in drift-panel.test.ts). */
export function jsonbRoundTrip<T>(value: T): T {
  const byJsonb = ([a]: [string, unknown], [b]: [string, unknown]) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b))
  const order = (v: unknown): unknown => Array.isArray(v) ? v.map(order)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(byJsonb).map(([k, x]) => [k, order(x)])) : v
  return order(value) as T
}

/**
 * The paid-path guard (review round 1, B1): null when `sent` is what selection verified, else why not.
 * The verified bytes are `priorBlindPrompt(sourcePrompt)` (the source run is immutable). The data sections
 * (concept, context, evidence) must be byte-identical under any revision; at the source's own revision the whole prompt must be.
 */
export function panelInputMismatch(sent: string, sourcePrompt: string, sameRevision: boolean): string | null {
  const verified = priorBlindPrompt(sourcePrompt)
  const [a, b] = [sent, verified].map((p) => INCREMENTAL_SECTIONS.exec(p)?.slice(1).join('\n'))
  if (a === undefined || b === undefined) return 'prompt shape not recognised'
  if (a !== b) return 'evidence sections differ from the verified prior-blind prompt'
  if (sameRevision && sent !== verified) return 'prompt differs from the verified prior-blind prompt'
  return null
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
  /** The latest run is over PANEL_STALE_WEEKS weeks old (panel off, or runs failing): the drift is withheld. */
  stale: boolean
  staleAfterWeeks: number
  /** Per score band; `bandsDisagree` when two bands' intervals do not overlap (review round 1, S6). */
  bands: PanelBandDrift[]
  bandsDisagree: boolean
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
  const stored = async (created: boolean) => {
    const p = (await query<{ size: number; candidates: number; selection_revision: string; selected_at: Date }>('SELECT size, candidates, selection_revision, selected_at FROM learning_drift_panels WHERE user_id=$1', [userId])).rows[0]
    return p && { userId, created, size: p.size, candidates: p.candidates, selectionRevision: p.selection_revision, selectedAt: p.selected_at.toISOString() }
  }
  const existing = await stored(false)
  if (existing) return existing
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
    FROM h, jsonb_to_recordset($5::jsonb) AS x(item int, source_run_id text, concept_id text, level int, source_percent numeric, ingredients jsonb)
    RETURNING item`,
    [userId, PANEL_SELECTION_REVISION, items.length, eligible.size, JSON.stringify(items)])
  return (await stored(inserted.rowCount > 0))!
}

/**
 * The items still to regrade this week, at most `cap` gradings a run (counting the week's earlier reservations).
 * Fair under the cap (review round 1, S2): learners take turns, one item each per round, and the learner who goes
 * first moves on by one every week (learners in byte order of id, offset by the week's index), so with L learners
 * each one goes first once in any L consecutive weeks: none is starved, whatever the cap. Byte order (COLLATE "C")
 * keeps the turn the same on every database locale. Within a learner items go in item order: selection numbers
 * them level by level, so every prefix of a panel is itself stratified, and a short share regrades the SAME
 * items week after week (what a within-item slope needs).
 */
export async function planWeek(query: MetaPgQueryFn, week: string, cap: number) {
  const done = Number((await query<{ n: string }>('SELECT count(*) n FROM learning_drift_panel_regrades WHERE week = $1::date', [week])).rows[0]!.n)
  const pending = (await query<{ user_id: string; item: number }>(`SELECT user_id, item FROM (
      SELECT i.user_id, i.item, row_number() OVER (PARTITION BY i.user_id ORDER BY i.item) turn,
        dense_rank() OVER (ORDER BY i.user_id COLLATE "C") - 1 learner FROM learning_drift_panel_items i
      WHERE NOT EXISTS (SELECT 1 FROM learning_drift_panel_regrades g WHERE g.user_id = i.user_id AND g.item = i.item AND g.week = $1::date)) p
    ORDER BY turn, mod(learner - ($1::date - date '1970-01-05') / 7 % (max(learner) OVER () + 1) + (max(learner) OVER () + 1), max(learner) OVER () + 1)`,
    [week])).rows.map((r) => ({ userId: r.user_id, item: r.item }))
  const room = Math.max(0, cap - done)
  return { items: pending.slice(0, room), overCap: Math.max(0, pending.length - room), alreadyThisWeek: done }
}

/** Rolling-window regrades of the current window, grouped by item: what the drift is fitted on. */
export async function windowGroups(query: MetaPgQueryFn, windowId: number, startedWeek: string, windowWeeks = PANEL_WINDOW_WEEKS) {
  const rows = (await query<{ user_id: string; item: number; level: number; week: Date | string; percent: string }>(`SELECT g.user_id, g.item, i.level, g.week, g.percent
    FROM learning_drift_panel_regrades g JOIN learning_drift_panel_items i USING (user_id, item)
    WHERE g.window_id = $1 AND g.status = 'completed' AND g.percent IS NOT NULL
      AND g.week IN (SELECT DISTINCT week FROM learning_drift_panel_regrades WHERE window_id = $1 AND status = 'completed' AND percent IS NOT NULL ORDER BY week DESC LIMIT $2)`,
    [windowId, windowWeeks])).rows
  const groups = new Map<string, { level: number; points: Array<{ weeks: number; percent: number }> }>()
  const weeks = new Set<string>()
  for (const r of rows) {
    const week = isoDate(r.week)
    weeks.add(week)
    const key = `${r.user_id}|${r.item}`
    ;(groups.get(key) ?? groups.set(key, { level: r.level, points: [] }).get(key)!).points.push({ weeks: weeksBetween(startedWeek, week), percent: Number(r.percent) })
  }
  return { groups: [...groups.values()].map((g) => g.points), levels: [...groups.values()].map((g) => g.level), weeks: [...weeks].sort() }
}

/** One score band's own drift (review round 1, S6): a ceiling or floor effect shows as bands that disagree. */
export interface PanelBandDrift { level: number; items: number; perWeek: number | null; interval: [number, number] | null }
/** Per-band drift, and whether two measured bands' intervals fail to overlap (then the pooled drift hides a level effect). */
export function bandDrifts(groups: readonly PanelGroup[], levels: readonly number[], graderSd: number): { bands: PanelBandDrift[]; disagree: boolean } {
  const bands: PanelBandDrift[] = []
  for (let level = 0; level < PANEL_LEVELS; level++) {
    const mine = groups.filter((_, i) => levels[i] === level)
    if (!mine.length) continue
    const d = panelDrift(mine, graderSd)
    bands.push({ level, items: mine.length, perWeek: d.perWeek, interval: d.interval })
  }
  return { bands, disagree: intervalsDisagree(bands.map((band) => band.interval)) }
}
/** Two measured intervals that do not overlap (touching counts as overlapping: no evidence they differ). */
export function intervalsDisagree(intervals: ReadonlyArray<readonly [number, number] | null>): boolean {
  const measured = intervals.filter((i): i is readonly [number, number] => i !== null)
  return measured.some((a) => measured.some((b) => a[1] < b[0]))
}

/** The grader's drift from the panel, and the panel's state for the page (why withheld, and until when). */
export async function panelBlindDrift(query: MetaPgQueryFn, graderSd: number, now = new Date()): Promise<{ drift: BlindDrift; panel: DriftPanelStatus }> {
  const counts = (await query<{ panels: string; items: string }>('SELECT (SELECT count(*) FROM learning_drift_panels) panels, (SELECT count(*) FROM learning_drift_panel_items) items')).rows[0]!
  const latest = await currentWindow(query)
  const window = latest && latest.grader_key === panelGraderKey() ? latest : null
  const { groups, levels, weeks } = window ? await windowGroups(query, Number(window.window_id), isoDate(window.started_week)) : { groups: [], levels: [], weeks: [] }
  const thisWeek = weekOf(now)
  const lastWeek = weeks.at(-1) ?? null
  const stale = lastWeek !== null && weeksBetween(lastWeek, thisWeek) > PANEL_STALE_WEEKS
  const measured = panelDrift(groups, graderSd)
  // A stale slope is not evidence about the grader now: withheld exactly like an unmeasured one.
  const drift = stale ? { ...measured, interval: null } : measured
  const { bands, disagree } = bandDrifts(groups, levels, graderSd)
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
      stale, staleAfterWeeks: PANEL_STALE_WEEKS, bands, bandsDisagree: disagree,
    },
  }
}

// ------------------------------------------------------------------ one regrade

/** The shipped grader's call, as the assessment service exposes it (LearningConceptAssessmentService.gradePrepared). */
export interface PanelGrader {
  gradePrepared(input: ReturnType<typeof panelGradingInput> & { model: typeof ASSESSMENT_MODEL }, label: string, durable?: DurableCallPlan): Promise<{
    status: string; assessment: { understandingPercent: number | null } | null; validatorRetry?: { kind: string } | null; [k: string]: unknown }>
}
export const RegradeStatus = z.enum(['completed', 'failed', 'uncertain', 'skipped'])
export type RegradeStatus = z.infer<typeof RegradeStatus>

/**
 * Regrade one panel item for one week. Reserved before the paid call, which runs under the shared
 * attempt lease (llm-attempt-lease.ts): a replay waits for a live owner, adopts or finishes a dead one's
 * call, and records 'uncertain' only where the lease refuses a repeat (a metered backend). A recorded
 * outcome other than 'uncertain' is returned as it is (idempotent per item and week). 'skipped' when the grader changed after the week
 * was planned (that week's remaining items wait for next week's run, in the new window).
 */
export async function regradePanelItem(query: MetaPgQueryFn, grader: PanelGrader, input: { userId: string; item: number; week: string; windowId: number }):
  Promise<{ userId: string; item: number; week: string; status: RegradeStatus; percent: number | null; calls: number }> {
  const out = (status: RegradeStatus, percent: number | null = null, calls = 0) => ({ userId: input.userId, item: input.item, week: input.week, status, percent, calls })
  const key = [input.userId, input.item, input.week]
  const read = async () => (await query<{ status: string | null; percent: string | null; calls: number | null; reserved_at: Date }>('SELECT status, percent, calls, reserved_at FROM learning_drift_panel_regrades WHERE user_id=$1 AND item=$2 AND week=$3::date', key)).rows[0]
  const recorded = (r: Awaited<ReturnType<typeof read>>) => out((r?.status ?? 'uncertain') as RegradeStatus, r?.percent == null ? null : Number(r.percent), r?.calls ?? 1)
  // A reservation whose outcome is unknown: its started call counts as spend (calls 1).
  const markUncertain = (error: string) => query(`UPDATE learning_drift_panel_regrades SET status='uncertain', calls=1, completed_at=now(), receipt=$4::jsonb WHERE user_id=$1 AND item=$2 AND week=$3::date AND status IS NULL`,
    [...key, JSON.stringify({ status: 'uncertain', error })])
  const existing = await read()
  // 'uncertain' is not final: a repeat-free backend finishes the call; a metered one refuses again (restart safety).
  if (existing?.status && existing.status !== 'uncertain') return recorded(existing)
  const window = await currentWindow(query)
  // A reservation already passed this check before its call: a replay finishes it in its own window.
  if (!existing && (!window || Number(window.window_id) !== input.windowId || window.grader_key !== panelGraderKey())) return out('skipped')
  // Recorded without a call: the week moves on to the next item (review round 1, S3), and the reason is kept.
  const refuse = async (error: string) => {
    // Reserved earlier and its input can no longer be rebuilt: the call's outcome stays unknown.
    if (existing) return (await markUncertain(`Reserved, never recorded, and the input cannot be rebuilt: ${error}`), out('uncertain', null, 1))
    await query(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model, status, calls, receipt, completed_at)
      VALUES ($1, $2, $3::date, $4, $5, $6, 'failed', 0, $7::jsonb, now()) ON CONFLICT DO NOTHING`,
      [...key, input.windowId, LIVE_INCREMENTAL_VARIANT.revision, PANEL_MODEL, JSON.stringify({ status: 'refused', error })])
    return out('failed')
  }
  let built: ReturnType<typeof panelGradingInput> | undefined
  try {
    const row = (await query<{ ingredients: unknown; prompt: string | null; revision: string | null }>(`SELECT i.ingredients, r.snapshot->>'prompt' prompt, r.snapshot->>'promptRevision' revision
      FROM learning_drift_panel_items i LEFT JOIN learning_concept_assessment_runs r ON r.run_id = i.source_run_id WHERE i.user_id=$1 AND i.item=$2`, [input.userId, input.item])).rows[0]
    if (!row) return await refuse('no such panel item')
    if (!row.prompt) return await refuse('source grading not found')
    // The RAW stored objects, as selection verified them: parsing would drop fields the grader saw (B1).
    if (!PanelIngredients.safeParse(row.ingredients).success) return await refuse('stored ingredients no longer match the schema')
    built = panelGradingInput(row.ingredients as PanelIngredients)
    const mismatch = panelInputMismatch(built.prompt, row.prompt, row.revision === LIVE_INCREMENTAL_VARIANT.revision)
    if (mismatch) return await refuse(mismatch)
  } catch (error) {
    return await refuse(`could not build the input: ${(error as Error).name}`)
  }
  const fresh = existing ? false : ((await query(`INSERT INTO learning_drift_panel_regrades(user_id, item, week, window_id, prompt_revision, model) VALUES ($1, $2, $3::date, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING item`,
    [...key, input.windowId, LIVE_INCREMENTAL_VARIANT.revision, PANEL_MODEL])).rowCount ?? 0) > 0
  const input_ = built!
  type Graded = { status: RegradeStatus; percent: number | null; calls: number; receipt: unknown }
  const outcome = await driveAttempt<Graded>(pgLeaseStore(query), {
    key: driftAttemptKey(input.userId, input.item, input.week), backend: ASSESSMENT_MODEL.backend, fresh, reservedAt: existing?.reserved_at ?? new Date(),
    settled: async () => (await query(`SELECT 1 FROM learning_drift_panel_regrades WHERE user_id=$1 AND item=$2 AND week=$3::date AND status <> 'uncertain'`, key)).rowCount > 0,
    work: async (durable) => {
      try {
        const result = await grader.gradePrepared({ ...input_, model: ASSESSMENT_MODEL }, `Learning drift panel ${input.week} item ${input.item}`, durable)
        const percent = result.status === 'completed' && typeof result.assessment?.understandingPercent === 'number' ? result.assessment.understandingPercent : null
        return { status: result.status === 'completed' ? 'completed' : 'failed', percent, calls: result.validatorRetry ? 2 : 1, receipt: result }
      } catch (error) {
        return { status: 'failed', percent: null, calls: 1, receipt: { status: 'failed', error: `grading threw: ${(error as Error).name}: ${String((error as Error).message).slice(0, 200)}` } }
      }
    },
    // A late result replaces an 'uncertain' stamp (review round 1, S1).
    record: async (g) => { await query(`UPDATE learning_drift_panel_regrades SET status=$4, percent=$5, calls=$6, receipt=$7::jsonb, completed_at=now() WHERE user_id=$1 AND item=$2 AND week=$3::date AND (status IS NULL OR status = 'uncertain')`,
      [...key, g.status, g.percent, g.calls, JSON.stringify(g.receipt)]) },
  })
  if (outcome.kind === 'refused') await markUncertain(`Reserved and never recorded (the process stopped during the call); not repeated: ${outcome.reason}.`)
  return recorded(await read())
}

/** The week's outcome across every panel: what the run's last step reports (numbers only). */
export async function summarizeWeek(query: MetaPgQueryFn, week: string) {
  const rows = (await query<{ status: string | null; n: string; calls: string | null }>('SELECT status, count(*) n, sum(calls) calls FROM learning_drift_panel_regrades WHERE week=$1::date GROUP BY status', [week])).rows
  const n = (s: string | null) => Number(rows.find((r) => r.status === s)?.n ?? 0)
  return { week, completed: n('completed'), failed: n('failed'), uncertain: n('uncertain'), reserved: n(null), calls: rows.reduce((a, r) => a + Number(r.calls ?? 0), 0) }
}
