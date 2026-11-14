import { LearningPolicySettings } from '@learner/contract/learning/learning-policy.js'
import { prerequisitePolicy, selectPrerequisites } from './learning-prerequisite-selection.js'
import { factBudget, stratifiedHoldout, williamsRow } from './learning-sim-design.js'
import { HALYARD_CATALOG, HALYARD_EDGES, HALYARD_TASKS } from './learning-sim-halyard.js'
import { EXAM_FACTS } from './learning-sim-matcher.js'
import { HALYARD_GRAPH, MEMORY_RULES, SIM_LANES, heldExam, seeded, updateHeld, type Held, type MemoryRules, type SimLane } from './learning-sim-memory.js'

/**
 * The no-model simulator (docs/specs/simulated-learner-experiment.md, "Ceiling and sensitivity"; design rev10 C.1,
 * D.10, D.11): the same briefs, budget, capacity and memory rule as a run (`updateHeld`, the run's own implementation)
 * and the run's exam (a held fact scores 2). Each session a policy makes a plan of sheet facts; the agent states each
 * planned fact with probability `compliance`, then fills the budget with facts of the brief's concepts at random (each
 * slot a random fact of a direct prerequisite instead, with probability 0.1). `off` has no plan.
 *
 * Policies; all plan by the product's graph (HALYARD_EDGES), a fact list concatenated by concept, sheet order:
 * - anchor: `anchorPlan`, the anchor arm's own directive, from the true held facts after the previous session.
 * - hook: the shipped default's proxy: the product's `selectPrerequisites` under the default policy, on simulated
 *   readings (from session 2, each concept read with probability 0.7, at its true held share + N(6, 17)), then the
 *   brief's non-held-out concepts.
 * - static: the hook proxy with no readings ever (the like-for-like static prerequisite-first prompt).
 * - nudge: one fact of a random direct prerequisite of the brief, no readings.
 * - placebo: one fact of a random concept that is neither in the brief nor an ancestor of it.
 * - omniscient (the upper bound, always followed): reads the held facts and knows the rules; any concept; greedy on
 *   expected exam points at the final exam (new facts with prerequisites held, then reviews whose survival gain is
 *   larger), shortest facts first within capacity.
 * Simulator rows only: no run has a hook-proxy, static, nudge or placebo arm.
 */
export const CEILING_POLICIES = ['off', 'anchor', 'hook', 'static', 'nudge', 'placebo', 'omniscient'] as const
export type CeilingPolicy = (typeof CEILING_POLICIES)[number]
/** The design's planning compliance (rev10 D.10, `grid6.py`): the anchor directive 0.8, every other plan 0.6. */
export const DESIGN_COMPLIANCE: Partial<Record<CeilingPolicy, number>> = { anchor: 0.8, hook: 0.6, static: 0.6, nudge: 0.6, placebo: 0.6 }
const SESSIONS = 5
const concepts = HALYARD_CATALOG.concepts.map((c) => c.id)
type Sheet = (conceptId: string) => ReadonlyArray<{ id: string; fact: string }>
const SHEET: Sheet = (c) => EXAM_FACTS.filter((f) => f.conceptId === c)
/** Every direct and indirect prerequisite of `c`, foundations first. */
const ancestors = (c: string): string[] => [...new Set(HALYARD_GRAPH.prerequisites(c).flatMap((p) => [...ancestors(p), p]))]

/**
 * The anchor arm's directive (design C.1), and the simulator's `anchor` policy: one implementation. From the facts
 * held after the previous session (`held`) and the graph, in order:
 * 1. the direct and indirect prerequisites of the brief's non-held-out concepts that are neither named nor held out
 *    and have no held fact: at most 2 concepts, foundations first, at most 2 unheld facts each;
 * 2. the brief's non-held-out concepts' unheld facts;
 * 3. their held facts (review);
 * in sheet order (never by length), truncated to `budgetLeft`.
 */
export function anchorPlan(input: { named: readonly string[]; heldOut: Iterable<string>; held: Held; budgetLeft: number }, sheet: Sheet = SHEET): string[] {
  const heldOut = new Set(input.heldOut), live = input.named.filter((c) => !heldOut.has(c))
  const unheld = (c: string) => sheet(c).map((f) => f.id).filter((id) => !(id in input.held))
  const prerequisites = [...new Set(live.flatMap(ancestors))]
    .filter((c) => !input.named.includes(c) && !heldOut.has(c) && !sheet(c).some((f) => f.id in input.held)).slice(0, 2)
  return [...new Set([...prerequisites.flatMap((c) => unheld(c).slice(0, 2)), ...live.flatMap(unheld),
    ...live.flatMap((c) => sheet(c).map((f) => f.id).filter((id) => id in input.held))])].slice(0, Math.max(0, input.budgetLeft))
}

const EDGES = HALYARD_EDGES.map(([from, to]) => ({ from, to, kind: 'hard-prerequisite' }))
const SHIPPED = prerequisitePolicy(LearningPolicySettings.parse({}))
/** The hook proxy's plan: the product's prerequisite selection (shipped default policy) on `scores`, then the brief's
 * non-held-out concepts, each concept's sheet whole, truncated to `budget`. */
export function hookPlan(named: readonly string[], heldOut: readonly string[], scores: ReadonlyMap<string, number>, budget: number, sheet: Sheet = SHEET): string[] {
  const live = named.filter((c) => !heldOut.includes(c))
  const { foundations } = selectPrerequisites({ targets: live, catalogIds: concepts, edges: EDGES, scores: new Map(scores), suppressed: new Set(heldOut) }, SHIPPED)
  return [...new Set([...foundations.map((f) => f.conceptId), ...live])].flatMap((c) => sheet(c).map((f) => f.id)).slice(0, budget)
}
/** The static prerequisite-first prompt: the hook proxy with no reading. */
export const staticPlan = (named: readonly string[], heldOut: readonly string[], budget: number, sheet: Sheet = SHEET) => hookPlan(named, heldOut, new Map(), budget, sheet)

type Prerequisites = (conceptId: string) => string[]
/** The world's prerequisite graph when it is NOT the product's: every edge keeps its dependent, its prerequisite is
 * drawn (seeded) from the other concepts. The rules absorb by this graph; the policies still plan by the product's. */
const perturbed: Prerequisites = (() => {
  const r = seeded('ceiling:perturbed-graph')
  const edges = HALYARD_EDGES.map(([, to]) => { const others = concepts.filter((c) => c !== to); return [others[Math.floor(r() * others.length)]!, to] as const })
  return (c: string) => [...new Set(edges.filter(([, to]) => to === c).map(([from]) => from))]
})()

function omniscient(lane: SimLane, session: number, nb: Held, rules: MemoryRules, world: Prerequisites): string[] {
  const have = new Set(Object.keys(nb)), held = new Set([...have].map(HALYARD_GRAPH.conceptOf))
  const survive = (str: number) => Array.from({ length: SESSIONS - session }, () => 1 - rules.forget[lane] * rules.spacing ** str).reduce((a, b) => a * b, 1)
  const options = [
    ...EXAM_FACTS.filter((f) => !have.has(f.id)).map((f) => ({ f, value: (world(f.conceptId).every((p) => held.has(p)) ? 1 : rules.prerequisiteAbsorb) * survive(0) })),
    ...EXAM_FACTS.filter((f) => have.has(f.id)).map((f) => ({ f, value: (1 - rules.forget[lane] * rules.spacing ** nb[f.id]!) * (survive(nb[f.id]! + 1) - survive(nb[f.id]!)) })),
  ].sort((a, b) => b.value - a.value || a.f.fact.length - b.f.fact.length)
  const out: string[] = []
  let chars = 0
  for (const o of options) {
    if (out.length >= factBudget(lane)) break
    if (!have.has(o.f.id) && chars + o.f.fact.length > SIM_LANES[lane].capacity) continue
    if (!have.has(o.f.id)) chars += o.f.fact.length
    out.push(o.f.id)
  }
  return out
}

/** The design's agent (D.11): each planned fact stated with probability `compliance`, the rest of the budget filled
 * with random facts of the brief's concepts, each slot a random direct-prerequisite fact with probability 0.1. */
function deliver(plan: string[], named: readonly string[], compliance: number, K: number, r: () => number): string[] {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
  const taught = plan.filter(() => r() < compliance)
  const pool = named.flatMap((c) => SHEET(c).map((f) => f.id)).filter((id) => !taught.includes(id))
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!] }
  const fill: string[] = []
  for (const id of pool) {
    if (fill.length >= K - taught.length) break
    const prerequisite = r() < 0.1 ? named.flatMap(HALYARD_GRAPH.prerequisites).flatMap((p) => SHEET(p).map((f) => f.id)).filter((g) => !taught.includes(g) && !fill.includes(g)) : []
    fill.push(prerequisite.length ? pick(prerequisite) : id)
  }
  return [...new Set([...taught, ...fill])].slice(0, K)
}

/** A normal draw (Box-Muller) from the stream `r`. */
const gauss = (r: () => number, mu: number, sd: number) => mu + sd * Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())

type SimOptions = { rules?: MemoryRules; world?: Prerequisites; compliance?: number }
/** One simulated learner: Williams row `k`, holdout block `k`, memory draws keyed by `${seed}|l${k}` (shared by every
 * policy: common random numbers), its agent's own stream. The item-mean exam after each session, its mean (AUC) and the last. */
export function simulateLearner(policy: CeilingPolicy, lane: SimLane, k: number, seed: string, o: SimOptions = {}) {
  const rules = o.rules ?? MEMORY_RULES, world = o.world ?? HALYARD_GRAPH.prerequisites, compliance = policy === 'omniscient' ? 1 : o.compliance ?? 1
  const graph = { ...HALYARD_GRAPH, prerequisites: world }, K = factBudget(lane), r = seeded(`${seed}|l${k}|${policy}|agent`)
  const heldOut = stratifiedHoldout(k, `${seed}:holdout`)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!
  let nb: Held = {}
  const exams: number[] = []
  for (let s = 1; s <= SESSIONS; s++) {
    const named = HALYARD_TASKS[williamsRow(k)[s - 1]!]!.named, live = named.filter((c) => !heldOut.includes(c))
    const readings = () => new Map(s < 2 ? [] : concepts.filter(() => r() < 0.7).map((c) => [c, 100 * SHEET(c).filter((f) => f.id in nb).length / SHEET(c).length + gauss(r, 6, 17)] as const))
    const direct = live.flatMap(HALYARD_GRAPH.prerequisites).filter((p) => !named.includes(p) && !heldOut.includes(p))
    const near = new Set([...named, ...named.flatMap(ancestors)]), far = concepts.filter((c) => !near.has(c) && !heldOut.includes(c))
    const plan = policy === 'off' ? []
      : policy === 'anchor' ? anchorPlan({ named, heldOut, held: nb, budgetLeft: K })
      : policy === 'hook' ? hookPlan(named, heldOut, readings(), K)
      : policy === 'static' ? staticPlan(named, heldOut, K)
      : policy === 'nudge' ? (direct.length ? [pick(SHEET(pick(direct))).id] : [])
      : policy === 'placebo' ? (far.length ? [pick(SHEET(pick(far))).id] : [])
      : omniscient(lane, s, nb, rules, world)
    nb = updateHeld(nb, deliver(plan, named, compliance, K, r), lane, `${seed}|l${k}`, s, graph, rules).held
    exams.push(heldExam(s, nb).items)
  }
  return { exams, auc: exams.reduce((a, b) => a + b, 0) / exams.length, final: exams.at(-1)! }
}

const RULE_VARIANTS: Array<{ name: string; rules: MemoryRules; world?: Prerequisites }> = [
  { name: 'all rules', rules: MEMORY_RULES },
  { name: 'forgetting off', rules: { ...MEMORY_RULES, forget: { none: 1, slow: 0, medium: 0, fast: 0 } } },
  { name: 'spacing off', rules: { ...MEMORY_RULES, spacing: 1 } },
  { name: 'prerequisites off', rules: { ...MEMORY_RULES, prerequisiteAbsorb: 1 } },
  { name: 'graph perturbed', rules: MEMORY_RULES, world: perturbed },
]
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
const sd = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1))
/** Per lane, `n` matched learners per policy (learner k of every policy shares its design and memory draws): off's
 * mean final and AUC, and each policy's, with its paired AUC gain over off, the gain's SD and d/sd. Deterministic. */
export function ceilingTable(lanes: SimLane[] = ['fast'], n = 40, o: { rules?: MemoryRules; world?: Prerequisites; compliance?: Partial<Record<CeilingPolicy, number>> } = {}) {
  return lanes.map((lane) => {
    const runs = (p: CeilingPolicy) => Array.from({ length: n }, (_, k) => simulateLearner(p, lane, k, `ceiling:${k}`, { ...o, compliance: o.compliance?.[p] }))
    const off = runs('off')
    const policies = Object.fromEntries(CEILING_POLICIES.filter((p) => p !== 'off').map((p) => {
      const xs = runs(p), gain = xs.map((x, k) => x.auc - off[k]!.auc)
      return [p, { final: mean(xs.map((x) => x.final)), auc: mean(xs.map((x) => x.auc)), aucGain: mean(gain), aucSd: sd(gain), d: mean(gain) / sd(gain) }]
    })) as Record<Exclude<CeilingPolicy, 'off'>, { final: number; auc: number; aucGain: number; aucSd: number; d: number }>
    return { lane, off: { final: mean(off.map((x) => x.final)), auc: mean(off.map((x) => x.auc)) }, policies }
  })
}

if (import.meta.main) {
  const n = Number(process.argv[2] ?? 1000), f = (x: number, d = 2) => x.toFixed(d)
  const policies = CEILING_POLICIES.filter((p) => p !== 'off')
  for (const [label, compliance] of [['design compliance (anchor 0.8, others 0.6)', DESIGN_COMPLIANCE], ['every plan followed (compliance 1)', {}]] as const) {
    console.log(`\nFast lane, ${n} matched learners per policy, ${label}. Cells: AUC item-mean gain over off (d/sd); off's AUC and final in the second column.\n`)
    console.log(`| rules | off AUC / final | ${policies.join(' | ')} |\n|---|---|${policies.map(() => '---|').join('')}`)
    for (const v of RULE_VARIANTS) for (const r of ceilingTable(['fast'], n, { rules: v.rules, world: v.world, compliance }))
      console.log(`| ${v.name} | ${f(r.off.auc, 1)} / ${f(r.off.final, 1)} | ${policies.map((p) => `${f(r.policies[p].aucGain)} (${f(r.policies[p].d)})`).join(' | ')} |`)
  }
}
