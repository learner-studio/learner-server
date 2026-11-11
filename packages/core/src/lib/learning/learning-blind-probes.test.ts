import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import { PROBE_GUIDANCE, PROBE_ROWS_SQL, probeCandidates, PROBE_MIN_CONCEPTS_PER_ARM, probeDifference, probeDrawn, probeExposure, probeIntervalText, selectProbe, tCritical95, type ProbeArm, type ProbeRow } from './learning-blind-probes.js'
import { probeCoverage, probeSchedule, seededRandom, simulateProbeRows, topicFeedback } from './learning-blind-probes.simulation.js'
import { heldOutConcepts } from './learning-concept-holdout.js'
import { injectionCoin } from './learning-intervention-policy.js'
import { LIVE_CATALOG } from './learning-live-catalog.js'
import { prerequisitePolicy } from './learning-prerequisite-selection.js'
import { taskTeachingContext } from './learning-teaching-default.js'

const catalog = LIVE_CATALOG.map((c) => ({ id: c.id, title: c.title }))
const catalogIds = catalog.map((c) => c.id)
const held = heldOutConcepts(LIVE_CATALOG)
const taught = catalogIds.filter((id) => !held.has(id))
const heldIds = [...held]
/** A turn id whose uniform pick lands on `conceptId` for this turn and graph (and that draws a probe at any rate above 0). */
const turnPicking = (conceptId: string, input: { ids: string[]; edges: Array<{ from: string; to: string; kind: 'related' | 'hard-prerequisite' }>; hops?: number }) => {
  for (let i = 0; i < 5000; i++) { const id = randomUUID(); if (probeDrawn(id, 20) && probeCandidates({ turnId: id, hops: input.hops ?? 1, turnConceptIds: input.ids, edges: input.edges, catalogIds, heldOut: held }).pick?.conceptId === conceptId) return id }
  throw new Error(`no turn picks ${conceptId}`)
}
const related = (from: string, to: string[]) => to.map((id) => ({ from, to: id, kind: 'related' as const }))

describe('the probe draw', () => {
  const ids = Array.from({ length: 20_000 }, () => randomUUID())
  test('is a pure function of the turn id, at the slider\'s rate, independent of the injection coin', () => {
    for (const id of ids.slice(0, 200)) expect(probeDrawn(id, 40)).toBe(probeDrawn(id, 40))
    for (const rate of [0, 20, 60, 100]) expect(Math.abs(100 * ids.filter((id) => probeDrawn(id, rate)).length / ids.length - rate)).toBeLessThan(1.5)
    const both = ids.filter((id) => probeDrawn(id, 50) && injectionCoin(id, 50)).length
    expect(Math.abs(100 * both / ids.length - 25)).toBeLessThan(1.5)
  })
  test('an uppercase turn id draws what its lowercase form draws (Postgres stores it lowercase)', () => {
    for (const id of ids.slice(0, 200)) expect(probeDrawn(id.toUpperCase(), 40)).toBe(probeDrawn(id, 40))
  })
})

describe('selectProbe', () => {
  const t = taught[0]!, h1 = heldIds[0]!, h2 = heldIds[1]!, t1 = taught[1]!, t2 = taught[2]!, t3 = taught[3]!
  const edges = related(t, [h1, h2, t1, t2])
  const base = { rate: 100, hops: 1, turnConceptIds: [t], edges, catalogIds, heldOut: held }

  test('one concept is picked among ALL candidates, the arm is that concept\'s arm, and the draw records both counts', () => {
    for (let i = 0; i < 50; i++) {
      const turnId = randomUUID(), { probe, draw, candidates } = selectProbe({ ...base, turnId })
      expect([h1, h2, t1, t2]).toContain(probe!.conceptId)
      expect(probe!.arm).toBe(held.has(probe!.conceptId) ? 'held_out' : 'taught')
      expect(probe).toMatchObject({ hops: 1, relatedTo: t })
      expect(probe).toEqual(candidates!.pick)
      expect(draw).toEqual({ outcome: 'delivered', rate: 100, hops: 1, arm: probe!.arm, heldOutCandidates: 2, taughtCandidates: 2, conceptId: probe!.conceptId, conceptHops: 1 })
      expect(selectProbe({ ...base, turnId })).toEqual(selectProbe({ ...base, turnId: turnId.toUpperCase() })) // a replay probes the same concept
    }
  })
  test('the pick does not know the arm: the same concepts are picked on the same turns whichever of them are held out', () => {
    for (let i = 0; i < 200; i++) {
      const turnId = randomUUID()
      const real = selectProbe({ ...base, turnId }).probe!.conceptId
      expect(selectProbe({ ...base, turnId, heldOut: new Set([t1, t2]) }).probe!.conceptId).toBe(real)
      expect(selectProbe({ ...base, turnId, heldOut: new Set<string>() }).probe!.conceptId).toBe(real)
    }
  })
  test('a turn with candidates in one arm only is probed like any other', () => {
    for (const [only, arm, counts] of [[[t1, t2], 'taught', { heldOutCandidates: 0, taughtCandidates: 2 }], [[h1, h2], 'held_out', { heldOutCandidates: 2, taughtCandidates: 0 }]] as const) {
      const { probe, draw } = selectProbe({ ...base, edges: related(t, [...only]), turnId: randomUUID() })
      expect(only).toContain(probe!.conceptId)
      expect(draw).toMatchObject({ outcome: 'delivered', arm, conceptId: probe!.conceptId, ...counts })
    }
  })
  test('rate 0 never draws; only concepts within the hop distance are candidates; a turn with none says so', () => {
    expect(selectProbe({ ...base, rate: 0, turnId: randomUUID() })).toEqual({ probe: null, candidates: null, draw: { outcome: 'not_drawn', rate: 0, hops: 1, arm: null, heldOutCandidates: null, taughtCandidates: null, conceptId: null, conceptHops: null } })
    const far = [...related(t, [t1]), ...related(t1, [h1])]
    const turnId = turnPicking(h1, { ids: [t], edges: far, hops: 2 })
    expect(selectProbe({ ...base, edges: far, hops: 1, turnId })).toMatchObject({ probe: { conceptId: t1, hops: 1 }, draw: { outcome: 'delivered', arm: 'taught', heldOutCandidates: 0, taughtCandidates: 1 } })
    expect(selectProbe({ ...base, edges: far, hops: 2, turnId })).toMatchObject({ probe: { conceptId: h1, hops: 2 }, draw: { hops: 2, conceptHops: 2, heldOutCandidates: 1, taughtCandidates: 1 } })
    // The stored distance is the concept's own, not the setting.
    expect(selectProbe({ ...base, edges: far, hops: 4, turnId }).draw).toMatchObject({ hops: 4, conceptHops: 2 })
    // No candidate at all: nothing is picked and there is no arm (the outcome keeps its old name).
    expect(selectProbe({ ...base, edges: [], turnId })).toMatchObject({ probe: null, draw: { outcome: 'arm_empty', arm: null, conceptId: null, heldOutCandidates: 0, taughtCandidates: 0 } })
    // The turn's own concepts are never candidates.
    expect(probeCandidates({ ...base, turnConceptIds: [t, h1, t1], turnId })).toMatchObject({ held_out: [{ conceptId: h2 }], taught: [{ conceptId: t2 }] })
  })
})

describe('exposure: how often each arm\'s concepts are candidates', () => {
  const [t, t1, far] = taught, h = heldIds[0]!
  const edges = [...related(t, [h, t1])]
  // `far` is a taught concept no turn comes near: it counts in its arm's per-concept rate all the same.
  const three = { edges, catalogIds: [t!, t1!, far!, h], heldOut: held, hops: 1 }

  test('each turn gives every candidate one over the number of candidates; a turn\'s own concept gets nothing there and is counted as such', () => {
    // A turn about t has h and t1 in range (half a probe each); a turn about t1 has only t (a whole one).
    const e = probeExposure({ ...three, turns: [{ turnId: randomUUID(), conceptIds: [t!] }, { turnId: randomUUID(), conceptIds: [t1!] }, { turnId: randomUUID(), conceptIds: ['not-in-the-catalog'] }] })
    expect(e).toEqual({ hops: 1, turns: 2, ratio: 1, arms: {
      held_out: { concepts: 1, inRange: 1, expectedProbes: 0.5, perConcept: 0.5, asTurnConcept: 0 },
      taught: { concepts: 3, inRange: 2, expectedProbes: 1.5, perConcept: 0.5, asTurnConcept: 2 / 3 } } })
    // The conversation returning to a taught concept takes probes away from it: three more turns about t1 give t three more, t1 none.
    const more = probeExposure({ ...three, turns: [t, t1, t1, t1, t1].map((id) => ({ turnId: randomUUID(), conceptIds: [id!] })) })
    expect(more.arms.taught).toMatchObject({ expectedProbes: 4.5, perConcept: 1.5, asTurnConcept: 5 / 3 })
    expect(more.ratio).toBeCloseTo(0.5 / 1.5, 10)
    expect(probeExposure({ ...three, turns: [] })).toMatchObject({ turns: 0, ratio: null })
  })

  test('the stored candidate count is the whole turn\'s, in the SQL the analysis reads (the unit tier\'s copy of the database test)', () => {
    expect(PROBE_ROWS_SQL).toContain('p.probe_held_out_candidates + p.probe_taught_candidates AS candidates')
    expect(PROBE_ROWS_SQL).not.toMatch(/CASE[^,]*probe_arm[^,]*candidates/i)
  })

  // Review 7, S2. In the fixture and the simulation the turns' topics do not know the arm. Here they do: what was
  // taught is returned to. Paired by seed (same graph, popularity and draws), 1 hop, 3,000 turns.
  test('when teaching changes what the conversation is about, the arms are no longer probed at the same rate: 5 to 15 % in this model', () => {
    const seeds = [1, 2, 3, 4].map((i) => 20261111 + i), run = (seed: number, boost: number) => topicFeedback({ seed, boost, turns: 3000, hops: 1, catalogIds, heldOut: held })
    const base = seeds.map((seed) => run(seed, 0).ratio), fed = seeds.map((seed) => run(seed, 2).ratio)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    // Topics blind to the arm: equal rates, up to the luck of which popular concepts are held out (0.74 to 1.23 by seed).
    expect(Math.abs(mean(base) - 1)).toBeLessThan(0.12)
    // Topics that follow teaching: held-out concepts get 5 to 15 % fewer probes per concept than taught ones, in every seed.
    const relative = fed.map((r, i) => r / base[i]!)
    for (const r of relative) expect(r).toBeLessThan(1)
    expect(mean(relative)).toBeGreaterThan(0.82)
    expect(mean(relative)).toBeLessThan(0.97)
  }, 120_000)
})

// The balance replay (docs/specs/blind-probes.md, "Balance"): the rule run over many turns on a
// graph with the shipped catalog and its real one-in-five holdout. The fixture is fixed (ids and
// edges are hashes of a counter), so the numbers below never change between runs.
describe('balance on a fixture graph with the real one-in-five share', () => {
  const pick = (key: string, n: number) => parseInt(createHash('md5').update(key).digest('hex').slice(0, 8), 16) % n
  // A sparse graph (one edge per concept): like the shipped one, most
  // turns have a taught concept in range and a good share have no held-out one.
  const edges = Array.from({ length: catalogIds.length }, (_, i) => ({ from: catalogIds[pick(`a${i}`, catalogIds.length)]!, to: catalogIds[pick(`b${i}`, catalogIds.length)]!, kind: 'related' as const }))
  const uuid = (i: number) => { const x = createHash('md5').update(`turn-${i}`).digest('hex'); return `${x.slice(0, 8)}-${x.slice(8, 12)}-4${x.slice(13, 16)}-8${x.slice(17, 20)}-${x.slice(20, 32)}` }
  const turns = Array.from({ length: 6000 }, (_, i) => ({ turnId: uuid(i), turnConceptIds: [catalogIds[pick(`c${i}`, catalogIds.length)]!, ...(i % 3 ? [] : [catalogIds[pick(`d${i}`, catalogIds.length)]!])] }))
  const share = (n: number, of: number) => 100 * n / of

  test('the holdout is the real one: about one concept in five', () => {
    expect(Math.abs(share(held.size, catalogIds.length) - 20)).toBeLessThan(3)
  })

  /** What a rule did to each arm over the turns, in order: nothing here looks at an answer. */
  const schedule = (picks: Array<{ candidates: Array<{ conceptId: string }>; picked: { conceptId: string } | null }>) => {
    const activity = new Map<string, number>(), probes = new Map<string, number>(), first = new Map<string, number>()
    picks.forEach(({ candidates, picked }, turn) => {
      for (const c of candidates) activity.set(c.conceptId, (activity.get(c.conceptId) ?? 0) + 1)
      if (picked) { probes.set(picked.conceptId, (probes.get(picked.conceptId) ?? 0) + 1); if (!first.has(picked.conceptId)) first.set(picked.conceptId, turn) }
    })
    const arm = (heldOut: boolean) => {
      // The arm's concepts that were near a turn at all (a concept that never was cannot be probed under any rule).
      const inPlay = [...activity.keys()].filter((id) => held.has(id) === heldOut), probed = inPlay.filter((id) => first.has(id))
      const sum = (ids: string[], of: Map<string, number>) => ids.reduce((total, id) => total + (of.get(id) ?? 0), 0)
      const times = inPlay.map((id) => first.get(id) ?? Infinity).sort((a, b) => a - b)
      return {
        probes: sum(inPlay, probes),
        /** Probes per time the concept was a candidate: the per-concept probe rate. */
        rate: sum(inPlay, probes) / sum(inPlay, activity),
        /** The turn by which a quarter, and half, of the arm's concepts had their first probe. */
        firstProbe: [times[Math.floor(times.length / 4)]!, times[Math.floor(times.length / 2)]!] as const,
        /** How often the PROBED concepts were near a turn. */
        probedActivity: sum(probed, activity) / probed.length,
      }
    }
    return { held: arm(true), taught: arm(false) }
  }
  for (const hops of [1, 2]) test(`${hops} hop${hops > 1 ? 's' : ''}: a concept is probed at the same rate, as early, and from an equally active set, whichever arm it is in`, () => {
    const draws = turns.map((turn) => ({ ...selectProbe({ ...turn, rate: 100, hops, edges, catalogIds, heldOut: held }), ...turn }))
    const all = (d: typeof draws[number]) => [...d.candidates!.held_out, ...d.candidates!.taught]
    // The fixture has what the real graph has: many turns with no held-out concept in range. They are probed too.
    const oneArm = draws.filter((d) => d.probe && (!d.draw.heldOutCandidates || !d.draw.taughtCandidates))
    expect(share(oneArm.length, draws.length)).toBeGreaterThan(hops === 1 ? 50 : 20)
    expect(draws.every((d) => d.probe ? d.draw.outcome === 'delivered' && d.draw.arm === d.probe.arm && held.has(d.probe.conceptId) === (d.probe.arm === 'held_out') : d.draw.outcome === 'arm_empty' && all(d).length === 0)).toBe(true)

    const now = schedule(draws.map((d) => ({ candidates: all(d), picked: d.probe })))
    // Equal per-concept probe rate.
    expect(Math.abs(now.held.rate / now.taught.rate - 1)).toBeLessThan(0.06)
    // So the held-out share of probes is the held-out share of candidates, about one in five, not one half.
    const slots = draws.reduce((sum, d) => sum + all(d).length, 0), heldSlots = draws.reduce((sum, d) => sum + d.draw.heldOutCandidates!, 0)
    expect(Math.abs(share(now.held.probes, now.held.probes + now.taught.probes) - share(heldSlots, slots))).toBeLessThan(1.5)
    expect(share(now.held.probes, now.held.probes + now.taught.probes)).toBeLessThan(25)
    // First probes arrive as early in one arm as in the other: the quartile and the median turn.
    for (const q of [0, 1]) expect(Math.abs(now.held.firstProbe[q]! / now.taught.firstProbe[q]! - 1)).toBeLessThan(0.3)
    // The probed concepts are equally active in both arms.
    expect(Math.abs(now.held.probedActivity / now.taught.probedActivity - 1)).toBeLessThan(0.05)

    // At the real 20% rate the drawn turns are a fifth of them, with the same held-out share.
    const at20 = draws.filter((d) => d.probe && probeDrawn(d.turnId, 20)), delivered = draws.filter((d) => d.probe)
    expect(Math.abs(share(at20.length, delivered.length) - 20)).toBeLessThan(2.5)
    expect(Math.abs(share(at20.filter((d) => d.probe!.arm === 'held_out').length, at20.length) - share(now.held.probes, delivered.length))).toBeLessThan(4)
  })
})

describe('a probe in the turn\'s guidance', () => {
  const t = taught[0]!, h = heldIds[0]!, h2 = heldIds[1]!, t1 = taught[1]!
  const edges = related(t, [h, t1])
  const base = { catalog, assessments: [], suppressed: new Set<string>(), gaps: [], foundationFirst: true, prerequisites: prerequisitePolicy(DEFAULT_LEARNING_POLICY), heldOut: held, ids: [t], edges }
  const probeOf = (context: string) => { const line = context.split('\nBlind probe: ')[1]?.split('\n')[0]; return line ? JSON.parse(line) as Record<string, unknown> : null }
  const targetsOf = (context: string) => JSON.parse(context.split('address only remainingGap): ')[1]!.split('\nPrerequisite selection: ')[0]!) as Array<{ conceptId: string }>

  test('off is byte-identical: no probe field, null and rate 0 all give the guidance without probes', () => {
    const off = taskTeachingContext(base)
    expect(taskTeachingContext({ ...base, probe: null })).toEqual(off)
    const notDrawn = taskTeachingContext({ ...base, probe: { turnId: randomUUID(), rate: 0, hops: 1 } })
    expect({ ...notDrawn, probe: null } as typeof notDrawn).toEqual(off)
    expect(notDrawn.probe).toMatchObject({ outcome: 'not_drawn', arm: null, conceptId: null })
    expect(off.context).not.toContain('probe')
    expect([off.probeConceptId, off.probe]).toEqual([null, null])
  })
  test('on: one probe on its own line, the same shape and words for both arms, never a teaching target', () => {
    const off = taskTeachingContext(base)
    const packets = [h, t1].map((concept) => taskTeachingContext({ ...base, probe: { turnId: turnPicking(concept, base), rate: 100, hops: 1 } }))
    expect(packets.map((p) => p.probeConceptId)).toEqual([h, t1])
    expect(packets.map((p) => p.probe)).toEqual((['held_out', 'taught'] as const).map((arm, i) => ({ outcome: 'delivered', rate: 100, hops: 1, arm, heldOutCandidates: 1, taughtCandidates: 1, conceptId: [h, t1][i]!, conceptHops: 1 })))
    for (const p of packets) {
      // The teaching targets are exactly what they were: the probe is not one of them.
      expect(p.conceptIds).toEqual(off.conceptIds)
      expect(targetsOf(p.context)).toEqual(targetsOf(off.context))
      expect(p.context.startsWith(off.context)).toBe(true)
      expect(Object.keys(probeOf(p.context)!)).toEqual(['conceptId', 'title', 'role', 'hops', 'relatedTo'])
      expect(probeOf(p.context)).toMatchObject({ role: 'probe', hops: 1, relatedTo: t })
      expect(p.context.endsWith(PROBE_GUIDANCE)).toBe(true)
    }
    // Nothing in the guidance says which arm the concept is in.
    const [heldPacket, taughtPacket] = packets
    const blank = (p: typeof heldPacket, id: string) => p!.context.replaceAll(id, 'ID').replaceAll(catalog.find((c) => c.id === id)!.title, 'TITLE')
    expect(blank(heldPacket, h)).toBe(blank(taughtPacket, t1))
    expect(PROBE_GUIDANCE).not.toMatch(/held|holdout|arm|experiment/i)
  })
  test('the holdout still holds: a held-out concept reaches the guidance only as the probe', () => {
    const holdoutEdges = [...related(t, [h, t1, h2]), { from: h, to: t, kind: 'hard-prerequisite' as const }, { from: h2, to: t, kind: 'hard-prerequisite' as const }]
    const p = taskTeachingContext({ ...base, ids: [t, h], edges: holdoutEdges, probe: { turnId: turnPicking(h2, { ids: [t, h], edges: holdoutEdges }), rate: 100, hops: 1 } })
    for (const id of [h, h2]) { expect(p.conceptIds).not.toContain(id); expect(targetsOf(p.context).map((n) => n.conceptId)).not.toContain(id) }
    // h is one of the turn's own concepts, so it is not a candidate; h2 is the probe and nothing else.
    expect(p.probeConceptId).toBe(h2)
    expect(p.context.split(h2).length - 1).toBe(1)
  })
  test('no taught-only signal: a suppressed (recently taught or demonstrated) concept is still a candidate', () => {
    const p = taskTeachingContext({ ...base, suppressed: new Set([t1]), probe: { turnId: turnPicking(t1, base), rate: 100, hops: 1 } })
    expect([p.probeConceptId, p.probe!.taughtCandidates]).toEqual([t1, 1])
  })
  test('a concept the packet was about to teach is probed instead when the pick lands on it', () => {
    // t1 is an unmet prerequisite of t: without probes the packet teaches it.
    const prerequisite = [...related(t, [h]), { from: t1, to: t, kind: 'hard-prerequisite' as const }]
    const off = taskTeachingContext({ ...base, edges: prerequisite })
    expect(off.conceptIds).toEqual([t1, t])
    const taughtArm = taskTeachingContext({ ...base, edges: prerequisite, probe: { turnId: turnPicking(t1, { ids: [t], edges: prerequisite }), rate: 100, hops: 1 } })
    expect([taughtArm.probeConceptId, taughtArm.conceptIds, targetsOf(taughtArm.context).map((n) => n.conceptId)]).toEqual([t1, [t], [t]])
    // The same kind of turn keeps the packet whole when the pick lands on the held-out concept: the turn was probed either way.
    const heldArm = taskTeachingContext({ ...base, edges: prerequisite, probe: { turnId: turnPicking(h, { ids: [t], edges: prerequisite }), rate: 100, hops: 1 } })
    expect([heldArm.probeConceptId, heldArm.conceptIds]).toEqual([h, [t1, t]])
  })
  test('the size rule is decided on the longest line of EITHER arm, so it never depends on which concept is picked', () => {
    // One arm's only candidate has a much longer title than the other's.
    const byTitle = (ids: string[]) => [...ids].sort((a, b) => catalog.find((c) => c.id === a)!.title.length - catalog.find((c) => c.id === b)!.title.length)
    const lines = (ids: [string, string]) => ids.map((id) => JSON.stringify(catalog.find((c) => c.id === id)!.title).length + id.length)
    for (const [heldId, taughtId] of [[byTitle(heldIds).at(-1)!, byTitle(taught.filter((id) => id !== t))[0]!], [byTitle(heldIds)[0]!, byTitle(taught.filter((id) => id !== t)).at(-1)!]] as const) {
      const [heldLine, taughtLine] = lines([heldId, taughtId])
      expect(Math.abs(heldLine! - taughtLine!)).toBeGreaterThan(20)
      const pair = related(t, [heldId, taughtId])
      const fits = (gap: number, arm: ProbeArm) => taskTeachingContext({ ...base, edges: pair, gaps: [{ conceptId: t, remainingGap: 'g'.repeat(gap) }], probe: { turnId: turnPicking(arm === 'held_out' ? heldId : taughtId, { ids: [t], edges: pair }), rate: 100, hops: 1 } }).probe!.outcome
      // The longest gap at which the longer line still fits: one more character and neither arm is probed,
      // although the arm with the shorter line would still fit.
      let gap = 0
      while (fits(gap + 1, 'held_out') === 'delivered') gap++
      expect(gap).toBeGreaterThan(100)
      for (const arm of ['held_out', 'taught'] as const) expect([fits(gap, arm), fits(gap + 1, arm), fits(gap + 10, arm)]).toEqual(['delivered', 'size', 'size'])
    }
  })
  test('lowest priority: no probe without a task target, none when the five slots are full, none past the size ceiling: decided on the turn, the same for both arms', () => {
    for (const arm of ['held_out', 'taught'] as const) {
      const on = (concept: string, graph: { ids: string[]; edges: Array<{ from: string; to: string; kind: 'related' }> }) => ({ turnId: turnPicking(concept, graph), rate: 100, hops: 1 })
      const probe = on(arm === 'taught' ? t1 : h, base)
      // Nothing to teach (the only concept is held out): a probe alone never makes a turn worth injecting,
      // and no probe line reaches the context of a packet without a target.
      const alone = taskTeachingContext({ ...base, ids: [h], edges: related(h, [t1, h2]), probe: on(arm === 'taught' ? t1 : h2, { ids: [h], edges: related(h, [t1, h2]) }) })
      expect([alone.conceptIds, alone.probeConceptId, alone.probe!.outcome, alone.probe!.arm]).toEqual([[], null, 'no_target', arm])
      expect(alone.context).toBe(taskTeachingContext({ ...base, ids: [h], edges: related(h, [t1, h2]) }).context)
      expect(alone.context).not.toContain('probe')
      const five = taught.slice(0, 5), spare = taught[5]!
      const fullProbe = on(arm === 'taught' ? spare : h, { ids: five, edges: related(five[0]!, [spare, h]) })
      const full = taskTeachingContext({ ...base, ids: five, edges: related(five[0]!, [spare, h]), probe: fullProbe })
      expect(full.conceptIds).toHaveLength(5)
      expect([full.probeConceptId, full.probe!.outcome, full.probe!.heldOutCandidates, full.probe!.taughtCandidates]).toEqual([null, 'packet_full', 1, 1])
      expect(taskTeachingContext({ ...base, ids: five.slice(0, 4), edges: related(five[0]!, [spare, h]), probe: on(arm === 'taught' ? spare : h, { ids: five.slice(0, 4), edges: related(five[0]!, [spare, h]) }) }).probeConceptId).toBe(arm === 'taught' ? spare : h)
      // A gap long enough that targets + probe pass 4,000 characters but the targets alone do not.
      const short = taskTeachingContext({ ...base, gaps: [{ conceptId: t, remainingGap: '' }] }).context.length
      const gaps = [{ conceptId: t, remainingGap: 'g'.repeat(3900 - short) }]
      expect(taskTeachingContext({ ...base, gaps: [{ conceptId: t, remainingGap: 'g' }], probe }).probeConceptId).toBe(arm === 'taught' ? t1 : h) // it fits with a short gap
      const tight = taskTeachingContext({ ...base, gaps, probe })
      expect([tight.probeConceptId, tight.probe!.outcome]).toEqual([null, 'size'])
      expect({ ...tight, probe: null } as typeof tight).toEqual(taskTeachingContext({ ...base, gaps }))
      expect(tight.conceptIds).toEqual([t])
      expect(tight.context.length).toBeLessThanOrEqual(4000)
    }
  })

  describe('the difference between the arms', () => {
    let index = 0
    const r = (arm: ProbeArm, concept_id: string, demonstrated: 0 | 1, candidates: number | null = 1, more: Partial<ProbeRow> = {}): ProbeRow =>
      ({ arm, concept_id, met_before: false, probe_index: 1, status: 'scored', demonstrated: Boolean(demonstrated), candidates, days_since_holdout: ++index, ...more })
    // Held-out: h1 probed twice (picked from 2, then from 4 candidates), h2 once. Taught: three concepts, one probe each.
    const repeated = [
      r('held_out', 'h1', 1, 2, { days_since_holdout: 2 }), r('held_out', 'h1', 0, 4, { probe_index: 2, days_since_holdout: 4 }), r('held_out', 'h2', 1, 2, { days_since_holdout: 6 }),
      r('taught', 't1', 1, 10, { days_since_holdout: 10 }), r('taught', 't2', 0, 10, { days_since_holdout: 20 }), r('taught', 't3', 1, 20, { days_since_holdout: 5 }),
    ]
    // One probe per concept: held-out 0, 1; taught 1, 0, 1, 1.
    const single = [r('held_out', 'h1', 0), r('held_out', 'h2', 1), r('taught', 't1', 1), r('taught', 't2', 0), r('taught', 't3', 1), r('taught', 't4', 1)]

    test('the 95 % critical value of Student\'s t, also for fractional degrees of freedom', () => {
      // Table values: 12.706 (1), 4.303 (2), 2.228 (10), 2.042 (30), 1.960 (normal).
      expect(tCritical95(1)).toBeCloseTo(12.7062, 3)
      expect(tCritical95(2)).toBeCloseTo(4.3027, 3)
      expect(tCritical95(10)).toBeCloseTo(2.2281, 3)
      expect(tCritical95(30)).toBeCloseTo(2.0423, 3)
      expect(tCritical95(1e6)).toBeCloseTo(1.96, 3)
      expect(tCritical95(1.5)).toBeGreaterThan(tCritical95(2))
      expect(tCritical95(1.5)).toBeLessThan(tCritical95(1))
    })

    test('the headline: each concept\'s first probe, the standard error is Welch\'s sqrt(s2/n + s2/n) with its degrees of freedom and t interval', () => {
      const d = probeDifference(single)
      // Held-out: mean 0.5, s2 0.5, n 2. Taught: mean 0.75, s2 0.25, n 4. sqrt(0.25 + 0.0625).
      expect([d.reading, d.status, d.difference]).toEqual(['first', 'ok', 0.25])
      expect(d.se).toBeCloseTo(0.559017, 6)
      // 0.3125^2 / (0.25^2 / 1 + 0.0625^2 / 3).
      expect(d.df).toBeCloseTo(1.530612, 5)
      expect(d.interval![0]).toBeCloseTo(0.25 - tCritical95(1.530612) * 0.559017, 4)
      expect(d.interval![1]).toBeCloseTo(0.25 + tCritical95(1.530612) * 0.559017, 4)
      expect(d.interval![1] - d.interval![0]).toBeGreaterThan(2 * 4.3 * 0.559) // wider than df 2 would give
      expect([d.strata, d.strataDropped, d.probes, d.concepts, d.delivered]).toEqual([1, 0, { held_out: 2, taught: 4 }, { held_out: 2, taught: 4 }, { held_out: 2, taught: 4 }])
      expect(probeDifference(single, { reading: 'first' })).toEqual(d)
    })

    test('the headline leaves every later probe of a concept out, and does not weigh by candidates', () => {
      const d = probeDifference(repeated)
      // h1's second probe (a 0) is gone: held-out 1, 1; taught 1, 0, 1 whatever their candidate counts. 2/3 - 1.
      expect(d.difference).toBeCloseTo(-1 / 3, 10)
      // Held-out has no spread: floor 0.75 x 0.25 / 4 = 0.046875. Taught: s2 1/3 over 3. sqrt(0.046875 + 0.111111).
      expect(d.se).toBeCloseTo(0.397475, 6)
      expect([d.probes, d.concepts, d.delivered, d.priorProbesGap]).toEqual([{ held_out: 2, taught: 3 }, { held_out: 2, taught: 3 }, { held_out: 2, taught: 3 }, 0])
      // Days, unweighted over first probes: held-out (2 + 6) / 2 = 4, taught (10 + 20 + 5) / 3.
      expect(d.daysGap).toBeCloseTo(35 / 3 - 4, 10)
      // A concept whose first probe was not scored is not in the headline, even with a scored second probe.
      const late = probeDifference([...repeated, r('taught', 't9', 0, 1, { status: 'no_answer' }), r('taught', 't9', 0, 1, { probe_index: 2 })])
      expect([late.difference, late.concepts.taught, late.unscored.taught.noAnswer, late.delivered.taught]).toEqual([d.difference, 3, 1, 4])
    })

    test('no spread is not no error: arms that all gave one answer still get a standard error and an interval', () => {
      const d = probeDifference([r('held_out', 'a', 0), r('held_out', 'b', 0), r('taught', 'c', 1), r('taught', 'd', 1)])
      // Each arm: p = (successes + 1) / (2 + 2), floor p(1 - p) / 4 = 0.046875. sqrt(0.09375), df 2, t 4.3027.
      expect([d.status, d.difference, d.df]).toEqual(['ok', 1, 2])
      expect(d.se).toBeCloseTo(0.306186, 6)
      expect(d.interval![0]).toBeCloseTo(1 - 4.3027 * 0.306186, 3)
      expect(d.interval![0]).toBeLessThan(0)
      // The same in the weighted reading: held-out weights 3 and 5 are 64 / 34 effective probes.
      const all = probeDifference([r('held_out', 'a', 0, 3), r('held_out', 'b', 0, 5), r('taught', 'c', 1, 2), r('taught', 'd', 1, 2)], { reading: 'all' })
      expect(all.se).toBeCloseTo(0.310051, 6)
      // The degrees of freedom stay finite and positive, so the interval is a number, not NaN.
      for (const x of [d, all]) expect([Number.isFinite(x.df), x.df! > 0, Number.isFinite(x.interval![0]), Number.isFinite(x.interval![1])]).toEqual([true, true, true, true])
    })

    test('strata are what the learner had met before; each is weighted by the concepts in its smaller arm and the variances add', () => {
      const met = { met_before: true }
      const d = probeDifference([...single, r('held_out', 'h3', 0, 1, met), r('held_out', 'h4', 0, 1, met), r('held_out', 'h5', 0, 1, met), r('held_out', 'h6', 0, 1, met), r('taught', 't5', 1, 1, met), r('taught', 't6', 1, 1, met), r('taught', 't7', 1, 1, met)])
      // Not met: 0.25, weight 2 (2 held-out, 4 taught concepts), variance 0.3125.
      // Met: 1 - 0 = 1, weight 3 (4 and 3), floors (1/6)(5/6)/6 = 0.023148 and (4/5)(1/5)/5 = 0.032.
      // (2 x 0.25 + 3 x 1) / 5; sqrt((4 x 0.3125 + 9 x 0.055148) / 25).
      expect(d.difference).toBeCloseTo(0.7, 10)
      expect(d.se).toBeCloseTo(0.264298, 6)
      expect([d.strata, d.strataDropped, d.concepts]).toEqual([2, 0, { held_out: 6, taught: 7 }])
    })

    test('not enough data: a stratum with fewer than two concepts in an arm is not compared, and what it holds is counted apart', () => {
      expect(PROBE_MIN_CONCEPTS_PER_ARM).toBe(2)
      // One concept per arm, rates 0 and 1: no difference is reported at all.
      const one = probeDifference([r('held_out', 'h1', 0), r('taught', 't1', 1), r('taught', 't1', 1, 1, { probe_index: 2 })], { reading: 'all' })
      expect(one).toMatchObject({ status: 'not_enough_data', difference: null, se: null, df: null, interval: null, strata: 0, strataDropped: 1, daysGap: null, priorProbesGap: null,
        probes: { held_out: 0, taught: 0 }, concepts: { held_out: 0, taught: 0 }, delivered: { held_out: 0, taught: 0 }, deliveredInDroppedStrata: { held_out: 1, taught: 2 } })
      expect(probeDifference([])).toMatchObject({ status: 'not_enough_data', difference: null, strata: 0, strataDropped: 0 })
      // The thin stratum is dropped and counted; the other one stands exactly as it was alone, and so do its counts.
      const thin = [r('held_out', 'h3', 0, 1, { met_before: true }), r('held_out', 'h3', 0, 1, { met_before: true, probe_index: 2, status: 'no_answer' }), r('taught', 't5', 1, 1, { met_before: true }), r('taught', 't6', 1, 1, { met_before: true, status: 'explained' })]
      const d = probeDifference([...single, ...thin], { reading: 'all' }), alone = probeDifference(single, { reading: 'all' })
      expect([d.status, d.strata, d.strataDropped]).toEqual(['ok', 1, 1])
      expect([d.difference, d.se, d.concepts, d.probes, d.delivered, d.unscored, d.ifExplained]).toEqual([alone.difference, alone.se, alone.concepts, alone.probes, alone.delivered, alone.unscored, alone.ifExplained])
      expect(d.deliveredInDroppedStrata).toEqual({ held_out: 2, taught: 2 })
    })

    test('sensitivity, all probes: a probe counts with the number of candidates its arm picked from, and a concept\'s probes are one cluster', () => {
      const d = probeDifference(repeated, { reading: 'all' })
      // Held-out rate (2x1 + 4x0 + 2x1) / 8 = 0.5; taught (10 + 0 + 20) / 40 = 0.75.
      expect([d.reading, d.difference]).toEqual(['all', 0.25])
      // Held-out clusters: h1 (2 - 0.5x6) / 8 = -0.125 with 6/8 of the weight, h2 +0.125 with 2/8:
      // 0.015625 / 0.25 + 0.015625 / 0.75 = 0.083333.
      // Taught clusters 0.0625, -0.1875, 0.125 with shares 1/4, 1/4, 1/2:
      // 0.00390625 / 0.75 + 0.03515625 / 0.75 + 0.015625 / 0.5 = 0.083333. sqrt(0.166667).
      expect(d.se).toBeCloseTo(0.408248, 6)
      // Effective concepts 64 / 40 = 1.6 and 1600 / 600 = 2.667: 0.027778 / (0.006944 / 0.6 + 0.006944 / 1.667).
      expect(d.df).toBeCloseTo(1.764706, 5)
      expect([d.probes, d.concepts, d.delivered]).toEqual([{ held_out: 3, taught: 3 }, { held_out: 2, taught: 3 }, { held_out: 3, taught: 3 }])
      // Days since the holdout began, same weights: held-out (4 + 16 + 12) / 8 = 4, taught (100 + 200 + 100) / 40 = 10.
      expect(d.daysGap).toBeCloseTo(6, 10)
      // Earlier probes of the same concept, same weights: held-out (0 + 4x1 + 0) / 8, taught none.
      expect(d.priorProbesGap).toBeCloseTo(-0.5, 10)
    })

    test('sensitivity, all probes: a probe stored without its candidate count is left out and counted, never weighed as one', () => {
      const d = probeDifference([...repeated, r('held_out', 'h7', 0, null), r('taught', 't7', 0, null), r('taught', 't8', 0, 0)], { reading: 'all' }), clean = probeDifference(repeated, { reading: 'all' })
      expect([d.difference, d.se, d.probes]).toEqual([clean.difference, clean.se, clean.probes])
      expect([d.missingWeight, d.delivered]).toEqual([{ held_out: 1, taught: 2 }, { held_out: 4, taught: 5 }])
      // The headline does not use the count, so there the same probes are scored.
      const first = probeDifference([...repeated, r('held_out', 'h7', 0, null), r('taught', 't7', 0, null)])
      expect([first.probes, first.missingWeight]).toEqual([{ held_out: 3, taught: 4 }, { held_out: 0, taught: 0 }])
    })

    test('the printed interval: clipped to the possible range, and said to be uninformative below two degrees of freedom', () => {
      expect(probeIntervalText({ interval: [-0.12345, 0.4], df: 9 })).toBe('-0.123 to 0.400')
      expect(probeIntervalText({ interval: [-1.6, 0.936], df: 2.98 })).toBe('-1.000 to 0.936 (clipped to the possible range)')
      expect(probeIntervalText({ interval: [0.2, 1.4], df: 2 }, 2)).toBe('0.20 to 1.00 (clipped to the possible range)')
      expect(probeIntervalText({ interval: [-1.3, 2.3], df: 2 })).toBe('-1.000 to 1.000 (the whole range: uninformative)')
      expect(probeIntervalText({ interval: [-250, 250], df: 1.53 })).toBe('uninformative (df 1.5 < 2)')
      expect(probeIntervalText({ interval: null, df: null })).toBe('no interval')
      // The result itself keeps the unclipped interval.
      expect(probeDifference(single).interval![1]).toBeGreaterThan(1)
      expect(probeIntervalText(probeDifference(single))).toBe('uninformative (df 1.5 < 2)')
    })

    test('sensitivity, concept means: each concept counts once with the mean of all its scored probes', () => {
      const d = probeDifference(repeated, { reading: 'concept' })
      // Held-out concept means 0.5 and 1; taught 1, 0, 1. sqrt(0.125/2 + 0.3333/3).
      expect([d.reading, d.probes, d.concepts]).toEqual(['concept', { held_out: 3, taught: 3 }, { held_out: 2, taught: 3 }])
      expect(d.difference).toBeCloseTo(2 / 3 - 0.75, 10)
      expect(d.se).toBeCloseTo(0.416667, 6)
      // h1's second probe has one earlier probe and half of h1's weight: (0 + 0.5 + 0) / 2.
      expect(d.priorProbesGap).toBeCloseTo(-0.25, 10)
      // The candidate count is not used here either: a probe stored without one counts like any other.
      const more = probeDifference([...repeated, r('held_out', 'h7', 0, null), r('taught', 't7', 0, null)], { reading: 'concept' })
      // Held-out means 0.5, 1, 0; taught 1, 0, 1, 0.
      expect([more.probes, more.concepts, more.missingWeight]).toEqual([{ held_out: 4, taught: 4 }, { held_out: 3, taught: 4 }, { held_out: 0, taught: 0 }])
      expect(more.difference).toBeCloseTo(0, 10)
    })

    test('probes that were not scored are counted per arm, and the difference is given with the explained ones scored both ways', () => {
      const more = [r('taught', 't2', 0, 10, { probe_index: 2, status: 'explained', days_since_holdout: 9000 }), r('held_out', 'h9', 0, 3, { status: 'no_answer' }), r('held_out', 'h2', 0, 2, { probe_index: 2, status: 'no_answer' })]
      const d = probeDifference([...repeated, ...more], { reading: 'all' }), clean = probeDifference(repeated, { reading: 'all' })
      expect(d.unscored).toEqual({ held_out: { noAnswer: 2, explained: 0 }, taught: { noAnswer: 0, explained: 1 } })
      // delivered = scored + no answer + explained, per arm.
      expect(d.delivered).toEqual({ held_out: 5, taught: 4 })
      // They change nothing in the scored figures: not the difference, not the days gap (the explained probe is 9000 days out), not the prior-probe gap.
      expect([d.difference, d.se, d.probes, d.daysGap, d.priorProbesGap]).toEqual([clean.difference, clean.se, { held_out: 3, taught: 3 }, clean.daysGap, clean.priorProbesGap])
      // The explained taught probe (weight 10) as not demonstrated: 30 / 50 - 0.5; as demonstrated: 40 / 50 - 0.5.
      expect(d.ifExplained.notDemonstrated).toBeCloseTo(0.1, 10)
      expect(d.ifExplained.demonstrated).toBeCloseTo(0.3, 10)
      // The headline: the explained probe is a second probe, so both bounds equal the difference; an explained FIRST probe moves them.
      const first = probeDifference([...repeated, ...more])
      expect([first.unscored, first.ifExplained.notDemonstrated]).toEqual([{ held_out: { noAnswer: 1, explained: 0 }, taught: { noAnswer: 0, explained: 0 } }, first.difference])
      const explainedFirst = probeDifference([...repeated, r('taught', 't4', 0, 1, { status: 'explained' })])
      // Taught 1, 0, 1 and the explained one: 2/4 - 1 or 3/4 - 1.
      expect([explainedFirst.difference, explainedFirst.ifExplained.notDemonstrated, explainedFirst.ifExplained.demonstrated, explainedFirst.unscored.taught.explained]).toEqual([first.difference, -0.5, -0.25, 1])
    })
  })

  describe('the analysis on a simulated learner (fixed seed)', () => {
    // 60 probes over 120 concepts, one in five held out. 1500 replications: a 95 % rate has a standard error of 0.6 points.
    const replications = 1500, seed = 20261111
    // These run thousands of simulated holdouts; a few seconds alone, more when the gate runs files side by side.
    const SIMULATION_TIMEOUT = 60_000
    test('no effect: the headline is unbiased, its standard error matches its spread, 95 % of intervals hold zero, none has a zero error', () => {
      const c = probeCoverage({ probes: 60 }, 'first', replications, seed)
      // About 12 of the 60 probes are held-out ones, so now and then an arm has too few concepts to compare.
      expect(c.compared).toBeGreaterThan(0.97 * replications)
      expect(Math.abs(c.bias)).toBeLessThan(0.015)
      expect(c.meanSe / c.spread).toBeGreaterThan(0.95)
      expect(c.meanSe / c.spread).toBeLessThan(1.08)
      expect(c.coverage).toBeGreaterThan(0.935)
      expect(c.coverage).toBeLessThan(0.975)
      expect(c.excludesZero).toBeLessThan(0.065)
      expect(c.zeroSe).toBe(0)
    }, SIMULATION_TIMEOUT)
    test('no effect, the sensitivity readings: their standard errors are honest too', () => {
      for (const reading of ['all', 'concept'] as const) {
        const c = probeCoverage({ probes: 60 }, reading, replications, seed)
        expect(c.meanSe / c.spread).toBeGreaterThan(0.95)
        expect(c.meanSe / c.spread).toBeLessThan(1.08)
        expect(c.coverage).toBeGreaterThan(0.935)
        expect(c.zeroSe).toBe(0)
      }
    }, SIMULATION_TIMEOUT)
    test('the scheduler treats the arms alike: as many probes per concept, first probes as early, probed concepts as central', () => {
      const now = probeSchedule({ probes: 300 }, 400, seed).arms
      expect(Math.abs(now.held_out.probesPerConcept / now.taught.probesPerConcept - 1)).toBeLessThan(0.05)
      expect(Math.abs(now.held_out.firstProbeAt - now.taught.firstProbeAt)).toBeLessThan(0.01)
      for (const q of [0, 1, 2]) expect(Math.abs(now.held_out.firstProbeQuartiles[q]! - now.taught.firstProbeQuartiles[q]!)).toBeLessThan(0.02)
      expect(Math.abs(now.held_out.probedCentrality / now.taught.probedCentrality - 1)).toBeLessThan(0.05)
    }, SIMULATION_TIMEOUT)
    test('a taught concept is the turn\'s own topic three times as often (and so not a candidate there): the headline stays unbiased', () => {
      const c = probeCoverage({ probes: 300, topicBoost: 2, centrality: 0.5 }, 'first', replications, seed)
      expect(Math.abs(c.bias)).toBeLessThan(0.012)
      expect(c.coverage).toBeGreaterThan(0.935)
      // The option changes nothing when it is not given: the worlds above are the ones the spec's table was run on.
      expect(simulateProbeRows({ probes: 40 }, seededRandom(7))).toEqual(simulateProbeRows({ probes: 40, topicBoost: undefined }, seededRandom(7)))
    }, SIMULATION_TIMEOUT)
    test('no teaching effect, but the learner improves with time and central concepts are better known: no bias', () => {
      const world = { probes: 300, trend: 1, centrality: 0.5 }
      const now = probeCoverage(world, 'first', replications, seed)
      expect(Math.abs(now.bias)).toBeLessThan(0.015)
      expect(now.coverage).toBeGreaterThan(0.935)
      // The balance figures say the same without any outcome: the gap in days (as a share of the run) and in earlier probes (concept means) is about zero now.
      const gaps = () => { const random = seededRandom(seed); let days = 0, prior = 0, n = 0
        for (let i = 0; i < 300; i++) { const rows = simulateProbeRows({ probes: 300 }, random), d = probeDifference(rows), means = probeDifference(rows, { reading: 'concept' }); if (d.daysGap === null || means.priorProbesGap === null) continue; days += d.daysGap / rows.at(-1)!.days_since_holdout; prior += means.priorProbesGap; n++ }
        return { days: days / n, prior: prior / n } }
      const uniform = gaps()
      expect(Math.abs(uniform.days)).toBeLessThan(0.02)
      expect(Math.abs(uniform.prior)).toBeLessThan(0.1)
    }, SIMULATION_TIMEOUT)
    test('a testing effect and no teaching effect: every reading stays at zero', () => {
      const world = { probes: 300, testing: 0.3 }
      const first = probeCoverage(world, 'first', 600, seed), all = probeCoverage(world, 'all', 600, seed)
      expect(Math.abs(first.bias)).toBeLessThan(0.02)
      expect(first.coverage).toBeGreaterThan(0.93)
      expect(Math.abs(all.bias)).toBeLessThan(0.03)
      expect(all.coverage).toBeGreaterThan(0.93)
    }, SIMULATION_TIMEOUT)
    test('the same seed gives the same rows', () => {
      expect(simulateProbeRows({ probes: 20 }, seededRandom(7))).toEqual(simulateProbeRows({ probes: 20 }, seededRandom(7)))
      expect(simulateProbeRows({ probes: 20 }, seededRandom(7))).not.toEqual(simulateProbeRows({ probes: 20 }, seededRandom(8)))
    }, SIMULATION_TIMEOUT)
  })
})
