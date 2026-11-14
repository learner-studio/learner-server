import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { BLIND_COUNTED, masteryNotifications } from './mastery-notifications.js'
import { countedMeasurements, masteryChanges, type CountedMeasurements, type MasteryChanges } from './mastery-change.js'
import { graderNoise } from './grader-noise.js'
import type { ConceptChange, CountedReading } from './mastery-change-statistics.js'
import { BRIEFED, HALYARD_CATALOG, HALYARD_TASKS, halyardId } from './learning-sim-halyard.js'
import { HALYARD_FACT_EXAM } from './learning-sim-facts.js'
import { replayExams, seeded, type ExamResult } from './learning-sim-memory.js'
import { factsBySentence, type StatedFact } from './learning-sim-matcher.js'
import { pairedEstimate, sequentialLooks, type Look, type LookDecision, type PairedEstimate } from './learning-sim-sequential.js'
import { canon, heldOutOf, simExam, simPairKey, simPlan, simProbeUserId, type SimLearnerConfig } from './learning-sim-experiment.js'
import { judgeAnalysis, judgeSample } from './learning-sim-judge.js'

/**
 * Analysis of a simulated-learner run (docs/specs/simulated-learner-experiment.md, "Pre-registered analysis"): one
 * path, `analyzeSimRun`, computes every estimand of SIM_PREREGISTRATION, the claim-2 accuracy of Learner's own
 * measurements, and the cost.
 * `loadSimRun` only READS (receipts, readings, notifications): it never calls a model. `analyzeSimRun` is pure.
 */
export type SimLearnerData = {
  config: SimLearnerConfig
  userId: string
  /** exam per timepoint (0 = the empty notebook's 0), read from the notebooks (`simExam`); missing timepoints are absent */
  exams: ExamResult[]
  /** Learner's reading per concept after each session's grading (null: no reading yet or no estimate) */
  readings: Array<{ session: number; conceptId: string; percent: number | null; confidence: string | null; assessmentRunId: string | null; status: string; promptRevision?: string | null
    /** Revision 10 (D.9, verdict 2b's coverage): the grading gave a counted prior-blind reading (BLIND_COUNTED). */
    counted?: boolean }>
  /** Review 9 N4: each recorded grading replicate's status, by session (the gate's part (a) reads them too). */
  replicates?: Array<{ session: number; status: string }>
  notifications: Array<{ runId: string; conceptId: string; kind: 'first_clear' | 'gain'; percent: number; delta: number | null }>
  /** The agent's turns: the hook's decision and targets, and the fact channel (what the matcher found within budget,
   * what the agent claimed, what was redacted). */
  agentTurns: Array<{ session: number; turn: number; decision: string; conceptIds: string[]; statedFactIds: string[]; invalidFacts: number; review: string | null
    claimedFactIds: string[]; unofferedFacts: string[]; overBudgetFacts: string[]; redacted: number; attributedFacts?: string[]; withheldFacts?: string[]
    /** `statedFactIds` with each fact's channel path (revision 10, A3): the deliveries `replayExams` replays. */
    statedFacts?: StatedFact[]
    /** The text the learner read (after redaction); absent in fixtures that do not exercise the channel gate. */
    text?: string }>
  notebooks: Array<{ session: number; overCapacity: number; forgotten: number; strengthened: number; unabsorbed: number }>
  calls: Array<{ role: string; model: string; effort: string; inputTokens: number | null; outputTokens: number | null; durationMs: number; attempts: number; invocations: number
    /** Revision 8: 429s on this call (never paid, never an attempt), and whether it has no answer yet (pending). */
    rateLimited?: number; pending?: boolean }>
  /** What Learner itself reports (docs/specs/mastery-change-statistics.md), read as the product reads it: the counted
   * measurements (prior-blind and anchored, by evidence time) and masteryChanges (verdicts on prior-blind only). */
  measurements?: CountedMeasurements
  changes?: MasteryChanges
  /** First message time (ms) of each session, index = session - 1: maps an evidence time to the session it came from. */
  sessionStarts?: number[]
  /** B6: Learner's prior-blind reading of each blind probe answer (null: no estimate), by the session it opened (the end
   * probe: sessions + 1), with its assessment run and its evidence time (ms; revision 10, D.9). */
  probes: Array<{ session: number; conceptId: string; percent: number | null; assessmentRunId?: string | null; at?: number | null }>
  /** Revision 10 (D.9, verdict 2a): what the product reports on the learner's probe user (`simProbeUserId`):
   * masteryChanges, and its gain notifications. */
  probeChanges?: MasteryChanges
  probeNotifications?: Array<{ runId: string; conceptId: string; kind: 'first_clear' | 'gain' }>
  /** Each learner message after an agent reply in its session: the share of its content-word types found in the
   * previous 3 agent messages (`overlap`), and its type count (the B5 echo gate). */
  learnerOverlaps: Array<{ session: number; overlap: number; types: number; introduced?: number | null }>
}

const parse = (text: string) => JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim())

export async function loadSimRun(runId: string): Promise<SimLearnerData[]> {
  const learners = (await q<{ learner_id: string; user_id: string; config: SimLearnerConfig }>('SELECT learner_id,user_id,config FROM learning_sim_learners WHERE run_id=$1 ORDER BY learner_id', [runId])).rows
  const out: SimLearnerData[] = []
  // One read of the global grader-noise model (with its drift panel) for the run, shared by every masteryChanges call.
  const noise = await graderNoise(q)
  for (const l of learners) {
    const calls = (await q<{ call_key: string; role: string; model: string; effort: string; input_tokens: number | null; output_tokens: number | null; duration_ms: number; attempts: number; output: { text: string } }>(
      'SELECT call_key,role,model,effort,input_tokens,output_tokens,duration_ms,attempts,output FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2', [runId, l.learner_id])).rows
    const exams: ExamResult[] = []
    for (let t = 0; t <= l.config.sessions; t++) {
      const exam = await simExam({ ...l.config, learnerId: l.learner_id }, t)
      if (exam) exams.push(exam)
    }
    const sessionOf = (key: string) => Number(key.slice(1, key.indexOf(':')))
    // Review 9 S-A: a grading's reservation with no recorded grading is kept as a reading with status `reserved`: at
    // the end of a run it is a lost grading, and the gate's part (a) fails on it.
    const grades = calls.filter((c) => c.role === 'grader' && /^s\d+:grade:[^:]+$/.test(c.call_key)).map((c) => ({ session: sessionOf(c.call_key), conceptId: c.call_key.split(':grade:')[1]!,
      ...(c.output.text === undefined ? { assessmentRunId: null, status: 'reserved' } : parse(c.output.text) as { assessmentRunId: string | null; status: string }) }))
    const replicates = calls.filter((c) => c.role === 'grader' && c.output.text !== undefined && /^s\d+:grade:[^:]+:r\d+$/.test(c.call_key))
      .map((c) => ({ session: sessionOf(c.call_key), status: (parse(c.output.text) as { status: string }).status }))
    const probeGrades = calls.filter((c) => c.role === 'grader' && c.output.text !== undefined && /^p\d+:grade:[^:]+$/.test(c.call_key)).map((c) => ({ session: Number(c.call_key.slice(1, c.call_key.indexOf(':'))), conceptId: c.call_key.split(':grade:')[1]!, ...(parse(c.output.text) as { assessmentRunId: string | null }) }))
    // `evidence_at`: the latest learner message the grading read (a probe's answer: its one message), the clock the
    // product's measurements are dated by; `counted`: the product's own counting rule on the run's reading.
    const receipts = new Map((await q<{ run_id: string; percent: string | null; confidence: string | null; revision: string | null; evidence_at: Date | null; counted: boolean }>(
      `SELECT r.run_id,t.receipt#>>'{assessment,understandingPercent}' percent,t.receipt#>>'{assessment,confidence}' confidence,r.snapshot->>'promptRevision' revision,
         (SELECT max((e->>'occurredAt')::timestamptz) FROM jsonb_array_elements(r.snapshot->'evidence') e WHERE e->>'role'='user') evidence_at,
         EXISTS (SELECT 1 FROM learning_mastery_readings m WHERE m.run_id=r.run_id AND ${BLIND_COUNTED('m')}) counted
       FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.run_id = ANY($1::text[])`,
      [[...grades, ...probeGrades].map((g) => g.assessmentRunId).filter(Boolean)])).rows.map((r) => [r.run_id, r]))
    const readings = grades.map((g) => { const r = g.assessmentRunId ? receipts.get(g.assessmentRunId) : undefined; return { session: g.session, conceptId: g.conceptId, percent: r?.percent == null ? null : Number(r.percent), confidence: r?.confidence ?? null, assessmentRunId: g.assessmentRunId, status: g.status, promptRevision: r?.revision ?? null, counted: r?.counted ?? false } })
    const probeUser = simProbeUserId({ runId, learnerId: l.learner_id })
    const messages = (await q<{ session: number; seq: number; role: string; text: string; meta: Record<string, unknown> | null; created_at: Date }>('SELECT session,seq,role,text,meta,created_at FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 ORDER BY session,seq,role', [runId, l.learner_id])).rows
    const sessionStarts = Array.from({ length: l.config.sessions }, (_, i) => Math.min(...messages.filter((m) => m.session === i + 1 && m.role !== 'notebook').map((m) => m.created_at.getTime())))
    const notes = (await masteryNotifications(q, l.user_id, { since: null, limit: 1000 })).map((n) => ({ runId: n.runId, conceptId: n.conceptId, kind: n.kind, percent: n.percent, delta: n.delta }))
    out.push({
      config: l.config, userId: l.user_id, exams, readings, replicates, notifications: notes,
      agentTurns: messages.filter((m) => m.role === 'agent').map((m) => { const x = (m.meta ?? {}) as Record<string, unknown>; const ids = (k: string) => (x[k] as string[] | undefined) ?? []
        return { session: m.session, turn: m.seq, decision: String(x.decision ?? 'none'), conceptIds: ids('conceptIds'), statedFactIds: ids('statedFactIds'), invalidFacts: Number(x.invalidFacts ?? 0), review: (x.review as string | null) ?? null,
          claimedFactIds: ids('claimedFactIds'), unofferedFacts: ids('unofferedFacts'), overBudgetFacts: ids('overBudgetFacts'), redacted: Number(x.redacted ?? 0), attributedFacts: ids('attributedFacts'), withheldFacts: ids('withheldFacts'), statedFacts: x.statedFacts as StatedFact[] | undefined, text: m.text } }),
      notebooks: messages.filter((m) => m.role === 'notebook').map((m) => ({ session: m.session, overCapacity: Number(m.meta?.overCapacity ?? 0), forgotten: Number(m.meta?.forgotten ?? 0),
        strengthened: Number(m.meta?.strengthened ?? 0), unabsorbed: Number(m.meta?.unabsorbed ?? 0) })),
      sessionStarts, learnerOverlaps: learnerOverlaps(messages, (s) => HALYARD_TASKS[l.config.taskOrder[s - 1]!]?.brief ?? ''),
      probes: probeGrades.map((g) => { const r = g.assessmentRunId ? receipts.get(g.assessmentRunId) : undefined; return { session: g.session, conceptId: g.conceptId, percent: r?.percent == null ? null : Number(r.percent),
        assessmentRunId: g.assessmentRunId, at: r?.evidence_at?.getTime() ?? null } }),
      probeChanges: await masteryChanges(q, probeUser, { sinceDays: null }, new Date(), noise),
      probeNotifications: (await masteryNotifications(q, probeUser, { since: null, limit: 1000 })).map((n) => ({ runId: n.runId, conceptId: n.conceptId, kind: n.kind })),
      measurements: await countedMeasurements(q, l.user_id),
      changes: await masteryChanges(q, l.user_id, { sinceDays: null }, new Date(), noise),
      // Review 9 S-C: a grading's reservation is not a call: it counts toward the cap (simCallsUsed), never toward the
      // retry share r, the health call counts or the cost models.
      calls: calls.filter((c) => !(c.model === 'reserved' && c.output.text === undefined)).map((c) => ({ role: c.role, model: c.model, effort: c.effort, inputTokens: c.input_tokens, outputTokens: c.output_tokens, durationMs: c.duration_ms, attempts: c.attempts, invocations: Math.max((c.output as { invocations?: number } | null)?.invocations ?? c.attempts, 1),
        rateLimited: Number((c.output as { rateLimited?: number } | null)?.rateLimited ?? 0), pending: c.output.text === undefined })),
    })
  }
  return out
}

/** Each session's deliveries in turn order, as `replayExams` reads them (design D.6). Review rev10-p2 R1: a turn that
 * delivered facts but stored no paths (written before revision 10) cannot be replayed, so it is refused, not read as
 * delivering nothing. */
export function sessionDeliveries(d: Pick<SimLearnerData, 'config' | 'agentTurns'>) {
  return Array.from({ length: d.config.sessions }, (_, i) => d.agentTurns.filter((t) => t.session === i + 1).sort((a, b) => a.turn - b.turn).flatMap((t) => {
    if (!t.statedFacts && t.statedFactIds.length) throw new Error(`session ${t.session} turn ${t.turn} stored statedFactIds without statedFacts (a run before revision 10): it cannot be replayed`)
    return t.statedFacts ?? []
  }))
}

// ---------------------------------------------------------------- learner echo (B5)

/** The grader-validity report's measure (scratchpad grader-validity/textfeat.ts), so the gate compares with the owner's
 * 0.21: content-word types of 3+ letters, minus a stop list. Not the matcher's tokenizer, on purpose (R1): that one
 * stems and keeps short numeric tokens to find facts; sharing either way would move a pinned measure. */
const STOP = new Set('the and for that this with you are was but not can its have has had from they them then than there their what when where which who will would should could just also into onto out our your yours about over under more most some such only very each other any all both how why yes too were been being does did doing done get got make made use used using let lets like want need needs think thanks thank okay sure right well here now one two three way thing things still even much many same so if or of to in on at by be is as an a we i me my it do no up down off again further once because while during before after above below between through those these am may might must shall ok yeah go going see say said know mean ill im ive dont doesnt didnt isnt wont cant thats whats theres'.split(' '))
const contentTypes = (text: string) => new Set((text.toLowerCase().replace(/[’']/g, '').match(/[a-z0-9_]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t)))
/** `introduced`: of the types Sam brings in with this message (not in the session's brief, not in Sam's own earlier
 * messages this session), the share found in the previous 3 agent messages; null when Sam brings in none. Revision 7:
 * the plain overlap has a floor from the brief's words, which the agent reuses (a message written before any agent text
 * overlapped the next 2 replies at 0.47 in pilot 0946448d), so the gate's mean reads `introduced`. */
export function learnerOverlaps(rows: Array<{ session: number; seq: number; role: string; text: string }>, briefOf: (session: number) => string = () => '') {
  // Conversation order: within a seq, Sam's message comes before the agent's reply to it.
  const rank = (role: string) => role === 'learner' ? 0 : role === 'agent' ? 1 : 2
  const messages = [...rows].sort((a, b) => a.session - b.session || a.seq - b.seq || rank(a.role) - rank(b.role))
  return messages.flatMap((m, i) => {
    if (m.role !== 'learner') return []
    const before = messages.slice(0, i).filter((x) => x.session === m.session && x.role === 'agent').slice(-3)
    const types = contentTypes(m.text)
    if (!before.length || !types.size) return []
    const source = contentTypes(before.map((x) => x.text).join('\n'))
    const known = contentTypes([briefOf(m.session), ...messages.slice(0, i).filter((x) => x.session === m.session && x.role === 'learner').map((x) => x.text)].join('\n'))
    const introduced = [...types].filter((t) => !known.has(t))
    return [{ session: m.session, overlap: [...types].filter((t) => source.has(t)).length / types.size, types: types.size,
      introduced: introduced.length ? introduced.filter((t) => source.has(t)).length / introduced.length : null }]
  })
}
/** Pre-registered B5 gate (revision 7): the mean of `introduced` ≤ 0.35 and the share of messages with a plain overlap
 * ≥ 0.7 ≤ 5%, on all messages and on 25-50 content types. The plain mean (`overlapMean`) is reported, not gated. */
export function learnerEcho(data: SimLearnerData[]) {
  const summary = (xs: SimLearnerData['learnerOverlaps']) => ({ n: xs.length, mean: mean(xs.flatMap((x) => x.introduced ?? [])), overlapMean: mean(xs.map((x) => x.overlap)),
    shareHigh: xs.length ? xs.filter((x) => x.overlap >= 0.7).length / xs.length : NaN })
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

export const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN
const sd = (xs: number[]) => { if (xs.length < 2) return NaN; const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)) }
/** The simulator's PRNG with a numbered bootstrap seed, so a report is reproducible from its rows. */
const rng = (seed: number) => seeded(`bootstrap:${seed}`)
/** One bootstrap resample (with replacement) of `xs`: the only resampling every interval of the report uses. */
export const resample = <T>(xs: readonly T[], r: () => number) => Array.from({ length: xs.length }, () => xs[Math.floor(r() * xs.length)]!)
const resampleMean = (xs: number[], r: () => number) => mean(resample(xs, r))
/** The one percentile interval of every bootstrap here: [lo, hi] at `level` (NaN when there are no draws). */
export const ci = (draws: number[], level = 0.95) => {
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

export const final = (d: SimLearnerData) => d.exams.find((e) => e.timepoint === d.config.sessions)
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
    ...changeAgreement(change),
    verdicts: { n: verdicts.length, beyondNoise: verdicts.filter((c) => c.beyondNoise).length, beyondNoiseExamMovedSameWay: verdicts.filter((c) => c.beyondNoise && Math.sign(c.truth) === Math.sign(c.reported) && c.truth !== 0).length,
      quietExamMoved: verdicts.filter((c) => !c.beyondNoise && Math.abs(c.truth) >= 25).length },
    aggregateCoverage: { n: aggregate.length, covered: aggregate.filter((a) => a.truth >= a.lo && a.truth <= a.hi).length },
  }
}
/** Revision 9's two change criteria (pre-registered): sign agreement where the exam moved 25+ points and the app reported a
 * change, and interval coverage (the true change inside delta ± 1.96·se). */
const changeAgreement = (change: Array<{ reported: number; se: number | null; truth: number }>) => {
  const clear = change.filter((c) => Math.abs(c.truth) >= 25 && c.reported !== 0)
  const covered = change.filter((c) => c.se !== null && c.se > 0)
  return { signAgreement: { n: clear.length, agree: clear.filter((c) => Math.sign(c.reported) === Math.sign(c.truth)).length },
    intervalCoverage: { n: covered.length, covered: covered.filter((c) => Math.abs(c.truth - c.reported) <= 1.96 * c.se!).length } }
}
/** Pre-registered claim-2 verdict on the app's change reports: each criterion is a share with a minimum n; any failure
 * reads "inaccurate", every one met reads "accurate", otherwise (too few) "not computable". Revision 9's conjunction;
 * `spearman` (revision 10, D.9) is verdict 2a's fourth criterion: the 95% learner-bootstrap lower bound above 0. */
export function changeReportVerdict(x: { sign: { n: number; agree: number }; coverage: { n: number; covered: number }; gains: { n: number; falseGains: number }; spearman?: { n: number; lo: number } }) {
  const t = SIM_PREREGISTRATION.claim2.changes
  const criteria = [[x.sign.n, x.sign.agree / x.sign.n >= t.signAgreement.min, t.signAgreement.minN], [x.coverage.n, x.coverage.covered / x.coverage.n >= t.intervalCoverage.min, t.intervalCoverage.minN],
    [x.gains.n, x.gains.falseGains / x.gains.n <= t.falseGains.max, t.falseGains.minN],
    // C8: a lower bound that is not finite (one learner, or every change tied) counts as too few, never as failed.
    ...(x.spearman ? [[Number.isFinite(x.spearman.lo) ? x.spearman.n : 0, x.spearman.lo > t.spearman.minLo, t.spearman.minN]] : [])] as Array<[number, boolean, number]>
  const computable = criteria.filter(([n, , minN]) => n >= minN)
  return computable.some(([, ok]) => !ok) ? 'inaccurate' : computable.length === criteria.length ? 'accurate' : 'not computable'
}

/**
 * Verdict 2a, "grader change-tracking on scheduled probes" (revision 10, D.9): the product's own masteryChanges on each
 * learner's probe user (all arms), each concept's first-to-last change against the exact held-share change between the
 * same two probe times (a probe before session s answers from the notebook the exam after session s - 1 reads). A
 * change end that matches no probe of its concept by evidence time is not paired (`unmatched`). False gains: a gain
 * notification on the probe user whose exam did not rise since the probe it beat. Spearman of reported against true
 * change, its 95% interval resampling learners. The verdict is `changeReportVerdict` with all four criteria.
 */
export function probeChangeTracking(data: SimLearnerData[]) {
  let unmatched = 0
  const learners = data.map((d) => (d.probeChanges?.concepts ?? []).flatMap((c: Pick<ConceptChange, 'conceptId' | 'fromAt' | 'toAt' | 'delta' | 'deltaSe'>) => {
    const at = (t: number) => d.probes.find((p) => p.conceptId === c.conceptId && p.at === t)?.session
    const s0 = at(c.fromAt), s1 = at(c.toAt)
    const e0 = s0 && examAt(d, s0 - 1, c.conceptId), e1 = s1 && examAt(d, s1 - 1, c.conceptId)
    if (typeof e0 !== 'number' || typeof e1 !== 'number') { unmatched++; return [] }
    return [{ reported: c.delta, se: c.deltaSe, truth: e1 - e0 }]
  })).filter((x) => x.length)
  const change = learners.flat()
  const gainChecks = data.flatMap((d) => (d.probeNotifications ?? []).filter((n) => n.kind === 'gain').map((n) => {
    const p = d.probes.find((x) => x.assessmentRunId === n.runId)
    const before = p ? d.probes.filter((x) => x.conceptId === n.conceptId && x.session < p.session && x.percent !== null).at(-1) : undefined
    const now = p ? examAt(d, p.session - 1, n.conceptId) : undefined, then = p ? examAt(d, (before?.session ?? 1) - 1, n.conceptId) : undefined
    return now !== undefined && then !== undefined ? now - then : null
  }))
  const gains = { n: gainChecks.length, falseGains: gainChecks.filter((x) => x !== null && x <= 0).length, unknown: gainChecks.filter((x) => x === null).length }
  const rho = (xs: typeof change) => pearson(ranks(xs.map((c) => c.reported)), ranks(xs.map((c) => c.truth)))
  const r = rng(7), draws: number[] = []
  for (let b = 0; b < 4000 && learners.length > 1; b++) { const x = rho(resample(learners, r).flat()); if (Number.isFinite(x)) draws.push(x) }
  const [lo, hi] = ci(draws)
  const spearman = { n: change.length, rho: rho(change), lo, hi }
  const agreement = changeAgreement(change)
  return { changes: change.length, unmatched, learners: learners.length, truths: change.map((c) => c.truth), sign: agreement.signAgreement, coverage: agreement.intervalCoverage, gains, spearman,
    verdict: changeReportVerdict({ sign: agreement.signAgreement, coverage: agreement.intervalCoverage, gains: { n: gains.n - gains.unknown, falseGains: gains.falseGains }, spearman }) }
}

/** Verdict 2b's coverage (revision 10, D.9): of the concept-sessions arm on's plan grades, the share with a counted
 * prior-blind reading, and the counted series (concepts with two or more counted readings: masteryChanges' concepts). */
function liveCoverage(data: SimLearnerData[]) {
  const conceptSessions = data.reduce((n, d) => n + simPlan(d.config).reduce((m, s) => m + s.grades.length, 0), 0)
  const counted = data.reduce((n, d) => n + d.readings.filter((r) => r.counted).length, 0)
  return { conceptSessions, counted, share: conceptSessions ? counted / conceptSessions : NaN, series: data.reduce((n, d) => n + (d.changes?.concepts.length ?? 0), 0) }
}

/** The most calls a learner can make. `gradingReplicates` is the policy's k: arm on grades through the product workflow,
 * which grades each reading k times; a concept with no new evidence is not regraded, so grading is an upper bound. */
export function plannedCalls(c: SimLearnerConfig, gradingReplicates = 1) {
  const sessions = simPlan(c)
  const actions = sessions.flatMap((s) => s.actions.map((a) => a.action))
  const count = (k: string) => actions.filter((a) => a.kind === k).length
  // A blind probe (B6) is one learner call and one grading; a session with nothing delivered before it asks none, so
  // these are upper bounds.
  return { learner: count('learner') + count('probe'), 'agent-reply': count('agent'), 'agent-match': c.arm === 'on' ? count('agent') : 0,
    grader: (sessions.reduce((n, s) => n + s.grades.length, 0) + count('probe')) * gradingReplicates }
}

// ---------------------------------------------------------------- the pre-registered analysis

/**
 * The pre-registration (docs/specs/simulated-learner-experiment.md, revision 10; design rev10 C-E v3). It is pinned by
 * the commit in the run record (on every learner's config in the database, before the first model call);
 * `analyzeSimRun` computes every estimand exactly as written here, and the report quotes it.
 */
export const SIM_PREREGISTRATION = {
  revision: 10,
  /** P4 (lead's decision): an open wording contradiction in the shipped default, kept as shipped and reported. */
  labelContradiction: 'Open wording contradiction (P4, kept as shipped): when the teaching context shows NO_READING_LINE (learning-teaching-default.ts: no current reading of this learner), the context can still carry the experiment label PREREQUISITE_EXPERIMENT_LABEL (learning-prerequisite-selection.ts: "weakest lesson prerequisite in prompt"), although with no reading no prerequisite is weakest by evidence. The label is part of the shipped default that arm on tests; changing shipped guidance is out of scope for this freeze, so it is not changed. A result is a result about the default as shipped, contradiction included.',
  scope: 'What this measures (revision 10): an LLM agent teaching through a budgeted fact channel, priced by a fixed memory model on verified delivered fact ids ("A-full": MEMORY_RULES uptake, forgetting, spacing and prerequisite absorption, keyed by pair and fact id; the exam is computed from the held facts), with Learner\'s live hook running the shipped default policy (LearningPolicySettings defaults: prerequisiteCount 2, prerequisiteDepth 2, spacedRepetition false, blindProbes false, progressionLinearity 60; foundationFirst false) plus the honest no-reading fallback. Arms: off (no hook), on (the shipped default), anchor (a true-state fact list, Learner off; no verdict). The result is about this testbed and this agent, not about real people.',
  givenUp: 'What A-full gives up (design A1): the LLM learner\'s choice of what to note under capacity; any learning from task content; paraphrase and partial understanding; and probe answers that are more than a copy of a canonical notebook. Revision 10 measures whether the hook changes what an LLM agent teaches, priced by a fixed memory model.',
  foundationFirst: '`foundationFirst` does not affect target selection in the live-turn path (foundations are always ordered first). In this simulator it appears only as a flag in the guidance JSON shown to the agent.',
  decisions: {
    note: 'Made by the lead on 2026-11-14, after the lead and the designer had seen revision 9\'s data.',
    items: [
      'B1. The 6,600 hard cap and the planned-keys rule stay. The main batch is re-sized to what fits. plannedCalls\' grading bound is not edited.',
      'B2. Revision 10\'s main batch is the last confirmatory test of this configuration in this testbed, whatever the in-batch check says. There are 2 pilot iterations in total, whatever the gate. Later confirmatory batches print every earlier verdict, split alpha, and build the iteration log by query.',
      'B3. Gatekeeping: AUC item-mean is primary. "Supported" also needs the final-exam item-mean paired estimate >= 0, with its 95% lower bound > -2.',
      'B4. The three sensitivity versions and the withhold rule replace the ±2 tolerance. The arm-blind judge is included (it fits the cap).',
      'B5. Revision 9\'s three-criterion conjunction stays. The probe verdict is named "grader change-tracking on scheduled probes". The live user\'s change report stays a pre-registered verdict.',
      'B6. The absorb = 1 decomposition, the fixed qualifier in the verdict sentence, the static-structure and placebo rows, a corrected dose-gate rationale, anchor numbers without the length sort, and the anchor threshold t >= 1.65.',
      'B7. Arm on is the shipped default policy. The narrowed hook (prerequisiteCount 1, prerequisiteDepth 1) is a "candidate configuration", kept as a setting; it does not fit the cap and is not run.',
      'Q2. A-mid was evaluated against A-full; A-full is used (at the compliance revision 9 implies, A-mid at its affordable 33 pairs has 19-42% power, against 67% for A-full at 36).',
    ],
  },
  primary: {
    estimand: 'Per learner, G = (1/5) Σ_{t=1..5} E_t, where E_t is the item-mean percent of the exam after session t (100 × items held / 60). Primary: the mean over the matched fast-lane pairs of G(on) - G(off), complete pairs only, paired t (df = pairs - lanes). on minus off is the effect of the whole shipped hook (its text, its guidance and its mastery readings together). The AUC was chosen after revision 9\'s data (disclosed, history.estimands).',
    configuration: 'shipped default configuration (not a tuned configuration)',
    gatekeeping: { finalMin: 0, finalLoAbove: -2, text: 'At the stopping look, "supported" also needs the final item-mean (E_5) paired estimate >= 0 and its 95% paired-t lower bound > -2. If the boundary is crossed and this fails, the verdict reads "inconclusive (faster early, final exam not non-inferior)", printed with both numbers.' },
    interval: 'The paired t interval, 95% and 90%, at the look where the sequence stops, not adjusted for stopping (an efficacy stop at look 1 or 2 overstates the size: read the size from it with the stop-bias table).',
    smallestEffectOfInterest: 2,
    verdict: 'supported: the paired t on G crosses the efficacy boundary at a look, the gatekeeping holds, and no withhold rule fires (sensitivity, D.6, D.8). harm shown: at the stop, the 95% interval of G lies below 0. no effect of 2 points or more: at the stop, the 90% interval of G lies within -2..+2 AND the 90% intervals of sensitivity versions (i) and (ii) do too (N1); otherwise "inconclusive (sensitivity versions disagree)". Otherwise inconclusive (after a futility stop: "inconclusive (stopped for futility)"). A null reading whose in-batch anchor check fails reads "inconclusive (testbed sensitivity not confirmed; programme stopped)". Never softened. Withheld when any pre-registered check fails or cannot be computed.',
    sentence: 'The verdict sentence carries a fixed qualifier. For "supported": "Learner\'s live hook, in its shipped default configuration (not a tuned configuration), changed the agent\'s teaching in a way this fixed memory model (which taxes facts whose direct prerequisite is unheld) rewards: +X [95% CI] AUC points; +Y points remain when the prerequisite rule is switched off on the same deliveries (D.7). This design cannot attribute any of it to Learner\'s mastery readings." The null words carry the same configuration name.',
    interim: 'Efficacy looks only at 12, 24 and 36 complete-or-ended pairs, by code (sequential). Until the sequence stops the analysis returns no between-arm number: the outcome, claim 2, the versions, the judge, the in-batch anchor check and the per-arm exam-derived mechanism columns are withheld or pooled, and the runner prints the decision only. Health looks (sequential.healthLooks) are separate, arm-blind and unlimited. The pilot reports mechanism and gates only.',
    incomplete: 'Complete-case, stratified by lane. Incompletion is reported by arm and lane; the verdict is withheld if, within a primary lane, arms on and off differ by more than 1 in incomplete learners.',
    lanes: 'Main batch: the fast lane, 3 blocks of 12 matched on/off pairs (36 + 36); block 1 also carries the 10 in-batch anchor learners (pairs 0-9) and the 2 never-learns controls (lane none). Pilot: fast lane off 12, anchor 12, on 3, and 2 controls; up to 2 iterations. The slow and medium lanes are not run.',
    power: 'Simulated (design D.4, no-model simulator, gated as the verdict): P(supported) 2.6% / 23% / 67% / 94% at shipped-default compliance 0 / 5% / 10% / 20% (d/sd 0 / 0.22 / 0.42 / 0.62); at a true 0, 63% futility stops and 57% "no effect of 2 points or more" (at SD about 3.4; that share depends on the SD). Under the normal model at 36 pairs: 81% at d/sd 0.5, 63% at 0.4. These are planning values, not predictions; compliance is the decisive unknown.',
    /** The owner's early-stopping design (learning-sim-sequential.ts), revision 10's looks and alpha. */
    sequential: {
      looks: [12, 24, 36] as const,
      /** Revision 8.5 (review 10 B1): a real run's --max-calls may not exceed this (the spend bound of the main batch). */
      hardCallCap: 6600,
      /** The cap floor the pin step enforces on every paid run (a lower bound only): --max-calls >= ceil(K × 1.05). */
      capFloor: { factor: 1.05, text: 'The pin step refuses a paid run whose --max-calls is below ceil(K × 1.05) (1,570 at the pilot\'s K = 1,495; 6,366 at the main batch\'s K = 6,062) or above the hard cap 6,600. The floor is a lower bound only: the pre-registered caps are unchanged (pilot 1,570; main ceil(K × (1.05 + r)) with r the pilot\'s retry share, 6,384 at r = 0.003).' },
      pairing: 'The k-th arm-on, arm-off and arm-anchor learners of the fast lane share pair index k: the same holdout block and Williams row (simSlots cellIndex), and every memory-rule draw keyed by run, lane, pair, kind, fact id and session (simPairKey, design A0), never the arm. The test is on the paired difference.',
      alpha: 'Claim 1 has a programme-wide one-sided alpha of 0.025, spent by batch. Revision 9 took one look at 10 pairs and stopped for futility, spending its look-1 efficacy alpha of 0.00026; revision 10 spends the rest, 0.02474.',
      boundary: 'O\'Brien-Fleming type, grid-integrated (obfBoundary), one-sided overall alpha 0.02474 (0.025 minus the 0.00026 spent at revision 9\'s look 1), 3 equally spaced looks at 12, 24 and 36 pairs: c = 2.0074, critical z 3.477, 2.459, 2.007, nominal one-sided p 0.00025, 0.00697, 0.02235, applied to the paired t (df = pairs - lanes). Fewer looks than planned (the cap) use the same per-look boundaries; a run with one fixed look (the e2e fixtures) uses the K = 1 boundary (c 1.9644).',
      futility: 'At look 1 or 2, a paired t at or below 0 (or not computable) stops the batch: reading "inconclusive (stopped for futility)" unless the harm or no-effect reading holds at the stop. Binding: the runner applies it by code and never overrides it.',
      falsePositive: 'Seeded simulation in learning-sim-sequential.test.ts (60,000 draws, true 0, SD 3.4, 36 pairs at 12/24/36): 2.36% with the futility rule; the test requires at most 2.8%.',
      // Review 7 S4: the size read at a stop is biased upward, more so the earlier the stop. Seeded simulation
      // (learning-sim-sequential.test.ts, 20,000 draws per row), printed beside every stopped primary.
      stopBias: {
        rows: [
          { truth: '0 (SD 3.4)', whenSupported: 1.47, atLook1: 2.74, atLook2: 1.84, naiveCoverage: 0.948 },
          { truth: '+1.44 (d/sd 0.42)', whenSupported: 1.86, atLook1: 3.51, atLook2: 2.19, naiveCoverage: 0.928 },
          { truth: '+2.29 (d/sd 0.62)', whenSupported: 2.49, atLook1: 4.05, atLook2: 2.67, naiveCoverage: 0.932 },
        ],
        why: 'The mean estimate (AUC points) given a "supported" stop, by the look it stopped at, and the share of runs whose naive 95% interval covers the truth. An early stop happens when the sample overstates the effect, so the stopped estimate is a ceiling-ward reading of the size, not the size: read the direction from the verdict and the size with this table.',
      },
      expectedCalls: 'Planned keys per learner (plannedCalls; it counts every live grading): on = learner 20 (15 turns + 5 probes) + reply 15 + match 15 + grader 57 = 107; off = anchor = 40; control = 107. Main K = 36 × 147 + 10 × 40 + 2 × 107 + 156 (the judge) = 6,062; --max-calls = ceil(K × (1.05 + r)), 6,384 at revision 9\'s r = 0.003, at most the hard cap 6,600 (it holds up to r = 3.88%). Pilot K = 3 × 107 + 24 × 40 + 2 × 107 = 1,495, cap ceil(K × 1.05) = 1,570; at most 2 iterations. Expected actual calls: about 3,400 at a true 0 (22 pairs), about 4,350 at 10% compliance, at most about 5,030.',
      healthLooks: 'Health looks are separate from efficacy looks: unlimited, from the first ended learner on, through sim-experiment.ts --health (simHealth), reading only arm-blind or pooled quantities: learner status, calls and paid invocations by role, call failures, parse retries, 429s, call durations, the validity gates pooled (echo, channel, never-learns control), and per-item exam screening pooled over arms. A health look never computes or prints a between-arm outcome difference.',
      voidRule: 'If a health look finds a bug that changes the instrument (the exam, its scoring, the channel, the learner, the memory rules, the hook or the grader), the batch is void: the revision number goes up, and data gathered before the fix is never pooled with data after it. A fix that does not change the instrument (the runner, scheduling, logging, the 429 handling) does not void it; which is which is stated in the report.',
      concurrency: '--concurrency (default 6, maximum 9) sets the model-call slots (LLM_CLI_MAX_CONCURRENT) and the workflow concurrency. A 429 (Too Many Requests) is never a learner outcome: it pauses every slot (backoff doubling from 30 s, capped at 5 min, times a random 0.5 to 1.5), is not counted as an attempt, is counted in the health look, and after two 429s in a row drops the slots one step (not below 2). A step that is still rate-limited after 10 minutes fails as a capacity error; the workflow retries it and the runner restarts a failed learner on its next boot.',
      oneStart: 'One operator, one start: a run id is started once (sim-experiment.ts refuses a run id that has an experiment run), and the workflow\'s first step refuses a second live or completed experiment run of the same run id, so two starts racing on one run id cannot both run it.',
    },
  },
  secondary: [
    'SECONDARY (no verdict): the final exam\'s item-mean (E_5, the gatekeeper\'s estimand); the final exam\'s concept-mean (revision 9\'s scale); the briefed/foundation split of the final concept-mean (where an effect comes from, never its sign).',
    'EXPLORATORY (no verdict, no multiplicity correction): anchor minus off and anchor minus on on G, over the 10 in-batch anchor pairs, computed only after the stop.',
  ],
  /** Design D.6: the sensitivity versions, by replayExams on the stored deliveries with the same draws and 0 model calls. */
  sensitivity: {
    versions: [
      '(i) matcher-only: the primary with every `attributed` (0.4) delivery dropped.',
      '(ii) volume-matched: each pair\'s two delivery sequences truncated, session by session, to the smaller delivered count, in delivery order.',
      '(iii) per-arm path shares: matched / matched-claimed / attributed, per arm, reported.',
    ],
    withhold: '"supported" is withheld if (i) or (ii) has a 95% paired-t lower bound <= 0 (or not computable), or if the judge\'s withhold fires. When a version equals the primary, crossing the boundary already implies its lower bound is > 0 (0.02235 < 0.025), so the rule costs power only when a version shrinks the effect, which is its purpose.',
    judge: 'The arm-blind judge (156 model calls after the stop): a seeded draw of (sentence, delivered fact) pairs from the stored deliveries, stratified by arm (on, off) × path (matcher, attributed), 36 per stratum (a short stratum is taken whole, its remainder from the same arm\'s matcher stratum), plus 6 planted FALSE pairs and 6 planted TRUE pairs. The judge sees only the sentence and the fact, shuffled, never the arm, and answers "does this sentence state this fact: yes / no". Reported: the false-delivery share per arm and path, and the arm difference weighted by each arm\'s path shares. Withheld: on\'s weighted false-delivery share exceeds off\'s with a 95% lower bound > 0, or the judge says "yes" to more than 2 of the 6 planted false pairs or "no" to more than 2 of the 6 planted true pairs (the judge is then not trusted), or an item is unanswered.',
    /** P6's notes for P7: how the judge's sample is drawn and read, and when an item is unanswered. */
    judgeMechanics: 'One seeded stream `${runId}|judge`, consumed in this order: per arm (on, then off) its attributed stratum, then its matcher stratum; then the 6 planted false pairs (a window from the pool, then a fact for it), then the 6 planted true pairs, then the shuffle that gives each item its index. The pool is the fast on and off learners\' stored deliveries in canonical order (learner id, session, turn, delivery order). A short attributed stratum is taken whole and its remainder drawn only from the same arm\'s matcher stratum. The judged text is the delivered window at its path\'s bar: the matcher\'s sentence with the one before it (0.6) for matched and matched-claimed, the first window at 0.4 for attributed. A planted false pair is a delivered window with a fact of another concept that the window does not state even at 0.4; a planted true pair is a sheet fact as its own sentence. The prompt is judgePrompt (sentence and fact only, each in the judge\'s view: every sheet id of EXAM_FACTS, fact or concept, bracketed or bare, removed, and any bracket left empty; P6 review R4). The stored reply, the matcher, every arm\'s score and the sample and its order read the text as delivered. The model is the run\'s agent model. Answers are read from the `judge:<i>` rows of learning_sim_calls over every index of the sample, never from step outputs: a row\'s output.text is the answer; any answer other than exactly yes or no, a row with output.failed, a row with neither and an index with no row are unanswered. A final judge failure is unanswered and fires "judge incomplete". Final means only: the call cap reached, a codex run with no cap, a reply refused after its one re-ask, a claim refused after 3 takeovers. A restart, a dead wrapper or any other transport error never makes an item final; the step retries it under the cap. The withhold\'s 95% interval is a stratified bootstrap with the path shares fixed (seed `${runId}|judge|bootstrap`); deliveries are clustered by learner and it resamples items, so it is anti-conservative, which makes the withhold fire more often (conservative for "supported"). Per-stratum Wilson intervals are descriptive.',
    reporting: 'The report states how many withhold rules fired and which ones, even when the primary is null (N3). Version (i) is printed beside the primary with its signed difference from it, read in both directions (N4).',
  },
  decomposition: 'Design D.7, "share carried by the prerequisite rule": the primary recomputed on the same stored deliveries with absorb = 1 (replayExams), printed beside the primary with both numbers and the ratio (the ratio is unstable when either is small). It holds the agent\'s choices fixed: a counterfactual of the instrument, not of the agent.',
  inBatchAnchor: { pairs: 10, text: 'The in-batch anchor check (design D.8): anchor minus off on G over pairs 0-9, computed only after the stop. If its 90% lower bound is <= 0 (or not computable), a null primary reads "inconclusive (testbed sensitivity not confirmed; programme stopped)". It never touches a "supported", and it never permits a revision 11 of this configuration.' },
  /** Design C: the pilot's gates and the iteration rule. A gate that cannot be computed fails. */
  pilot: {
    anchorGate: { pairs: 12, minT: 1.65, text: 'C.2: PASS iff, over 12 complete anchor/off pairs (pairs 0-11), the paired t of anchor minus off on G is >= 1.65 (the main batch\'s fixed-design standardized MDE 2.85/√36 = 0.475, times √12) and the mean is > 0. It reads arms anchor and off only. Operating characteristics (simulated, 20,000 draws; in brackets, at least one pass in 2 iterations): true anchor d/sd 0: 6.3% (12%); 0.3: 30% (51%); 0.475: 52% (77%); 0.62: 70% (91%); 0.92: 93% (100%); 1.13: 98%. Passing shows that a followed, explicit fact list moves this instrument by at least the main batch\'s MDE. It does not imply that the main batch has power for the hook. Over two iterations, a null testbed passes 12% of the time.' },
    doseGate: { minDiffPp: 3, text: 'C.4 (treatment fidelity; mechanism only, it reads no exam): over the 3 pilot on learners pooled, the share of delivered facts on concepts the session\'s brief does not name, minus the same share for their 3 matched off learners (same pair index, same briefs), is >= +3 percentage points. It is a cost rule, not a validity rule: it stops the main batch when the shipped guidance is not executed. It cannot be retried: a failure stops claim 1 with the product finding "the shipped guidance is not executed by this agent (dose difference X pp)".',
      revision9: 'revision 9\'s hook would have passed the dose gate (+5.0 pp: `on` 46/374 = 12.3% against `off` 27/372 = 7.3%)' },
    /** Design D.4 (R3): the programme-level chance of "supported" (the terminal dose gate times the main batch). */
    programme: [
      { compliance: '0', dosePasses: '15%', mainSupported: '2.6%', programme: 'about 0.4%' },
      { compliance: '0.05', dosePasses: '50%', mainSupported: '23%', programme: 'about 12%' },
      { compliance: '0.10', dosePasses: '78%', mainSupported: '67%', programme: 'about 52%' },
      { compliance: '0.20', dosePasses: '97%', mainSupported: '94%', programme: 'about 91%' },
    ],
    gates: 'C.5, carried over: gradings settle and arm on has a non-null reading from session 2; the channel gate; valid ids >= 95%; the B5 echo; the never-learns control (mastery part only; its exam is structurally 0). The pilot report prints no exam-derived number for arm on.',
    echo: 'N6: the B5 echo gate is unchanged under A-full (Sam now reads canonical sheet text, so the echo may rise). An echo failure is a pilot gate failure, never a tuning point: its threshold and the rendering of the notebook do not change.',
    iterations: 'C.6: 2 pilot iterations in total, whatever the gate; each has a new run id, declares the runs before it (--after) and is fully logged. Any gate failure in iteration 2, or a dose failure in either, stops claim 1. Iteration 2 may change only: after a C.2 failure, the anchor directive\'s presentation (wording and format, never its fact choice) or the pre-declared K6/cap800 rung (a reworded directive is tuning toward a pass, allowed once and logged with its full wording diff); after a C.5 failure, a reviewed code fix on the failing gate\'s code path only (R4: a change to the memory rules, the matcher, the exam, the anchor directive\'s fact choice, the hook or the prompts is out of scope; if one is needed, iteration 2 fails); never anything after a C.4 failure. The runner records both frozen commits and the iteration log prints the full git diff between them. The gate thresholds, the anchor\'s selection rule, the estimand and the main design never change.',
  },
  claim2: {
    probes: 'Grader level on the scheduled probes (descriptive beside 2a): every probe reading of every probe-taking learner (up to 5 per learner, sessions 2-6, each against the exam after the session before it), the interval a learner bootstrap; accurate if MAE <= 20, MAE below a constant reading at the observed median truth (the constant with the least MAE), and the Spearman interval above 0; inaccurate if MAE >= 30, or n >= 40 and the interval covers 0; otherwise inconclusive.',
    verdict2a: 'Verdict 2a, "grader change-tracking on scheduled probes": each learner\'s probe user (schedule A s2 / B s3 / A s4 / B s5 / A end), the product\'s own masteryChanges on it, against the exact held-share change between the same probe times. Accurate needs all four criteria computed and met (sign agreement, interval coverage, false gains, and the Spearman correlation\'s learner-bootstrap 95% lower bound > 0 at n >= 30); any computed failure reads inaccurate; otherwise not computable. It is never worded as "the app reports improvement accurately".',
    /** The lead's item (b), P5's guarantee in its own words: what a pair shares in the probe draw, and what it does not. */
    probeDraw: 'The probe draw (P5): one uniform draw per pair and probe key; each learner takes that quantile of its own delivered concepts; the same rank only when the two learners\' sets have the same size.',
    verdict2b: 'Verdict 2b, the live user\'s change report: revision 9\'s three criteria on the live on users, with its coverage (the share of concept-sessions with a counted reading) printed beside it.',
    prediction: 'Predicted before any data: both most likely read "not computable". 2a: about 84 probe-taking learners give about 47-67 first-to-last changes and about 10-17 sign-eligible, against a minimum of 20. 2b: revision 9 had 4 series.',
    /** The app\'s change reports, against the exam\'s change over the same sessions. Accurate: every criterion met at its
     * minimum n; inaccurate: any one failed; otherwise not computable. */
    changes: {
      signAgreement: { min: 0.75, minN: 20, why: 'Where the exam moved 25+ points (two facts) and the app reported a change, its sign agrees at least 3 times in 4. Chance is 1 in 2; at n = 20, 15/20 has a 95% Wilson lower bound above 0.5.' },
      intervalCoverage: { min: 0.85, minN: 20, why: 'The true change lies inside the app\'s 95% interval at least 85% of the time (nominal 95, minus 10).' },
      falseGains: { max: 0.2, minN: 10, why: 'At most 1 gain notification in 5 is false (the exam did not rise for that concept between the reading it beat and this one); undecidable ones are excluded.' },
      spearman: { minLo: 0, minN: 30, why: 'Verdict 2a only: the Spearman correlation of reported against true change, its 95% learner-bootstrap lower bound above 0. C8: a lower bound that is not computable (NaN: one learner, or every reported or true change tied) at n >= 30 reads "not computable" for this criterion, never "inaccurate"; another criterion that fails still reads "inaccurate".' },
    },
  },
  /** The never-learns negative control (revision 7, owner request); revision 10 reads its mastery part only. */
  negativeControl: {
    design: 'Lane none: notebook capacity 0 (nothing is ever written) and teaching budget 0 (no fact sheet is offered and the channel redacts every fact), arm on, through the same workflows as every learner (sessions, the hook, the product grader, the exam). It converses and answers but retains nothing. 2 learners in the pilot, 2 in the main batch; it enters no other estimand, check or gate.',
    mastery: 'Learner reports no change: 0 notifications (gain or first clear), 0 concepts whose change is beyond noise (after FDR) and upward, and no learner whose aggregate change interval lies above 0.',
    failure: 'A failure means the grader or the report rewards talk without knowledge. In the pilot it is a gate; in the main batch it is a check (a failure withholds the primary verdict) and reads the claim-2 change verdict "inaccurate". Its exam part is gone: under A-full an empty notebook scores 0 by construction.',
  },
  checks: [
    'incompletion balanced: within each primary lane, incomplete learners in arms on and off differ by at most 1',
    'no injection ever targets a held-out concept',
    'the channel gate on every learner (every claimed fact accounted, no over-budget fact read)',
    'the never-learns control\'s mastery part',
    'frozen code and spec: no file under packages/ (the sim, the product code it runs: the hook policy, the assessment workflow and grader, and the mastery-change and notification code that computes claim 2 at analysis), the root package.json and bun.lock, nor this spec differs from the commit recorded at the run\'s start or is untracked; every learner in the database carries the same run record (its commit, cap, looks and the runs it follows). A start, a resume and an analysis on any other tree are refused, so the run is made and analysed from a worktree pinned at that commit',
  ],
  mechanism: [
    'dose: facts delivered per concept-session on the concepts the injection targeted against the rest (arm off read on the concept-sessions arm on targeted for the same design row), and the off-brief delivered share',
    'channel: sentences redacted, unoffered and over-budget facts, the agent\'s claimed ids against the matcher, and each arm\'s delivery path shares (version iii)',
    'memory: forgotten, strengthened, not absorbed and over capacity per session, by arm',
    'waste and restatement against the previous exam (pooled over arms before the stop)',
  ],
  /** Fixed blocks the report prints before any number (design B, D.10, E). */
  history: {
    revision9: { runId: 'ccec88a3-652a-4d31-b88d-0d70ee4d9f1d',
      verdictLine: '**Primary (whole-exam gain, on minus off, paired, mean over fast of the mean pair difference; stopped at look 1): -0.8 [95%: -5.3, 3.7; 90%: -4.4, 2.8] (10 pairs, 1 lanes; t -0.41, df 9, one-sided p 0.65). Reading: inconclusive (stopped for futility). Verdict: inconclusive (stopped for futility).**' },
    confirmatoryVerdicts: ['revision 9 (run ccec88a3-652a-4d31-b88d-0d70ee4d9f1d): inconclusive (stopped for futility), final for revision 9'],
    configurationsTested: 2,
    configurations: 'revision 9: the shipped default + spacedRepetition; revision 10: the shipped default',
    erratum: 'Erratum to revision 9\'s header (revision 9\'s verdict is unchanged): revision 9\'s header said the hook ran "spacedRepetition: true and foundationFirst: true (NEITHER is the product default)". In fact `foundationFirst` changed no target; revision 9\'s `on` arm differed from the shipped default only by `spacedRepetition` and the `"foundationFirst":true` flag in the guidance JSON shown to the agent. The 46% of target slots on foundations that the diagnosis attributed to `foundationFirst` came from the shipped ordering.',
    estimands: 'Seen before this pre-registration (revision 9, 10 pairs; mean on - off, SD of the differences, within-pair r): final concept-mean (revision 9\'s primary) -0.80, 6.23, 0.19; final item-mean (revision 10\'s gatekeeper) -0.33, 5.84, 0.05; AUC concept-mean +1.12, 4.08, 0.26; AUC item-mean (revision 10\'s primary) +1.30, 2.79, 0.25. The primary is the estimand on which revision 9 looks best (t about 1.47). The gatekeeping was chosen by the lead on 2026-11-14, also after this data.',
    ownerSpeed: 'The owner\'s statement on speed, quoted only as recorded: on 2026-11-12, before revision 9\'s report (2026-11-14), the owner set the objective of auto-mode tuning: optimise "both speed of mastery gain and durable retention, \'Pareto\'", with speed of gain "the primary uncompromiseable goal". It was not said about this estimand or this experiment: it concerns what a future self-tuner may optimise, and does not justify AUC as revision 10\'s primary. The final-exam gatekeeper is consistent with its second objective, but was not derived from it.',
    /** Design E.2: every change and its predicted direction on on - off. */
    directions: [
      { change: 'A1 rule uptake on ids (A-full)', evidence: '[sim] default proxy at 10% compliance: d/sd 0.14 rev9-like, 0.29 A-lite, 0.42 A-full', direction: 'favours on (the absorb tax becomes the lever)' },
      { change: 'A0 CRN pairing', evidence: '[sim] r 0.13-0.40', direction: 'neutral in mean; small precision gain' },
      { change: 'A2 all sheets offered', evidence: '[data] 71% of on target slots were off-brief, and lookups delivered 7 of 59', direction: 'favours on (removes a limit only on hit)' },
      { change: 'A3 verified claims', evidence: '[data] matcher-confirmed claims: on 50.2%, off 45.1%', direction: 'a guess: probably favours on (it drops more off deliveries); version (i) measures it' },
      { change: 'A4 item-mean, AUC', evidence: '[data] rev9 -0.80 to +1.30 across the four estimands', direction: 'favours on' },
      { change: 'B7 shipped default instead of the candidate', evidence: '[sim] 0.91 against 0.61 at equal compliance', direction: 'favours on in the simulator; chosen for relevance, not size' },
      { change: 'B2 honest fallback', evidence: 'none', direction: 'unknown (text only)' },
      { change: 'B4 spaced repetition off', evidence: '[data] its 59 review turns moved no budget in rev9', direction: 'about neutral' },
    ],
    directionsReading: 'Every change with a known direction points toward on. The guards are the gatekeeping, the sensitivity versions and the judge, the decomposition and the qualifier inside the verdict sentence, the placebo, nudge and static-prompt rows, and the programme stop. The anchor gate is not a guard against this: it shows that the instrument responds, not that it is neutral.',
    /** Design D.10 (R1): the simulator rows, A-full, compliance 0.6 unless stated. */
    simulator: [
      { policy: 'anchor', does: 'true-state fact list, 2 prerequisites', dsd: '0.92', points: '+3.48' },
      { policy: 'shipped-default proxy', does: '≤ 2 unmet prerequisites within 2 hops, then the brief', dsd: '0.91', points: '+3.66' },
      { policy: 'static prerequisite-first prompt, same plan shape', does: 'the shipped-default proxy\'s plan with no readings ever (unmet = unscored prerequisites within 2 hops, foundations first, then the brief)', dsd: '1.04 (114% of the hook proxy)', points: '+3.98' },
      { policy: 'candidate config proxy', does: '1 direct prerequisite, then the brief', dsd: '0.61', points: '+2.19' },
      { policy: 'one-fact static nudge', does: 'one fact of a random direct prerequisite first, no readings (a smaller plan, not like for like)', dsd: '0.41', points: '+1.38' },
      { policy: 'placebo', does: 'one fact of a random non-prerequisite off-brief concept', dsd: '0.12', points: '+0.38' },
    ],
    simulatorReading: 'Read: in the planning model, a static prerequisite-first prompt does at least as well as the hook. The like-for-like static prompt (the same plan shape with no readings) reaches d/sd 1.04 against the hook proxy\'s 0.91 (114%). The readings add nothing in this model. The one-fact nudge (0.41) and the placebo (0.12) are smaller plans and are not a comparison of readings against no readings; the placebo is above 0 because foundation facts are untaxed by the rule.',
    proves: 'What a positive result would prove: the shipped hook changed what an LLM agent teaches, in a way that this fixed memory model rewards. In the simulator about 83-89% of that effect is carried by the prerequisite rule. What it would not prove: that the gain comes from Learner\'s mastery readings. No arm isolates them, and in the planning model a static prerequisite-first prompt does at least as well as the hook (d/sd 1.04 against 0.91). Nor would it prove that real people or an LLM learner understand more, or that the app reports improvement accurately.',
    programmeStop: 'Revision 10\'s main batch is the last confirmatory test of this configuration (the shipped default) in this testbed, whatever the in-batch anchor check says. Every later confirmatory batch, under any name, prints every earlier confirmatory verdict and the number of hook configurations tested, spends its alpha from the programme\'s remaining 0.025, and builds its iteration log by query. No result is re-analysed under another estimand after unblinding.',
  },
  /** Design E.3: the iteration log, by query (not by declaration), over the database the run is in. */
  iterationLogQuery: 'select run_id, min(created_at), string_agg(distinct arm, \',\') from learning_sim_learners where created_at > (select min(created_at) from learning_sim_learners where run_id = \'ccec88a3-652a-4d31-b88d-0d70ee4d9f1d\') and arm in (\'anchor\', \'on\') group by run_id',
} as const
type Integrity = { ok: boolean; detail: string }

const factConcept = (factId: string) => halyardId(factId.replace(/-f\d+$/, ''))
/** The concepts some task's brief names (9 of 13); the rest are foundations reached only as prerequisites. */
const FOUNDATIONS = HALYARD_CATALOG.concepts.map((c) => c.id).filter((id) => !BRIEFED.includes(id))
const scopeTotal = (e: ExamResult, ids: string[]) => mean(ids.map((id) => e.byConcept[id]!))

// ---------------------------------------------------------------- revision 10 estimands (design D.3, D.6, D.7)

/** Design D.3: G, the mean of the post-session exams E_1..E_sessions, each the item-mean percent (`items`). NaN when one
 * is missing. */
export const auc = (exams: readonly ExamResult[], sessions: number) => {
  const xs = Array.from({ length: sessions }, (_, i) => exams.find((e) => e.timepoint === i + 1)?.items)
  return xs.every((x): x is number => x !== undefined) ? mean(xs) : NaN
}
/** A learner's exams recomputed from its stored deliveries with the pair's own draws (P1's `replayExams`): no override is
 * the run's exams; the overrides give versions (i) and (ii) and the decomposition. */
export const replayedExams = (d: Pick<SimLearnerData, 'config' | 'agentTurns'>, overrides: Parameters<typeof replayExams>[3] = {}) =>
  replayExams(sessionDeliveries(d), d.config.lane, simPairKey(d.config), overrides)
/** Version (ii)'s truncation: per session, the smaller of the two learners' delivered counts. */
const volumeMatch = (a: SimLearnerData, b: SimLearnerData) => { const x = sessionDeliveries(a), y = sessionDeliveries(b); return x.map((s, i) => Math.min(s.length, y[i]!.length)) }
/** Delivered facts on concepts the session's brief does not name (the dose gate's measure, design C.4), from the record. */
const offBrief = (d: SimLearnerData) => {
  let delivered = 0, off = 0
  for (const t of d.agentTurns) {
    const named = new Set(HALYARD_TASKS[d.config.taskOrder[t.session - 1]!]!.named)
    delivered += t.statedFactIds.length
    off += t.statedFactIds.filter((id) => !named.has(factConcept(id))).length
  }
  return { delivered, off }
}

/** The pilot's channel gate (revision 8, re-review 5 point 2), from each agent turn's record, every learner and arm
 * (the channel is arm-blind): every fact the agent claimed is budgeted, redacted as over budget, or already counted
 * that session (a free restatement); and no over-budget fact is found by the matcher in the text the learner read
 * unless it was budgeted. Both counts must be 0. null: no agent turn, or a turn without its text. */
export function channelIntegrity(ds: SimLearnerData[]) {
  let turns = 0, claimedUnaccounted = 0, overBudgetKept = 0, textMissing = 0
  for (const d of ds) for (const session of new Set(d.agentTurns.map((t) => t.session))) {
    const counted = new Set<string>()
    for (const t of d.agentTurns.filter((x) => x.session === session).sort((a, b) => a.turn - b.turn)) {
      turns++
      const stated = new Set(t.statedFactIds), over = new Set(t.overBudgetFacts), withheld = new Set(t.withheldFacts ?? [])
      // Review 6 B1: a withheld claim (its sentence redacted, or no sentence to place it in) was not read: accounted.
      claimedUnaccounted += t.claimedFactIds.filter((id) => !stated.has(id) && !over.has(id) && !withheld.has(id) && !counted.has(id)).length
      if (t.text == null) textMissing++
      else { const read = new Set(factsBySentence(t.text).flatMap((x) => x.facts)); overBudgetKept += t.overBudgetFacts.filter((id) => read.has(id) && !stated.has(id) && !counted.has(id)).length }
      for (const id of stated) counted.add(id)
    }
  }
  return { turns, claimedUnaccounted, overBudgetKept, ok: turns && !textMissing ? claimedUnaccounted === 0 && overBudgetKept === 0 : null }
}

/** The never-learns control (lane none, arm on: notebook capacity 0, teaching budget 0), against
 * `SIM_PREREGISTRATION.negativeControl`: the mastery part only (revision 10: its exam is structurally 0). No gain or
 * first-clear notification, no concept change beyond noise upward, and no learner whose aggregate change interval lies
 * above 0. null: no control learner. */
export function neverLearnsControl(control: SimLearnerData[]) {
  const toasts = control.reduce((n, d) => n + d.notifications.length, 0)
  const rises = control.reduce((n, d) => n + (d.changes?.concepts ?? []).filter((c) => c.beyondNoise && c.delta > 0).length, 0)
  const aggregateRises = control.filter((d) => (d.changes?.aggregate.changeInterval?.[0] ?? 0) > 0).length
  return { n: control.length, toasts, rises, aggregateRises, ok: !control.length ? null : toasts === 0 && rises === 0 && aggregateRises === 0 }
}

/** Matched pairs in the primary lanes: arm `a` and arm `b` learners of a lane with the same `config.pair` (runs before
 * revision 8: the same rank by learner id, numeric-aware). A pair with only one arm present is not a pair. */
export function simPairs(cells: SimLearnerData[], lanes: readonly string[], a = 'on', b = 'off') {
  const index = (d: SimLearnerData, ds: SimLearnerData[]) => d.config.pair ?? [...ds].sort((x, y) => x.config.learnerId.localeCompare(y.config.learnerId, 'en', { numeric: true })).indexOf(d)
  return lanes.flatMap((lane) => {
    const as = cells.filter((d) => d.config.lane === lane && d.config.arm === a), bs = cells.filter((d) => d.config.lane === lane && d.config.arm === b)
    return as.flatMap((d) => { const pair = index(d, as), mate = bs.find((o) => index(o, bs) === pair); return mate ? [{ lane, pair, on: d, off: mate }] : [] })
  })
}

/** Design D.3, D.6, D.8: the reading and the verdict at the stop, from the estimates alone. `fired` lists every withhold
 * rule that fired, and would fire on a "supported" (N3), even when the primary is null; `judge` is the judge's own
 * withholds, null when it did not run. */
export function simVerdict(x: { decision: LookDecision; primary: PairedEstimate; final: PairedEstimate; matcherOnly: PairedEstimate; volumeMatched: PairedEstimate
  judge: string[] | null; anchorCheck: PairedEstimate; failedChecks: string[] }) {
  const { smallestEffectOfInterest: sesoi, gatekeeping: gk } = SIM_PREREGISTRATION.primary
  const within = (e: PairedEstimate) => e.lo90 >= -sesoi && e.hi90 <= sesoi
  const gatekept = x.final.mean >= gk.finalMin && x.final.lo > gk.finalLoAbove
  const base = !Number.isFinite(x.primary.lo) ? 'inconclusive (too few pairs)'
    : x.decision === 'efficacy' ? (gatekept ? 'supported' : SIM_READINGS.gatekept)
    : x.primary.hi < 0 ? 'harm shown'
    : within(x.primary) ? (within(x.matcherOnly) && within(x.volumeMatched) ? `no effect of ${sesoi} points or more` : SIM_READINGS.versionsDisagree)
    : x.decision === 'futility' ? 'inconclusive (stopped for futility)' : 'inconclusive'
  const anchorConfirmed = x.anchorCheck.lo90 > 0
  const isNull = !['supported', 'harm shown', SIM_READINGS.gatekept].includes(base)
  const reading = isNull && !anchorConfirmed ? SIM_READINGS.anchorNotConfirmed : base
  const onSupported = [
    ...(x.matcherOnly.lo > 0 ? [] : [`sensitivity version (i) matcher-only: 95% lower bound ${Number.isFinite(x.matcherOnly.lo) ? '≤ 0' : 'not computable'}`]),
    ...(x.volumeMatched.lo > 0 ? [] : [`sensitivity version (ii) volume-matched: 95% lower bound ${Number.isFinite(x.volumeMatched.lo) ? '≤ 0' : 'not computable'}`]),
    ...(x.judge ?? ['judge: not run']),
  ]
  const fired = [...onSupported, ...(anchorConfirmed ? [] : ['in-batch anchor check: 90% lower bound ≤ 0 or not computable']), ...x.failedChecks]
  const verdict = x.failedChecks.length ? `withheld (${x.failedChecks.join('; ')})` : reading === 'supported' && onSupported.length ? `withheld (${onSupported.join('; ')})` : reading
  return { reading, verdict, fired }
}
export const SIM_READINGS = {
  gatekept: 'inconclusive (faster early, final exam not non-inferior)',
  versionsDisagree: 'inconclusive (sensitivity versions disagree)',
  anchorNotConfirmed: 'inconclusive (testbed sensitivity not confirmed; programme stopped)',
} as const
const signed = (x: number) => Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(2)}` : 'n/a'
/** Design D.3: the verdict sentence with its fixed qualifier and the configuration name. */
export function verdictSentence(verdict: string, primary: PairedEstimate, ruleOff: PairedEstimate) {
  const configuration = `Learner's live hook, in its ${SIM_PREREGISTRATION.primary.configuration}`
  return verdict === 'supported'
    ? `${configuration}, changed the agent's teaching in a way this fixed memory model (which taxes facts whose direct prerequisite is unheld) rewards: ${signed(primary.mean)} [95% CI ${signed(primary.lo)}, ${signed(primary.hi)}] AUC points; ${signed(ruleOff.mean)} points remain when the prerequisite rule is switched off on the same deliveries (D.7). This design cannot attribute any of it to Learner's mastery readings.`
    : `${configuration}: ${verdict}.`
}

/** The pilot gates (design C.2, C.4, C.5) and the clause each belongs to: the iteration rule (C.6) reads it. */
export const SIM_PILOT_GATES = { anchor: 'C.2', dose: 'C.4', onReadings: 'C.5', channel: 'C.5', validIds: 'C.5', learnerEcho: 'C.5', neverLearns: 'C.5' } as const
export type SimPilotGate = keyof typeof SIM_PILOT_GATES
/** The gates that failed (a gate that could not be computed fails), each with its clause. */
export function pilotGateFailures(gates: Record<SimPilotGate, boolean | null | { ok: boolean | null }>) {
  return (Object.keys(SIM_PILOT_GATES) as SimPilotGate[]).filter((g) => { const v = gates[g]; return (v !== null && typeof v === 'object' ? v.ok : v) !== true })
    .map((gate) => ({ gate, clause: SIM_PILOT_GATES[gate] }))
}

/** `looks`: the efficacy looks in pairs (default: the pre-registered 12, 24, 36); `mainPerArm` is shorthand for one
 * fixed look at that many pairs. A run with fewer pairs than the first look is a pilot and reports mechanism, checks
 * and gates only. While the sequence continues (an interim look said continue) no between-arm number is returned:
 * the outcome and claim 2 are null and the sequential section carries decisions only. `endedPairs`: how many pairs (by
 * pair index, from 0) have every learner ended; absent, every pair present counts as ended (fixtures, a finished run).
 * `stoppedBy`: the recorded stop of a sequential run (learning-sim-looks.ts), so a batch stopped by a failed check at a
 * look that said "continue" reads as stopped with its verdict withheld, not as still running. `judge`: the judge's
 * answers by item index (design D.6), absent when it did not run. */
export function analyzeSimRun(all: SimLearnerData[], opts: { integrity?: Integrity | null; mainPerArm?: number; looks?: number[]; endedPairs?: number; stoppedBy?: string; judge?: ReadonlyArray<string | null | undefined>; judgeCalls?: SimLearnerData['calls'] } = {}) {
  const looks = opts.looks ?? (opts.mainPerArm !== undefined ? [opts.mainPerArm] : [...SIM_PREREGISTRATION.primary.sequential.looks])
  // The never-learns control is read by its own gate only; every other estimand, check and gate reads the rest.
  const data = all.filter((d) => d.config.lane !== 'none'), control = neverLearnsControl(all.filter((d) => d.config.lane === 'none'))
  const isComplete = (d: SimLearnerData) => Boolean(final(d))
  const arms: string[] = [...new Set(data.map((d) => d.config.arm))].sort()
  const lanes = [...new Set(data.map((d) => d.config.lane))].sort()
  const primaryLanes = lanes.filter((lane) => data.some((d) => d.config.lane === lane && d.config.arm === 'on'))
  // The primary cells: arms on and off in the lanes that have arm on. Only they gate the verdict.
  const primaryCells = data.filter((d) => primaryLanes.includes(d.config.lane) && (d.config.arm === 'on' || d.config.arm === 'off'))
  const mainSized = primaryLanes.length > 0 && primaryLanes.every((lane) => ['on', 'off'].every((arm) => data.filter((d) => d.config.arm === arm && d.config.lane === lane).length >= looks[0]!))
  const G = (d: SimLearnerData) => auc(d.exams, d.config.sessions)
  const row = (d: SimLearnerData) => `${d.config.lane}|${d.config.taskOrder.join('')}`
  const targetedBy = (d: SimLearnerData, s: number) => new Set(d.agentTurns.filter((t) => t.session === s && t.decision === 'influence').flatMap((t) => t.conceptIds))

  // Revision 8, matched pairs and group-sequential looks (SIM_PREREGISTRATION.primary.sequential), on G.
  const matched = simPairs(primaryCells, primaryLanes)
  // A look is taken only on pairs whose learners have all ended (`endedPairs`, from the workflow statuses): a resumed
  // runner or an --analyze-only during a block must not read a later look off a half-run block.
  const scheduledPairs = Math.min(primaryLanes.length ? Math.min(...primaryLanes.map((lane) => matched.filter((p) => p.lane === lane).length)) : 0, opts.endedPairs ?? Infinity)
  type Pair = (typeof matched)[number]
  const completePairs = (ps: Pair[]) => ps.filter((p) => isComplete(p.on) && isComplete(p.off))
  const lookSeq = sequentialLooks(completePairs(matched).map((p) => ({ lane: p.lane, pair: p.pair, diff: G(p.on) - G(p.off) })), looks, scheduledPairs)
  const stop = lookSeq.at(-1)
  const stopped = Boolean(stop && stop.decision !== 'continue')
  /** The paired estimate of `f(a) - f(b)` over the complete pairs below `below`, by lane. */
  const paired = (ps: Pair[], f: (p: Pair) => number, below: number) => pairedEstimate(primaryLanes.map((lane) => completePairs(ps).filter((p) => p.lane === lane && p.pair < below).map(f)))
  const diff = (f: (d: SimLearnerData) => number) => (p: Pair) => f(p.on) - f(p.off)

  // Mechanism checks, per arm, from the channel's record and the previous exam (design D.5).
  const mechanism = Object.fromEntries(arms.map((arm) => {
    let targetedDose = 0, targetedCells = 0, otherDose = 0, otherCells = 0, stated = 0, alreadyRight = 0, misses = 0, missesStated = 0, budget = 0, redacted = 0, unoffered = 0, overBudget = 0
    let claimed = 0, claimedFound = 0, invalid = 0, reviews = 0, influence = 0, turns = 0, offBriefFacts = 0
    const paths: Record<string, number> = { matched: 0, 'matched-claimed': 0, attributed: 0 }
    for (const d of data.filter((x) => x.config.arm === arm)) {
      const peers = data.filter((x) => x.config.arm === 'on' && row(x) === row(d))
      offBriefFacts += offBrief(d).off
      for (const t of d.agentTurns) for (const x of t.statedFacts ?? []) paths[x.path]!++
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
        for (const t of ts) { claimed += t.claimedFactIds.length; claimedFound += t.claimedFactIds.filter((id) => t.statedFactIds.includes(id) && !t.attributedFacts?.includes(id)).length }
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
    const pathTotal = Object.values(paths).reduce((a, b) => a + b, 0)
    return [arm, { targetedDose: targetedCells ? targetedDose / targetedCells : NaN, targetedCells, otherDose: otherCells ? otherDose / otherCells : NaN, otherCells,
      stated, budget, budgetUsed: budget ? stated / budget : NaN, redacted, unoffered, overBudget, invalidFacts: invalid,
      validIdShare: claimed ? 1 - invalid / claimed : NaN, claimedConfirmed: claimed ? claimedFound / claimed : NaN,
      alreadyRight, missesStated, alreadyRightShare: stated ? alreadyRight / stated : NaN, restatement: misses ? missesStated / misses : NaN, misses,
      influenceTurns: influence, turns, reviewTurns: reviews, offBriefShare: stated ? offBriefFacts / stated : NaN,
      /** Version (iii), design D.6: the arm's delivery path shares. */
      pathShares: Object.fromEntries(Object.entries(paths).map(([k, n]) => [k, pathTotal ? n / pathTotal : NaN])) }]
  }))
  // A pilot pools the two exam-derived columns over arms: by arm, with 3 learners each, they give each arm's interim
  // exam level (review 3, S1). So does a main batch whose sequence continues (no between-arm number before the stop).
  if (!mainSized || !stopped) {
    // Revision 10 (C.5): a pilot prints no exam-derived number for arm on, pooled or not, so its pool leaves on out.
    const ms = Object.values(mechanism), pool = mainSized ? ms : Object.entries(mechanism).filter(([arm]) => arm !== 'on').map(([, m]) => m)
    const sum = (k: 'alreadyRight' | 'missesStated' | 'misses' | 'stated') => pool.reduce((n, m) => n + m[k], 0)
    const pooled = { alreadyRightShare: sum('stated') ? sum('alreadyRight') / sum('stated') : NaN, restatement: sum('misses') ? sum('missesStated') / sum('misses') : NaN, misses: sum('misses') }
    for (const m of ms) Object.assign(m, pooled, { alreadyRight: NaN, missesStated: NaN })
  }

  // Pre-registered checks (design D.8): each is true, false, or null (could not be computed, which withholds too).
  const incompletion = Object.fromEntries(lanes.map((lane) => [lane, Object.fromEntries(arms.map((arm) => {
    const cell = data.filter((d) => d.config.arm === arm && d.config.lane === lane)
    return [arm, { assigned: cell.length, incomplete: cell.filter((d) => !isComplete(d)).length }]
  }))]))
  const incompletionOk = primaryLanes.length ? primaryLanes.every((lane) => Math.abs(incompletion[lane]!.on!.incomplete - (incompletion[lane]!.off?.incomplete ?? NaN)) <= 1) : null
  const heldOutTargeted = data.reduce((n, d) => n + d.agentTurns.flatMap((t) => (t.decision === 'influence' ? t.conceptIds : [])).filter((id) => heldOutOf(d.config).has(id)).length, 0)
  const channel = channelIntegrity(all)
  const checks = {
    incompletion, incompletionOk, heldOutTargeted, heldOutOk: heldOutTargeted === 0,
    integrity: opts.integrity ?? null, integrityOk: opts.integrity ? opts.integrity.ok : null, channelOk: channel.ok,
    holdoutCounts: Object.fromEntries(HALYARD_CATALOG.concepts.map((c) => [c.id, data.filter((d) => heldOutOf(d.config).has(c.id)).length])),
    incomplete: data.filter((d) => !isComplete(d)).map((d) => d.config.learnerId),
    neverLearns: control,
  }
  const failed = ([['incompletion balanced', checks.incompletionOk], ['no held-out targeting', checks.heldOutOk], ['frozen code and spec', checks.integrityOk],
    ['the channel gate on every learner', checks.channelOk], ['never-learns control: no reported rise', control.ok]] as Array<[string, boolean | null]>)
    .filter(([, ok]) => ok !== true).map(([name, ok]) => `${name}: ${ok === null ? 'not computable' : 'failed'}`)

  const sequential = { looks, scheduledPairs, completePairs: completePairs(matched).length, stopped, stoppedBy: opts.stoppedBy ?? null,
    decisions: lookSeq.map((l) => ({ look: l.look, plannedPairs: l.plannedPairs, decision: l.decision, nominalP: l.nominalP })),
    // Interim numbers are revealed only once the sequence has stopped.
    detail: stopped ? lookSeq : null as Look[] | null }
  // The outcome (after the stop only): the primary, the gatekeeper, the versions, the decomposition, the judge, the
  // in-batch anchor check, the secondaries and the exploratory contrasts, every one paired over the pairs of the stop.
  const outcome = !mainSized || !stopped ? null : (() => {
    const below = stop!.plannedPairs
    const replayG = (overrides: Parameters<typeof replayExams>[3]) => (d: SimLearnerData) => auc(replayedExams(d, overrides), d.config.sessions)
    const primary = paired(matched, diff(G), below)
    const finalItems = paired(matched, diff((d) => final(d)!.items), below)
    const matcherOnly = paired(matched, diff(replayG({ dropPaths: ['attributed'] })), below)
    const volumeMatched = paired(matched, (p) => { const truncateTo = volumeMatch(p.on, p.off); return replayG({ truncateTo })(p.on) - replayG({ truncateTo })(p.off) }, below)
    const ruleOff = paired(matched, diff(replayG({ absorb: 1 })), below)
    const anchorPairs = simPairs(data, primaryLanes, 'anchor', 'off')
    const anchorCheck = paired(anchorPairs, diff(G), SIM_PREREGISTRATION.inBatchAnchor.pairs)
    const judge = opts.judge ? judgeAnalysis(all[0]!.config.runId, judgeSample(all[0]!.config.runId, data), opts.judge) : null
    const v = simVerdict({ decision: stop!.decision, primary, final: finalItems, matcherOnly, volumeMatched, judge: judge?.withheld ?? null, anchorCheck, failedChecks: failed })
    const replayable = completePairs(matched).flatMap((p) => [p.on, p.off])
    return {
      primary, ...v, sentence: verdictSentence(v.verdict, primary, ruleOff), stoppedAt: stop!.look, primaryLanes, failedChecks: failed,
      final: finalItems, finalConcept: paired(matched, diff((d) => final(d)!.total), below),
      briefed: paired(matched, diff((d) => scopeTotal(final(d)!, BRIEFED)), below), foundations: paired(matched, diff((d) => scopeTotal(final(d)!, FOUNDATIONS)), below),
      matcherOnly, volumeMatched, ruleOff, judge, anchorCheck,
      anchorOn: paired(simPairs(data, primaryLanes, 'anchor', 'on'), diff(G), SIM_PREREGISTRATION.inBatchAnchor.pairs),
      /** The identity the versions rest on (design A1): replaying a learner's deliveries reproduces its stored exams. */
      replayIdentity: { learners: replayable.length, reproduced: replayable.filter((d) => replayedExams(d).every((e) => canon(e) === canon(d.exams.find((x) => x.timepoint === e.timepoint)))).length },
    }
  })()

  // The pilot's gates (no outcome is read from the pilot). A null gate counts as a failure.
  // Revision 8.3 (after pilot db59766b, from arm-on grading receipts, no outcome): in session 1 the production grader
  // rightly abstains (null, confidence insufficient) when the learner has shown nothing citable. The gate is null (fails)
  // unless every arm-on learner has at least 2 graded sessions; otherwise it holds when, for every arm-on learner,
  // (a) every recorded grading of every graded session, main and replicates, is settled (completed, failed, no_evidence
  // or unchanged; a reservation never recorded, a pending or a refused grading is not), and a session that recorded a
  // grading has at least one completed one, and (b) from session 2 on, the session has at least one non-null reading.
  // A session whose concepts were all skipped for no new evidence records no grading and passes (a); a lost grading
  // leaves its reservation (status `reserved`), which fails (a).
  const settled = new Set(['completed', 'failed', 'no_evidence', 'unchanged'])
  const onLearners = data.filter((d) => d.config.arm === 'on')
  const bySession = (d: SimLearnerData) => Array.from({ length: d.config.sessions - 1 }, (_, i) => ({ rs: d.readings.filter((r) => r.session === i + 1),
    statuses: [...d.readings, ...(d.replicates ?? [])].filter((r) => r.session === i + 1).map((r) => r.status) }))
  const readingsBySession = Object.fromEntries(onLearners.map((d) => [d.config.learnerId, bySession(d).map(({ rs, statuses }) => ({
    read: rs.filter((r) => r.percent != null).map((r) => r.conceptId).sort(), completed: rs.filter((r) => r.status === 'completed').length,
    failed: rs.filter((r) => r.status === 'failed').length, unchanged: rs.filter((r) => r.status === 'unchanged').length,
    noEvidence: rs.filter((r) => r.status === 'no_evidence').length, unsettled: statuses.filter((x) => !settled.has(x)).length }))]))
  const onReadings = onLearners.length > 0 && onLearners.every((d) => d.config.sessions - 1 >= 2)
    ? onLearners.every((d) => bySession(d).every(({ rs, statuses }, i) => statuses.every((x) => settled.has(x)) && (!rs.length || rs.some((r) => r.status !== 'failed'))
      && (i === 0 || rs.some((r) => r.percent != null))))
    : null
  const echo = learnerEcho(data)
  const { anchorGate: ag, doseGate: dg } = SIM_PREREGISTRATION.pilot
  // C.2, the anchor gate (a pilot only: in the main batch anchor - off is read after the stop): over the first 12 complete
  // anchor/off pairs, the paired t of G >= 1.65 and the mean > 0. Fewer pairs: not computable (fails).
  const anchorPairs = completePairs(simPairs(data, primaryLanes, 'anchor', 'off')).filter((p) => p.pair < ag.pairs)
  const anchorEstimate = paired(anchorPairs, diff(G), ag.pairs)
  // C.4, the dose gate (mechanism only, no exam): the on learners' pooled off-brief delivered share minus their matched
  // off learners' share, in percentage points (rounded to 1e-9, so +3.0 is +3.0). A missing mate fails.
  const doseOf = (ds: SimLearnerData[]) => ds.map(offBrief).reduce((a, b) => ({ delivered: a.delivered + b.delivered, off: a.off + b.off }), { delivered: 0, off: 0 })
  const onPairs = simPairs(primaryCells, primaryLanes)
  const [doseOn, doseOff] = [doseOf(onPairs.map((p) => p.on)), doseOf(onPairs.map((p) => p.off))]
  const diffPp = Math.round(1e11 * (doseOn.off / doseOn.delivered - doseOff.off / doseOff.delivered)) / 1e9
  const gates = {
    anchor: { pairs: anchorPairs.length, estimate: mainSized ? null : anchorEstimate, ok: mainSized ? null : anchorPairs.length >= ag.pairs ? anchorEstimate.t >= ag.minT && anchorEstimate.mean > 0 : null },
    dose: { on: doseOn, off: doseOff, onLearners: onLearners.length, pairs: onPairs.length, diffPp, ok: onPairs.length && onPairs.length === onLearners.length && Number.isFinite(diffPp) ? diffPp >= dg.minDiffPp : null },
    validIds: arms.length && arms.every((arm) => Number.isFinite(mechanism[arm]!.validIdShare)) ? arms.every((arm) => mechanism[arm]!.validIdShare >= 0.95) : null,
    onReadings,
    learnerEcho: echo.ok,
    neverLearns: control.ok,
    channel,
  }
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
  const claim2 = !mainSized || !stopped ? null : {
    gradings: graded.length, withEstimate: graded.filter((r) => r.percent !== null).length,
    promptRevisions: graded.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.promptRevision ?? 'unknown']: (acc[r.promptRevision ?? 'unknown'] ?? 0) + 1 }), {}),
    gainNotifications, priorBlind, blindProbes: blindProbes(data),
    /** Verdict 2a, grader change-tracking on scheduled probes. */
    probeSeries: probeChangeTracking(data),
    /** Verdict 2b's coverage and counted series, printed beside it. */
    liveCoverage: liveCoverage(onPrimary),
    liveSeries: onPrimary.flatMap((d) => (d.changes?.concepts ?? []).map((c) => ({ learnerId: d.config.learnerId, conceptId: c.conceptId, delta: c.delta, deltaSe: c.deltaSe }))),
    // Verdict 2b, the live user's change report (revision 9's computation, unchanged).
    // A rise reported for the never-learns control is a report that rewards talk without knowledge.
    changeVerdict: control.ok === false ? 'inaccurate' : control.ok === null ? 'not computable'
      : changeReportVerdict({ sign: priorBlind.signAgreement, coverage: priorBlind.intervalCoverage, gains: { n: gainNotifications.n - gainNotifications.unknown, falseGains: gainNotifications.falseGains } }),
  }

  // Cost: calls per learner-session by role (the judge's receipts included), tokens and wall time per call; `retried`
  // counts calls paid more than once.
  const calls = [...all.flatMap((d) => d.calls), ...(opts.judgeCalls ?? [])]
  const sessions = all.reduce((n, d) => n + d.config.sessions, 0)
  const cost = {
    /** Review 10 B1: the call cap of the run's record (learning_sim_learners), null when unrecorded or uncapped. */
    cap: data[0]?.config.run?.maxCalls ?? null,
    calls: calls.length, sessions,
    // Paid invocations per call key, minus 1: the pilot's retry share, which sizes the main batch's cap (stopping rule).
    retryShare: calls.length ? calls.reduce((n, c) => n + c.invocations, 0) / calls.length - 1 : NaN, modelSeconds: calls.reduce((n, c) => n + c.durationMs, 0) / 1000,
    byRole: Object.fromEntries([...new Set(calls.map((c) => c.role))].sort().map((role) => { const cs = calls.filter((c) => c.role === role)
      return [role, { calls: cs.length, perSession: cs.length / Math.max(1, sessions), meanSeconds: mean(cs.map((c) => c.durationMs / 1000)), inputTokens: cs.reduce((n, c) => n + (c.inputTokens ?? 0), 0), outputTokens: cs.reduce((n, c) => n + (c.outputTokens ?? 0), 0), retried: cs.filter((c) => c.attempts > 1).length, models: [...new Set(cs.map((c) => `${c.model}/${c.effort}`))] }] })),
  }
  return { preregistration: SIM_PREREGISTRATION, learners: all.length, complete: all.filter(isComplete).length, pilot: !mainSized, mechanism, checks, sequential: mainSized ? { ...sequential, failedChecks: failed } : null, outcome, gates, gateFailures: pilotGateFailures(gates), echo, readingsBySession, memory, claim2, cost }
}
type SimReport = ReturnType<typeof analyzeSimRun>

const f = (x: number, d = 1) => Number.isFinite(x) ? x.toFixed(d) : 'n/a'
const est = (e: Estimate) => `${f(e.mean)} [${f(e.lo)}, ${f(e.hi)}] (n=${e.n})`
/** The fixed blocks every revision-10 report prints first (design B, D.4, D.10, E): revision 9's verdict verbatim, the
 * erratum, the configurations tested, the lead's decisions, the disclosures and the simulator's reading. */
function fixedBlocks(p: typeof SIM_PREREGISTRATION) {
  const h = p.history
  return [
    '## Earlier confirmatory verdicts (fixed block)', '', `Revision 9, run ${h.revision9.runId}, verbatim:`, '', h.revision9.verdictLine, '', h.erratum, '',
    ...h.confirmatoryVerdicts.map((x) => `- ${x}`), `- hook configurations tested so far: ${h.configurationsTested} (${h.configurations})`, '',
    `> ${p.scope}`, '', `> ${p.labelContradiction}`, '', `> ${p.foundationFirst}`, '', `> ${p.givenUp}`, '',
    `**The lead's decisions.** ${p.decisions.note}`, ...p.decisions.items.map((x) => `- ${x}`), '',
    `**Disclosure.** ${h.estimands}`, '', h.ownerSpeed, '',
    '| change | evidence | predicted direction for `on` |', '|---|---|---|', ...h.directions.map((x) => `| ${x.change} | ${x.evidence} | ${x.direction} |`), '', h.directionsReading, '',
    '| policy (simulator, A-full, compliance 0.6) | what it does | AUC d/sd vs off | AUC points |', '|---|---|---|---|', ...h.simulator.map((x) => `| ${x.policy} | ${x.does} | ${x.dsd} | ${x.points} |`), '',
    h.simulatorReading, '', h.proves, '',
    `**The dose gate is a weak screen:** ${p.pilot.doseGate.revision9}.`, '',
    '| guidance compliance | P(dose gate passes) | P(main batch supported) | P(supported), whole programme |', '|---|---|---|---|',
    ...p.pilot.programme.map((x) => `| ${x.compliance} | ${x.dosePasses} | ${x.mainSupported} | ${x.programme} |`), '', h.programmeStop, '',
  ]
}

/** The report: the fixed blocks, the iteration log, the pre-registration, mechanism, checks, gates, the looks, then the
 * outcome (after the stop only), claim 2 and the cost. `iterationLog`: lines built from the database (simIterationLog). */
export function renderSimReport(runId: string, b: SimReport, iterationLog: string[] = []): string {
  const p = b.preregistration
  const pct = (x: number) => Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : 'n/a'
  const yes = (x: boolean | null) => x === null ? 'NOT COMPUTABLE (fails)' : x ? 'pass' : 'FAIL'
  const pest = (e: PairedEstimate) => `${f(e.mean, 2)} [95%: ${f(e.lo, 2)}, ${f(e.hi, 2)}; 90%: ${f(e.lo90, 2)}, ${f(e.hi90, 2)}] (${e.pairs} pairs, ${e.lanes} lanes; t ${f(e.t, 2)}, df ${e.df}, one-sided p ${Number.isFinite(e.p) ? e.p.toPrecision(2) : 'n/a'})`
  const lookLine = (l: { look: number; plannedPairs: number; decision: string; nominalP: number }) => `look ${l.look} at ${l.plannedPairs} pairs (boundary p ≤ ${l.nominalP.toPrecision(3)}): ${l.decision}`
  const g = b.gates, o = b.outcome
  return [`# Simulated-learner run ${runId} (revision ${p.revision})`, '', ...fixedBlocks(p),
    '## Iteration log (by query, design E.3)', '', `\`${p.iterationLogQuery}\``, '', ...(iterationLog.length ? iterationLog : ['- (no run returned)']), '',
    '## Pre-registration', '',
    `Learners: ${b.learners} (${b.complete} complete). Pre-registered before the first call (the run record on every learner).`, '',
    `- Primary: ${p.primary.estimand} ${p.primary.interval}`, `- Gatekeeping: ${p.primary.gatekeeping.text}`, `- Verdict: ${p.primary.verdict}`, `- ${p.primary.sentence}`,
    `- ${p.primary.interim} ${p.primary.incomplete}`, `- Lanes: ${p.primary.lanes}`, `- Alpha: ${p.primary.sequential.alpha} ${p.primary.sequential.boundary}`,
    `- Power: ${p.primary.power}`, `- Calls: ${p.primary.sequential.expectedCalls} ${p.primary.sequential.capFloor.text}`, `- ${p.primary.sequential.oneStart}`, `- Iterations: ${p.pilot.iterations}`,
    `- Sensitivity: ${p.sensitivity.versions.join(' ')} ${p.sensitivity.withhold} ${p.sensitivity.reporting}`, `- Judge: ${p.sensitivity.judge}`, `- Judge mechanics: ${p.sensitivity.judgeMechanics}`,
    `- Decomposition: ${p.decomposition}`, `- ${p.inBatchAnchor.text}`, `- ${p.secondary.join(' ')}`,
    `- Claim 2: ${p.claim2.verdict2a} ${p.claim2.probeDraw} ${p.claim2.verdict2b} ${p.claim2.prediction}`, '',
    '### 1. Mechanism checks (before the outcome; from the channel\'s record, not the agent\'s report)', '',
    '| arm | dose on targeted concepts | dose on the rest | off-brief delivered | facts delivered / budget | delivered already right | last-exam misses delivered | influence turns | review turns | redacted sentences | unoffered | over budget | valid claimed ids | claims the matcher confirms | paths matched / claimed / attributed |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...Object.entries(b.mechanism).map(([arm, m]) => `| ${arm} | ${f(m.targetedDose, 2)} (${m.targetedCells}) | ${f(m.otherDose, 2)} (${m.otherCells}) | ${pct(m.offBriefShare)} | ${m.stated} / ${m.budget} (${pct(m.budgetUsed)}) | ${pct(m.alreadyRightShare)} | ${pct(m.restatement)} of ${m.misses} | ${m.influenceTurns}/${m.turns} | ${m.reviewTurns} | ${m.redacted} | ${m.unoffered} | ${m.overBudget} | ${pct(m.validIdShare)} | ${pct(m.claimedConfirmed)} | ${pct(m.pathShares.matched!)} / ${pct(m.pathShares['matched-claimed']!)} / ${pct(m.pathShares.attributed!)} |`), '',
    'Dose is delivered facts per concept-session. Arm off is read on the concept-sessions arm on targeted for learners with the same lane and task order.',
    ...(o ? [] : ['Before the stop (and in a pilot), "delivered already right" and "last-exam misses delivered" are pooled over arms: by arm they would show each arm\'s interim exam level.']), '',
    '| arm | forgotten per session | strengthened (spacing) | not absorbed (prerequisite) | over capacity |', '|---|---|---|---|---|',
    ...Object.entries(b.memory).map(([arm, m]) => `| ${arm} | ${f(m.forgotten, 2)} | ${f(m.strengthened, 2)} | ${f(m.unabsorbed, 2)} | ${f(m.overCapacity, 2)} |`), '',
    '### 2. Pre-registered checks (any failure withholds the verdict)', '',
    `- Incompletion balanced within each primary lane, on vs off (≤ 1 apart): ${yes(b.checks.incompletionOk)}; ${Object.entries(b.checks.incompletion).map(([lane, arms]) => `${lane}: ${Object.entries(arms).map(([arm, x]) => `${arm} ${x.incomplete}/${x.assigned}`).join(', ')}`).join('; ')}`,
    `- Held-out concepts targeted by an injection: ${b.checks.heldOutTargeted} (${yes(b.checks.heldOutOk)}); times each concept was held out: ${Object.values(b.checks.holdoutCounts).join(', ')}`,
    `- Frozen code and spec: ${yes(b.checks.integrityOk)}${b.checks.integrity ? ` (${b.checks.integrity.detail})` : ''}`,
    `- The channel gate on every learner (claimed not budgeted ${g.channel.claimedUnaccounted}, over budget read ${g.channel.overBudgetKept}, ${g.channel.turns} turns): ${yes(b.checks.channelOk)}`,
    `- Never-learns control (lane none, arm on; n=${b.checks.neverLearns.n}): notifications ${b.checks.neverLearns.toasts}, concepts risen beyond noise ${b.checks.neverLearns.rises}, aggregate rises ${b.checks.neverLearns.aggregateRises} (all 0) ${yes(b.checks.neverLearns.ok)}. ${p.negativeControl.failure}`, '',
    ...(b.pilot ? ['### Pilot gates (a gate that cannot be computed fails)', '',
      `- C.2 anchor gate (anchor minus off on G, ${g.anchor.pairs} complete pairs of ${p.pilot.anchorGate.pairs}; t ≥ ${p.pilot.anchorGate.minT} and mean > 0): ${g.anchor.estimate ? pest(g.anchor.estimate) : 'n/a'}: ${yes(g.anchor.ok)}`,
      `- C.4 dose gate (off-brief delivered share, on minus matched off, ≥ +${p.pilot.doseGate.minDiffPp} pp): on ${g.dose.on.off}/${g.dose.on.delivered}, off ${g.dose.off.off}/${g.dose.off.delivered}, difference ${f(g.dose.diffPp, 1)} pp: ${yes(g.dose.ok)}${g.dose.ok === false ? `. The shipped guidance is not executed by this agent (dose difference ${f(g.dose.diffPp, 1)} pp): claim 1 stops` : ''}`,
      `- C.5: valid ids ≥ 95% ${yes(g.validIds)}; arm on: ≥ 2 graded sessions, every grading settled (none reserved, pending or refused), not all failed where any was recorded, a non-null reading from session 2 on ${yes(g.onReadings)}; learner echo of the agent (B5) ${yes(g.learnerEcho)}; never-learns control ${yes(g.neverLearns)}; channel ${yes(g.channel.ok)}`,
      `- Failed: ${b.gateFailures.map((x) => `${x.gate} (${x.clause})`).join(', ') || 'none'}. ${p.pilot.echo}`, ''] : []),
    `- Learner echo of the agent (B5): mean share of Sam's introduced words found in the agent's text ${f(b.echo.all.mean, 2)}, share of messages with overlap ≥ 0.7 ${pct(b.echo.all.shareHigh)} (n=${b.echo.all.n}); length-matched ${f(b.echo.lengthMatched.mean, 2)}, ${pct(b.echo.lengthMatched.shareHigh)} (n=${b.echo.lengthMatched.n}). Plain mean overlap, not gated (the owner's messages: 0.21): ${f(b.echo.all.overlapMean, 2)}; length-matched ${f(b.echo.lengthMatched.overlapMean, 2)}`,
    ...Object.entries(b.readingsBySession).map(([id, sessions]) => `- ${id}: per session, gradings completed / failed / unchanged / no evidence / not settled (replicates and reservations included), then the concepts with a reading: ${sessions.map((x, i) => `s${i + 1} ${x.completed}/${x.failed}/${x.unchanged}/${x.noEvidence}/${x.unsettled} read ${x.read.length} (${x.read.map((c) => c.split('--')[1]).join(', ')})`).join('; ')}`), '',
    ...(b.sequential ? ['### Sequential looks', '', `Planned looks at ${b.sequential.looks.join(', ')} pairs; ${b.sequential.scheduledPairs} pairs scheduled, ${b.sequential.completePairs} complete.`, '',
      ...(b.sequential.decisions.length ? b.sequential.decisions.map((l) => `- ${lookLine(l)}`) : ['- no look due yet']), '',
      ...(b.sequential.detail ? b.sequential.detail.map((l) => `- look ${l.look} estimate: ${pest(l.estimate)}`) : [b.sequential.stoppedBy ? `The batch stopped (${b.sequential.stoppedBy}) with the verdict withheld: no between-arm number is shown.` : 'The sequence continues: no between-arm number is shown before it stops.']), ''] : []),
    ...(!o || !b.claim2 ? ['### 3. Outcome and claim 2: not computed', '', b.sequential ? (b.sequential.stoppedBy ? `The batch stopped (${b.sequential.stoppedBy}); the verdict is withheld.` : 'The sequence has not stopped.') : `A run with fewer pairs than the first look (${p.primary.sequential.looks[0]}) is a pilot: it reports mechanism, checks and gates only.`, ''] : [
      '### 3. Outcome', '',
      `**Primary (AUC item-mean G, on minus off, paired, ${o.primaryLanes.join(', ')}; stopped at look ${o.stoppedAt}): ${pest(o.primary)}. Reading: ${o.reading}. Verdict: ${o.verdict}.**`, '',
      `**${o.sentence}**`, '',
      `Gatekeeping (final item-mean E_5, on minus off; needs ≥ 0 and a 95% lower bound > -2): ${pest(o.final)}.`, '',
      `Version (i) matcher-only beside the primary (N4): ${pest(o.matcherOnly)}; signed difference (i) minus primary ${signed(o.matcherOnly.mean - o.primary.mean)}.`,
      `Version (ii) volume-matched: ${pest(o.volumeMatched)}.`,
      `Decomposition, share carried by the prerequisite rule (absorb = 1 on the same deliveries): primary ${signed(o.primary.mean)}, with absorb = 1 ${signed(o.ruleOff.mean)} (${pest(o.ruleOff)}); share carried by the rule ${pct(1 - o.ruleOff.mean / o.primary.mean)}.`,
      `Replay identity: ${o.replayIdentity.reproduced} of ${o.replayIdentity.learners} learners' stored exams reproduced by replaying their deliveries.`, '',
      o.judge ? `Judge (arm-blind, ${o.judge.strata.reduce((n, s) => n + s.n, 0)} delivery items): ${o.judge.strata.map((s) => `${s.arm}/${s.group} ${s.falseDeliveries}/${s.n} false (${pct(s.share)} [${pct(s.lo)}, ${pct(s.hi)}])`).join('; ')}; weighted on ${pct(o.judge.weighted.on)}, off ${pct(o.judge.weighted.off)}, on minus off ${pct(o.judge.weighted.diff)} [${pct(o.judge.weighted.lo)}, ${pct(o.judge.weighted.hi)}]; planted false said yes ${o.judge.planted.falseSaidYes}/6, planted true said no ${o.judge.planted.trueSaidNo}/6.` : 'Judge: not run.', '',
      `In-batch anchor check (anchor minus off on G, pairs 0-${p.inBatchAnchor.pairs - 1}; 90% lower bound > 0): ${pest(o.anchorCheck)}: ${o.anchorCheck.lo90 > 0 ? 'confirmed' : 'NOT CONFIRMED'}.`, '',
      `Withhold rules that fired (N3; a "supported" would be withheld by the first group): ${o.fired.length} — ${o.fired.join('; ') || 'none'}.`, '',
      `Not adjusted for stopping (review 7 S4): the mean estimate when supported, by stop, in simulation: ${p.primary.sequential.stopBias.rows.map((x) => `true ${x.truth}: ${x.whenSupported} overall, ${x.atLook1} at a look-1 stop, ${x.atLook2} at a look-2 stop, naive 95% coverage ${(x.naiveCoverage * 100).toFixed(1)}%`).join('; ')}.`, '',
      `Secondary (no verdict): final concept-mean ${pest(o.finalConcept)}; briefed concepts (${BRIEFED.length}) ${pest(o.briefed)}; foundations (${HALYARD_CATALOG.concepts.length - BRIEFED.length}) ${pest(o.foundations)}.`,
      `Exploratory (no verdict): anchor minus off ${pest(o.anchorCheck)}; anchor minus on ${pest(o.anchorOn)}.`, '',
      '## Claim 2: Learner\'s own measurements against the exam', '',
      `Verdict 2a, grader change-tracking on scheduled probes (pre-registered; each learner's probe user, all arms, the product's masteryChanges against the exact held-share change between the same probe times): **${b.claim2.probeSeries.verdict}**. ${b.claim2.probeSeries.changes} changes from ${b.claim2.probeSeries.learners} learners (${b.claim2.probeSeries.unmatched} unpaired). Sign agreement where the exam moved 25+: ${b.claim2.probeSeries.sign.agree}/${b.claim2.probeSeries.sign.n} (≥ ${pct(p.claim2.changes.signAgreement.min)}, n ≥ ${p.claim2.changes.signAgreement.minN}); 95% interval coverage ${b.claim2.probeSeries.coverage.covered}/${b.claim2.probeSeries.coverage.n} (≥ ${pct(p.claim2.changes.intervalCoverage.min)}, n ≥ ${p.claim2.changes.intervalCoverage.minN}); false gains ${b.claim2.probeSeries.gains.falseGains}/${b.claim2.probeSeries.gains.n - b.claim2.probeSeries.gains.unknown} (≤ ${pct(p.claim2.changes.falseGains.max)}, n ≥ ${p.claim2.changes.falseGains.minN}; ${b.claim2.probeSeries.gains.unknown} undecidable); Spearman ${f(b.claim2.probeSeries.spearman.rho, 2)} [${f(b.claim2.probeSeries.spearman.lo, 2)}, ${f(b.claim2.probeSeries.spearman.hi, 2)}] (lower bound > ${p.claim2.changes.spearman.minLo}, n ≥ ${p.claim2.changes.spearman.minN}; ${Number.isFinite(b.claim2.probeSeries.spearman.lo) ? 'computed' : 'not computable'}).`, '',
      `Verdict 2b, the live user's change report (pre-registered; arm on, primary lane): **${b.claim2.changeVerdict}**. Sign agreement where the exam moved 25+: ${b.claim2.priorBlind.signAgreement.agree}/${b.claim2.priorBlind.signAgreement.n}; 95% interval coverage ${b.claim2.priorBlind.intervalCoverage.covered}/${b.claim2.priorBlind.intervalCoverage.n}; false gains ${b.claim2.gainNotifications.falseGains}/${b.claim2.gainNotifications.n - b.claim2.gainNotifications.unknown} (${b.claim2.gainNotifications.unknown} undecidable).`, '',
      `Coverage of 2b: ${b.claim2.liveCoverage.counted} of ${b.claim2.liveCoverage.conceptSessions} graded concept-sessions have a counted reading (${pct(b.claim2.liveCoverage.share)}). Counted series (concepts with two or more counted readings): ${b.claim2.liveCoverage.series}${b.claim2.liveSeries.length ? `: ${b.claim2.liveSeries.map((x) => `${x.learnerId} ${x.conceptId} ${f(x.delta)} ± ${f(1.96 * x.deltaSe)}`).join('; ')}` : ''}.`, '',
      `Pre-registered, grader level on blind probes: ${b.claim2.blindProbes.n} pairs from ${b.claim2.blindProbes.learners} learners: MAE ${f(b.claim2.blindProbes.mae)} [${f(b.claim2.blindProbes.maeLo)}, ${f(b.claim2.blindProbes.maeHi)}] (a constant reading: ${f(b.claim2.blindProbes.constantMae)}), bias ${f(b.claim2.blindProbes.bias)}, Spearman ${f(b.claim2.blindProbes.spearman, 2)} [${f(b.claim2.blindProbes.rhoLo, 2)}, ${f(b.claim2.blindProbes.rhoHi, 2)}]: **${b.claim2.blindProbes.verdict}**.`, '',
      `EXPLORATORY: gradings ${b.claim2.gradings} (${b.claim2.withEstimate} with an estimate); prompt revisions ${Object.entries(b.claim2.promptRevisions).map(([k, n]) => `\`${k}\` ${n}`).join(', ') || 'none'}. Level: ${b.claim2.priorBlind.measurements} measurements, Pearson ${f(b.claim2.priorBlind.pearson, 2)}, bias ${f(b.claim2.priorBlind.meanBias)}, MAE ${f(b.claim2.priorBlind.meanAbsError)}.`, '',
      '| reading bin (prior-blind) | n | mean reading | mean exam |', '|---|---|---|---|', ...b.claim2.priorBlind.calibration.map((x) => `| ${x.reading} | ${x.n} | ${f(x.meanReading)} | ${f(x.meanExam)} |`), '']),
    '## Cost', '', `Call cap of record: ${b.cost.cap ?? 'none recorded'}.`, '', `${b.cost.calls} calls over ${b.cost.sessions} learner-sessions; ${f(b.cost.modelSeconds / 3600, 2)} model-hours; retry share r = ${f(b.cost.retryShare, 3)} (paid invocations per call key minus 1; the main batch's --max-calls is ceil(K × (1.05 + r))).`, '',
    '| role | calls | per session | mean s | input tokens | output tokens | paid more than once | model |', '|---|---|---|---|---|---|---|---|',
    ...Object.entries(b.cost.byRole).map(([role, x]) => `| ${role} | ${x.calls} | ${f(x.perSession)} | ${f(x.meanSeconds)} | ${x.inputTokens} | ${x.outputTokens} | ${x.retried} | ${x.models.join(', ')} |`), ''].join('\n')
}

type SimRunRecord = NonNullable<SimLearnerConfig['run']>
/** Review 10 S2: the run's record, read from its learners in the database: every learner carries the same one, or
 * there is none (a run recorded before revision 8.5, or learners that disagree). */
export function simRunRecord(configs: Array<Pick<SimLearnerConfig, 'run'>>): SimRunRecord | null {
  const first = configs[0]?.run
  return first && configs.every((c) => canon(c.run) === canon(first)) ? first : null
}

/** The integrity of --analyze-only and of every sequential look, from the database record alone. `changed`: the
 * frozen paths changed since the record's commit (empty for a stub run, whose looks run from a working tree). A real
 * run's record must name the pre-registered looks (review 9 B1'). */
export function simRecordIntegrity(data: Array<{ config: Pick<SimLearnerConfig, 'run'> }>, o: { stub: boolean; changed: string[]; unreadable?: string; head: string }) {
  const run = simRunRecord(data.map((d) => d.config))
  if (!run) return { ok: false, detail: 'the learners carry no common run record (recorded before revision 8.5, or they differ)' }
  // Review RC1: a frozen tree git cannot compare with the record fails integrity, never passes it.
  if (o.unreadable) return { ok: false, detail: `recorded at ${run.commit.slice(0, 8)}; the frozen tree cannot be checked: ${o.unreadable}` }
  const looksMoved = !o.stub && JSON.stringify(run.looks) !== JSON.stringify(SIM_PREREGISTRATION.primary.sequential.looks)
  return { ok: !o.changed.length && !looksMoved,
    detail: `recorded at ${run.commit.slice(0, 8)}; analysed at ${o.head.slice(0, 8)}; frozen paths changed since: ${o.changed.join(', ') || 'none'}${looksMoved ? '; looks differ from the pre-registered ones' : ''}` }
}

/** Review 9 B1', review 10 S5: whether a run's learners may be read or run by this process. A stub process takes only
 * stub learners, a real one only codex learners. */
export function simTransportRefusal(transports: string[], stub: boolean): string | null {
  const other = [...new Set(transports.filter((t) => t !== (stub ? 'stub' : 'codex')))]
  return other.length ? `the run has ${other.join(', ')} learners; this invocation is ${stub ? '--stub' : 'a real run'}` : null
}

/** Review 10 B1, S2: what a start or resume must match. The learners already in the database must equal this
 * invocation's (their run record included), and every one of them must be in it. Returns what differs. */
export function simRunDifferences(stored: SimLearnerConfig[], now: SimLearnerConfig[]): string[] {
  const byId = new Map(now.map((c) => [c.learnerId, c]))
  const out = new Set<string>()
  for (const c of stored) {
    const n = byId.get(c.learnerId)
    if (!n) { out.add('learners'); continue }
    for (const k of new Set([...Object.keys(c), ...Object.keys(n)]) as Set<keyof SimLearnerConfig>) {
      if (k === 'run' && c.run && n.run) { for (const r of Object.keys({ ...c.run, ...n.run }) as Array<keyof SimRunRecord>) if (canon(c.run[r]) !== canon(n.run[r])) out.add(`run.${r}`) }
      else if (canon(c[k]) !== canon(n[k])) out.add(k)
    }
  }
  return [...out].sort()
}
