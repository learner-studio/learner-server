import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { masteryNotifications } from './mastery-notifications.js'
import { countedMeasurements, masteryChanges, type CountedMeasurements, type MasteryChanges } from './mastery-change.js'
import type { ConceptChange, CountedReading } from './mastery-change-statistics.js'
import { BRIEFED, HALYARD_CATALOG, halyardId } from './learning-sim-halyard.js'
import { HALYARD_FACT_EXAM } from './learning-sim-facts.js'
import { seeded } from './learning-sim-memory.js'
import { doubleScored, examResult, heldOutOf, scoredPoints, simPlan, type ExamResult, type SimLearnerConfig } from './learning-sim-experiment.js'

/**
 * Analysis of a simulated-learner run (docs/specs/simulated-learner-experiment.md, "Pre-registered analysis"): one
 * path, `analyzeSimRun`, computes every estimand of SIM_PREREGISTRATION, the claim-2 accuracy of Learner's own
 * measurements, and the cost.
 * `loadSimRun` only READS (receipts, readings, notifications): it never calls a model. `analyzeSimRun` is pure.
 */
type SimLearnerData = {
  config: SimLearnerConfig
  userId: string
  /** exam per timepoint (0 = the empty notebook's 0), from the scorer's receipts; missing timepoints are absent */
  exams: ExamResult[]
  /** Learner's reading per concept after each session's grading (null: no reading yet or no estimate) */
  readings: Array<{ session: number; conceptId: string; percent: number | null; confidence: string | null; assessmentRunId: string | null; status: string; promptRevision?: string | null }>
  notifications: Array<{ runId: string; conceptId: string; kind: 'first_clear' | 'gain'; percent: number; delta: number | null }>
  /** The agent's turns: the hook's decision and targets, and the fact channel (what the matcher found within budget,
   * what the agent claimed, what was redacted). */
  agentTurns: Array<{ session: number; turn: number; decision: string; conceptIds: string[]; statedFactIds: string[]; invalidFacts: number; review: string | null
    claimedFactIds: string[]; unofferedFacts: string[]; overBudgetFacts: string[]; redacted: number }>
  notebooks: Array<{ session: number; overCapacity: number; forgotten: number; strengthened: number; unabsorbed: number }>
  calls: Array<{ role: string; model: string; effort: string; inputTokens: number | null; outputTokens: number | null; durationMs: number; attempts: number; invocations: number }>
  /** What Learner itself reports (docs/specs/mastery-change-statistics.md), read as the product reads it: the counted
   * measurements (prior-blind and anchored, by evidence time) and masteryChanges (verdicts on prior-blind only). */
  measurements?: CountedMeasurements
  changes?: MasteryChanges
  /** First message time (ms) of each session, index = session - 1: maps an evidence time to the session it came from. */
  sessionStarts?: number[]
  /** B6: Learner's prior-blind reading of each blind probe answer (null: no estimate), by the session it opened. */
  probes: Array<{ session: number; conceptId: string; percent: number | null }>
  /** Each learner message after an agent reply in its session: the share of its content-word types found in the
   * previous 3 agent messages (`overlap`), and its type count (the B5 echo gate). */
  learnerOverlaps: Array<{ session: number; overlap: number; types: number }>
  /** Exams scored twice (one in ten), raw points of each scoring. */
  doubleScores: Array<{ timepoint: number; first: Record<string, number>; second: Record<string, number> }>
}

const parse = (text: string) => JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim())

export async function loadSimRun(runId: string): Promise<SimLearnerData[]> {
  const learners = (await q<{ learner_id: string; user_id: string; config: SimLearnerConfig }>('SELECT learner_id,user_id,config FROM learning_sim_learners WHERE run_id=$1 ORDER BY learner_id', [runId])).rows
  const out: SimLearnerData[] = []
  for (const l of learners) {
    const calls = (await q<{ call_key: string; role: string; model: string; effort: string; input_tokens: number | null; output_tokens: number | null; duration_ms: number; attempts: number; output: { text: string } }>(
      'SELECT call_key,role,model,effort,input_tokens,output_tokens,duration_ms,attempts,output FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2', [runId, l.learner_id])).rows
    // A pending receipt (a call cut off mid-flight and not yet replayed) has no text: it is paid, never read.
    const byKey = new Map(calls.filter((c) => c.output.text !== undefined).map((c) => [c.call_key, c]))
    const exams: ExamResult[] = []
    const doubleScores: NonNullable<SimLearnerData['doubleScores']> = []
    for (let t = 0; t <= l.config.sessions; t++) {
      const scored = byKey.get(`exam${t}:score`)
      // There is no baseline exam: an empty notebook scores 0.
      if (t === 0) { exams.push(examResult(0, {})); continue }
      if (!scored) continue
      const answered = byKey.get(`exam${t}:answer`)
      const answers = answered ? (parse(answered.output.text) as { answers: Array<{ id: string; guess?: boolean }> }).answers : []
      exams.push(examResult(t, scoredPoints(parse(scored.output.text), answers)))
      const second = byKey.get(`exam${t}:score2`)
      if (second) doubleScores.push({ timepoint: t, first: scoredPoints(parse(scored.output.text), []), second: scoredPoints(parse(second.output.text), []) })
    }
    const grades = calls.filter((c) => c.role === 'grader' && /^s\d+:grade:[^:]+$/.test(c.call_key)).map((c) => ({ session: Number(c.call_key.slice(1, c.call_key.indexOf(':'))), conceptId: c.call_key.split(':grade:')[1]!, ...(parse(c.output.text) as { assessmentRunId: string | null; status: string }) }))
    const probeGrades = calls.filter((c) => c.role === 'grader' && /^p\d+:grade:[^:]+$/.test(c.call_key)).map((c) => ({ session: Number(c.call_key.slice(1, c.call_key.indexOf(':'))), conceptId: c.call_key.split(':grade:')[1]!, ...(parse(c.output.text) as { assessmentRunId: string | null }) }))
    const receipts = new Map((await q<{ run_id: string; percent: string | null; confidence: string | null; revision: string | null }>(
      `SELECT r.run_id,t.receipt#>>'{assessment,understandingPercent}' percent,t.receipt#>>'{assessment,confidence}' confidence,r.snapshot->>'promptRevision' revision
       FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.run_id = ANY($1::text[])`,
      [[...grades, ...probeGrades].map((g) => g.assessmentRunId).filter(Boolean)])).rows.map((r) => [r.run_id, r]))
    const readings = grades.map((g) => { const r = g.assessmentRunId ? receipts.get(g.assessmentRunId) : undefined; return { session: g.session, conceptId: g.conceptId, percent: r?.percent == null ? null : Number(r.percent), confidence: r?.confidence ?? null, assessmentRunId: g.assessmentRunId, status: g.status, promptRevision: r?.revision ?? null } })
    const messages = (await q<{ session: number; seq: number; role: string; text: string; meta: Record<string, unknown> | null; created_at: Date }>('SELECT session,seq,role,text,meta,created_at FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 ORDER BY session,seq,role', [runId, l.learner_id])).rows
    const sessionStarts = Array.from({ length: l.config.sessions }, (_, i) => Math.min(...messages.filter((m) => m.session === i + 1 && m.role !== 'notebook').map((m) => m.created_at.getTime())))
    const notes = (await masteryNotifications(q, l.user_id, { since: null, limit: 1000 })).map((n) => ({ runId: n.runId, conceptId: n.conceptId, kind: n.kind, percent: n.percent, delta: n.delta }))
    out.push({
      config: l.config, userId: l.user_id, exams, readings, notifications: notes,
      agentTurns: messages.filter((m) => m.role === 'agent').map((m) => { const x = (m.meta ?? {}) as Record<string, unknown>; const ids = (k: string) => (x[k] as string[] | undefined) ?? []
        return { session: m.session, turn: m.seq, decision: String(x.decision ?? 'none'), conceptIds: ids('conceptIds'), statedFactIds: ids('statedFactIds'), invalidFacts: Number(x.invalidFacts ?? 0), review: (x.review as string | null) ?? null,
          claimedFactIds: ids('claimedFactIds'), unofferedFacts: ids('unofferedFacts'), overBudgetFacts: ids('overBudgetFacts'), redacted: Number(x.redacted ?? 0) } }),
      notebooks: messages.filter((m) => m.role === 'notebook').map((m) => ({ session: m.session, overCapacity: Number(m.meta?.overCapacity ?? 0), forgotten: Number(m.meta?.forgotten ?? 0),
        strengthened: Number(m.meta?.strengthened ?? 0), unabsorbed: Number(m.meta?.unabsorbed ?? 0) })),
      sessionStarts, doubleScores, learnerOverlaps: learnerOverlaps(messages),
      probes: probeGrades.map((g) => { const r = g.assessmentRunId ? receipts.get(g.assessmentRunId) : undefined; return { session: g.session, conceptId: g.conceptId, percent: r?.percent == null ? null : Number(r.percent) } }),
      measurements: await countedMeasurements(q, l.user_id),
      changes: await masteryChanges(q, l.user_id, { sinceDays: null }),
      calls: calls.map((c) => ({ role: c.role, model: c.model, effort: c.effort, inputTokens: c.input_tokens, outputTokens: c.output_tokens, durationMs: c.duration_ms, attempts: c.attempts, invocations: Math.max((c.output as { invocations?: number } | null)?.invocations ?? c.attempts, 1) })),
    })
  }
  return out
}

// ---------------------------------------------------------------- learner echo (B5)

/** The grader-validity report's measure (scratchpad grader-validity/textfeat.ts), so the gate compares with the owner's
 * 0.21: content-word types of 3+ letters, minus a stop list. Not the matcher's tokenizer, on purpose (R1): that one
 * stems and keeps short numeric tokens to find facts; sharing either way would move a pinned measure. */
const STOP = new Set('the and for that this with you are was but not can its have has had from they them then than there their what when where which who will would should could just also into onto out our your yours about over under more most some such only very each other any all both how why yes too were been being does did doing done get got make made use used using let lets like want need needs think thanks thank okay sure right well here now one two three way thing things still even much many same so if or of to in on at by be is as an a we i me my it do no up down off again further once because while during before after above below between through those these am may might must shall ok yeah go going see say said know mean ill im ive dont doesnt didnt isnt wont cant thats whats theres'.split(' '))
const contentTypes = (text: string) => new Set((text.toLowerCase().replace(/[’']/g, '').match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t)))
export function learnerOverlaps(rows: Array<{ session: number; seq: number; role: string; text: string }>) {
  // Conversation order: within a seq, Sam's message comes before the agent's reply to it.
  const rank = (role: string) => role === 'learner' ? 0 : role === 'agent' ? 1 : 2
  const messages = [...rows].sort((a, b) => a.session - b.session || a.seq - b.seq || rank(a.role) - rank(b.role))
  return messages.flatMap((m, i) => {
    if (m.role !== 'learner') return []
    const before = messages.slice(0, i).filter((x) => x.session === m.session && x.role === 'agent').slice(-3)
    const types = contentTypes(m.text)
    if (!before.length || !types.size) return []
    const source = contentTypes(before.map((x) => x.text).join('\n'))
    return [{ session: m.session, overlap: [...types].filter((t) => source.has(t)).length / types.size, types: types.size }]
  })
}
/** Pre-registered B5 gate: mean overlap ≤ 0.35 and share ≥ 0.7 ≤ 5%, on all messages and on 25-50 content types. */
export function learnerEcho(data: SimLearnerData[]) {
  const summary = (xs: Array<{ overlap: number }>) => ({ n: xs.length, mean: mean(xs.map((x) => x.overlap)), shareHigh: xs.length ? xs.filter((x) => x.overlap >= 0.7).length / xs.length : NaN })
  const all = data.flatMap((d) => d.learnerOverlaps)
  const out = { all: summary(all), lengthMatched: summary(all.filter((x) => x.types >= 25 && x.types <= 50)) }
  const pass = (x: { n: number; mean: number; shareHigh: number }) => x.n > 0 && x.mean <= 0.35 && x.shareHigh <= 0.05
  return { ...out, ok: all.length ? pass(out.all) && pass(out.lengthMatched) : null }
}

// ---------------------------------------------------------------- claim 2 primary: blind probes (B6)

const ranks = (xs: number[]) => {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0])
  const out = new Array<number>(xs.length)
  for (let i = 0; i < order.length;) { let j = i; while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++; for (let k = i; k <= j; k++) out[order[k]![1]] = (i + j) / 2; i = j + 1 }
  return out
}
type ProbePair = { reading: number; truth: number }
const probeStats = (pairs: ProbePair[]) => ({ n: pairs.length, mae: mean(pairs.map((p) => Math.abs(p.reading - p.truth))), bias: mean(pairs.map((p) => p.reading - p.truth)),
  spearman: pearson(ranks(pairs.map((p) => p.reading)), ranks(pairs.map((p) => p.truth))) })
/** Pre-registered (sim-batch2-design.md section 6): each probe's prior-blind reading against the exam after the
 * previous session for that concept, which answered from the same notebook. 95% intervals resample learners.
 * Accurate: MAE ≤ 20 and the Spearman interval above 0; inaccurate: MAE ≥ 30, or n ≥ 40 and the interval covers 0. */
export function blindProbes(data: SimLearnerData[]) {
  const learners = data.map((d) => d.probes.flatMap((p) => { const truth = examAt(d, p.session - 1, p.conceptId); return p.percent === null || truth === undefined ? [] : [{ reading: p.percent, truth }] })).filter((x) => x.length)
  const point = probeStats(learners.flat())
  const r = rng(6), mae: number[] = [], rho: number[] = []
  for (let b = 0; b < 4000 && learners.length > 1; b++) {
    const st = probeStats(resample(learners, r).flat())
    mae.push(st.mae); if (Number.isFinite(st.spearman)) rho.push(st.spearman)
  }
  const [maeLo, maeHi] = ci(mae), [rhoLo, rhoHi] = ci(rho)
  // The baseline a reading must beat: a constant reading at the observed median truth (the constant with the least MAE).
  const sorted = learners.flat().map((p) => p.truth).sort((a, b) => a - b), mid = sorted.length / 2
  const median = sorted.length % 2 ? sorted[Math.floor(mid)]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  const constantMae = mean(sorted.map((t) => Math.abs(t - median)))
  const verdict = !point.n || !Number.isFinite(rhoLo) ? 'not computable'
    : point.mae <= 20 && point.mae < constantMae && rhoLo > 0 ? 'accurate'
      : point.mae >= 30 || (point.n >= 40 && rhoLo <= 0 && rhoHi >= 0) ? 'inaccurate' : 'inconclusive'
  // A probe with no reading (the grader gave no estimate) is not a pair; counted by arm, as incompletion is (S5).
  const noEstimate: Record<string, { probes: number; none: number }> = {}
  for (const d of data) for (const p of d.probes) { const a = (noEstimate[d.config.arm] ??= { probes: 0, none: 0 }); a.probes++; if (p.percent === null) a.none++ }
  return { ...point, learners: learners.length, maeLo, maeHi, rhoLo, rhoHi, constantMae, verdict, noEstimate }
}

// ---------------------------------------------------------------- statistics

const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const sd = (xs: number[]) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) }
/** The simulator's PRNG with a numbered bootstrap seed, so a report is reproducible from its rows. */
const rng = (seed: number) => seeded(`bootstrap:${seed}`)
/** One bootstrap resample (with replacement) of `xs`: the only resampling every interval of the report uses. */
const resample = <T>(xs: readonly T[], r: () => number) => Array.from({ length: xs.length }, () => xs[Math.floor(r() * xs.length)]!)
const resampleMean = (xs: number[], r: () => number) => mean(resample(xs, r))
/** The one percentile interval of every bootstrap here: [lo, hi] at `level` (NaN when there are no draws). */
const ci = (draws: number[], level = 0.95) => {
  const v = [...draws].sort((a, b) => a - b)
  return v.length ? [v[Math.floor(((1 - level) / 2) * v.length)]!, v[Math.ceil(((1 + level) / 2) * v.length) - 1]!] as const : [NaN, NaN] as const
}
export type Estimate = { n: number; mean: number; lo: number; hi: number }
/** Percentile bootstrap over learners (the unit of randomization): 95% CI of the mean, 4000 resamples. */
function bootstrapMean(xs: number[], seed = 1): Estimate {
  if (!xs.length) return { n: 0, mean: NaN, lo: NaN, hi: NaN }
  const r = rng(seed), means: number[] = []
  for (let b = 0; b < 4000; b++) means.push(resampleMean(xs, r))
  const [lo, hi] = xs.length > 1 ? ci(means) : [NaN, NaN]
  return { n: xs.length, mean: mean(xs), lo, hi }
}
type LaneEstimate = Estimate & { nB: number; lo90: number; hi90: number; lanes: number }
/** The mean over strata (lanes) of the per-lane difference of group means, each group resampled within its lane
 * (4,000 draws): every lane weighs the same whatever its size. 95% and 90% percentile intervals. A lane with an
 * empty group makes the estimate undefined (NaN), never silently drops out. */
function laneMeanDiff(a: number[][], b: number[][], seed = 3): LaneEstimate {
  const n = a.flat().length, nB = b.flat().length, lanes = a.length
  const none = { n, nB, lanes, mean: NaN, lo: NaN, hi: NaN, lo90: NaN, hi90: NaN }
  if (!lanes || a.some((g) => !g.length) || b.some((g) => !g.length)) return none
  const r = rng(seed), diffs: number[] = []
  for (let i = 0; i < 4000; i++) diffs.push(mean(a.map((g, l) => resampleMean(g, r) - resampleMean(b[l]!, r))))
  const ok = a.every((g) => g.length > 1) && b.every((g) => g.length > 1)
  const [lo, hi] = ok ? ci(diffs) : [NaN, NaN], [lo90, hi90] = ok ? ci(diffs, 0.9) : [NaN, NaN]
  return { n, nB, lanes, mean: mean(a.map((g, l) => mean(g) - mean(b[l]!))), lo, hi, lo90, hi90 }
}
function pearson(xs: number[], ys: number[]) {
  if (xs.length < 3) return NaN
  const mx = mean(xs), my = mean(ys)
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < xs.length; i++) { sxy += (xs[i]! - mx) * (ys[i]! - my); sxx += (xs[i]! - mx) ** 2; syy += (ys[i]! - my) ** 2 }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN
}

// ---------------------------------------------------------------- analysis

const final = (d: SimLearnerData) => d.exams.find((e) => e.timepoint === d.config.sessions)
/** Gains are final-exam scores: the baseline is an empty notebook's 0 (no baseline exam is taken). */
const groupGain = (d: SimLearnerData, held: boolean) => {
  const f = final(d)
  if (!f) return null
  const heldOut = heldOutOf(d.config)
  return mean(HALYARD_CATALOG.concepts.map((c) => c.id).filter((id) => heldOut.has(id) === held).map((id) => f.byConcept[id]!))
}

/** The session an evidence time belongs to: the last session that had started by then. */
const sessionAt = (d: SimLearnerData, at: number) => { let s = 0; (d.sessionStarts ?? []).forEach((start, i) => { if (Number.isFinite(start) && start <= at) s = i + 1 }); return s }
const examAt = (d: SimLearnerData, session: number, conceptId: string) => d.exams.find((e) => e.timepoint === session)?.byConcept[conceptId]

/**
 * Claim 2 on what the app reports (prior-blind series, masteryChanges). Level, EXPLORATORY: each measurement against
 * the exam after the session its evidence came from. Change, PRE-REGISTERED (`SIM_PREREGISTRATION.claim2.changes`):
 * each concept's first-to-last change against the exam's change over the same sessions: sign agreement where the
 * exam moved 25+ points, interval coverage (true change inside delta ± 1.96·se), and the verdicts (beyond noise
 * after FDR) against whether the exam moved. Aggregate: each learner's interval for the mean change against the
 * learner's mean true change.
 */
function measurementAccuracy(data: SimLearnerData[]) {
  const withData = data.filter((d) => d.measurements)
  const level = withData.flatMap((d) => d.measurements!.blind.flatMap((m: CountedReading) => {
    const session = sessionAt(d, m.at), exam = examAt(d, session, m.conceptId)
    return session && exam !== undefined ? [{ reading: m.percent, exam }] : []
  }))
  const change = withData.flatMap((d) => (d.changes?.concepts ?? []).flatMap((c: ConceptChange) => {
    const s0 = sessionAt(d, c.fromAt), s1 = sessionAt(d, c.toAt), e0 = examAt(d, s0, c.conceptId), e1 = examAt(d, s1, c.conceptId)
    if (!s0 || !s1 || s0 === s1 || e0 === undefined || e1 === undefined) return []
    return [{ learnerId: d.config.learnerId, reported: c.delta, se: c.deltaSe, beyondNoise: c.beyondNoise, truth: e1 - e0 }]
  }))
  const clear = change.filter((c) => Math.abs(c.truth) >= 25 && c.reported !== 0)
  const covered = change.filter((c) => c.se !== null && c.se > 0)
  const verdicts = change.filter((c) => c.beyondNoise !== null)
  const aggregate = withData.flatMap((d) => {
    const iv = d.changes?.aggregate.changeInterval
    const truths = change.filter((c) => c.learnerId === d.config.learnerId).map((c) => c.truth)
    return iv && truths.length ? [{ lo: iv[0], hi: iv[1], truth: mean(truths) }] : []
  })
  const calibration = [0, 20, 40, 60, 80].map((lo) => { const inBin = level.filter((p) => p.reading >= lo && p.reading < (lo === 80 ? 101 : lo + 20))
    return { reading: `${lo}-${lo === 80 ? 100 : lo + 19}`, n: inBin.length, meanReading: mean(inBin.map((p) => p.reading)), meanExam: mean(inBin.map((p) => p.exam)) } })
  return {
    measurements: level.length, calibration,
    pearson: pearson(level.map((p) => p.reading), level.map((p) => p.exam)),
    meanBias: mean(level.map((p) => p.reading - p.exam)),
    meanAbsError: mean(level.map((p) => Math.abs(p.reading - p.exam))),
    changes: change.length,
    changeCorrelation: pearson(change.map((c) => c.reported), change.map((c) => c.truth)),
    signAgreement: { n: clear.length, agree: clear.filter((c) => Math.sign(c.reported) === Math.sign(c.truth)).length },
    intervalCoverage: { n: covered.length, covered: covered.filter((c) => Math.abs(c.truth - c.reported) <= 1.96 * c.se!).length },
    verdicts: { n: verdicts.length, beyondNoise: verdicts.filter((c) => c.beyondNoise).length, beyondNoiseExamMovedSameWay: verdicts.filter((c) => c.beyondNoise && Math.sign(c.truth) === Math.sign(c.reported) && c.truth !== 0).length,
      quietExamMoved: verdicts.filter((c) => !c.beyondNoise && Math.abs(c.truth) >= 25).length },
    aggregateCoverage: { n: aggregate.length, covered: aggregate.filter((a) => a.truth >= a.lo && a.truth <= a.hi).length },
  }
}
/** Pre-registered claim-2 verdict on the app's change reports: each criterion is a share with a minimum n; any failure
 * reads "inaccurate", every one met reads "accurate", otherwise (too few) "not computable". */
export function changeReportVerdict(x: { sign: { n: number; agree: number }; coverage: { n: number; covered: number }; gains: { n: number; falseGains: number } }) {
  const t = SIM_PREREGISTRATION.claim2.changes
  const criteria = [[x.sign.n, x.sign.agree / x.sign.n >= t.signAgreement.min, t.signAgreement.minN], [x.coverage.n, x.coverage.covered / x.coverage.n >= t.intervalCoverage.min, t.intervalCoverage.minN],
    [x.gains.n, x.gains.falseGains / x.gains.n <= t.falseGains.max, t.falseGains.minN]] as Array<[number, boolean, number]>
  const computable = criteria.filter(([n, , minN]) => n >= minN)
  return computable.some(([, ok]) => !ok) ? 'inaccurate' : computable.length === criteria.length ? 'accurate' : 'not computable'
}

/** The most calls a learner can make. `gradingReplicates` is the policy's k: arm on grades through the product workflow,
 * which grades each reading k times; a concept with no new evidence is not regraded, so grading is an upper bound. */
export function plannedCalls(c: SimLearnerConfig, gradingReplicates = 1) {
  const sessions = simPlan(c)
  const actions = sessions.flatMap((s) => s.actions.map((a) => a.action))
  const count = (k: string) => actions.filter((a) => a.kind === k).length
  // A blind probe (B6) is one learner call and one grading; a session with nothing delivered before it asks none, so
  // these are upper bounds.
  return { learner: count('learner') + count('probe'), 'agent-reply': count('agent'), 'agent-match': c.arm === 'off' ? 0 : count('agent'), notebook: count('notebook'), 'exam-answer': count('exam-answer'),
    // One exam in ten is scored twice (a deterministic draw), so the count is exact.
    'exam-score': count('exam-score') + actions.filter((x) => x.kind === 'exam-score' && doubleScored(c, x.session)).length,
    grader: (sessions.reduce((n, s) => n + s.grades.length, 0) + count('probe')) * gradingReplicates }
}

// ---------------------------------------------------------------- the pre-registered analysis

/**
 * The pre-registration (docs/specs/simulated-learner-experiment.md). The runner writes it into the run's config.json
 * once, before the first model call, with the sha256 of this file; `analyzeSimRun` computes every estimand exactly as
 * written here, and the report quotes it.
 */
export const SIM_PREREGISTRATION = {
  scope: 'What this measures: an LLM learner with a capacity-limited notebook, under fixed memory rules (MEMORY_RULES: forgetting, spacing, prerequisite absorption), taught by an LLM agent through a budgeted fact channel, with Learner\'s live hook running the shipped policy plus spacedRepetition: true and foundationFirst: true (NEITHER is the product default; both are off by default). The result is conditional on those rules and settings and says nothing about a real person\'s memory, nor about the product as shipped by default.',
  primary: {
    scope: 'The whole exam (13 concepts) and no narrower scope: every arm gets the same exam, the same catalog and manual naming each concept\'s prerequisites, the same 2 lookups beyond the brief and the same budget, so what an arm earns on the 4 foundations no brief names is its agent\'s choice, not the design\'s. Scoring only the 9 briefed concepts would penalize any arm that teaches prerequisites. The split (9 briefed, 4 foundations) is reported with no verdict.',
    lanes: 'Main batch: fast lane off 30, on 30, oracle 4 (an anchor, no verdict); slow and medium off 2 each (descriptive lane order only). The primary is the fast lane alone. Which lane can show an effect at 30 per arm (MDE 0.74 SD), against the no-model oracle gain: slow (+1.1) no, it needs SD <= 1.5 and sits below the smallest effect of interest; medium (+2.8) only at SD <= 3.8, and arm on there would take the batch to about 10,900 calls; fast (+5.0) only if SD <= 6.8. About 5,710 planned call keys; the cap counts every paid invocation (retries included) and is set from the pilot\'s retry share (stopping rule). Pilot: fast off 3, on 3, oracle 1; slow and medium off 1 each (about 700). The briefed/foundation split of on minus off is read as where an effect comes from, never as its sign; a primary carried by the foundations with the briefed split <= 0 is read as "budget moved to concepts the memory rules do not penalize", not as "the readings help".',
    power: 'Minimum detectable effect (80% power, two-sided alpha 0.05, 30 per arm, t with 58 df) = 2.85 x SD x sqrt(2/30) = 0.74 SD of the per-learner whole-exam gain: 2.2 at SD 3, 3.7 at SD 5, 5.9 at SD 8 (the percentile bootstrap runs about 2% narrow at n = 30). The SD is unknown before the pilot; the no-model floor (perfect note taker, fast lane) is 2.9. +5.0 is the gain of a ceiling HEURISTIC, not of the shipped policy: at a true +2.5 the power is 49% at SD 5 and 29% at SD 6.8. The design is NOT powered for the smallest effect of interest (2) unless SD <= 2.8. The reading "no effect of 2 points or more" is practically unreachable: at a true 0 it is reached 80% of the time only at SD <= 2.65 (65% at 3, 23% at 4, 0% at 4.7), so a null result will read "inconclusive" and says only that the effect is not above the realized MDE. Powering 2 points needs 3.92 x SD^2 learners per arm (98 at SD 5): an operator decision, not taken here.',
    stopping: 'Fixed size, no interim look at the outcome: the outcome and claim 2 are computed only for a run with the main batch\'s 30 per arm; a smaller run (the pilot) reports mechanism, checks and gates only. If every pilot gate passes, the main batch runs as pre-registered; it is not abandoned after a look at the pilot. It runs once, to all 68 learners, with --max-calls = ceil(K x (1.05 + r)): K the main allocation\'s planned call keys from --dry-run, r the pilot\'s retry share (paid invocations per call key minus 1, in the report\'s cost section). If that exceeds 6,600, the main batch does not run as pre-registered and a smaller allocation is a new pre-registration (the pilot shows no outcome, so that choice is blind to it). It ends early only at the call cap (the rest are incomplete: complete-case, incompletion reported, the verdict withheld if unbalanced) or not at all when a pilot gate failed. The stall alarm is not a stop: the runner is restarted with the same run id. Noise gate, from the pilot only: if the pooled within-arm SD of the fast lane\'s whole-exam gain (on and off) exceeds 6.8, there is no main batch; a further batch is a new pre-registration. With 3 per arm (4 df) this gate is weak both ways: it lets a batch run 24% of the time at a true SD of 10 and stops one 42% of the time at a true SD of 6.9. No learner is added after any outcome is seen.',
    estimand: 'Whole-exam gain (the exam after the last session, all 13 concepts including each learner\'s held-out ones; the baseline is an empty notebook\'s 0), arm on minus arm off: the mean over the run\'s lanes of the per-lane difference of complete-case means. on minus off is the effect of the whole hook (its text, its guidance and its mastery readings together).',
    interval: '95% percentile bootstrap, each arm resampled within its lane (4,000 draws, fixed seed); the 90% interval of the same draws for the equivalence reading.',
    smallestEffectOfInterest: 2,
    verdict: 'supported: the 95% interval lies above 0. harm shown: it lies below 0. no effect of 2 points or more: the 90% interval lies within -2..+2 (two one-sided tests at 5%). Otherwise inconclusive. Never softened. Withheld when any pre-registered check fails or cannot be computed.',
    interim: 'No interim look: the outcome is computed once, after the last learner ends, and only for a run of the main batch\'s size. The pilot reports mechanism and checks only.',
    incomplete: 'Complete-case, stratified by lane. Incompletion is reported by arm and lane; the verdict is withheld if, within a primary lane, arms on and off differ by more than 1 in incomplete learners.',
    /** Learners per arm (on and off) in every primary lane for the outcome and claim 2 to be computed. */
    mainPerArm: 30,
    /** The pilot's noise gate: a pooled fast-lane SD above this puts the main batch's MDE (0.74 SD) above +5.0. */
    noiseGateSd: 6.8,
  },
  claim2: {
    probes: 'Grader level on blind probes (B6): accurate if MAE <= 20, MAE below a constant reading at the observed median truth (the constant with the least MAE), and the Spearman interval above 0; inaccurate if MAE >= 30, or n >= 40 and the interval covers 0; otherwise inconclusive.',
    /** The app\'s change reports (masteryChanges, prior-blind; gain notifications), arm on in the primary lane, against
     * the exam\'s change over the same sessions. Accurate: every criterion met at its minimum n; inaccurate: any one
     * failed; otherwise not computable. */
    changes: {
      signAgreement: { min: 0.75, minN: 20, why: 'Where the exam moved 25+ points (two facts) and the app reported a change, its sign agrees at least 3 times in 4. Chance is 1 in 2; at n = 20, 15/20 has a 95% Wilson lower bound above 0.5.' },
      intervalCoverage: { min: 0.85, minN: 20, why: 'The true change lies inside the app\'s 95% interval at least 85% of the time (nominal 95, minus 10). Exam and reading scales differ, so this tests whether the stated uncertainty is honest on the exam\'s scale.' },
      falseGains: { max: 0.2, minN: 10, why: 'At most 1 gain notification in 5 is false (the exam did not rise for that concept between the reading it beat and this one); undecidable ones are excluded.' },
    },
  },
  secondary: [
    'SENSITIVITY of the primary (no verdict): the same estimand with each exam scored on the facts the channel delivered within budget to that learner only (every other fact counts 0 at baseline and at the final exam), so knowledge that bypassed the channel cannot carry the difference.',
    'EXPLORATORY (no verdict, no multiplicity correction; read as hypotheses): oracle minus off; oracle minus on; on minus blind (the part due to the mastery readings); the within-learner contrast (non-held-out minus held-out concept gain); every contrast per lane.',
  ],
  checks: [
    'unbudgeted knowledge about 0 and balanced, on the primary cells only (arms on and off in the primary lanes): on the FINAL exam, facts scored 2 (not a declared guess) that the channel never delivered within budget in any session average at most 0.5 per learner in each of the two arms, and the two averages differ by at most 0.2 (about 0.2 exam points). Other arms and lanes are reported, never gated',
    'incompletion balanced: within each primary lane, incomplete learners in arms on and off differ by at most 1',
    'no injection ever targets a held-out concept',
    'frozen code and spec: no file under packages/ (the sim, the product code it runs: the hook policy, the assessment workflow and grader, and the mastery-change and notification code that computes claim 2 at analysis), the root package.json and bun.lock, nor this spec differs from the commit recorded at the run\'s start or is untracked; and every learner in the database matches config.json. A start, a resume and an analysis on any other tree are refused, so the run is made and analysed from a worktree pinned at that commit',
  ],
  mechanism: [
    'dose: facts the matcher found delivered per concept-session, on the concepts the injection targeted against the rest; arm off is read on the concept-sessions that arm on targeted for the learners with the same lane and task order',
    'waste: share of delivered facts already right (2 points) on the previous exam, by arm',
    'restatement: share of facts wrong (0 points) on the previous exam delivered in the next session (sessions 2 on), by arm',
    'channel: sentences redacted, unoffered and over-budget facts, and the agent\'s claimed ids against the matcher, by arm',
  ],
  changedFromDesign: 'The design note named the within-learner difference (non-held-out minus held-out gain) as primary. Under a fixed per-session teaching budget, injection that only MOVES teaching from held-out to other concepts raises that difference while total learning stays flat, so it favours the product; the whole-exam gain does not. The review of 5354994 added: no exam answer in any base prompt, the budget enforced at the channel, the memory rules, the equivalence reading, the lane-mean estimator, and the blind arm.',
} as const
type Integrity = { ok: boolean; detail: string }

const factConcept = (factId: string) => halyardId(factId.replace(/-f\d+$/, ''))
const delivered = (d: SimLearnerData, upTo: number) => new Set(d.agentTurns.filter((t) => t.session <= upTo).flatMap((t) => t.statedFactIds ?? []))
/** The concepts some task's brief names (9 of 13); the rest are foundations reached only as prerequisites. */
const FOUNDATIONS = HALYARD_CATALOG.concepts.map((c) => c.id).filter((id) => !BRIEFED.includes(id))
const scopeTotal = (e: ExamResult, ids: string[]) => mean(ids.map((id) => e.byConcept[id]!))
/** Whole-exam gain with the final exam scored on the facts the channel delivered to this learner only (the primary's
 * sensitivity series): a fact that reached the learner some other way counts 0. */
export const deliveredGain = (d: SimLearnerData) => {
  const keep = delivered(d, d.config.sessions), e = final(d)!
  return examResult(e.timepoint, Object.fromEntries(Object.entries(e.points).filter(([id]) => keep.has(id)))).total
}
/** Exam facts right (2 points) at exam `t` that the channel never delivered within budget in sessions 1..t. */
export const unbudgetedAt = (d: SimLearnerData, t: number) => {
  const e = d.exams.find((x) => x.timepoint === t)
  if (!e) return null
  const got = delivered(d, t)
  return HALYARD_FACT_EXAM.filter((q) => e.points[q.id] === 2 && !got.has(q.id)).map((q) => q.id)
}

/** `mainPerArm`: the arm size from which the outcome and claim 2 are computed (default: the pre-registered main batch's);
 * a smaller run is a pilot and reports mechanism, checks and gates only. */
export function analyzeSimRun(data: SimLearnerData[], opts: { integrity?: Integrity | null; mainPerArm?: number } = {}) {
  const isComplete = (d: SimLearnerData) => Boolean(final(d))
  const complete = data.filter(isComplete)
  const arms: string[] = [...new Set(data.map((d) => d.config.arm))].sort()
  const lanes = (['slow', 'medium', 'fast'] as const).filter((lane) => data.some((d) => d.config.lane === lane))
  const primaryLanes = lanes.filter((lane) => data.some((d) => d.config.lane === lane && d.config.arm === 'on'))
  // The primary cells: arms on and off in the lanes that have arm on. Only they gate the verdict.
  const primaryCells = data.filter((d) => primaryLanes.includes(d.config.lane) && (d.config.arm === 'on' || d.config.arm === 'off'))
  const mainSized = primaryLanes.length > 0 && primaryLanes.every((lane) => ['on', 'off'].every((arm) => data.filter((d) => d.config.arm === arm && d.config.lane === lane).length >= (opts.mainPerArm ?? SIM_PREREGISTRATION.primary.mainPerArm)))
  const gain = (d: SimLearnerData) => final(d)!.total
  const briefedGain = (d: SimLearnerData) => scopeTotal(final(d)!, BRIEFED)
  const foundationGain = (d: SimLearnerData) => scopeTotal(final(d)!, FOUNDATIONS)
  const did = (d: SimLearnerData) => groupGain(d, false)! - groupGain(d, true)!
  const by = (arm: string, lane?: string) => complete.filter((d) => d.config.arm === arm && (!lane || d.config.lane === lane))
  const row = (d: SimLearnerData) => `${d.config.lane}|${d.config.taskOrder.join('')}`
  const targetedBy = (d: SimLearnerData, s: number) => new Set(d.agentTurns.filter((t) => t.session === s && t.decision === 'influence').flatMap((t) => t.conceptIds))

  // Mechanism checks, per arm, from the channel's matcher and the previous exam.
  const mechanism = Object.fromEntries(arms.map((arm) => {
    let targetedDose = 0, targetedCells = 0, otherDose = 0, otherCells = 0, stated = 0, alreadyRight = 0, misses = 0, missesStated = 0, budget = 0, redacted = 0, unoffered = 0, overBudget = 0
    let claimed = 0, claimedFound = 0, invalid = 0, reviews = 0, influence = 0, turns = 0
    for (const d of data.filter((x) => x.config.arm === arm)) {
      const peers = data.filter((x) => x.config.arm === 'on' && row(x) === row(d))
      for (let s = 1; s <= d.config.sessions; s++) {
        const ts = d.agentTurns.filter((t) => t.session === s)
        if (!ts.length) continue
        const prev = d.exams.find((e) => e.timepoint === s - 1)
        const facts = ts.flatMap((t) => t.statedFactIds)
        // Arm off has no injection: it is read on the concepts arm on targeted for learners of the same design row.
        const targeted = arm === 'off' ? new Set(peers.flatMap((p) => [...targetedBy(p, s)])) : targetedBy(d, s)
        turns += ts.length
        influence += ts.filter((t) => t.decision === 'influence').length
        reviews += ts.filter((t) => t.review).length
        budget += d.config.factBudget
        redacted += ts.reduce((n, t) => n + t.redacted, 0)
        unoffered += ts.reduce((n, t) => n + t.unofferedFacts.length, 0)
        overBudget += ts.reduce((n, t) => n + t.overBudgetFacts.length, 0)
        invalid += ts.reduce((n, t) => n + t.invalidFacts, 0)
        for (const t of ts) { claimed += t.claimedFactIds.length; claimedFound += t.claimedFactIds.filter((id) => t.statedFactIds.includes(id)).length }
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
      stated, budget, budgetUsed: budget ? stated / budget : NaN, redacted, unoffered, overBudget, invalidFacts: invalid,
      validIdShare: claimed ? 1 - invalid / claimed : NaN, claimedConfirmed: claimed ? claimedFound / claimed : NaN,
      alreadyRight, missesStated, alreadyRightShare: stated ? alreadyRight / stated : NaN, restatement: misses ? missesStated / misses : NaN, misses,
      influenceTurns: influence, turns, reviewTurns: reviews }]
  }))
  // A pilot pools the two exam-derived columns over arms: by arm, with 3 learners each, they give each arm's interim
  // exam level (review 3, S1).
  if (!mainSized) {
    const ms = Object.values(mechanism), sum = (k: 'alreadyRight' | 'missesStated' | 'misses' | 'stated') => ms.reduce((n, m) => n + m[k], 0)
    const pooled = { alreadyRightShare: sum('stated') ? sum('alreadyRight') / sum('stated') : NaN, restatement: sum('misses') ? sum('missesStated') / sum('misses') : NaN, misses: sum('misses') }
    for (const m of ms) Object.assign(m, pooled, { alreadyRight: NaN, missesStated: NaN })
  }

  // Pre-registered checks: each is true, false, or null (could not be computed, which withholds the verdict too).
  // Unbudgeted knowledge: reported by arm over every lane; gated on the final exam of the primary cells only.
  const finalUnbudgeted = (ds: SimLearnerData[]) => ds.map((d) => unbudgetedAt(d, d.config.sessions)?.length).filter((n): n is number => n != null)
  const primaryUnbudgeted = (['on', 'off'] as const).map((arm) => finalUnbudgeted(primaryCells.filter((d) => d.config.arm === arm)))
  const unbudgeted = Object.fromEntries(arms.map((arm) => {
    const cells = data.filter((d) => d.config.arm === arm).flatMap((d) => Array.from({ length: d.config.sessions }, (_, i) => ({ session: i + 1, last: i + 1 === d.config.sessions, n: unbudgetedAt(d, i + 1)?.length })).filter((x) => x.n != null)) as Array<{ session: number; last: boolean; n: number }>
    const sessions = [...new Set(cells.map((c) => c.session))].sort((a, b) => a - b)
    const finals = cells.filter((c) => c.last)
    return [arm, { finalPerLearner: mean(finals.map((c) => c.n)), finals: finals.length, bySession: Object.fromEntries(sessions.map((s) => [s, mean(cells.filter((c) => c.session === s).map((c) => c.n))])) }]
  }))
  const [onUnbudgeted, offUnbudgeted] = primaryUnbudgeted.map(mean) as [number, number]
  const unbudgetedArmGap = Math.abs(onUnbudgeted - offUnbudgeted)
  const incompletion = Object.fromEntries(lanes.map((lane) => [lane, Object.fromEntries(arms.map((arm) => {
    const all = data.filter((d) => d.config.arm === arm && d.config.lane === lane)
    return [arm, { assigned: all.length, incomplete: all.filter((d) => !isComplete(d)).length }]
  }))]))
  // Arm off's final exam by lane: descriptive (arm on's would show the outcome in a pilot).
  const laneOrder = { off: lanes.map((lane) => ({ lane, finalExam: mean(by('off', lane).map((d) => final(d)!.total)), n: by('off', lane).length })) }
  const offDid = bootstrapMean(by('off').map(did))
  const unbudgetedOk = Number.isFinite(onUnbudgeted) && Number.isFinite(offUnbudgeted) ? onUnbudgeted <= 0.5 && offUnbudgeted <= 0.5 && unbudgetedArmGap <= 0.2 : null
  const incompletionOk = primaryLanes.length ? primaryLanes.every((lane) => Math.abs(incompletion[lane]!.on!.incomplete - (incompletion[lane]!.off?.incomplete ?? NaN)) <= 1) : null
  const heldOutTargeted = data.reduce((n, d) => n + d.agentTurns.flatMap((t) => (t.decision === 'influence' ? t.conceptIds : [])).filter((id) => heldOutOf(d.config).has(id)).length, 0)
  const checks = {
    unbudgeted, unbudgetedPrimary: { on: onUnbudgeted, off: offUnbudgeted }, unbudgetedArmGap, unbudgetedOk, incompletion, incompletionOk, heldOutTargeted, heldOutOk: heldOutTargeted === 0,
    laneOrder, integrity: opts.integrity ?? null, integrityOk: opts.integrity ? opts.integrity.ok : null,
    offWithinLearner: offDid, offWithinLearnerCoversZero: offDid.n > 1 ? offDid.lo <= 0 && offDid.hi >= 0 : null,
    holdoutCounts: Object.fromEntries(HALYARD_CATALOG.concepts.map((c) => [c.id, data.filter((d) => heldOutOf(d.config).has(c.id)).length])),
    incomplete: data.filter((d) => !isComplete(d)).map((d) => d.config.learnerId),
  }
  const failed = ([['unbudgeted knowledge about 0 and balanced', checks.unbudgetedOk], ['incompletion balanced', checks.incompletionOk], ['no held-out targeting', checks.heldOutOk],
    ['frozen code and spec', checks.integrityOk]] as Array<[string, boolean | null]>).filter(([, ok]) => ok !== true).map(([name, ok]) => `${name}: ${ok === null ? 'not computable' : 'failed'}`)

  const SESOI = SIM_PREREGISTRATION.primary.smallestEffectOfInterest
  const contrast = (a: string, b: string, f: (d: SimLearnerData) => number, lane?: string) => lane
    ? laneMeanDiff([by(a, lane).map(f)], [by(b, lane).map(f)])
    : laneMeanDiff(primaryLanes.map((l) => by(a, l).map(f)), primaryLanes.map((l) => by(b, l).map(f)))
  const [primary, briefed, foundations, sensitivityDelivered] = [gain, briefedGain, foundationGain, deliveredGain].map((f) => contrast('on', 'off', f)) as [LaneEstimate, LaneEstimate, LaneEstimate, LaneEstimate]
  const reading = !Number.isFinite(primary.lo) ? 'inconclusive (too few learners)'
    : primary.lo > 0 ? 'supported' : primary.hi < 0 ? 'harm shown' : primary.lo90 >= -SESOI && primary.hi90 <= SESOI ? `no effect of ${SESOI} points or more` : 'inconclusive'
  const verdict = failed.length ? `withheld (${failed.join('; ')})` : reading
  const pairs: Array<[string, string]> = [['on', 'off'], ['oracle', 'off'], ['oracle', 'on'], ['on', 'blind']]
  const present = pairs.filter(([a, b]) => arms.includes(a) && arms.includes(b))
  const outcome = !mainSized ? null : {
    primary, reading, verdict, failedChecks: failed, primaryLanes, briefed, foundations, sensitivityDelivered,
    contrasts: Object.fromEntries(present.map(([a, b]) => [`${a} - ${b}`, { examGain: contrast(a, b, gain), withinLearner: contrast(a, b, did),
      byLane: Object.fromEntries(lanes.map((lane) => [lane, { examGain: contrast(a, b, gain, lane), withinLearner: contrast(a, b, did, lane) }])) }])),
    byArm: Object.fromEntries(arms.map((arm) => [arm, { sdGainByLane: Object.fromEntries(lanes.map((lane) => [lane, sd(by(arm, lane).map(gain))])),
      byLane: Object.fromEntries(lanes.map((lane) => [lane, { examGain: bootstrapMean(by(arm, lane).map(gain)), withinLearner: bootstrapMean(by(arm, lane).map(did)), finalExam: mean(by(arm, lane).map((d) => final(d)!.total)) }])) }])),
  }
  // The pilot's gates (no outcome is read from the pilot). A null gate counts as a failure.
  const readingsBySession = Object.fromEntries(data.filter((d) => d.config.arm === 'on').map((d) => [d.config.learnerId,
    Array.from({ length: d.config.sessions - 1 }, (_, i) => d.readings.filter((r) => r.session === i + 1 && r.percent != null).map((r) => r.conceptId).sort())]))
  const onReadings = Object.values(readingsBySession)
  const echo = learnerEcho(data)
  // The pilot's unbudgeted gate counts facts (3 learners per arm make a mean gap meaningless): on the final exam of the
  // primary cells, each arm's total is at most floor(n / 2) (0.5 per learner) and the two totals differ by at most 1.
  const [onLeaks, offLeaks] = primaryUnbudgeted.map((xs) => ({ n: xs.length, total: xs.reduce((a, b) => a + b, 0) }))
  // Noise gate: the pooled within-arm SD of the fast lane's whole-exam gain, arms on and off (the main batch's MDE).
  const fast = (['on', 'off'] as const).map((arm) => by(arm, 'fast').map(gain))
  const pooledSd = Math.sqrt(fast.reduce((a, xs) => a + (xs.length - 1) * sd(xs) ** 2, 0) / (fast.reduce((a, xs) => a + xs.length, 0) - 2))
  const gates = {
    unbudgeted: onLeaks!.n && offLeaks!.n ? [onLeaks!, offLeaks!].every((x) => x.total <= Math.floor(x.n / 2)) && Math.abs(onLeaks!.total - offLeaks!.total) <= 1 : null,
    noise: { pooledSd, ok: Number.isFinite(pooledSd) ? pooledSd <= SIM_PREREGISTRATION.primary.noiseGateSd : null },
    validIds: arms.length && arms.every((arm) => Number.isFinite(mechanism[arm]!.validIdShare)) ? arms.every((arm) => mechanism[arm]!.validIdShare >= 0.95) : null,
    onReadings: onReadings.length ? onReadings.every((sessions) => sessions.length > 0 && sessions.every((ids) => ids.length > 0)) : null,
    learnerEcho: echo.ok,
  }
  const double = data.flatMap((d) => d.doubleScores)
  const items = double.flatMap((x) => Object.keys(x.first).map((id) => [x.first[id], x.second[id] ?? 0]))
  const scorer = { exams: double.length, items: items.length, itemAgreement: items.length ? items.filter(([a, b]) => a === b).length / items.length : NaN,
    totalDiff: mean(double.map((x) => Math.abs(examResult(0, x.first).total - examResult(0, x.second).total))) }
  const memory = Object.fromEntries(arms.map((arm) => { const ns = data.filter((d) => d.config.arm === arm).flatMap((d) => d.notebooks)
    return [arm, { forgotten: mean(ns.map((n) => n.forgotten)), strengthened: mean(ns.map((n) => n.strengthened)), unabsorbed: mean(ns.map((n) => n.unabsorbed)), overCapacity: mean(ns.map((n) => n.overCapacity)) }] }))

  // Claim 2 (main-sized runs only): Learner's own measurements against the exam, arm on in the primary lanes (the only
  // arm that grades), and the product's gain notifications: one is false when the exam did not rise for that concept
  // between the reading it beat and this one.
  const onPrimary = primaryCells.filter((d) => d.config.arm === 'on')
  const gainChecks = onPrimary.flatMap((d) => d.notifications.filter((n) => n.kind === 'gain').map((n) => {
    const r = d.readings.find((x) => x.assessmentRunId === n.runId)
    const before = r ? d.readings.filter((x) => x.conceptId === n.conceptId && x.session < r.session && x.percent !== null).at(-1) : undefined
    const examNow = r ? examAt(d, r.session, n.conceptId) : undefined
    const examBefore = r ? examAt(d, before?.session ?? 0, n.conceptId) : undefined
    return examNow !== undefined && examBefore !== undefined ? examNow - examBefore : null
  }))
  const graded = data.flatMap((d) => d.readings.filter((r) => r.assessmentRunId))
  const gainNotifications = { n: gainChecks.length, falseGains: gainChecks.filter((x) => x !== null && x <= 0).length, unknown: gainChecks.filter((x) => x === null).length }
  const priorBlind = measurementAccuracy(onPrimary)
  const claim2 = !mainSized ? null : {
    gradings: graded.length, withEstimate: graded.filter((r) => r.percent !== null).length,
    promptRevisions: graded.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.promptRevision ?? 'unknown']: (acc[r.promptRevision ?? 'unknown'] ?? 0) + 1 }), {}),
    gainNotifications, priorBlind, blindProbes: blindProbes(data),
    changeVerdict: changeReportVerdict({ sign: priorBlind.signAgreement, coverage: priorBlind.intervalCoverage, gains: { n: gainNotifications.n - gainNotifications.unknown, falseGains: gainNotifications.falseGains } }),
  }

  // Cost: calls per learner-session by role, tokens and wall time per call; `retried` counts calls paid more than once.
  const calls = data.flatMap((d) => d.calls)
  const sessions = data.reduce((n, d) => n + d.config.sessions, 0)
  const cost = {
    calls: calls.length, sessions,
    // Paid invocations per call key, minus 1: the pilot's retry share, which sizes the main batch's cap (stopping rule).
    retryShare: calls.length ? calls.reduce((n, c) => n + c.invocations, 0) / calls.length - 1 : NaN, modelSeconds: calls.reduce((n, c) => n + c.durationMs, 0) / 1000,
    byRole: Object.fromEntries([...new Set(calls.map((c) => c.role))].sort().map((role) => { const cs = calls.filter((c) => c.role === role)
      return [role, { calls: cs.length, perSession: cs.length / Math.max(1, sessions), meanSeconds: mean(cs.map((c) => c.durationMs / 1000)), inputTokens: cs.reduce((n, c) => n + (c.inputTokens ?? 0), 0), outputTokens: cs.reduce((n, c) => n + (c.outputTokens ?? 0), 0), retried: cs.filter((c) => c.attempts > 1).length, models: [...new Set(cs.map((c) => `${c.model}/${c.effort}`))] }] })),
  }
  return { preregistration: SIM_PREREGISTRATION, learners: data.length, complete: complete.length, mechanism, checks, outcome, gates, echo, readingsBySession, scorer, memory, claim2, cost }
}
type SimReport = ReturnType<typeof analyzeSimRun>

const f = (x: number, d = 1) => Number.isFinite(x) ? x.toFixed(d) : 'n/a'
const est = (e: Estimate) => `${f(e.mean)} [${f(e.lo)}, ${f(e.hi)}] (n=${e.n})`
/** The report: scope, pre-registration, mechanism checks, pre-registered checks, the outcome (in that order), then
 * claim 2 and the cost. */
export function renderSimReport(runId: string, b: SimReport): string {
  const pct = (x: number) => Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : 'n/a'
  const yes = (x: boolean | null) => x === null ? 'NOT COMPUTABLE (fails)' : x ? 'pass' : 'FAIL'
  const lest = (e: LaneEstimate) => `${f(e.mean)} [95%: ${f(e.lo)}, ${f(e.hi)}; 90%: ${f(e.lo90)}, ${f(e.hi90)}] (n=${e.n} vs ${e.nB}, ${e.lanes} lanes)`
  const any = (e: Estimate | LaneEstimate) => ('lo90' in e ? lest(e) : est(e))
  return [`# Simulated-learner run ${runId}`, '', `> ${b.preregistration.scope}`, '',
    'Exam scores are percent of points on the closed-book exam (8 single-fact questions per concept, 0-100). Intervals are percentile bootstrap over learners.', '',
    `Learners: ${b.learners} (${b.complete} complete). Pre-registered before the first call (config.json).`, '',
    `- Primary: ${b.preregistration.primary.estimand} ${b.preregistration.primary.interval} ${b.preregistration.primary.verdict}`,
    `- ${b.preregistration.primary.interim} ${b.preregistration.primary.incomplete}`,
    `- Scope: ${b.preregistration.primary.scope}`, `- Lanes: ${b.preregistration.primary.lanes}`,
    `- Power: ${b.preregistration.primary.power}`, `- Stopping: ${b.preregistration.primary.stopping}`,
    `- Secondary: ${b.preregistration.secondary.join(' ')}`,
    `- Changed from the design note: ${b.preregistration.changedFromDesign}`, '',
    '### 1. Mechanism checks (before the outcome; from the channel\'s matcher, not the agent\'s report)', '',
    '| arm | dose on targeted concepts | dose on the rest | facts delivered / budget | delivered already right | last-exam misses delivered | influence turns | review turns | redacted sentences | unoffered | over budget | valid claimed ids | claims the matcher confirms |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(b.mechanism).map(([arm, m]) => `| ${arm} | ${f(m.targetedDose, 2)} (${m.targetedCells}) | ${f(m.otherDose, 2)} (${m.otherCells}) | ${m.stated} / ${m.budget} (${pct(m.budgetUsed)}) | ${pct(m.alreadyRightShare)} | ${pct(m.restatement)} of ${m.misses} | ${m.influenceTurns}/${m.turns} | ${m.reviewTurns} | ${m.redacted} | ${m.unoffered} | ${m.overBudget} | ${pct(m.validIdShare)} | ${pct(m.claimedConfirmed)} |`), '',
    'Dose is delivered facts per concept-session. Arm off is read on the concept-sessions arm on targeted for learners with the same lane and task order.',
    ...(b.outcome ? [] : ['In a pilot, "delivered already right" and "last-exam misses delivered" are pooled over arms: by arm they would show each arm\'s interim exam level.']), '',
    '| arm | forgotten per session | strengthened (spacing) | not absorbed (prerequisite) | over capacity |', '|---|---|---|---|---|',
    ...Object.entries(b.memory).map(([arm, m]) => `| ${arm} | ${f(m.forgotten, 2)} | ${f(m.strengthened, 2)} | ${f(m.unabsorbed, 2)} | ${f(m.overCapacity, 2)} |`), '',
    '### 2. Pre-registered checks (any failure withholds the verdict)', '',
    `- Unbudgeted knowledge on the final exam, primary cells, per learner (≤ 0.5 in on and in off, within 0.2; on ${f(b.checks.unbudgetedPrimary.on, 2)}, off ${f(b.checks.unbudgetedPrimary.off, 2)}, gap ${f(b.checks.unbudgetedArmGap, 2)}): ${yes(b.checks.unbudgetedOk)}. Every arm and lane, descriptive: ${Object.entries(b.checks.unbudgeted).map(([arm, u]) => `${arm} ${f(u.finalPerLearner, 2)} (${u.finals} learners; every exam by session ${Object.entries(u.bySession).map(([s, x]) => `${s}: ${f(x, 2)}`).join(', ')})`).join('; ')}`,
    `- Incompletion balanced within each primary lane, on vs off (≤ 1 apart): ${yes(b.checks.incompletionOk)}; ${Object.entries(b.checks.incompletion).map(([lane, arms]) => `${lane}: ${Object.entries(arms).map(([arm, x]) => `${arm} ${x.incomplete}/${x.assigned}`).join(', ')}`).join('; ')}`,
    `- Held-out concepts targeted by an injection: ${b.checks.heldOutTargeted} (${yes(b.checks.heldOutOk)})`,
    `- Frozen code and spec: ${yes(b.checks.integrityOk)}${b.checks.integrity ? ` (${b.checks.integrity.detail})` : ''}`,
    `- Arm off by lane (descriptive): ${b.checks.laneOrder.off.map((l) => `${l.lane} ${f(l.finalExam)} (n=${l.n})`).join(', ')}; within learner ${est(b.checks.offWithinLearner)}; times each concept was held out: ${Object.values(b.checks.holdoutCounts).join(', ')}`,
    `- Exam scorer, double-scored exams: ${b.scorer.exams}, item agreement ${pct(b.scorer.itemAgreement)}, mean |total difference| ${f(b.scorer.totalDiff, 2)}`, '',
    '### Pilot gates (a null gate fails)', '',
    `- unbudgeted (primary cells, counts) ${yes(b.gates.unbudgeted)}; noise (pooled fast SD ${f(b.gates.noise.pooledSd, 2)} ≤ ${b.preregistration.primary.noiseGateSd}) ${yes(b.gates.noise.ok)}; valid ids ≥ 95% ${yes(b.gates.validIds)}; arm on readings non-null every graded session ${yes(b.gates.onReadings)}; learner echo of the agent (B5) ${yes(b.gates.learnerEcho)}`,
    `- Learner echo of the agent (B5; the owner's messages: 0.21): mean overlap ${f(b.echo.all.mean, 2)}, share ≥ 0.7 ${pct(b.echo.all.shareHigh)} (n=${b.echo.all.n}); length-matched ${f(b.echo.lengthMatched.mean, 2)}, ${pct(b.echo.lengthMatched.shareHigh)} (n=${b.echo.lengthMatched.n})`,
    ...Object.entries(b.readingsBySession).map(([id, sessions]) => `- ${id}: concepts with a reading per session: ${sessions.map((ids, i) => `s${i + 1} ${ids.length} (${ids.map((x) => x.split('--')[1]).join(', ')})`).join('; ')}`), '',
    ...(!b.outcome || !b.claim2 ? ['### 3. Outcome and claim 2: not computed', '', `A run smaller than the main batch (${b.preregistration.primary.mainPerArm} per arm in arms on and off) is a pilot: it reports mechanism, checks and gates only.`, ''] : [
      '### 3. Outcome', '',
      `**Primary (whole-exam gain, on minus off, mean of per-lane differences over ${b.outcome.primaryLanes.join(', ')}): ${lest(b.outcome.primary)}. Reading: ${b.outcome.reading}. Verdict: ${b.outcome.verdict}.**`, '',
      `Descriptive split (no verdict; where an effect comes from, never its sign): the same contrast on the ${BRIEFED.length} briefed concepts ${lest(b.outcome.briefed)}; on the ${HALYARD_CATALOG.concepts.length - BRIEFED.length} foundations ${lest(b.outcome.foundations)}.`, '',
      `Sensitivity (no verdict): the same contrast scored on delivered facts only: ${lest(b.outcome.sensitivityDelivered)}.`, '',
      'Secondary contrasts are exploratory.', '',
      '| contrast | whole-exam gain | within learner | per lane: whole-exam gain |', '|---|---|---|---|',
      ...Object.entries(b.outcome.contrasts).map(([k, x]) => `| ${k} | ${any(x.examGain)} | ${any(x.withinLearner)} | ${Object.entries(x.byLane).map(([lane, y]) => `${lane} ${est(y.examGain)}`).join('; ')} |`), '',
      '| arm | per lane: whole-exam gain (SD) | per lane: final exam |', '|---|---|---|',
      ...Object.entries(b.outcome.byArm).map(([arm, x]) => `| ${arm} | ${Object.entries(x.byLane).map(([lane, y]) => `${lane} ${est(y.examGain)} (${f(x.sdGainByLane[lane]!)})`).join('; ')} | ${Object.entries(x.byLane).map(([lane, y]) => `${lane} ${f(y.finalExam)}`).join(', ')} |`), '',
      '## Claim 2: Learner\'s own measurements against the exam', '',
      `Pre-registered, the app's change reports (arm on, primary lane): **${b.claim2.changeVerdict}**. Sign agreement where the exam moved 25+: ${b.claim2.priorBlind.signAgreement.agree}/${b.claim2.priorBlind.signAgreement.n} (≥ ${pct(b.preregistration.claim2.changes.signAgreement.min)}, n ≥ ${b.preregistration.claim2.changes.signAgreement.minN}); 95% interval coverage ${b.claim2.priorBlind.intervalCoverage.covered}/${b.claim2.priorBlind.intervalCoverage.n} (≥ ${pct(b.preregistration.claim2.changes.intervalCoverage.min)}, n ≥ ${b.preregistration.claim2.changes.intervalCoverage.minN}); false gain notifications ${b.claim2.gainNotifications.falseGains}/${b.claim2.gainNotifications.n - b.claim2.gainNotifications.unknown} (≤ ${pct(b.preregistration.claim2.changes.falseGains.max)}, n ≥ ${b.preregistration.claim2.changes.falseGains.minN}; ${b.claim2.gainNotifications.unknown} undecidable).`, '',
      `Pre-registered, grader level on blind probes: ${b.claim2.blindProbes.n} pairs from ${b.claim2.blindProbes.learners} learners: MAE ${f(b.claim2.blindProbes.mae)} [${f(b.claim2.blindProbes.maeLo)}, ${f(b.claim2.blindProbes.maeHi)}] (a constant reading: ${f(b.claim2.blindProbes.constantMae)}), bias ${f(b.claim2.blindProbes.bias)}, Spearman ${f(b.claim2.blindProbes.spearman, 2)} [${f(b.claim2.blindProbes.rhoLo, 2)}, ${f(b.claim2.blindProbes.rhoHi, 2)}]: **${b.claim2.blindProbes.verdict}**. Probes with no estimate, by arm: ${Object.entries(b.claim2.blindProbes.noEstimate).map(([arm, x]) => `${arm} ${x.none}/${x.probes}`).join(', ') || 'none'}.`, '',
      `EXPLORATORY: gradings ${b.claim2.gradings} (${b.claim2.withEstimate} with an estimate); prompt revisions ${Object.entries(b.claim2.promptRevisions).map(([k, n]) => `\`${k}\` ${n}`).join(', ') || 'none'}. Level: ${b.claim2.priorBlind.measurements} measurements, Pearson ${f(b.claim2.priorBlind.pearson, 2)}, bias ${f(b.claim2.priorBlind.meanBias)}, MAE ${f(b.claim2.priorBlind.meanAbsError)}. Change: ${b.claim2.priorBlind.changes} concept changes, r ${f(b.claim2.priorBlind.changeCorrelation, 2)}; verdicts beyond noise ${b.claim2.priorBlind.verdicts.beyondNoise}/${b.claim2.priorBlind.verdicts.n} (${b.claim2.priorBlind.verdicts.beyondNoiseExamMovedSameWay} with the exam moving the same way), quiet while the exam moved 25+ ${b.claim2.priorBlind.verdicts.quietExamMoved}; learner interval coverage ${b.claim2.priorBlind.aggregateCoverage.covered}/${b.claim2.priorBlind.aggregateCoverage.n}.`, '',
      '| reading bin (prior-blind) | n | mean reading | mean exam |', '|---|---|---|---|', ...b.claim2.priorBlind.calibration.map((x) => `| ${x.reading} | ${x.n} | ${f(x.meanReading)} | ${f(x.meanExam)} |`), '']),
    '## Cost', '', `${b.cost.calls} calls over ${b.cost.sessions} learner-sessions; ${f(b.cost.modelSeconds / 3600, 2)} model-hours; retry share r = ${f(b.cost.retryShare, 3)} (paid invocations per call key minus 1; the main batch's --max-calls is ceil(K × (1.05 + r))).`, '',
    '| role | calls | per session | mean s | input tokens | output tokens | paid more than once | model |', '|---|---|---|---|---|---|---|---|',
    ...Object.entries(b.cost.byRole).map(([role, x]) => `| ${role} | ${x.calls} | ${f(x.perSession)} | ${f(x.meanSeconds)} | ${x.inputTokens} | ${x.outputTokens} | ${x.retried} | ${x.models.join(', ')} |`), ''].join('\n')
}
