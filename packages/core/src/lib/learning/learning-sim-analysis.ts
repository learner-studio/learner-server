import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { masteryNotifications } from './mastery-notifications.js'
import { countedMeasurements, masteryChanges, type CountedMeasurements, type MasteryChanges } from './mastery-change.js'
import type { ConceptChange, CountedReading } from './mastery-change-statistics.js'
import { HALYARD_CATALOG, halyardId } from './learning-sim-halyard.js'
import { HALYARD_FACT_EXAM } from './learning-sim-facts.js'
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
  calls: Array<{ role: string; model: string; effort: string; inputTokens: number | null; outputTokens: number | null; durationMs: number; attempts: number }>
  /** What Learner itself reports (docs/specs/mastery-change-statistics.md), read as the product reads it: the counted
   * measurements (prior-blind and anchored, by evidence time) and masteryChanges (verdicts on prior-blind only). */
  measurements?: CountedMeasurements
  changes?: MasteryChanges
  /** First message time (ms) of each session, index = session - 1: maps an evidence time to the session it came from. */
  sessionStarts?: number[]
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
    const receipts = new Map((await q<{ run_id: string; percent: string | null; confidence: string | null; revision: string | null }>(
      `SELECT r.run_id,t.receipt#>>'{assessment,understandingPercent}' percent,t.receipt#>>'{assessment,confidence}' confidence,r.snapshot->>'promptRevision' revision
       FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.run_id = ANY($1::text[])`,
      [grades.map((g) => g.assessmentRunId).filter(Boolean)])).rows.map((r) => [r.run_id, r]))
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
      sessionStarts, doubleScores,
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
function bootstrapMean(xs: number[], seed = 1): Estimate {
  if (!xs.length) return { n: 0, mean: NaN, lo: NaN, hi: NaN }
  const r = rng(seed), means: number[] = []
  for (let b = 0; b < 4000; b++) { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]!; means.push(s / xs.length) }
  means.sort((a, b) => a - b)
  return { n: xs.length, mean: mean(xs), lo: xs.length > 1 ? means[100]! : NaN, hi: xs.length > 1 ? means[3899]! : NaN }
}
/** Difference of two independent group means, resampling each group. */
function bootstrapDiff(a: number[], b: number[], seed = 2): Estimate & { nB: number } {
  if (!a.length || !b.length) return { n: a.length, nB: b.length, mean: NaN, lo: NaN, hi: NaN }
  const r = rng(seed), diffs: number[] = []
  const draw = (xs: number[]) => { let s = 0; for (let i = 0; i < xs.length; i++) s += xs[Math.floor(r() * xs.length)]!; return s / xs.length }
  for (let i = 0; i < 4000; i++) diffs.push(draw(a) - draw(b))
  diffs.sort((x, y) => x - y)
  const ok = a.length > 1 && b.length > 1
  return { n: a.length, nB: b.length, mean: mean(a) - mean(b), lo: ok ? diffs[100]! : NaN, hi: ok ? diffs[3899]! : NaN }
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
  const draw = (g: number[]) => { let s = 0; for (let i = 0; i < g.length; i++) s += g[Math.floor(r() * g.length)]!; return s / g.length }
  for (let i = 0; i < 4000; i++) diffs.push(mean(a.map((g, l) => draw(g) - draw(b[l]!))))
  diffs.sort((x, y) => x - y)
  const ok = a.every((g) => g.length > 1) && b.every((g) => g.length > 1)
  return { n, nB, lanes, mean: mean(a.map((g, l) => mean(g) - mean(b[l]!))), lo: ok ? diffs[100]! : NaN, hi: ok ? diffs[3899]! : NaN, lo90: ok ? diffs[200]! : NaN, hi90: ok ? diffs[3799]! : NaN }
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
const baseline = (d: SimLearnerData) => d.exams.find((e) => e.timepoint === 0)
const groupGain = (d: SimLearnerData, held: boolean) => {
  const f = final(d), b = baseline(d)
  if (!f || !b) return null
  const heldOut = heldOutOf(d.config)
  const ids = HALYARD_CATALOG.concepts.map((c) => c.id).filter((id) => heldOut.has(id) === held)
  return mean(ids.map((id) => f.byConcept[id]! - b.byConcept[id]!))
}

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
function measurementAccuracy(data: SimLearnerData[], series: 'blind' | 'anchored') {
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
  const calibration = [0, 20, 40, 60, 80].map((lo) => { const inBin = level.filter((p) => p.reading >= lo && p.reading < (lo === 80 ? 101 : lo + 20))
    return { reading: `${lo}-${lo === 80 ? 100 : lo + 19}`, n: inBin.length, meanReading: mean(inBin.map((p) => p.reading)), meanExam: mean(inBin.map((p) => p.exam)) } })
  return {
    measurements: level.length, calibration,
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

/** The most calls a learner can make. `gradingReplicates` is the policy's k: arm on grades through the product workflow,
 * which grades each reading k times; a concept with no new evidence is not regraded, so grading is an upper bound. */
export function plannedCalls(c: SimLearnerConfig, gradingReplicates = 1) {
  const sessions = simPlan(c)
  const actions = sessions.flatMap((s) => s.actions.map((a) => a.action))
  const count = (k: string) => actions.filter((a) => a.kind === k).length
  return { learner: count('learner'), 'agent-reply': count('agent'), 'agent-match': c.arm === 'off' ? 0 : count('agent'), notebook: count('notebook'), 'exam-answer': count('exam-answer'),
    // One exam in ten is scored twice (a deterministic draw), so the count is exact.
    'exam-score': count('exam-score') + actions.filter((x) => x.kind === 'exam-score' && doubleScored(c, x.session)).length,
    grader: sessions.reduce((n, s) => n + s.grades.length, 0) * gradingReplicates }
}

// ---------------------------------------------------------------- the pre-registered analysis

/**
 * The pre-registration (docs/specs/simulated-learner-experiment.md). The runner writes it into the run's config.json
 * once, before the first model call, with the sha256 of this file; `analyzeSimRun` computes every estimand exactly as
 * written here, and the report quotes it.
 */
export const SIM_PREREGISTRATION = {
  scope: 'What this measures: an LLM learner with a capacity-limited notebook, under fixed memory rules (MEMORY_RULES: forgetting, spacing, prerequisite absorption), taught by an LLM agent through a budgeted fact channel, with Learner\'s live hook running the shipped policy plus spacedRepetition: true (NOT the product default, which is off). The result is conditional on those rules and says nothing about a real person\'s memory, nor about the product as shipped by default.',
  primary: {
    estimand: 'Whole-exam gain (the exam after the last session, all 13 concepts including each learner\'s held-out ones; the baseline is an empty notebook\'s 0), arm on minus arm off: the mean over the run\'s lanes of the per-lane difference of complete-case means. on minus off is the effect of the whole hook (its text, its guidance and its mastery readings together).',
    interval: '95% percentile bootstrap, each arm resampled within its lane (4,000 draws, fixed seed); the 90% interval of the same draws for the equivalence reading.',
    smallestEffectOfInterest: 2,
    verdict: 'supported: the 95% interval lies above 0. harm shown: it lies below 0. no effect of 2 points or more: the 90% interval lies within -2..+2 (two one-sided tests at 5%). Otherwise inconclusive. Never softened. Withheld when any pre-registered check fails or cannot be computed.',
    interim: 'No interim look: the outcome is computed once, after the last learner ends. The pilot reports mechanism and checks only.',
    incomplete: 'Complete-case, stratified by lane. Incompletion is reported by arm and lane; the verdict is withheld if, within a lane, the arms\' counts of incomplete learners differ by more than 1.',
  },
  secondary: [
    'EXPLORATORY (no verdict, no multiplicity correction; read as hypotheses): oracle minus off; oracle minus on; on minus blind (the part due to the mastery readings); the within-learner contrast (non-held-out minus held-out concept gain); every contrast per lane.',
  ],
  checks: [
    'unbudgeted knowledge about 0 in every arm: exam facts scored 2 (not a declared guess) that the channel never delivered within budget up to that exam, at most 0.5 per learner-exam on average, in every arm',
    'incompletion balanced: within each lane, incomplete learners per arm differ by at most 1',
    'no injection ever targets a held-out concept',
    'lane order: arm off\'s final exam rises with lane capacity',
    'config integrity: config.json and the sha256 of the analysis, design and prompt modules match what was pre-registered',
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
/** Exam facts right (2 points) at exam `t` that the channel never delivered within budget in sessions 1..t. */
export const unbudgetedAt = (d: SimLearnerData, t: number) => {
  const e = d.exams.find((x) => x.timepoint === t)
  if (!e) return null
  const got = delivered(d, t)
  return HALYARD_FACT_EXAM.filter((q) => e.points[q.id] === 2 && !got.has(q.id)).map((q) => q.id)
}

export function analyzeSimRun(data: SimLearnerData[], opts: { integrity?: Integrity | null } = {}) {
  const isComplete = (d: SimLearnerData) => Boolean(final(d) && baseline(d))
  const complete = data.filter(isComplete)
  const arms: string[] = [...new Set(data.map((d) => d.config.arm))].sort()
  const lanes = (['slow', 'medium', 'fast'] as const).filter((lane) => data.some((d) => d.config.lane === lane))
  const primaryLanes = lanes.filter((lane) => data.some((d) => d.config.lane === lane && d.config.arm === 'on'))
  const gain = (d: SimLearnerData) => final(d)!.total - baseline(d)!.total
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
      alreadyRightShare: stated ? alreadyRight / stated : NaN, restatement: misses ? missesStated / misses : NaN, misses,
      influenceTurns: influence, turns, reviewTurns: reviews }]
  }))

  // Pre-registered checks: each is true, false, or null (could not be computed, which withholds the verdict too).
  const unbudgeted = Object.fromEntries(arms.map((arm) => {
    const cells = data.filter((d) => d.config.arm === arm).flatMap((d) => Array.from({ length: d.config.sessions }, (_, i) => ({ session: i + 1, n: unbudgetedAt(d, i + 1)?.length })).filter((x) => x.n != null)) as Array<{ session: number; n: number }>
    const sessions = [...new Set(cells.map((c) => c.session))].sort((a, b) => a - b)
    return [arm, { perLearnerExam: mean(cells.map((c) => c.n)), exams: cells.length, bySession: Object.fromEntries(sessions.map((s) => [s, mean(cells.filter((c) => c.session === s).map((c) => c.n))])) }]
  }))
  const incompletion = Object.fromEntries(lanes.map((lane) => [lane, Object.fromEntries(arms.map((arm) => {
    const all = data.filter((d) => d.config.arm === arm && d.config.lane === lane)
    return [arm, { assigned: all.length, incomplete: all.filter((d) => !isComplete(d)).length }]
  }))]))
  const laneOrder = Object.fromEntries(arms.map((arm) => [arm, lanes.map((lane) => ({ lane, finalExam: mean(by(arm, lane).map((d) => final(d)!.total)), n: by(arm, lane).length }))]))
  const offLanes = laneOrder.off?.filter((l) => l.n > 0) ?? []
  const offDid = bootstrapMean(by('off').map(did))
  const unbudgetedOk = arms.length ? arms.every((arm) => Number.isFinite(unbudgeted[arm]!.perLearnerExam)) ? arms.every((arm) => unbudgeted[arm]!.perLearnerExam <= 0.5) : null : null
  const incompletionOk = lanes.every((lane) => { const xs = Object.values(incompletion[lane]!).filter((x) => x.assigned).map((x) => x.incomplete); return Math.max(...xs) - Math.min(...xs) <= 1 })
  const heldOutTargeted = data.reduce((n, d) => n + d.agentTurns.flatMap((t) => (t.decision === 'influence' ? t.conceptIds : [])).filter((id) => heldOutOf(d.config).has(id)).length, 0)
  const offLanesOrdered = offLanes.length > 1 ? offLanes.every((l, i) => i === 0 || l.finalExam > offLanes[i - 1]!.finalExam) : null
  const checks = {
    unbudgeted, unbudgetedOk, incompletion, incompletionOk, heldOutTargeted, heldOutOk: heldOutTargeted === 0,
    laneOrder, offLanesOrdered, integrity: opts.integrity ?? null, integrityOk: opts.integrity ? opts.integrity.ok : null,
    offWithinLearner: offDid, offWithinLearnerCoversZero: offDid.n > 1 ? offDid.lo <= 0 && offDid.hi >= 0 : null,
    holdoutCounts: Object.fromEntries(HALYARD_CATALOG.concepts.map((c) => [c.id, data.filter((d) => heldOutOf(d.config).has(c.id)).length])),
    incomplete: data.filter((d) => !isComplete(d)).map((d) => d.config.learnerId),
  }
  const failed = ([['unbudgeted knowledge about 0', checks.unbudgetedOk], ['incompletion balanced', checks.incompletionOk], ['no held-out targeting', checks.heldOutOk],
    ['arm off lane order', checks.offLanesOrdered], ['config integrity', checks.integrityOk]] as Array<[string, boolean | null]>).filter(([, ok]) => ok !== true).map(([name, ok]) => `${name}: ${ok === null ? 'not computable' : 'failed'}`)

  const SESOI = SIM_PREREGISTRATION.primary.smallestEffectOfInterest
  const contrast = (a: string, b: string, f: (d: SimLearnerData) => number, lane?: string) => lane
    ? bootstrapDiff(by(a, lane).map(f), by(b, lane).map(f))
    : laneMeanDiff(primaryLanes.map((l) => by(a, l).map(f)), primaryLanes.map((l) => by(b, l).map(f)))
  const primary = laneMeanDiff(primaryLanes.map((l) => by('on', l).map(gain)), primaryLanes.map((l) => by('off', l).map(gain)))
  const reading = !Number.isFinite(primary.lo) ? 'inconclusive (too few learners)'
    : primary.lo > 0 ? 'supported' : primary.hi < 0 ? 'harm shown' : primary.lo90 >= -SESOI && primary.hi90 <= SESOI ? `no effect of ${SESOI} points or more` : 'inconclusive'
  const verdict = failed.length ? `withheld (${failed.join('; ')})` : reading
  const pairs: Array<[string, string]> = [['on', 'off'], ['oracle', 'off'], ['oracle', 'on'], ['on', 'blind']]
  const present = pairs.filter(([a, b]) => arms.includes(a) && arms.includes(b))
  const outcome = {
    primary, reading, verdict, failedChecks: failed, primaryLanes,
    contrasts: Object.fromEntries(present.map(([a, b]) => [`${a} - ${b}`, { examGain: contrast(a, b, gain), withinLearner: contrast(a, b, did),
      byLane: Object.fromEntries(lanes.map((lane) => [lane, { examGain: contrast(a, b, gain, lane), withinLearner: contrast(a, b, did, lane) }])) }])),
    byArm: Object.fromEntries(arms.map((arm) => [arm, { sdGainByLane: Object.fromEntries(lanes.map((lane) => [lane, sd(by(arm, lane).map(gain))])),
      byLane: Object.fromEntries(lanes.map((lane) => [lane, { examGain: bootstrapMean(by(arm, lane).map(gain)), withinLearner: bootstrapMean(by(arm, lane).map(did)), finalExam: mean(by(arm, lane).map((d) => final(d)!.total)) }])) }])),
  }
  // The pilot's gates (no outcome is read from the pilot). A null gate counts as a failure.
  const readingsBySession = Object.fromEntries(data.filter((d) => d.config.arm === 'on').map((d) => [d.config.learnerId,
    Array.from({ length: d.config.sessions - 1 }, (_, i) => d.readings.filter((r) => r.session === i + 1 && r.percent != null).map((r) => r.conceptId).sort())]))
  const onReadings = Object.values(readingsBySession)
  const gates = {
    unbudgeted: checks.unbudgetedOk,
    validIds: arms.length && arms.every((arm) => Number.isFinite(mechanism[arm]!.validIdShare)) ? arms.every((arm) => mechanism[arm]!.validIdShare >= 0.95) : null,
    onReadings: onReadings.length ? onReadings.every((sessions) => sessions.length > 0 && sessions.every((ids) => ids.length > 0)) : null,
    offLanesOrdered,
  }
  const double = data.flatMap((d) => d.doubleScores)
  const items = double.flatMap((x) => Object.keys(x.first).map((id) => [x.first[id], x.second[id] ?? 0]))
  const scorer = { exams: double.length, items: items.length, itemAgreement: items.length ? items.filter(([a, b]) => a === b).length / items.length : NaN,
    totalDiff: mean(double.map((x) => Math.abs(examResult(0, x.first).total - examResult(0, x.second).total))) }
  const memory = Object.fromEntries(arms.map((arm) => { const ns = data.filter((d) => d.config.arm === arm).flatMap((d) => d.notebooks)
    return [arm, { forgotten: mean(ns.map((n) => n.forgotten)), strengthened: mean(ns.map((n) => n.strengthened)), unabsorbed: mean(ns.map((n) => n.unabsorbed)), overCapacity: mean(ns.map((n) => n.overCapacity)) }] }))

  // Claim 2: Learner's own measurements against the exam (only arm on grades), and the product's gain notifications:
  // one is false when the exam did not rise for that concept between the reading it beat and this one.
  const gainChecks = data.flatMap((d) => d.notifications.filter((n) => n.kind === 'gain').map((n) => {
    const r = d.readings.find((x) => x.assessmentRunId === n.runId)
    const before = r ? d.readings.filter((x) => x.conceptId === n.conceptId && x.session < r.session && x.percent !== null).at(-1) : undefined
    const examNow = r ? examAt(d, r.session, n.conceptId) : undefined
    const examBefore = r ? examAt(d, before?.session ?? 0, n.conceptId) : undefined
    return examNow !== undefined && examBefore !== undefined ? examNow - examBefore : null
  }))
  const graded = data.flatMap((d) => d.readings.filter((r) => r.assessmentRunId))
  const claim2 = {
    gradings: graded.length, withEstimate: graded.filter((r) => r.percent !== null).length,
    promptRevisions: graded.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.promptRevision ?? 'unknown']: (acc[r.promptRevision ?? 'unknown'] ?? 0) + 1 }), {}),
    gainNotifications: { n: gainChecks.length, falseGains: gainChecks.filter((x) => x !== null && x <= 0).length, unknown: gainChecks.filter((x) => x === null).length },
    priorBlind: measurementAccuracy(data, 'blind'), anchored: measurementAccuracy(data, 'anchored'),
  }

  // Cost: calls per learner-session by role, tokens and wall time per call; `retried` counts calls paid more than once.
  const calls = data.flatMap((d) => d.calls)
  const sessions = data.reduce((n, d) => n + d.config.sessions, 0)
  const cost = {
    calls: calls.length, sessions, modelSeconds: calls.reduce((n, c) => n + c.durationMs, 0) / 1000,
    byRole: Object.fromEntries([...new Set(calls.map((c) => c.role))].sort().map((role) => { const cs = calls.filter((c) => c.role === role)
      return [role, { calls: cs.length, perSession: cs.length / Math.max(1, sessions), meanSeconds: mean(cs.map((c) => c.durationMs / 1000)), inputTokens: cs.reduce((n, c) => n + (c.inputTokens ?? 0), 0), outputTokens: cs.reduce((n, c) => n + (c.outputTokens ?? 0), 0), retried: cs.filter((c) => c.attempts > 1).length, models: [...new Set(cs.map((c) => `${c.model}/${c.effort}`))] }] })),
  }
  return { preregistration: SIM_PREREGISTRATION, learners: data.length, complete: complete.length, mechanism, checks, outcome, gates, readingsBySession, scorer, memory, claim2, cost }
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
    `- Secondary: ${b.preregistration.secondary.join(' ')}`,
    `- Changed from the design note: ${b.preregistration.changedFromDesign}`, '',
    '### 1. Mechanism checks (before the outcome; from the channel\'s matcher, not the agent\'s report)', '',
    '| arm | dose on targeted concepts | dose on the rest | facts delivered / budget | delivered already right | last-exam misses delivered | influence turns | review turns | redacted sentences | unoffered | over budget | valid claimed ids | claims the matcher confirms |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(b.mechanism).map(([arm, m]) => `| ${arm} | ${f(m.targetedDose, 2)} (${m.targetedCells}) | ${f(m.otherDose, 2)} (${m.otherCells}) | ${m.stated} / ${m.budget} (${pct(m.budgetUsed)}) | ${pct(m.alreadyRightShare)} | ${pct(m.restatement)} of ${m.misses} | ${m.influenceTurns}/${m.turns} | ${m.reviewTurns} | ${m.redacted} | ${m.unoffered} | ${m.overBudget} | ${pct(m.validIdShare)} | ${pct(m.claimedConfirmed)} |`), '',
    'Dose is delivered facts per concept-session. Arm off is read on the concept-sessions arm on targeted for learners with the same lane and task order.', '',
    '| arm | forgotten per session | strengthened (spacing) | not absorbed (prerequisite) | over capacity |', '|---|---|---|---|---|',
    ...Object.entries(b.memory).map(([arm, m]) => `| ${arm} | ${f(m.forgotten, 2)} | ${f(m.strengthened, 2)} | ${f(m.unabsorbed, 2)} | ${f(m.overCapacity, 2)} |`), '',
    '### 2. Pre-registered checks (any failure withholds the verdict)', '',
    `- Unbudgeted knowledge, per learner-exam (≤ 0.5 in every arm): ${yes(b.checks.unbudgetedOk)}; ${Object.entries(b.checks.unbudgeted).map(([arm, u]) => `${arm} ${f(u.perLearnerExam, 2)} (${u.exams} exams; by session ${Object.entries(u.bySession).map(([s, x]) => `${s}: ${f(x, 2)}`).join(', ')})`).join('; ')}`,
    `- Incompletion balanced within lane (≤ 1 apart): ${yes(b.checks.incompletionOk)}; ${Object.entries(b.checks.incompletion).map(([lane, arms]) => `${lane}: ${Object.entries(arms).map(([arm, x]) => `${arm} ${x.incomplete}/${x.assigned}`).join(', ')}`).join('; ')}`,
    `- Held-out concepts targeted by an injection: ${b.checks.heldOutTargeted} (${yes(b.checks.heldOutOk)})`,
    `- Arm off lane order: ${yes(b.checks.offLanesOrdered)}; ${Object.entries(b.checks.laneOrder).map(([arm, ls]) => `${arm}: ${ls.map((l) => `${l.lane} ${f(l.finalExam)} (n=${l.n})`).join(', ')}`).join('; ')}`,
    `- Config integrity: ${yes(b.checks.integrityOk)}${b.checks.integrity ? ` (${b.checks.integrity.detail})` : ''}`,
    `- Arm off, within learner (descriptive): ${est(b.checks.offWithinLearner)}; times each concept was held out: ${Object.values(b.checks.holdoutCounts).join(', ')}`,
    `- Exam scorer, double-scored exams: ${b.scorer.exams}, item agreement ${pct(b.scorer.itemAgreement)}, mean |total difference| ${f(b.scorer.totalDiff, 2)}`, '',
    '### 3. Outcome', '',
    `**Primary (whole-exam gain, on minus off, mean of per-lane differences over ${b.outcome.primaryLanes.join(', ')}): ${lest(b.outcome.primary)}. Reading: ${b.outcome.reading}. Verdict: ${b.outcome.verdict}.**`, '',
    'Secondary contrasts are exploratory.', '',
    '| contrast | whole-exam gain | within learner | per lane: whole-exam gain |', '|---|---|---|---|',
    ...Object.entries(b.outcome.contrasts).map(([k, x]) => `| ${k} | ${any(x.examGain)} | ${any(x.withinLearner)} | ${Object.entries(x.byLane).map(([lane, y]) => `${lane} ${est(y.examGain)}`).join('; ')} |`), '',
    '| arm | per lane: whole-exam gain (SD) | per lane: final exam |', '|---|---|---|',
    ...Object.entries(b.outcome.byArm).map(([arm, x]) => `| ${arm} | ${Object.entries(x.byLane).map(([lane, y]) => `${lane} ${est(y.examGain)} (${f(x.sdGainByLane[lane]!)})`).join('; ')} | ${Object.entries(x.byLane).map(([lane, y]) => `${lane} ${f(y.finalExam)}`).join(', ')} |`), '',
    '### Pilot gates (a null gate fails)', '',
    `- unbudgeted ${yes(b.gates.unbudgeted)}; valid ids ≥ 95% ${yes(b.gates.validIds)}; arm on readings non-null every graded session ${yes(b.gates.onReadings)}; arm off lanes ordered ${yes(b.gates.offLanesOrdered)}`,
    ...Object.entries(b.readingsBySession).map(([id, sessions]) => `- ${id}: concepts with a reading per session: ${sessions.map((ids, i) => `s${i + 1} ${ids.length} (${ids.map((x) => x.split('--')[1]).join(', ')})`).join('; ')}`), '',
    '## Claim 2: Learner\'s own measurements against the exam', '',
    `Gradings: ${b.claim2.gradings} (${b.claim2.withEstimate} with an estimate); prompt revisions ${Object.entries(b.claim2.promptRevisions).map(([k, n]) => `\`${k}\` ${n}`).join(', ') || 'none'}. Gain notifications: ${b.claim2.gainNotifications.n}, false (the exam did not rise) ${b.claim2.gainNotifications.falseGains}, undecidable ${b.claim2.gainNotifications.unknown}.`, '',
    'Read as the product reads them (mastery-change statistics). Only the prior-blind series carries verdicts; the anchored series is the live score the learner sees, descriptive only. A measurement is dated by its evidence and compared with the exam after the session that evidence came from.', '',
    '| series | measurements | Pearson r | mean bias | mean abs error | concept changes | change r | sign agreement | interval coverage (95%) | verdicts beyond noise (exam moved the same way) | quiet while exam moved 25+ | learner interval coverage | lane rank (reported / exam) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...([['prior-blind', b.claim2.priorBlind], ['anchored (live)', b.claim2.anchored]] as const).map(([name, a]) => `| ${name} | ${a.measurements} | ${f(a.pearson, 2)} | ${f(a.meanBias)} | ${f(a.meanAbsError)} | ${a.changes} | ${f(a.changeCorrelation, 2)} | ${a.signAgreement.agree}/${a.signAgreement.n} | ${a.intervalCoverage.n ? `${a.intervalCoverage.covered}/${a.intervalCoverage.n}` : 'n/a'} | ${a.verdicts.n ? `${a.verdicts.beyondNoise}/${a.verdicts.n} (${a.verdicts.beyondNoiseExamMovedSameWay})` : 'n/a'} | ${a.verdicts.n ? a.verdicts.quietExamMoved : 'n/a'} | ${a.aggregateCoverage.n ? `${a.aggregateCoverage.covered}/${a.aggregateCoverage.n}` : 'n/a'} | ${a.laneRank.reported.join(' < ')} / ${a.laneRank.exam.join(' < ')} |`), '',
    '| reading bin (prior-blind) | n | mean reading | mean exam |', '|---|---|---|---|', ...b.claim2.priorBlind.calibration.map((x) => `| ${x.reading} | ${x.n} | ${f(x.meanReading)} | ${f(x.meanExam)} |`), '',
    '## Cost', '', `${b.cost.calls} calls over ${b.cost.sessions} learner-sessions; ${f(b.cost.modelSeconds / 3600, 2)} model-hours.`, '',
    '| role | calls | per session | mean s | input tokens | output tokens | paid more than once | model |', '|---|---|---|---|---|---|---|---|',
    ...Object.entries(b.cost.byRole).map(([role, x]) => `| ${role} | ${x.calls} | ${f(x.perSession)} | ${f(x.meanSeconds)} | ${x.inputTokens} | ${x.outputTokens} | ${x.retried} | ${x.models.join(', ')} |`), ''].join('\n')
}
