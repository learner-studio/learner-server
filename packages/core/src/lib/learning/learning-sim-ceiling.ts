import { factBudget, stratifiedHoldout, williamsRow } from './learning-sim-design.js'
import { BRIEFED, HALYARD_CATALOG, HALYARD_EDGES, HALYARD_TASKS } from './learning-sim-halyard.js'
import { EXAM_FACTS, HALYARD_LENS } from './learning-sim-matcher.js'
import { MEMORY_RULES, SIM_LANES, parseNotebook, seeded, updateNotebook, type MemoryRules, type SimLane, type Strengths } from './learning-sim-memory.js'

/**
 * The no-model simulator (docs/specs/simulated-learner-experiment.md, "Memory rules", ceiling and sensitivity):
 * the same briefs, budget, capacity and memory rules as a run, with a perfect note taker (it writes down exactly the
 * facts stated) and a perfect exam (a fact in the notebook scores 2). It bounds what any teaching policy can gain,
 * and shows how much of that depends on each memory rule.
 *
 * Policies (what the agent chooses to state, `factBudget` facts per session, within the sheets the channel offers):
 * - off: no reading of the learner. The concepts the brief names, interleaved, in sheet order.
 * - oracle: the oracle arm's information: last exam's score per concept, except the learner's held-out concepts.
 *   Prerequisites it scores at 0 first, then the named concept it scores lowest, skipping the share of each sheet the
 *   score says is known. It reaches at most 2 concepts beyond the brief, as the channel's lookups allow.
 * - omniscient: reads the notebook itself and knows the rules; any concept; greedy on expected exam points at the
 *   final exam (new facts with prerequisites held, then reviews whose survival gain is larger), shortest facts first.
 */
type CeilingPolicy = 'off' | 'oracle' | 'omniscient'
const SESSIONS = 5
const concepts = HALYARD_CATALOG.concepts.map((c) => c.id)
const sheet = (c: string) => EXAM_FACTS.filter((f) => f.conceptId === c)
const prereqs = (c: string) => HALYARD_EDGES.filter(([, to]) => to === c).map(([from]) => from)
const ancestors = (c: string): string[] => [...new Set(prereqs(c).flatMap((p) => [...ancestors(p), p]))]
const byText = new Map(EXAM_FACTS.map((f) => [f.fact.toLowerCase(), f.id]))
const known = (nb: string) => new Set(parseNotebook(nb).flatMap((e) => e.facts).map((t) => byText.get(t.toLowerCase())!).filter(Boolean))
export function examOf(nb: string) {
  const k = known(nb)
  const by = Object.fromEntries(concepts.map((c) => [c, Math.round(100 * 2 * sheet(c).filter((f) => k.has(f.id)).length / 16)]))
  return { byConcept: by, total: Math.round(Object.values(by).reduce((a, b) => a + b, 0) / concepts.length), briefed: Math.round(BRIEFED.reduce((a, c) => a + by[c]!, 0) / BRIEFED.length) }
}
const exact = { ...HALYARD_LENS, tag: (note: string) => { const id = byText.get(note.toLowerCase()); return id ? [id] : [] } }
type Prerequisites = (conceptId: string) => string[]
/** The world's prerequisite graph when it is NOT the product's: every edge keeps its dependent, its prerequisite is
 * drawn (seeded) from the other concepts. The rules absorb by this graph; the oracle policy still plans by the
 * product's (HALYARD_EDGES), as arm on and oracle do in a run. */
const perturbed: Prerequisites = (() => {
  const r = seeded('ceiling:perturbed-graph')
  const edges = HALYARD_EDGES.map(([, to]) => { const others = concepts.filter((c) => c !== to); return [others[Math.floor(r() * others.length)]!, to] as const })
  return (c: string) => [...new Set(edges.filter(([, to]) => to === c).map(([from]) => from))]
})()

function choose(policy: CeilingPolicy, lane: SimLane, session: number, named: string[], nb: string, strengths: Strengths, last: Record<string, number> | null, heldOut: string[], rules: MemoryRules, world: Prerequisites) {
  const K = factBudget(lane)
  if (policy === 'off') {
    const lists = named.map(sheet), out = []
    for (let i = 0; out.length < K && i < 8; i++) for (const l of lists) if (out.length < K && l[i]) out.push(l[i]!)
    return out
  }
  if (policy === 'oracle') {
    const score = (c: string) => heldOut.includes(c) || !last ? 0 : last[c] ?? 0
    const pre = [...new Set(named.flatMap(ancestors))].filter((c) => !named.includes(c) && score(c) === 0).slice(0, 2)
    const order = [...pre, ...[...named].sort((a, b) => score(a) - score(b))]
    const out = []
    for (const c of order) {
      const skip = Math.round((score(c) / 100) * 8)
      for (const f of [...sheet(c).slice(skip), ...sheet(c).slice(0, skip)]) if (out.length < K) out.push(f)
    }
    return out
  }
  const have = known(nb), held = new Set([...have].map((id) => HALYARD_LENS.conceptOf(id)))
  const survive = (str: number) => Array.from({ length: SESSIONS - session }, () => 1 - rules.forget[lane] * rules.spacing ** str).reduce((a, b) => a * b, 1)
  const strengthOf = (text: string) => strengths[text.replace(/\s+/g, ' ').trim().toLowerCase()] ?? 0
  const options = [
    ...EXAM_FACTS.filter((f) => !have.has(f.id)).map((f) => ({ f, value: (world(f.conceptId).every((p) => held.has(p)) ? 1 : rules.prerequisiteAbsorb) * survive(0) })),
    ...EXAM_FACTS.filter((f) => have.has(f.id)).map((f) => ({ f, value: (1 - rules.forget[lane] * rules.spacing ** strengthOf(f.fact)) * (survive(strengthOf(f.fact) + 1) - survive(strengthOf(f.fact))) })),
  ].sort((a, b) => b.value - a.value || a.f.fact.length - b.f.fact.length)
  const out = []
  let chars = 0
  for (const o of options) {
    if (out.length >= K) break
    if (!have.has(o.f.id) && chars + o.f.fact.length > SIM_LANES[lane].capacity) continue
    if (!have.has(o.f.id)) chars += o.f.fact.length
    out.push(o.f)
  }
  return out
}

/** One simulated learner: Latin-square row `k`, holdout block `k`, its own forgetting seed. Final exam total. */
export function simulateLearner(policy: CeilingPolicy, lane: SimLane, k: number, seed: string, rules: MemoryRules = MEMORY_RULES, world: Prerequisites = HALYARD_LENS.prerequisites) {
  const lens = { ...exact, prerequisites: world }
  let nb = '', strengths: Strengths = {}, last: Record<string, number> | null = null
  const heldOut = stratifiedHoldout(k, `${seed}:holdout`)
  for (let s = 1; s <= SESSIONS; s++) {
    const task = HALYARD_TASKS[williamsRow(k)[s - 1]!]!
    const stated = choose(policy, lane, s, task.named, nb, strengths, last, heldOut, rules, world)
    const u = updateNotebook(nb, strengths, stated.map((f) => ({ topic: f.conceptId, facts: [f.fact] })), lane, `${seed}|l${k}`, s, new Set(stated.map((f) => f.id)), lens, rules)
    nb = u.text
    strengths = u.strengths
    last = examOf(nb).byConcept
  }
  return examOf(nb)
}

const RULE_VARIANTS: Array<{ name: string; rules: MemoryRules; world?: Prerequisites }> = [
  { name: 'all rules', rules: MEMORY_RULES },
  { name: 'forgetting off', rules: { ...MEMORY_RULES, forget: { slow: 0, medium: 0, fast: 0 } } },
  { name: 'forgetting halved', rules: { ...MEMORY_RULES, forget: { slow: MEMORY_RULES.forget.slow / 2, medium: MEMORY_RULES.forget.medium / 2, fast: MEMORY_RULES.forget.fast / 2 } } },
  { name: 'spacing off', rules: { ...MEMORY_RULES, spacing: 1 } },
  { name: 'spacing halved', rules: { ...MEMORY_RULES, spacing: 1 - (1 - MEMORY_RULES.spacing) / 2 } },
  { name: 'prerequisites off', rules: { ...MEMORY_RULES, prerequisiteAbsorb: 1 } },
  { name: 'prerequisites halved', rules: { ...MEMORY_RULES, prerequisiteAbsorb: 1 - (1 - MEMORY_RULES.prerequisiteAbsorb) / 2 } },
  { name: 'graph perturbed', rules: MEMORY_RULES, world: perturbed },
]
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
/** Mean final exam per policy over `n` learners per lane, and the two gains over off. Deterministic. */
export function ceilingTable(lanes: SimLane[] = ['slow', 'medium'], n = 40, rules: MemoryRules = MEMORY_RULES, world?: Prerequisites) {
  return lanes.map((lane) => {
    const runs = (p: CeilingPolicy) => Array.from({ length: n }, (_, k) => simulateLearner(p, lane, k, `ceiling:${k}`, rules, world))
    const sd = (xs: number[]) => Math.sqrt(xs.reduce((a, x) => a + (x - mean(xs)) ** 2, 0) / (xs.length - 1))
    const [offRuns, oracleRuns, omniRuns] = (['off', 'oracle', 'omniscient'] as const).map(runs)
    const scope = (key: 'total' | 'briefed') => {
      const off = offRuns!.map((x) => x[key]), oracle = oracleRuns!.map((x) => x[key]), omni = omniRuns!.map((x) => x[key])
      return { off: mean(off), oracle: mean(oracle), omniscient: mean(omni), offSd: sd(off), oracleGain: mean(oracle) - mean(off), omniscientGain: mean(omni) - mean(off) }
    }
    return { lane, ...scope('total'), briefed: scope('briefed') }
  })
}

if (import.meta.main) {
  const f = (x: number) => x.toFixed(1)
  console.log('| rules | lane | off (sd) | oracle | omniscient | oracle - off | omniscient - off | briefed 9: off (sd) | oracle - off |\n|---|---|---|---|---|---|---|---|---|')
  for (const v of RULE_VARIANTS) for (const r of ceilingTable(['slow', 'medium', 'fast'], 40, v.rules, v.world))
    console.log(`| ${v.name} | ${r.lane} | ${f(r.off)} (${f(r.offSd)}) | ${f(r.oracle)} | ${f(r.omniscient)} | ${f(r.oracleGain)} | ${f(r.omniscientGain)} | ${f(r.briefed.off)} (${f(r.briefed.offSd)}) | ${f(r.briefed.oracleGain)} |`)
}
