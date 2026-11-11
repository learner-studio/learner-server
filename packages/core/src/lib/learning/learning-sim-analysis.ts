import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { masteryNotifications } from './mastery-notifications.js'
import { HALYARD_CATALOG, HALYARD_HELD_OUT, HALYARD_TERMS } from './learning-sim-halyard.js'
import { examResult, simActions, type ExamResult, type SimLearnerConfig } from './learning-sim-experiment.js'

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
  readings: Array<{ session: number; conceptId: string; percent: number | null; confidence: string | null; assessmentRunId: string | null; status: string }>
  notifications: Array<{ runId: string; conceptId: string; kind: 'first_clear' | 'gain'; percent: number; delta: number | null }>
  agentTurns: Array<{ session: number; turn: number; decision: string; conceptIds: string[]; probe: string | null; injectedChars: number; droppedMatches: number; text: string }>
  learnerTurns: Array<{ session: number; turn: number; text: string }>
  notebooks: Array<{ session: number; written: number | null; kept: number; cut: number; overCapacity: number; forgotten: number }>
  retests: Array<{ conceptId: string; original: number | null; retest: number | null }>
  leakage: Array<{ conceptId: string; percent: number | null; confidence: string | null; status: string }>
  calls: Array<{ role: string; model: string; effort: string; inputTokens: number | null; outputTokens: number | null; durationMs: number; attempts: number }>
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
      if (!scored) continue
      const points = Object.fromEntries((parse(scored.output.text) as { scores: Array<{ id: string; points: number }> }).scores.map((x) => [x.id, Math.max(0, Math.min(2, Math.round(x.points)))]))
      exams.push(examResult(t, points))
    }
    const grades = calls.filter((c) => c.role === 'grader' && /^s\d+:grade:/.test(c.call_key)).map((c) => ({ session: Number(c.call_key.slice(1, c.call_key.indexOf(':'))), conceptId: c.call_key.split(':grade:')[1]!, ...(parse(c.output.text) as { assessmentRunId: string | null; status: string }) }))
    const receipts = new Map((await q<{ run_id: string; percent: string | null; confidence: string | null }>(
      `SELECT run_id,receipt#>>'{assessment,understandingPercent}' percent,receipt#>>'{assessment,confidence}' confidence FROM learning_concept_assessment_receipts WHERE run_id = ANY($1::text[])`,
      [grades.map((g) => g.assessmentRunId).filter(Boolean)])).rows.map((r) => [r.run_id, r]))
    const readings = grades.map((g) => { const r = g.assessmentRunId ? receipts.get(g.assessmentRunId) : undefined; return { session: g.session, conceptId: g.conceptId, percent: r?.percent == null ? null : Number(r.percent), confidence: r?.confidence ?? null, assessmentRunId: g.assessmentRunId, status: g.status } })
    const messages = (await q<{ session: number; seq: number; role: string; text: string; meta: Record<string, unknown> | null }>('SELECT session,seq,role,text,meta FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 ORDER BY session,seq,role', [runId, l.learner_id])).rows
    const notes = (await masteryNotifications(q, l.user_id, { since: null, limit: 1000 })).map((n) => ({ runId: n.runId, conceptId: n.conceptId, kind: n.kind, percent: n.percent, delta: n.delta }))
    const experiment = async (prefix: string) => (await q<{ request_id: string; concept_id: string; status: string; percent: string | null; confidence: string | null }>(
      `SELECT r.request_id,r.concept_id,COALESCE(t.receipt->>'status','pending') status,t.receipt#>>'{assessment,understandingPercent}' percent,t.receipt#>>'{assessment,confidence}' confidence
       FROM learning_concept_assessment_runs r LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.user_id=$1 AND r.request_id LIKE $2`, [l.user_id, `${prefix}%`])).rows
    const retestRows = await experiment(`sim-retest:${runId}:${l.learner_id}:`)
    const retests = retestRows.map((r) => { const originalRun = r.request_id.split(':').at(-1)!; const o = readings.find((x) => x.assessmentRunId === originalRun); return { conceptId: r.concept_id, original: o?.percent ?? null, retest: r.percent == null ? null : Number(r.percent) } })
    const leakage = (await experiment(`sim-leak:${runId}:${l.learner_id}:`)).map((r) => ({ conceptId: r.concept_id, percent: r.percent == null ? null : Number(r.percent), confidence: r.confidence, status: r.status }))
    out.push({
      config: l.config, userId: l.user_id, exams, readings, notifications: notes,
      agentTurns: messages.filter((m) => m.role === 'agent').map((m) => ({ session: m.session, turn: m.seq, text: m.text, decision: String(m.meta?.decision ?? 'none'), conceptIds: (m.meta?.conceptIds as string[]) ?? [], probe: (m.meta?.probe as string | null) ?? null, injectedChars: Number(m.meta?.injectedChars ?? 0), droppedMatches: Number(m.meta?.droppedMatches ?? 0) })),
      learnerTurns: messages.filter((m) => m.role === 'learner').map((m) => ({ session: m.session, turn: m.seq, text: m.text })),
      notebooks: messages.filter((m) => m.role === 'notebook').map((m) => ({ session: m.session, written: m.meta?.written == null ? null : Number(m.meta.written), kept: m.text.length,
        // A notebook stored before the per-topic merge has no `cut`: whatever exceeded the old cap was lost.
        cut: m.meta?.cut != null ? Number(m.meta.cut) : Math.max(0, Number(m.meta?.written ?? 0) - m.text.length),
        overCapacity: Number(m.meta?.overCapacity ?? 0), forgotten: Number(m.meta?.forgotten ?? 0) })),
      retests, leakage,
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
  const ids = HALYARD_CATALOG.concepts.map((c) => c.id).filter((id) => HALYARD_HELD_OUT.has(id) === held)
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
    for (const r of d.readings) if (r.percent !== null && HALYARD_HELD_OUT.has(r.conceptId) === held) latest.set(r.conceptId, r.percent)
    return latest.size ? mean([...latest.values()]) : NaN
  }
  const examFinal = (d: SimLearnerData, held: boolean) => { const e = final(d); return e ? mean(HALYARD_CATALOG.concepts.filter((c) => HALYARD_HELD_OUT.has(c.id) === held).map((c) => e.byConcept[c.id]!)) : NaN }
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
  }

  // Validity checks: grader noise, leakage, differential opportunity, the holdout, notebook pressure.
  const retests = data.flatMap((d) => d.retests).filter((r) => r.original !== null && r.retest !== null)
  const injectedOn = (d: SimLearnerData, held: boolean) => d.agentTurns.flatMap((t) => (t.decision === 'influence' ? t.conceptIds : [])).filter((id) => HALYARD_HELD_OUT.has(id) === held).length
  const mentionRate = (arm: string, role: 'agent' | 'learner', held: boolean) => {
    const ds = data.filter((d) => d.config.arm === arm), ids = HALYARD_CATALOG.concepts.map((c) => c.id).filter((id) => HALYARD_HELD_OUT.has(id) === held)
    const turns = ds.flatMap((d) => role === 'agent' ? d.agentTurns : d.learnerTurns)
    return turns.length ? mean(ids.map((id) => turns.filter((t) => conceptMentioned(id, t.text)).length / turns.length)) : NaN
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
  return { learners: data.map((d) => ({ learnerId: d.config.learnerId, arm: d.config.arm, lane: d.config.lane, exams: d.exams.map((e) => e.total) })), claim1, claim2, validity, cost }
}
export type SimReport = ReturnType<typeof analyzeSimRun>

/** Planned calls per learner (upper bound for grading: a concept with no new evidence is not regraded). */
export function plannedCalls(c: SimLearnerConfig) {
  const actions = simActions(c)
  const count = (k: string) => actions.filter((a) => a.kind === k).length
  return { learner: count('learner'), 'agent-reply': count('agent'), 'agent-match': c.arm === 'off' ? 0 : count('agent'), notebook: c.arm === 'frozen' ? 0 : count('notebook'), 'exam-answer': count('exam-answer'), 'exam-score': count('exam-score'), grader: count('grade') + c.retests + (c.leakageProbe ? 3 : 0) }
}

const f = (x: number, d = 1) => Number.isFinite(x) ? x.toFixed(d) : 'n/a'
const est = (e: Estimate) => `${f(e.mean)} [${f(e.lo)}, ${f(e.hi)}] (n=${e.n})`
export function renderSimReport(runId: string, r: SimReport): string {
  const lines = [`# Simulated-learner run ${runId}`, '', `Learners: ${r.learners.length}. Exam scores are percent of points on the closed-book exam (8 single-fact questions per concept, 0-100). Intervals are 95% percentile-bootstrap over learners; with n=1 per group there is no interval.`, '',
    '## Primary outcome', '',
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
