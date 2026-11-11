import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { masteryNotifications } from './mastery-notifications.js'
import { countedMeasurements, masteryChanges, type CountedMeasurements, type MasteryChanges } from './mastery-change.js'
import type { ConceptChange, CountedReading } from './mastery-change-statistics.js'
import { HALYARD_CATALOG, HALYARD_TERMS, halyardId } from './learning-sim-halyard.js'
import { HALYARD_FACT_EXAM } from './learning-sim-facts.js'
import { examResult, heldOutOf, simActions, type ExamResult, type SimLearnerConfig } from './learning-sim-experiment.js'

/**
 * Analysis of a simulated-learner run (docs/specs/simulated-learner-experiment.md, "Pre-registered analysis").
 * `loadSimRun` only READS (receipts, readings, notifications): it never calls a model. `analyzeSimRun` is pure.
 */
export type SimLearnerData = {
  config: SimLearnerConfig
  userId: string
  /** exam per timepoint (0 = baseline), from the scorer's receipts; missing timepoints are absent */
  exams: ExamResult[]
  /** Learner's reading per concept after each session's grading (null: no reading yet or no estimate) */
  readings: Array<{ session: number; conceptId: string; percent: number | null; confidence: string | null; assessmentRunId: string | null; status: string; promptRevision?: string | null }>
  notifications: Array<{ runId: string; conceptId: string; kind: 'first_clear' | 'gain'; percent: number; delta: number | null }>
  agentTurns: Array<{ session: number; turn: number; decision: string; conceptIds: string[]; probe: string | null; injectedChars: number; droppedMatches: number; text: string
    /** Batch 2's fact channel (absent in batch 1). */
    statedFactIds?: string[]; sheets?: string[]; lookups?: string[]; budgetLeft?: number | null; overBudget?: number; invalidFacts?: number; review?: string | null }>
  learnerTurns: Array<{ session: number; turn: number; text: string }>
  notebooks: Array<{ session: number; written: number | null; kept: number; cut: number; overCapacity: number; forgotten: number }>
  retests: Array<{ conceptId: string; original: number | null; retest: number | null }>
  leakage: Array<{ conceptId: string; percent: number | null; confidence: string | null; status: string }>
  calls: Array<{ role: string; model: string; effort: string; inputTokens: number | null; outputTokens: number | null; durationMs: number; attempts: number }>
  /** What Learner itself reports (docs/specs/mastery-change-statistics.md), read as the product reads it: the counted
   * measurements (prior-blind and anchored, by evidence time) and masteryChanges (verdicts on prior-blind only). */
  measurements?: CountedMeasurements
  changes?: MasteryChanges
  /** First message time (ms) of each session, index = session - 1: maps an evidence time to the session it came from. */
  sessionStarts?: number[]
}

const parse = (text: string) => JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim())

export async function loadSimRun(runId: string): Promise<SimLearnerData[]> {
  const learners = (await q<{ learner_id: string; user_id: string; config: SimLearnerConfig }>('SELECT learner_id,user_id,config FROM learning_sim_learners WHERE run_id=$1 ORDER BY learner_id', [runId])).rows
  const out: SimLearnerData[] = []
  for (const l of learners) {
    const calls = (await q<{ call_key: string; role: string; model: string; effort: string; input_tokens: number | null; output_tokens: number | null; duration_ms: number; attempts: number; output: { text: string } }>(
      'SELECT call_key,role,model,effort,input_tokens,output_tokens,duration_ms,attempts,output FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2', [runId, l.learner_id])).rows
    const byKey = new Map(calls.map((c) => [c.call_key, c]))
    const exams: ExamResult[] = []
    for (let t = 0; t <= l.config.sessions; t++) {
      const scored = byKey.get(`exam${t}:score`)
      // Batch 2 runs no baseline exam: an empty notebook scores 0.
      if (!scored && t === 0 && l.config.design === 'v2') { exams.push(examResult(0, {})); continue }
      if (!scored) continue
      const points = Object.fromEntries((parse(scored.output.text) as { scores: Array<{ id: string; points: number }> }).scores.map((x) => [x.id, Math.max(0, Math.min(2, Math.round(x.points)))]))
      exams.push(examResult(t, points))
    }
    const grades = calls.filter((c) => c.role === 'grader' && /^s\d+:grade:/.test(c.call_key)).map((c) => ({ session: Number(c.call_key.slice(1, c.call_key.indexOf(':'))), conceptId: c.call_key.split(':grade:')[1]!, ...(parse(c.output.text) as { assessmentRunId: string | null; status: string }) }))
    const receipts = new Map((await q<{ run_id: string; percent: string | null; confidence: string | null; revision: string | null }>(
      `SELECT r.run_id,t.receipt#>>'{assessment,understandingPercent}' percent,t.receipt#>>'{assessment,confidence}' confidence,r.snapshot->>'promptRevision' revision
       FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.run_id = ANY($1::text[])`,
      [grades.map((g) => g.assessmentRunId).filter(Boolean)])).rows.map((r) => [r.run_id, r]))
    const readings = grades.map((g) => { const r = g.assessmentRunId ? receipts.get(g.assessmentRunId) : undefined; return { session: g.session, conceptId: g.conceptId, percent: r?.percent == null ? null : Number(r.percent), confidence: r?.confidence ?? null, assessmentRunId: g.assessmentRunId, status: g.status, promptRevision: r?.revision ?? null } })
    const messages = (await q<{ session: number; seq: number; role: string; text: string; meta: Record<string, unknown> | null; created_at: Date }>('SELECT session,seq,role,text,meta,created_at FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 ORDER BY session,seq,role', [runId, l.learner_id])).rows
    const sessionStarts = Array.from({ length: l.config.sessions }, (_, i) => Math.min(...messages.filter((m) => m.session === i + 1 && m.role !== 'notebook').map((m) => m.created_at.getTime())))
    const notes = (await masteryNotifications(q, l.user_id, { since: null, limit: 1000 })).map((n) => ({ runId: n.runId, conceptId: n.conceptId, kind: n.kind, percent: n.percent, delta: n.delta }))
    const experiment = async (prefix: string) => (await q<{ request_id: string; concept_id: string; status: string; percent: string | null; confidence: string | null }>(
      `SELECT r.request_id,r.concept_id,COALESCE(t.receipt->>'status','pending') status,t.receipt#>>'{assessment,understandingPercent}' percent,t.receipt#>>'{assessment,confidence}' confidence
       FROM learning_concept_assessment_runs r LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.user_id=$1 AND r.request_id LIKE $2`, [l.user_id, `${prefix}%`])).rows
    const retestRows = await experiment(`sim-retest:${runId}:${l.learner_id}:`)
    const retests = retestRows.map((r) => { const originalRun = r.request_id.split(':').at(-1)!; const o = readings.find((x) => x.assessmentRunId === originalRun); return { conceptId: r.concept_id, original: o?.percent ?? null, retest: r.percent == null ? null : Number(r.percent) } })
    const leakage = (await experiment(`sim-leak:${runId}:${l.learner_id}:`)).map((r) => ({ conceptId: r.concept_id, percent: r.percent == null ? null : Number(r.percent), confidence: r.confidence, status: r.status }))
    out.push({
      config: l.config, userId: l.user_id, exams, readings, notifications: notes,
      agentTurns: messages.filter((m) => m.role === 'agent').map((m) => ({ session: m.session, turn: m.seq, text: m.text, decision: String(m.meta?.decision ?? 'none'), conceptIds: (m.meta?.conceptIds as string[]) ?? [], probe: (m.meta?.probe as string | null) ?? null, injectedChars: Number(m.meta?.injectedChars ?? 0), droppedMatches: Number(m.meta?.droppedMatches ?? 0),
        ...(m.meta?.statedFactIds ? { statedFactIds: m.meta.statedFactIds as string[], sheets: (m.meta.sheets as string[]) ?? [], lookups: (m.meta.lookups as string[]) ?? [], budgetLeft: m.meta.budgetLeft == null ? null : Number(m.meta.budgetLeft), overBudget: Number(m.meta.overBudget ?? 0), invalidFacts: Number(m.meta.invalidFacts ?? 0), review: (m.meta.review as string | null) ?? null } : {}) })),
      learnerTurns: messages.filter((m) => m.role === 'learner').map((m) => ({ session: m.session, turn: m.seq, text: m.text })),
      notebooks: messages.filter((m) => m.role === 'notebook').map((m) => ({ session: m.session, written: m.meta?.written == null ? null : Number(m.meta.written), kept: m.text.length,
        // A notebook stored before the per-topic merge has no `cut`: whatever exceeded the old cap was lost.
        cut: m.meta?.cut != null ? Number(m.meta.cut) : Math.max(0, Number(m.meta?.written ?? 0) - m.text.length),
        overCapacity: Number(m.meta?.overCapacity ?? 0), forgotten: Number(m.meta?.forgotten ?? 0) })),
      retests, leakage, sessionStarts,
      measurements: await countedMeasurements(q, l.user_id),
      changes: await masteryChanges(q, l.user_id, { sinceDays: null }),
      calls: calls.map((c) => ({ role: c.role, model: c.model, effort: c.effort, inputTokens: c.input_tokens, outputTokens: c.output_tokens, durationMs: c.duration_ms, attempts: c.attempts })),
    })
  }
  return out
}

// ---------------------------------------------------------------- statistics

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const sd = (xs: number[]) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) }
/** Deterministic PRNG (mulberry32), so a report is reproducible from its rows. */
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
export type Estimate = { n: number; mean: number; lo: number; hi: number }
/** Percentile bootstrap over learners (the unit of randomization): 95% CI of the mean, 4000 resamples. */
export function bootstrapMean(xs: number[], seed = 1): Estimate {
  if (!xs.length) return { n: 0, mean: NaN, lo: NaN, hi: NaN }
  const r = rng(seed), means: number[] = []
  for (let b = 0; b < 4000; b++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]!; means.push(s / xs.length) }
  means.sort((a, b) => a - b)
  return { n: xs.length, mean: mean(xs), lo: xs.length > 1 ? means[100]! : NaN, hi: xs.length > 1 ? means[3899]! : NaN }
}
/** Difference of two independent group means, resampling each group. */
export function bootstrapDiff(a: number[], b: number[], seed = 2): Estimate & { nB: number } {
  if (!a.length || !b.length) return { n: a.length, nB: b.length, mean: NaN, lo: NaN, hi: NaN }
  const r = rng(seed), diffs: number[] = []
  const draw = (xs: number[]) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]!; return s / xs.length }
  for (let i = 0; i < 4000; i++) diffs.push(draw(a) - draw(b))
  diffs.sort((x, y) => x - y)
  const ok = a.length > 1 && b.length > 1
  return { n: a.length, nB: b.length, mean: mean(a) - mean(b), lo: ok ? diffs[100]! : NaN, hi: ok ? diffs[3899]! : NaN }
}
/** Difference of two pooled group means, resampling each group WITHIN its strata (lanes): lane differences add no
 * resampling noise, since the design fixes how many learners each lane holds. */
export function stratifiedDiff(a: number[][], b: number[][], seed = 3): Estimate & { nB: number } {
  const flatA = a.flat(), flatB = b.flat()
  if (!flatA.length || !flatB.length) return { n: flatA.length, nB: flatB.length, mean: NaN, lo: NaN, hi: NaN }
  const r = rng(seed), diffs: number[] = []
  const draw = (groups: number[][]) => { let s = 0, n = 0; for (const g of groups) for (let i = 0; i < g.length; i++) { s += g[Math.floor(r() * g.length)]!; n++ } return s / n }
  for (let i = 0; i < 4000; i++) diffs.push(draw(a) - draw(b))
  diffs.sort((x, y) => x - y)
  const ok = flatA.length > 1 && flatB.length > 1
  return { n: flatA.length, nB: flatB.length, mean: mean(flatA) - mean(flatB), lo: ok ? diffs[100]! : NaN, hi: ok ? diffs[3899]! : NaN }
}
export function pearson(xs: number[], ys: number[]) {
  if (xs.length < 3) return NaN
  const mx = mean(xs), my = mean(ys)
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2 }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN
}
const ranks = (xs: number[]) => { const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]); const r = new Array<number>(xs.length); for (let i = 0; i < order.length;) { let j = i; while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++; for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2 + 1; i = j + 1 } return r }
export const spearman = (xs: number[], ys: number[]) => pearson(ranks(xs), ranks(ys))

// ---------------------------------------------------------------- analysis

const conceptMentioned = (conceptId: string, text: string) => { const t = text.toLowerCase(); return (HALYARD_TERMS[conceptId] ?? []).some((w) => t.includes(w.toLowerCase())) }
const final = (d: SimLearnerData) => d.exams.find((e) => e.timepoint === d.config.sessions)
const baseline = (d: SimLearnerData) => d.exams.find((e) => e.timepoint === 0)
const groupGain = (d: SimLearnerData, held: boolean) => {
  const f = final(d), b = baseline(d)
  if (!f || !b) return null
  const heldOut = heldOutOf(d.config)
  const ids = HALYARD_CATALOG.concepts.map((c) => c.id).filter((id) => heldOut.has(id) === held)
  return mean(ids.map((id) => f.byConcept[id]! - b.byConcept[id]!))
}

export function analyzeSimRun(data: SimLearnerData[]) {
  const complete = data.filter((d) => final(d) && baseline(d))
  const arms = [...new Set(data.map((d) => d.config.arm))]
  const by = (arm: string) => complete.filter((d) => d.config.arm === arm)
  const gain = (d: SimLearnerData) => final(d)!.total - baseline(d)!.total
  const did = (d: SimLearnerData) => groupGain(d, false)! - groupGain(d, true)!

  // Claim 1: does injection improve understanding (exam), against no Learner, an irrelevant-text control, and within learner (taught vs held-out)?
  const claim1 = {
    byArm: Object.fromEntries(arms.map((arm) => [arm, { examGain: bootstrapMean(by(arm).map(gain)), taughtGain: bootstrapMean(by(arm).map((d) => groupGain(d, false)!)), heldOutGain: bootstrapMean(by(arm).map((d) => groupGain(d, true)!)), taughtMinusHeldOut: bootstrapMean(by(arm).map(did)) }])),
    contrasts: Object.fromEntries(arms.filter((a) => a !== 'off').map((arm) => [`${arm} - off`, { examGain: bootstrapDiff(by(arm).map(gain), by('off').map(gain)), taughtMinusHeldOut: bootstrapDiff(by(arm).map(did), by('off').map(did)) }])),
    // Pre-registered primary: within learner (taught minus held-out exam gain), Learner on against Learner off.
    primary: bootstrapDiff(by('on').map(did), by('off').map(did)),
    onVsControl: { examGain: bootstrapDiff(by('on').map(gain), by('control').map(gain)), taughtMinusHeldOut: bootstrapDiff(by('on').map(did), by('control').map(did)) },
    byLane: Object.fromEntries([...new Set(complete.map((d) => d.config.lane))].map((lane) => [lane, Object.fromEntries(arms.map((arm) => [arm, bootstrapMean(by(arm).filter((d) => d.config.lane === lane).map(gain))]))])),
    trajectory: Object.fromEntries(arms.map((arm) => [arm, Array.from({ length: Math.max(0, ...data.map((d) => d.config.sessions)) + 1 }, (_, t) => mean(by(arm).map((d) => d.exams.find((e) => e.timepoint === t)?.total).filter((x): x is number => x !== undefined)))])),
  }

  // Claim 2: does Learner's reporting track the exam? Pairs: (learner, concept, session) with an estimate.
  const pairs: Array<{ arm: string; reading: number; exam: number; dReading: number | null; dExam: number | null }> = []
  for (const d of data) {
    const latest = new Map<string, { percent: number; session: number }>()
    for (let s = 1; s <= d.config.sessions; s++) {
      const exam = d.exams.find((e) => e.timepoint === s)
      for (const r of d.readings.filter((x) => x.session === s && x.percent !== null)) {
        const prev = latest.get(r.conceptId)
        if (exam) {
          const prevExam = prev ? d.exams.find((e) => e.timepoint === prev.session)?.byConcept[r.conceptId] : undefined
          pairs.push({ arm: d.config.arm, reading: r.percent!, exam: exam.byConcept[r.conceptId]!, dReading: prev ? r.percent! - prev.percent : null, dExam: prev && prevExam !== undefined ? exam.byConcept[r.conceptId]! - prevExam : null })
        }
        latest.set(r.conceptId, { percent: r.percent!, session: s })
      }
    }
  }
  const changes = pairs.filter((p) => p.dReading !== null && p.dExam !== null && p.dReading !== 0)
  const bins = [0, 20, 40, 60, 80, 101].slice(0, -1).map((lo, i, all) => { const hi = i + 1 < all.length ? all[i + 1]! : 101; const inBin = pairs.filter((p) => p.reading >= lo && p.reading < hi); return { reading: `${lo}-${hi === 101 ? 100 : hi - 1}`, n: inBin.length, meanReading: mean(inBin.map((p) => p.reading)), meanExam: mean(inBin.map((p) => p.exam)) } })
  // A gain notification is false when the exam did not rise for that concept between the reading it beat and this one.
  const gainChecks = data.flatMap((d) => d.notifications.filter((n) => n.kind === 'gain').map((n) => {
    const r = d.readings.find((x) => x.assessmentRunId === n.runId)
    const before = r ? [...d.readings].filter((x) => x.conceptId === n.conceptId && x.session < r.session && x.percent !== null).at(-1) : undefined
    const examNow = r ? d.exams.find((e) => e.timepoint === r.session)?.byConcept[n.conceptId] : undefined
    const examBefore = before ? d.exams.find((e) => e.timepoint === before.session)?.byConcept[n.conceptId] : r ? baseline(d)?.byConcept[n.conceptId] : undefined
    return { arm: d.config.arm, learnerId: d.config.learnerId, conceptId: n.conceptId, delta: n.delta, examDelta: examNow !== undefined && examBefore !== undefined ? examNow - examBefore : null }
  }))
  // Learner's own holdout picture (final readings, taught minus held-out) against the exam's, per arm.
  const finalReadings = (d: SimLearnerData, held: boolean) => {
    const latest = new Map<string, number>()
    for (const r of d.readings) if (r.percent !== null && heldOutOf(d.config).has(r.conceptId) === held) latest.set(r.conceptId, r.percent)
    return latest.size ? mean([...latest.values()]) : NaN
  }
  const examFinal = (d: SimLearnerData, held: boolean) => { const e = final(d); return e ? mean(HALYARD_CATALOG.concepts.filter((c) => heldOutOf(d.config).has(c.id) === held).map((c) => e.byConcept[c.id]!)) : NaN }
  const holdout = Object.fromEntries(arms.map((arm) => [arm, {
    reported: bootstrapMean(data.filter((d) => d.config.arm === arm).map((d) => finalReadings(d, false) - finalReadings(d, true)).filter(Number.isFinite)),
    exam: bootstrapMean(by(arm).map((d) => examFinal(d, false) - examFinal(d, true))),
  }]))
  // Gradings per arm: the grader is anchored on its own previous estimate and rarely lowers it, so an arm
  // graded more often rises without learning. Shown next to every reading-based number.
  const gradings = Object.fromEntries(arms.map((arm) => {
    const ds = data.filter((d) => d.config.arm === arm)
    const graded = ds.flatMap((d) => d.readings.filter((r) => r.assessmentRunId))
    return [arm, { learners: ds.length, gradings: graded.length, perLearner: ds.length ? graded.length / ds.length : NaN, perLearnerConcept: ds.length ? graded.length / (ds.length * HALYARD_CATALOG.concepts.length) : NaN, withEstimate: graded.filter((r) => r.percent !== null).length }]
  }))
  // Known truth: the learner's knowledge is its notebook, and the closed-book exam reads exactly that. Per
  // (learner, concept): Learner's reported change (last reading minus first) against the exam's change over
  // the same sessions. In the frozen arm the true change is 0 by construction.
  const tracking = data.flatMap((d) => HALYARD_CATALOG.concepts.flatMap((concept) => {
    const rs = d.readings.filter((r) => r.conceptId === concept.id && r.percent !== null)
    if (rs.length < 2) return []
    const first = rs[0]!, last = rs.at(-1)!
    const e0 = d.exams.find((e) => e.timepoint === first.session)?.byConcept[concept.id], e1 = d.exams.find((e) => e.timepoint === last.session)?.byConcept[concept.id]
    if (e0 === undefined || e1 === undefined) return []
    return [{ arm: d.config.arm, reported: last.percent! - first.percent!, truth: e1 - e0 }]
  }))
  const knownTruth = Object.fromEntries(arms.map((arm) => {
    const t = tracking.filter((x) => x.arm === arm)
    return [arm, { n: t.length, meanReported: mean(t.map((x) => x.reported)), meanTruth: mean(t.map((x) => x.truth)), meanAbsError: mean(t.map((x) => Math.abs(x.reported - x.truth))), up: t.filter((x) => x.reported > 0).length, down: t.filter((x) => x.reported < 0).length, flat: t.filter((x) => x.reported === 0).length }]
  }))
  const claim2 = {
    gradings,
    knownTruth,
    trackingCorrelation: pearson(tracking.map((x) => x.reported), tracking.map((x) => x.truth)),
    holdout,
    pairs: pairs.length,
    pearson: pearson(pairs.map((p) => p.reading), pairs.map((p) => p.exam)),
    spearman: spearman(pairs.map((p) => p.reading), pairs.map((p) => p.exam)),
    meanAbsError: mean(pairs.map((p) => Math.abs(p.reading - p.exam))),
    meanBias: mean(pairs.map((p) => p.reading - p.exam)),
    signAgreement: { n: changes.length, agree: changes.filter((p) => Math.sign(p.dReading!) === Math.sign(p.dExam!)).length },
    calibration: bins,
    gainNotifications: { n: gainChecks.length, falseGains: gainChecks.filter((g) => g.examDelta !== null && g.examDelta <= 0).length, unknown: gainChecks.filter((g) => g.examDelta === null).length, items: gainChecks },
    firstClear: data.reduce((n, d) => n + d.notifications.filter((x) => x.kind === 'first_clear').length, 0),
    /** Learner's own measurements and verdicts (mastery-change statistics), read as the product reads them. The
     * prior-blind series carries every verdict; the anchored series is what the learner sees, descriptive only. */
    /** Which grader produced the readings, by prompt revision (the live product grades with the v6 prior-aware
     * incremental pass; manual assessment, which the sim uses, with the v5 prior-blind prompt). */
    promptRevisions: data.flatMap((d) => d.readings).reduce<Record<string, number>>((acc, r) => r.assessmentRunId ? { ...acc, [r.promptRevision ?? 'unknown']: (acc[r.promptRevision ?? 'unknown'] ?? 0) + 1 } : acc, {}),
    priorBlind: measurementAccuracy(data, 'blind'),
    anchoredMeasurements: measurementAccuracy(data, 'anchored'),
  }

  // Validity checks: grader noise, leakage, differential opportunity, the holdout, notebook pressure.
  const retests = data.flatMap((d) => d.retests).filter((r) => r.original !== null && r.retest !== null)
  const injectedOn = (d: SimLearnerData, held: boolean) => d.agentTurns.flatMap((t) => (t.decision === 'influence' ? t.conceptIds : [])).filter((id) => heldOutOf(d.config).has(id) === held).length
  const mentionRate = (arm: string, role: 'agent' | 'learner', held: boolean) => {
    const rates = data.filter((d) => d.config.arm === arm).flatMap((d) => {
      const ids = HALYARD_CATALOG.concepts.map((c) => c.id).filter((id) => heldOutOf(d.config).has(id) === held)
      const turns = role === 'agent' ? d.agentTurns : d.learnerTurns
      return turns.length ? [mean(ids.map((id) => turns.filter((t) => conceptMentioned(id, t.text)).length / turns.length))] : []
    })
    return mean(rates)
  }
  const validity = {
    graderRetest: { n: retests.length, meanAbsDiff: mean(retests.map((r) => Math.abs(r.retest! - r.original!))), sdDiff: sd(retests.map((r) => r.retest! - r.original!)), items: retests },
    leakage: { n: data.flatMap((d) => d.leakage).length, credited: data.flatMap((d) => d.leakage).filter((x) => (x.percent ?? 0) > 10).length, items: data.flatMap((d) => d.leakage) },
    heldOutInjections: data.reduce((n, d) => n + injectedOn(d, true), 0),
    taughtInjections: data.reduce((n, d) => n + injectedOn(d, false), 0),
    decisions: Object.fromEntries(arms.map((arm) => [arm, data.filter((d) => d.config.arm === arm).flatMap((d) => d.agentTurns).reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.decision]: (acc[t.decision] ?? 0) + 1 }), {})])),
    probes: data.flatMap((d) => d.agentTurns).filter((t) => t.probe).length,
    droppedMatches: data.reduce((n, d) => n + d.agentTurns.reduce((m, t) => m + t.droppedMatches, 0), 0),
    opportunity: Object.fromEntries(arms.map((arm) => [arm, { agentTaught: mentionRate(arm, 'agent', false), agentHeldOut: mentionRate(arm, 'agent', true), learnerTaught: mentionRate(arm, 'learner', false), learnerHeldOut: mentionRate(arm, 'learner', true) }])),
    notebookTruncated: data.flatMap((d) => d.notebooks).filter((n) => n.cut > 0).length,
    notebookCutChars: data.flatMap((d) => d.notebooks).reduce((n, x) => n + x.cut, 0),
    notebookOverCapacity: data.flatMap((d) => d.notebooks).reduce((n, x) => n + x.overCapacity, 0),
    notebookForgotten: data.flatMap((d) => d.notebooks).reduce((n, x) => n + x.forgotten, 0),
    notebooks: data.flatMap((d) => d.notebooks).length,
    incomplete: data.filter((d) => !final(d) || !baseline(d)).map((d) => d.config.learnerId),
  }

  // Cost: calls per learner-session by role, tokens and wall time per call.
  const calls = data.flatMap((d) => d.calls)
  const sessions = data.reduce((n, d) => n + d.config.sessions, 0)
  const roles = [...new Set(calls.map((c) => c.role))].sort()
  const cost = {
    learners: data.length, sessions, calls: calls.length, callsPerLearnerSession: calls.length / Math.max(1, sessions),
    byRole: Object.fromEntries(roles.map((role) => { const cs = calls.filter((c) => c.role === role); return [role, { calls: cs.length, perSession: cs.length / Math.max(1, sessions), meanSeconds: mean(cs.map((c) => c.durationMs / 1000)), inputTokens: cs.reduce((n, c) => n + (c.inputTokens ?? 0), 0), outputTokens: cs.reduce((n, c) => n + (c.outputTokens ?? 0), 0), retried: cs.filter((c) => c.attempts > 1).length, models: [...new Set(cs.map((c) => `${c.model}/${c.effort}`))] }] })),
    modelSeconds: calls.reduce((n, c) => n + c.durationMs, 0) / 1000,
  }
  return { learners: data.map((d) => ({ learnerId: d.config.learnerId, arm: d.config.arm, lane: d.config.lane, exams: d.exams.map((e) => e.total) })), claim1, claim2, validity, cost,
    batch2: data.some((d) => d.config.design === 'v2') ? analyzeBatch2(data) : null }
}
export type SimReport = ReturnType<typeof analyzeSimRun>

/** The session an evidence time belongs to: the last session that had started by then. */
const sessionAt = (d: SimLearnerData, at: number) => { let s = 0; (d.sessionStarts ?? []).forEach((start, i) => { if (Number.isFinite(start) && start <= at) s = i + 1 }); return s }
const examAt = (d: SimLearnerData, session: number, conceptId: string) => d.exams.find((e) => e.timepoint === session)?.byConcept[conceptId]

/**
 * Claim 2 on Learner's own statistics, one series at a time. Level: each measurement against the exam after the
 * session its evidence came from. Change: each concept's first-to-last change (masteryChanges, prior-blind series)
 * against the exam's change over the same sessions: sign agreement, interval coverage (true change inside
 * delta ± 1.96·se) and the verdicts (beyond noise after FDR) against whether the exam moved. Aggregate: each
 * learner's random-effects interval for the mean change against the learner's mean true change. Lanes: mean final
 * measurement per lane, ranked against the exam's ranking.
 */
export function measurementAccuracy(data: SimLearnerData[], series: 'blind' | 'anchored') {
  const withData = data.filter((d) => d.measurements)
  const level = withData.flatMap((d) => d.measurements![series].flatMap((m: CountedReading) => {
    const session = sessionAt(d, m.at), exam = examAt(d, session, m.conceptId)
    return session && exam !== undefined ? [{ arm: d.config.arm, lane: d.config.lane, reading: m.percent, exam }] : []
  }))
  // Per-concept change: the product's verdict set for the blind series; the same first-to-last change for anchored.
  const change = withData.flatMap((d) => {
    const items: Array<Pick<ConceptChange, 'conceptId' | 'from' | 'to' | 'fromAt' | 'toAt' | 'delta'> & { deltaSe: number | null; beyondNoise: boolean | null }> = series === 'blind'
      ? d.changes?.concepts ?? []
      : [...d.measurements!.anchored.reduce((g, m) => g.set(m.conceptId, [...(g.get(m.conceptId) ?? []), m]), new Map<string, CountedReading[]>()).values()].flatMap((ms) => ms.length > 1 ? [{ conceptId: ms[0]!.conceptId, from: ms[0]!.percent, to: ms.at(-1)!.percent, fromAt: ms[0]!.at, toAt: ms.at(-1)!.at, delta: ms.at(-1)!.percent - ms[0]!.percent, deltaSe: null, beyondNoise: null }] : [])
    return items.flatMap((c) => {
      const s0 = sessionAt(d, c.fromAt), s1 = sessionAt(d, c.toAt), e0 = examAt(d, s0, c.conceptId), e1 = examAt(d, s1, c.conceptId)
      if (!s0 || !s1 || s0 === s1 || e0 === undefined || e1 === undefined) return []
      return [{ arm: d.config.arm, learnerId: d.config.learnerId, reported: c.delta, se: c.deltaSe, beyondNoise: c.beyondNoise, truth: e1 - e0 }]
    })
  })
  const moved = change.filter((c) => c.reported !== 0)
  const covered = change.filter((c) => c.se !== null && c.se > 0)
  const verdicts = change.filter((c) => c.beyondNoise !== null)
  const aggregate = series === 'blind' ? withData.flatMap((d) => {
    const iv = d.changes?.aggregate.changeInterval
    const truths = change.filter((c) => c.learnerId === d.config.learnerId).map((c) => c.truth)
    return iv && truths.length ? [{ arm: d.config.arm, lo: iv[0], hi: iv[1], truth: mean(truths) }] : []
  }) : []
  const lanes = [...new Set(withData.map((d) => d.config.lane))]
  const laneMeans = lanes.map((lane) => {
    const ds = withData.filter((d) => d.config.lane === lane)
    const finals = ds.flatMap((d) => [...new Map(d.measurements![series].map((m) => [m.conceptId, m.percent])).values()])
    return { lane, reported: mean(finals), exam: mean(ds.map((d) => final(d)?.total).filter((x): x is number => x !== undefined)) }
  })
  const rank = (key: 'reported' | 'exam') => [...laneMeans].filter((l) => Number.isFinite(l[key])).sort((a, b) => a[key] - b[key]).map((l) => l.lane)
  return {
    measurements: level.length,
    pearson: pearson(level.map((p) => p.reading), level.map((p) => p.exam)),
    meanBias: mean(level.map((p) => p.reading - p.exam)),
    meanAbsError: mean(level.map((p) => Math.abs(p.reading - p.exam))),
    changes: change.length,
    changeCorrelation: pearson(change.map((c) => c.reported), change.map((c) => c.truth)),
    signAgreement: { n: moved.filter((c) => c.truth !== 0).length, agree: moved.filter((c) => c.truth !== 0 && Math.sign(c.reported) === Math.sign(c.truth)).length },
    intervalCoverage: { n: covered.length, covered: covered.filter((c) => Math.abs(c.truth - c.reported) <= 1.96 * c.se!).length },
    verdicts: { n: verdicts.length, beyondNoise: verdicts.filter((c) => c.beyondNoise).length, beyondNoiseExamMovedSameWay: verdicts.filter((c) => c.beyondNoise && Math.sign(c.truth) === Math.sign(c.reported) && c.truth !== 0).length,
      quietExamMoved: verdicts.filter((c) => !c.beyondNoise && Math.abs(c.truth) >= 25).length },
    aggregateCoverage: { n: aggregate.length, covered: aggregate.filter((a) => a.truth >= a.lo && a.truth <= a.hi).length },
    lanes: laneMeans, laneRank: { reported: rank('reported'), exam: rank('exam') },
  }
}

/** Planned calls per learner (upper bound for grading: a concept with no new evidence is not regraded). */
/** The most calls a learner can make. `gradingReplicates` is the policy's k: a Learner arm grades through the product
 * workflow, which grades each reading k times; `off` grades directly, once. */
export function plannedCalls(c: SimLearnerConfig, gradingReplicates = 1) {
  const actions = simActions(c)
  const count = (k: string) => actions.filter((a) => a.kind === k).length
  return { learner: count('learner'), 'agent-reply': count('agent'), 'agent-match': c.arm === 'off' ? 0 : count('agent'), notebook: c.arm === 'frozen' ? 0 : count('notebook'), 'exam-answer': count('exam-answer'), 'exam-score': count('exam-score'), grader: count('grade') * (c.arm === 'off' ? 1 : gradingReplicates) + c.retests + (c.leakageProbe ? 3 : 0) }
}

const f = (x: number, d = 1) => Number.isFinite(x) ? x.toFixed(d) : 'n/a'
const est = (e: Estimate) => `${f(e.mean)} [${f(e.lo)}, ${f(e.hi)}] (n=${e.n})`
export function renderSimReport(runId: string, r: SimReport): string {
  const lines = [`# Simulated-learner run ${runId}`, '', `Learners: ${r.learners.length}. Exam scores are percent of points on the closed-book exam (8 single-fact questions per concept, 0-100). Intervals are 95% percentile-bootstrap over learners; with n=1 per group there is no interval.`, '',
    ...(r.batch2 ? [...renderBatch2(r.batch2), '## Batch-1 tables (descriptive for a batch-2 run)', ''] : []),
    r.batch2 ? '### Batch-1 primary (taught minus held-out, on minus off)' : '## Primary outcome', '',
    `Within learner: blind exam gain on taught concepts minus held-out concepts (final minus baseline), arm \`on\` minus arm \`off\` (a difference of differences): **${est(r.claim1.primary)}**.`, '',
    '## Claim 1: exam gain (final minus baseline)', '', '| arm | exam gain | taught gain | held-out gain | taught minus held-out |', '|---|---|---|---|---|',
    ...Object.entries(r.claim1.byArm).map(([arm, x]) => `| ${arm} | ${est(x.examGain)} | ${est(x.taughtGain)} | ${est(x.heldOutGain)} | ${est(x.taughtMinusHeldOut)} |`), '',
    '| contrast | exam gain difference | taught-minus-held-out difference |', '|---|---|---|',
    ...Object.entries(r.claim1.contrasts).map(([k, x]) => `| ${k} | ${est(x.examGain)} | ${est(x.taughtMinusHeldOut)} |`),
    `| on - control | ${est(r.claim1.onVsControl.examGain)} | ${est(r.claim1.onVsControl.taughtMinusHeldOut)} |`, '',
    'Mean exam total by timepoint:', '', ...Object.entries(r.claim1.trajectory).map(([arm, xs]) => `- ${arm}: ${xs.map((x) => f(x, 0)).join(' -> ')}`), '',
    '## Claim 2: Learner readings against the exam', '',
    `- pairs (learner x concept x session with an estimate): ${r.claim2.pairs}`,
    `- Pearson r ${f(r.claim2.pearson, 2)}, Spearman rho ${f(r.claim2.spearman, 2)}, mean |reading - exam| ${f(r.claim2.meanAbsError)} points, mean bias ${f(r.claim2.meanBias)}`,
    `- sign agreement of changes: ${r.claim2.signAgreement.agree}/${r.claim2.signAgreement.n}`,
    `- gain notifications: ${r.claim2.gainNotifications.n}; false (exam did not rise): ${r.claim2.gainNotifications.falseGains}; undecidable: ${r.claim2.gainNotifications.unknown}; first-clear notifications: ${r.claim2.firstClear}`, '',
    '| arm | learners | gradings | per learner | per learner x concept | with an estimate |', '|---|---|---|---|---|---|',
    ...Object.entries(r.claim2.gradings).map(([arm, g]) => `| ${arm} | ${g.learners} | ${g.gradings} | ${f(g.perLearner)} | ${f(g.perLearnerConcept, 2)} | ${g.withEstimate} |`), '',
    `Known truth (per learner x concept with 2+ readings: reported change, last minus first reading, against the exam's change over the same sessions; frozen arm truth is 0 by construction). Pearson r over all: ${f(r.claim2.trackingCorrelation, 2)}.`, '',
    '| arm | n | mean reported change | mean true change | mean abs error | reported up / down / flat |', '|---|---|---|---|---|---|',
    ...Object.entries(r.claim2.knownTruth).map(([arm, k]) => `| ${arm} | ${k.n} | ${f(k.meanReported)} | ${f(k.meanTruth)} | ${f(k.meanAbsError)} | ${k.up} / ${k.down} / ${k.flat} |`), '',
    '| arm | reported taught minus held-out (final readings) | exam taught minus held-out (final) |', '|---|---|---|',
    ...Object.entries(r.claim2.holdout).map(([arm, x]) => `| ${arm} | ${est(x.reported)} | ${est(x.exam)} |`), '',
    '### Claim 2 on Learner\'s own measurements', '',
    `Grader prompt revisions of these readings: ${Object.entries(r.claim2.promptRevisions).map(([k, n]) => `\`${k}\` ${n}`).join(', ') || 'none'}.${Object.keys(r.claim2.promptRevisions).some((k) => k.includes('prior-aware')) ? '' : ' A prior-blind prompt makes every reading a prior-blind measurement, so the two series below coincide; the live product\'s anchored readings come from the prior-aware incremental pass, which this run does not exercise.'}`, '',
    'Read as the product reads them (mastery-change statistics). Only the prior-blind series carries verdicts; the anchored series is the live score the learner sees, descriptive only. A measurement is dated by its evidence and compared with the exam after the session that evidence came from.', '',
    '| series | measurements | Pearson r | mean bias | mean abs error | concept changes | change r | sign agreement | interval coverage (95%) | verdicts beyond noise (exam moved the same way) | quiet while exam moved 25+ | learner interval coverage | lane rank (reported / exam) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...([['prior-blind', r.claim2.priorBlind], ['anchored (live)', r.claim2.anchoredMeasurements]] as const).map(([name, a]) => `| ${name} | ${a.measurements} | ${f(a.pearson, 2)} | ${f(a.meanBias)} | ${f(a.meanAbsError)} | ${a.changes} | ${f(a.changeCorrelation, 2)} | ${a.signAgreement.agree}/${a.signAgreement.n} | ${a.intervalCoverage.n ? `${a.intervalCoverage.covered}/${a.intervalCoverage.n}` : 'n/a'} | ${a.verdicts.n ? `${a.verdicts.beyondNoise}/${a.verdicts.n} (${a.verdicts.beyondNoiseExamMovedSameWay})` : 'n/a'} | ${a.verdicts.n ? a.verdicts.quietExamMoved : 'n/a'} | ${a.aggregateCoverage.n ? `${a.aggregateCoverage.covered}/${a.aggregateCoverage.n}` : 'n/a'} | ${a.laneRank.reported.join(' < ')} / ${a.laneRank.exam.join(' < ')} |`), '',
    '| reading bin | n | mean reading | mean exam |', '|---|---|---|---|', ...r.claim2.calibration.map((b) => `| ${b.reading} | ${b.n} | ${f(b.meanReading)} | ${f(b.meanExam)} |`), '',
    '## Validity checks', '',
    `- grader test-retest: n=${r.validity.graderRetest.n}, mean |diff| ${f(r.validity.graderRetest.meanAbsDiff)} points, sd of diff ${f(r.validity.graderRetest.sdDiff)}`,
    `- leakage probes (assistant-only explanation): ${r.validity.leakage.credited}/${r.validity.leakage.n} credited above 10%`,
    `- injected concept slots: taught ${r.validity.taughtInjections}, held-out ${r.validity.heldOutInjections} (must be 0)`,
    `- blind probes delivered: ${r.validity.probes}; invalid agent tags dropped: ${r.validity.droppedMatches}`,
    `- notebooks with any cut text: ${r.validity.notebookTruncated}/${r.validity.notebooks} (${r.validity.notebookCutChars} chars cut; must be 0); facts over the learner's capacity: ${r.validity.notebookOverCapacity}; facts forgotten by the lane's retention: ${r.validity.notebookForgotten}`,
    `- incomplete learners: ${r.validity.incomplete.join(', ') || 'none'}`, '',
    '| arm | decisions | agent mentions taught | held-out | learner mentions taught | held-out |', '|---|---|---|---|---|---|',
    ...Object.entries(r.validity.opportunity).map(([arm, o]) => `| ${arm} | ${JSON.stringify(r.validity.decisions[arm])} | ${f(o.agentTaught, 2)} | ${f(o.agentHeldOut, 2)} | ${f(o.learnerTaught, 2)} | ${f(o.learnerHeldOut, 2)} |`), '',
    '## Cost', '', `${r.cost.calls} calls over ${r.cost.sessions} learner-sessions (${f(r.cost.callsPerLearnerSession)} per learner-session); ${f(r.cost.modelSeconds / 3600, 2)} model-hours.`, '',
    '| role | calls | per session | mean s | input tokens | output tokens | retried | model |', '|---|---|---|---|---|---|---|---|',
    ...Object.entries(r.cost.byRole).map(([role, x]) => `| ${role} | ${x.calls} | ${f(x.perSession)} | ${f(x.meanSeconds)} | ${x.inputTokens} | ${x.outputTokens} | ${x.retried} | ${x.models.join(', ')} |`), '']
  return lines.join('\n')
}

// ---------------------------------------------------------------- batch 2

/**
 * Batch 2's pre-registration (docs/specs/simulated-learner-experiment.md, "Batch 2"). The runner writes it into the
 * run's config.json before the first model call, and the report quotes it. The estimands are computed by
 * `analyzeBatch2` exactly as written here.
 */
export const BATCH2_PREREGISTRATION = {
  primary: {
    estimand: 'Whole-exam gain (exam after the last session minus the baseline, all 13 concepts, each learner\'s held-out concepts included), arm on minus arm off, learners of the slow and medium lanes pooled.',
    interval: '95% percentile bootstrap over learners, each arm resampled separately within lane (4,000 draws, fixed seed).',
    verdict: 'supported: the interval lies above 0. harm shown: it lies below 0. Otherwise not shown. Never softened.',
    target: 'A 5-point effect (16 learners per arm per lane; SD re-estimated by the arm-off pilot).',
  },
  secondary: [
    'oracle minus off, whole-exam gain (does the injection mechanism help with perfect mastery information?)',
    'oracle minus on, whole-exam gain (is the grader the limiting part?)',
    'within learner: gain on the learner\'s non-held-out concepts minus its held-out concepts, on minus off and oracle minus off',
    'every contrast per lane (slow, medium; the fast cell is descriptive)',
  ],
  checks: [
    'arm off: the within-learner held-out difference is about 0 (its interval covers 0); the holdout is random per learner',
    'lane order: the exam after the last session is ordered slow < medium < fast in arm off',
    'no injection ever targets a held-out concept',
  ],
  mechanism: [
    'dose: sheet facts stated per concept-session, on concepts the injection targeted that session against the rest, by arm',
    'waste: share of stated facts that were already right (2 points) on the previous exam, by arm',
    'restatement: share of facts wrong (0 points) on the previous exam that are stated in the next session (sessions 2 on), by arm',
  ],
  changedFromDesign: 'The design note named the within-learner difference (non-held-out minus held-out gain) as primary. Under a fixed per-session teaching budget, injection that only MOVES teaching from held-out to other concepts raises that difference while total learning stays flat, so it favours arm on by construction. It is secondary here, and the whole-exam gain is primary.',
} as const

const factConcept = (factId: string) => halyardId(factId.replace(/-f\d+$/, ''))
export function analyzeBatch2(data: SimLearnerData[]) {
  const v2 = data.filter((d) => d.config.design === 'v2')
  const complete = v2.filter((d) => final(d) && baseline(d))
  const arms: string[] = [...new Set(v2.map((d) => d.config.arm))].sort()
  const lanes = (['slow', 'medium', 'fast'] as const).filter((lane) => v2.some((d) => d.config.lane === lane))
  const gain = (d: SimLearnerData) => final(d)!.total - baseline(d)!.total
  const did = (d: SimLearnerData) => groupGain(d, false)! - groupGain(d, true)!
  const by = (arm: string, lane?: string) => complete.filter((d) => d.config.arm === arm && (!lane || d.config.lane === lane))
  const pooled = (arm: string) => by(arm).filter((d) => d.config.lane !== 'fast')

  // Mechanism checks, per arm, from the agent's own fact-channel records and the previous exam.
  const mechanism = Object.fromEntries(arms.map((arm) => {
    let targetedDose = 0, targetedCells = 0, otherDose = 0, otherCells = 0, stated = 0, alreadyRight = 0, misses = 0, missesStated = 0, budget = 0, over = 0, invalid = 0, reviews = 0, influence = 0, turns = 0
    for (const d of v2.filter((x) => x.config.arm === arm)) {
      for (let s = 1; s <= d.config.sessions; s++) {
        const ts = d.agentTurns.filter((t) => t.session === s)
        if (!ts.length) continue
        const prev = d.exams.find((e) => e.timepoint === s - 1)
        const facts = ts.flatMap((t) => t.statedFactIds ?? [])
        const targeted = new Set(ts.flatMap((t) => (t.decision === 'influence' ? t.conceptIds : [])))
        turns += ts.length
        influence += ts.filter((t) => t.decision === 'influence').length
        reviews += ts.filter((t) => t.review).length
        budget += d.config.factBudget ?? 0
        over += ts.reduce((n, t) => n + (t.overBudget ?? 0), 0)
        invalid += ts.reduce((n, t) => n + (t.invalidFacts ?? 0), 0)
        for (const concept of HALYARD_CATALOG.concepts) {
          const dose = facts.filter((f) => factConcept(f) === concept.id).length
          if (targeted.has(concept.id)) { targetedDose += dose; targetedCells++ } else { otherDose += dose; otherCells++ }
        }
        stated += facts.length
        if (prev) alreadyRight += facts.filter((f) => prev.points[f] === 2).length
        if (prev && s >= 2) {
          const zero = HALYARD_FACT_EXAM.map((q) => q.id).filter((id) => (prev.points[id] ?? 0) === 0)
          misses += zero.length
          missesStated += zero.filter((id) => facts.includes(id)).length
        }
      }
    }
    return [arm, { targetedDose: targetedCells ? targetedDose / targetedCells : NaN, targetedCells, otherDose: otherCells ? otherDose / otherCells : NaN, otherCells,
      stated, budget, budgetUsed: budget ? stated / budget : NaN, overBudget: over, invalidFacts: invalid,
      alreadyRightShare: stated ? alreadyRight / stated : NaN, restatement: misses ? missesStated / misses : NaN, misses,
      influenceTurns: influence, turns, reviewTurns: reviews }]
  }))

  const pooledLanes = lanes.filter((lane) => lane !== 'fast')
  const contrast = (a: string, b: string, f: (d: SimLearnerData) => number, lane?: string) => lane
    ? bootstrapDiff(by(a, lane).map(f), by(b, lane).map(f))
    : stratifiedDiff(pooledLanes.map((l) => by(a, l).map(f)), pooledLanes.map((l) => by(b, l).map(f)))
  const primary = contrast('on', 'off', gain)
  const verdict = !(primary.n > 1 && primary.nB > 1) ? 'not shown (too few learners)' : primary.lo > 0 ? 'supported' : primary.hi < 0 ? 'harm shown' : 'not shown'
  const pairs: Array<[string, string]> = [['on', 'off'], ['oracle', 'off'], ['oracle', 'on']]
  const present = pairs.filter(([a, b]) => arms.includes(a) && arms.includes(b))
  const outcome = {
    primary, verdict,
    contrasts: Object.fromEntries(present.map(([a, b]) => [`${a} - ${b}`, { examGain: contrast(a, b, gain), withinLearner: contrast(a, b, did),
      byLane: Object.fromEntries(lanes.map((lane) => [lane, { examGain: contrast(a, b, gain, lane), withinLearner: contrast(a, b, did, lane) }])) }])),
    byArm: Object.fromEntries(arms.map((arm) => [arm, { examGain: bootstrapMean(pooled(arm).map(gain)), withinLearner: bootstrapMean(pooled(arm).map(did)), sdGain: sd(pooled(arm).map(gain)), sdWithinLearner: sd(pooled(arm).map(did)),
      byLane: Object.fromEntries(lanes.map((lane) => [lane, { examGain: bootstrapMean(by(arm, lane).map(gain)), withinLearner: bootstrapMean(by(arm, lane).map(did)), finalExam: mean(by(arm, lane).map((d) => final(d)!.total)) }])) }])),
  }
  // Pre-registered checks.
  const offDid = bootstrapMean(by('off').map(did))
  const laneOrder = Object.fromEntries(arms.map((arm) => [arm, lanes.map((lane) => ({ lane, finalExam: mean(by(arm, lane).map((d) => final(d)!.total)), n: by(arm, lane).length }))]))
  const offLanes = laneOrder.off?.filter((l) => l.n > 0) ?? []
  const checks = {
    offWithinLearner: offDid, offWithinLearnerCoversZero: offDid.n > 1 ? offDid.lo <= 0 && offDid.hi >= 0 : null,
    laneOrder, offLanesOrdered: offLanes.length > 1 ? offLanes.every((l, i) => i === 0 || l.finalExam > offLanes[i - 1]!.finalExam) : null,
    heldOutTargeted: v2.reduce((n, d) => n + d.agentTurns.flatMap((t) => (t.decision === 'influence' ? t.conceptIds : [])).filter((id) => heldOutOf(d.config).has(id)).length, 0),
    holdoutCounts: Object.fromEntries(HALYARD_CATALOG.concepts.map((c) => [c.id, v2.filter((d) => heldOutOf(d.config).has(c.id)).length])),
    incomplete: v2.filter((d) => !final(d) || !baseline(d)).map((d) => d.config.learnerId),
  }
  return { preregistration: BATCH2_PREREGISTRATION, learners: v2.length, complete: complete.length, mechanism, checks, outcome }
}
export type Batch2Report = ReturnType<typeof analyzeBatch2>

/** Batch 2's section: the pre-registration, then the mechanism checks, then the outcome (in that order, on purpose). */
export function renderBatch2(b: Batch2Report): string[] {
  const pct = (x: number) => Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : 'n/a'
  return ['## Batch 2', '', `Learners: ${b.learners} (${b.complete} complete). Pre-registered before the first call (config.json).`, '',
    `- Primary: ${b.preregistration.primary.estimand} ${b.preregistration.primary.interval} ${b.preregistration.primary.verdict}`,
    `- Changed from the design note: ${b.preregistration.changedFromDesign}`, '',
    '### 1. Mechanism checks (before the outcome)', '',
    '| arm | dose on targeted concepts | dose on the rest | facts stated / budget | stated already right | last-exam misses restated | influence turns | review turns | over budget | invalid ids |', '|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(b.mechanism).map(([arm, m]) => `| ${arm} | ${f(m.targetedDose, 2)} (${m.targetedCells}) | ${f(m.otherDose, 2)} (${m.otherCells}) | ${m.stated} / ${m.budget} (${pct(m.budgetUsed)}) | ${pct(m.alreadyRightShare)} | ${pct(m.restatement)} of ${m.misses} | ${m.influenceTurns}/${m.turns} | ${m.reviewTurns} | ${m.overBudget} | ${m.invalidFacts} |`), '',
    'Dose is sheet facts stated per concept-session. Arm off has no injection, so every concept is in "the rest".', '',
    '### 2. Pre-registered checks', '',
    `- Arm off, within learner (non-held-out minus held-out gain): ${est(b.checks.offWithinLearner)}; covers 0: ${b.checks.offWithinLearnerCoversZero ?? 'n/a'}`,
    `- Lane order of the final exam in arm off (slow < medium < fast): ${b.checks.offLanesOrdered ?? 'n/a'}; ${Object.entries(b.checks.laneOrder).map(([arm, ls]) => `${arm}: ${ls.map((l) => `${l.lane} ${f(l.finalExam)} (n=${l.n})`).join(', ')}`).join('; ')}`,
    `- Held-out concepts targeted by an injection: ${b.checks.heldOutTargeted} (must be 0)`,
    `- Times each concept was held out: ${Object.values(b.checks.holdoutCounts).join(', ')}`,
    `- Incomplete learners: ${b.checks.incomplete.join(', ') || 'none'}`, '',
    '### 3. Outcome', '',
    `**Primary (whole-exam gain, on minus off, slow and medium pooled): ${est(b.outcome.primary)} vs n=${b.outcome.primary.nB}. Verdict: ${b.outcome.verdict}.**`, '',
    '| contrast | whole-exam gain | within learner | per lane: whole-exam gain |', '|---|---|---|---|',
    ...Object.entries(b.outcome.contrasts).map(([k, x]) => `| ${k} | ${est(x.examGain)} | ${est(x.withinLearner)} | ${Object.entries(x.byLane).map(([lane, y]) => `${lane} ${est(y.examGain)}`).join('; ')} |`), '',
    '| arm | whole-exam gain | SD | within learner | SD | per lane final exam |', '|---|---|---|---|---|---|',
    ...Object.entries(b.outcome.byArm).map(([arm, x]) => `| ${arm} | ${est(x.examGain)} | ${f(x.sdGain)} | ${est(x.withinLearner)} | ${f(x.sdWithinLearner)} | ${Object.entries(x.byLane).map(([lane, y]) => `${lane} ${f(y.finalExam)}`).join(', ')} |`), '']
}
