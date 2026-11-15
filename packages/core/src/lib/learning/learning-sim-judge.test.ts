import { describe, expect, test } from 'bun:test'
import { ATTRIBUTION_THRESHOLD, EXAM_FACTS, factsIn, type DeliveryPath } from './learning-sim-matcher.js'
import { HALYARD_CATALOG } from './learning-sim-halyard.js'
import { SimLearnerConfig } from './learning-sim-experiment.js'
import { SIM_JUDGE_CALLS, blindItem, judgeView, judgeAnalysis, judgePrompt, judgeSample, type JudgeAnswer, type JudgeSample } from './learning-sim-judge.js'
import type { SimLearnerData } from './learning-sim-analysis.js'

const RUN = '00000000-0000-4000-8000-0000000000a6'
type Turn = SimLearnerData['agentTurns'][number]
/** A fast-lane learner whose turn k delivers `turns[k].factId` on its path, in `turns[k].text`. */
const custom = (arm: 'on' | 'off', i: number, turns: Array<{ text: string; factId: string; path: DeliveryPath }>, lane: 'fast' | 'slow' = 'fast'): Pick<SimLearnerData, 'config' | 'agentTurns'> => ({
  config: SimLearnerConfig.parse({ runId: RUN, learnerId: `l3${String(i).padStart(3, '0')}`, arm, lane, sessions: 5, turns: 3, transport: 'stub',
    learnerModel: { model: 'm', effort: 'low', timeoutSec: 1 }, agentModel: { model: 'm', effort: 'low', timeoutSec: 1 }, heldOut: [], taskOrder: [0, 1, 2, 3, 4], factBudget: 8, dayGap: 1, pair: i }),
  agentTurns: turns.map(({ text, factId, path }, k): Turn => ({ session: 1 + Math.floor(k / 3), turn: 1 + (k % 3), decision: 'none', conceptIds: [], statedFactIds: [factId], invalidFacts: 0, review: null,
    claimedFactIds: [], unofferedFacts: [], overBudgetFacts: [], redacted: 0, statedFacts: [{ factId, path }], text })),
})
/** One fast-lane learner whose turn k delivers EXAM_FACTS[(offset + k) % 60] verbatim, on `paths[k]`. */
const learner = (arm: 'on' | 'off', i: number, paths: DeliveryPath[], offset = i * 7, lane: 'fast' | 'slow' = 'fast') => custom(arm, i, paths.map((path, k) => {
  const f = EXAM_FACTS[(offset + k) % EXAM_FACTS.length]!
  return { text: `Here is the plan. ${f.fact}`, factId: f.id, path }
}), lane)
const paths = (matched: number, claimed: number, attributed: number): DeliveryPath[] => [...Array(matched).fill('matched'), ...Array(claimed).fill('matched-claimed'), ...Array(attributed).fill('attributed')]
/** on: matcher 60 (30 + 30), attributed 20 (short: its 16 go to on's matcher); off: matcher 60, attributed 50. Plus
 * a slow-lane learner, which is never sampled. */
const fixture = (on: 'on' | 'off' = 'on', off: 'on' | 'off' = 'off') => [
  learner(on, 1, paths(15, 20, 10)), learner(on, 2, paths(15, 10, 10)),
  learner(off, 3, paths(20, 10, 25)), learner(off, 4, paths(10, 20, 25)),
  learner('on', 5, paths(30, 0, 30), 0, 'slow'),
]

describe('the blind delivery judge: the sample (design D.6, work order P6)', () => {
  test('strata of 36 by arm x path group; a short attributed stratum is taken whole and its remainder goes to the same arm\'s matcher stratum; 6 + 6 planted pairs', () => {
    const { items } = judgeSample(RUN, fixture())
    const count = (arm: string, group: string) => items.filter((x) => x.kind === 'delivery' && x.arm === arm && x.group === group).length
    expect({ onMatcher: count('on', 'matcher'), onAttributed: count('on', 'attributed'), offMatcher: count('off', 'matcher'), offAttributed: count('off', 'attributed') })
      .toEqual({ onMatcher: 52, onAttributed: 20, offMatcher: 36, offAttributed: 36 })
    expect(items.filter((x) => x.kind === 'planted-false').length).toBe(6)
    expect(items.filter((x) => x.kind === 'planted-true').length).toBe(6)
    expect(items.length).toBe(SIM_JUDGE_CALLS)
    expect(SIM_JUDGE_CALLS).toBe(156)
    expect(items.map((x) => x.index)).toEqual(items.map((_, k) => k))
    // Only fast on/off learners are sampled; no delivery is drawn twice.
    expect(items.every((x) => x.kind !== 'delivery' || x.learnerId !== 'l3005')).toBe(true)
    const keys = items.filter((x) => x.kind === 'delivery').map((x) => x.kind === 'delivery' && `${x.learnerId}|${x.session}|${x.turn}|${x.factId}`)
    expect(new Set(keys).size).toBe(keys.length)
    // The matcher group is matched + matched-claimed; the item is the window the delivered text states the fact in.
    expect(new Set(items.flatMap((x) => (x.kind === 'delivery' && x.group === 'matcher' ? [x.path] : [])))).toEqual(new Set(['matched', 'matched-claimed']))
    for (const x of items.filter((y) => y.kind === 'delivery')) expect(x.sentence).toBe(`Here is the plan. ${x.fact}`)
    // Planted true: a sheet fact with its own verbatim sentence; planted false: a real delivered sentence with a fact of another concept.
    const concept = new Map(EXAM_FACTS.map((f) => [f.id, f.conceptId]))
    for (const x of items.filter((y) => y.kind === 'planted-true')) expect(x.sentence).toBe(x.fact)
    // Over 30 seeds (180 planted false pairs), never a fact of the sentence's own concept.
    for (let k = 0; k < 30; k++) for (const x of judgeSample(`${RUN}|${k}`, fixture()).items.filter((y) => y.kind === 'planted-false')) {
      const real = EXAM_FACTS.find((f) => x.sentence === `Here is the plan. ${f.fact}`)!
      expect(concept.get(x.factId)).not.toBe(real.conceptId)
    }
    // The arm's own path shares, over all its fast deliveries: on 60/80 matcher, off 60/110.
    expect(judgeSample(RUN, fixture()).pathShares).toEqual({ on: { matcher: 60 / 80, attributed: 20 / 80 }, off: { matcher: 60 / 110, attributed: 50 / 110 } })
  })

  test('deterministic for a seed: the same items in the same order whatever the order of the data; another run id draws another sample', () => {
    const a = judgeSample(RUN, fixture())
    expect(judgeSample(RUN, [...fixture()].reverse())).toEqual(a)
    const other = judgeSample('00000000-0000-4000-8000-0000000000b7', fixture().map((d) => ({ ...d, config: { ...d.config, runId: '00000000-0000-4000-8000-0000000000b7' } })))
    expect(other.items.map((x) => x.sentence + x.fact)).not.toEqual(a.items.map((x) => x.sentence + x.fact))
  })

  test('a stratum short in both groups is taken whole: the total is then below 156', () => {
    const { items } = judgeSample(RUN, [learner('on', 1, paths(5, 0, 2)), learner('off', 2, paths(40, 0, 40))])
    expect(items.filter((x) => x.kind === 'delivery' && x.arm === 'on').length).toBe(7)
    expect(items.length).toBe(7 + 72 + 12)
  })

  // Review R3 (M1): the order the judge sees is a seeded permutation, so arm is not confounded with time (drift, capacity).
  test('the items are shuffled: the arms and the planted pairs are interleaved in the judge\'s order', () => {
    const { items } = judgeSample(RUN, fixture())
    const meanIndex = (keep: (x: (typeof items)[number]) => boolean) => { const xs = items.filter(keep).map((x) => x.index); return xs.reduce((a, b) => a + b, 0) / xs.length }
    const on = meanIndex((x) => x.kind === 'delivery' && x.arm === 'on'), off = meanIndex((x) => x.kind === 'delivery' && x.arm === 'off')
    expect(Math.abs(on - off)).toBeLessThan(15)
    expect(meanIndex((x) => x.kind !== 'delivery')).toBeLessThan(110)
  })

  // Review R3 (M13): an attributed delivery is found at its own bar (0.4), where the matcher's 0.6 finds nothing.
  test('an attributed delivery stated at 0.4 but not at 0.6 is judged on the window that states it at 0.4', () => {
    const title = (c: string) => HALYARD_CATALOG.concepts.find((x) => x.id === c)!.title
    const loose = EXAM_FACTS.map((f) => ({ f, text: `${title(f.conceptId)}: ${f.fact.replace(/[.]$/, '').split(' ').filter((_, k) => k % 2 === 0).join(' ')}.` }))
      .find(({ f, text }) => factsIn(text, ATTRIBUTION_THRESHOLD).includes(f.id) && !factsIn(text, 0.6).includes(f.id))!
    const { items } = judgeSample(RUN, [custom('on', 1, [{ text: `Here is the plan. ${loose.text}`, factId: loose.f.id, path: 'attributed' }]), learner('off', 2, paths(3, 0, 0))])
    expect(items.find((x) => x.kind === 'delivery' && x.arm === 'on')).toMatchObject({ group: 'attributed', factId: loose.f.id, sentence: `Here is the plan. ${loose.text}` })
  })

  // Review R3 (M19): a planted false pair never pairs a window with a fact it states (here every window states two concepts' facts).
  test('a planted false pair never uses a fact its window states at 0.4, even of another concept', () => {
    const pair = (k: number) => { const a = EXAM_FACTS[k]!, b = EXAM_FACTS.find((f, j) => j > k && f.conceptId !== a.conceptId)!; return { text: `${a.fact} ${b.fact}`, factId: b.id, path: 'matched' as const } }
    const data = [custom('on', 1, [0, 10, 20].map(pair)), custom('off', 2, [30, 40, 50].map(pair))]
    for (let k = 0; k < 100; k++) for (const x of judgeSample(`${RUN}|${k}`, data).items.filter((y) => y.kind === 'planted-false')) {
      expect(factsIn(x.sentence, ATTRIBUTION_THRESHOLD)).not.toContain(x.factId)
    }
  })

  test('the judge never sees the arm: the prompt is the sentence and the fact only, identical when the arm labels are swapped', () => {
    // What the workflow step receives and renders (simJudgePlan -> simJudgeItem): blindItem, the index, sentence and fact only.
    const prompts = (s: JudgeSample) => s.items.map((x) => judgePrompt(blindItem(x)))
    expect(new Set(judgeSample(RUN, fixture()).items.map((x) => Object.keys(blindItem(x)).sort().join()))).toEqual(new Set(['fact,index,sentence']))
    // on and off with identical deliveries: swapping their labels changes no prompt and no order.
    const twin = (a: 'on' | 'off', b: 'on' | 'off') => [learner(a, 1, paths(30, 20, 30), 0), learner(b, 2, paths(30, 20, 30), 0)]
    const swapped = (d: ReturnType<typeof twin>) => d.map((x, k) => ({ ...x, config: { ...x.config, learnerId: `l300${2 - k}` } }))
    expect(prompts(judgeSample(RUN, swapped(twin('off', 'on'))))).toEqual(prompts(judgeSample(RUN, twin('on', 'off'))))
    // rg over the rendered prompts: no run id, learner id, arm, path, stratum or fact id.
    const text = prompts(judgeSample(RUN, fixture())).join('\n')
    for (const banned of [/0000000000a6/, /\bl3\d{3}\b/, /\barm\b/i, /\b(matched|attributed|matcher|planted|stratum)\b/i, /\b[a-z]+(-[a-z]+)*-f\d+\b/, /\boff\b/i]) expect(text).not.toMatch(banned)
    expect(judgePrompt({ sentence: 'S.', fact: 'F.' })).toContain('S.')
  })

  test('P6 R4: sheet ids the agent cites never reach the judge; the sample, its order and its keys are unchanged', () => {
    // The agent cites ids from its sheets, bracketed or bare (rev9: 20 of 651 judge windows). Tag every reply.
    const tagged = fixture().map((d) => ({ ...d, agentTurns: d.agentTurns.map((t) => {
      const f = EXAM_FACTS.find((x) => x.id === t.statedFacts![0]!.factId)!
      return { ...t, text: `Here is the plan [${f.id}]. ${f.fact.replace(/\.$/, '')} (see ${f.id}, ${f.conceptId}).` }
    }) }))
    const plain = judgeSample(RUN, fixture()), withIds = judgeSample(RUN, tagged)
    // The stored windows keep the ids (the matcher and the reply are untouched); only the judge's view drops them.
    expect(withIds.items.some((x) => x.sentence.includes('[') )).toBe(true)
    const text = withIds.items.map((x) => judgePrompt(blindItem(x))).join('\n')
    for (const f of EXAM_FACTS) { expect(text).not.toContain(f.id); expect(text).not.toContain(f.conceptId) }
    expect(text).not.toMatch(/\[\s*\]|\(\s*(see)?[\s,]*\)/)
    // Same draws: every index has the same kind, stratum and fact as without the ids, so the judge:<i> keys are the same.
    const key = (s: JudgeSample) => s.items.map((x) => [x.index, x.kind, x.factId, x.kind === 'delivery' ? `${x.arm}/${x.group}/${x.learnerId}/${x.session}/${x.turn}` : ''].join())
    expect(key(withIds)).toEqual(key(plain))
    expect(blindItem({ index: 0, kind: 'planted-true', sentence: 'An epoch [keel-key-f3] starts at 1 (keel-key-f3, keel-key-f2).', fact: 'F.', factId: 'keel-key-f3' }).sentence)
      .toBe('An epoch starts at 1.')
    // Review notes: only ids, and brackets that held nothing but ids, are removed. Text without an id is returned byte
    // for byte, in every arm alike: empty or "see" brackets, newlines and double spaces stay.
    for (const plain of ['Keep () and [ ] and (see) here.', 'Line one.\nLine two  with two spaces .', '(see the notes) [SEE]', '  Leading spaces stay.'])
      expect(judgeView(plain)).toBe(plain)
    // An id glued to a word character, or followed by one, is not an id (J1); case does not hide one.
    expect(judgeView('xkeel-key-f1 and keel-key-f1x and keel-key-f1_a stay.')).toBe('xkeel-key-f1 and keel-key-f1x and keel-key-f1_a stay.')
    expect(judgeView('KEEL-KEY-F1 says the epoch starts at 1 [Keel-Key-F2].')).toBe('says the epoch starts at 1.')
    expect(judgeView('Mixed (see keel-key-f1 and the notes).')).toBe('Mixed (see and the notes).')
    // A sheet fact's own text holds no id: the judge's fact, and a planted true sentence, are unchanged.
    for (const f of EXAM_FACTS) expect(judgeView(f.fact)).toBe(f.fact)
  })
})

describe('the blind delivery judge: the analysis and its withhold rules (design D.6)', () => {
  const sample = judgeSample(RUN, fixture())
  /** The judge's answers: `no` for a delivery with probability `falseShare[arm]` (deterministic by index), right on the planted pairs. */
  const answers = (falseShare: { on: number; off: number }, planted: { falseSays?: JudgeAnswer; trueSays?: JudgeAnswer } = {}): JudgeAnswer[] => sample.items.map((x) => {
    if (x.kind !== 'delivery') return x.kind === 'planted-false' ? planted.falseSays ?? 'no' : planted.trueSays ?? 'yes'
    return (x.index * 0.6180339887) % 1 < falseShare[x.arm] ? 'no' : 'yes'
  })

  test('a judge that agrees with every delivery and the planted pairs withholds nothing', () => {
    const r = judgeAnalysis(RUN, sample, answers({ on: 0, off: 0 }))
    expect(r.withheld).toEqual([])
    expect(r.weighted).toMatchObject({ on: 0, off: 0, diff: 0 })
    expect(r.planted).toEqual({ falseSaidYes: 0, trueSaidNo: 0 })
    expect(r.strata.map((s) => [s.arm, s.group, s.n, s.falseDeliveries])).toEqual([['on', 'matcher', 52, 0], ['on', 'attributed', 20, 0], ['off', 'matcher', 36, 0], ['off', 'attributed', 36, 0]])
    // Wilson 95% at 0 of 36: [0, 0.0964].
    expect(r.strata[2]!.hi).toBeCloseTo(0.0964, 3)
  })

  test('the on-worse rule fires on a planted on-worse sample, and not on the mirror image', () => {
    const worse = judgeAnalysis(RUN, sample, answers({ on: 0.5, off: 0 }))
    expect(worse.withheld).toEqual(['judge: on false-delivery share above off'])
    expect(worse.weighted.lo).toBeGreaterThan(0)
    // The weights are each arm's own path shares: on = 60/80 x its matcher share + 20/80 x its attributed share.
    const share = (arm: string, group: string) => worse.strata.find((s) => s.arm === arm && s.group === group)!.share
    expect(worse.weighted.on).toBeCloseTo((60 / 80) * share('on', 'matcher') + (20 / 80) * share('on', 'attributed'), 12)
    const better = judgeAnalysis(RUN, sample, answers({ on: 0, off: 0.5 }))
    expect(better.withheld).toEqual([])
    expect(better.weighted.hi).toBeLessThan(0)
  })

  test('the planted-pair checks: a yes-to-all judge and a no-to-all judge are untrusted; 2 of 6 wrong is tolerated, 3 is not', () => {
    expect(judgeAnalysis(RUN, sample, sample.items.map(() => 'yes')).withheld).toEqual(['judge untrusted: yes to more than 2 of 6 planted false pairs'])
    expect(judgeAnalysis(RUN, sample, sample.items.map(() => 'no')).withheld).toEqual(['judge untrusted: no to more than 2 of 6 planted true pairs'])
    const plantedFalse = sample.items.filter((x) => x.kind === 'planted-false').map((x) => x.index)
    const wrong = (k: number) => answers({ on: 0, off: 0 }).map((a, i) => (plantedFalse.slice(0, k).includes(i) ? 'yes' : a))
    expect(judgeAnalysis(RUN, sample, wrong(2)).withheld).toEqual([])
    expect(judgeAnalysis(RUN, sample, wrong(3)).withheld).toEqual(['judge untrusted: yes to more than 2 of 6 planted false pairs'])
    // The other side (re-review C3): "no" to planted true pairs, 2 tolerated, 3 not.
    const plantedTrue = sample.items.filter((x) => x.kind === 'planted-true').map((x) => x.index)
    const missed = (k: number) => answers({ on: 0, off: 0 }).map((a, i) => (plantedTrue.slice(0, k).includes(i) ? 'no' : a))
    expect(judgeAnalysis(RUN, sample, missed(2)).withheld).toEqual([])
    expect(judgeAnalysis(RUN, sample, missed(3)).withheld).toEqual(['judge untrusted: no to more than 2 of 6 planted true pairs'])
  })

  test('a missing answer withholds (the judge did not finish)', () => {
    const partial: Array<JudgeAnswer | undefined> = answers({ on: 0, off: 0 })
    partial[5] = undefined
    expect(judgeAnalysis(RUN, sample, partial).withheld).toEqual(['judge incomplete: 1 of 156 items unanswered'])
  })

  // Review R1: only "yes" and "no" are answers. Anything else (a case variant, a failed item's null, R2) is unanswered,
  // never counted as "yes".
  test('an answer outside {yes, no} is unanswered, never a yes', () => {
    const odd = answers({ on: 0, off: 0 }).map((a, i) => (sample.items[i]!.kind === 'planted-false' ? 'Yes' : sample.items[i]!.kind === 'delivery' && i % 50 === 0 ? null : a))
    const r = judgeAnalysis(RUN, sample, odd)
    const n = odd.filter((a) => a !== 'yes' && a !== 'no').length
    expect(r.withheld).toEqual([`judge incomplete: ${n} of 156 items unanswered`])
    expect(r.planted.falseSaidYes).toBe(0)
  })

  // Review R3 (M8): the interval is a real bootstrap: a small positive difference whose interval spans 0 withholds nothing.
  test('a small on-worse difference whose interval spans 0 withholds nothing', () => {
    const r = judgeAnalysis(RUN, sample, answers({ on: 0.1, off: 0.05 }))
    expect(r.weighted.diff).toBeGreaterThan(0)
    expect(r.weighted.lo).toBeLessThan(0)
    expect(r.withheld).toEqual([])
  })
})
