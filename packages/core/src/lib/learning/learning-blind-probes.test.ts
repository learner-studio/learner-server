import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import { PROBE_GUIDANCE, probeArm, probeCandidates, probeDrawn, selectProbe, type ProbeArm } from './learning-blind-probes.js'
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
/** A turn id whose probe coin lands on `arm` (and that draws a probe at any rate above 0). */
const turnFor = (arm: ProbeArm) => { for (;;) { const id = randomUUID(); if (probeArm(id) === arm && probeDrawn(id, 20)) return id } }
const related = (from: string, to: string[]) => to.map((id) => ({ from, to: id, kind: 'related' as const }))

describe('the probe draw', () => {
  const ids = Array.from({ length: 20_000 }, () => randomUUID())
  test('is a pure function of the turn id, at the slider\'s rate, independent of the injection coin', () => {
    for (const id of ids.slice(0, 200)) { expect(probeDrawn(id, 40)).toBe(probeDrawn(id, 40)); expect(probeArm(id)).toBe(probeArm(id)) }
    for (const rate of [0, 20, 60, 100]) expect(Math.abs(100 * ids.filter((id) => probeDrawn(id, rate)).length / ids.length - rate)).toBeLessThan(1.5)
    const both = ids.filter((id) => probeDrawn(id, 50) && injectionCoin(id, 50)).length
    expect(Math.abs(100 * both / ids.length - 25)).toBeLessThan(1.5)
  })
  test('the arm is a fair coin, also among the turns that draw a probe', () => {
    const drawn = ids.filter((id) => probeDrawn(id, 40))
    for (const set of [ids, drawn]) expect(Math.abs(100 * set.filter((id) => probeArm(id) === 'held_out').length / set.length - 50)).toBeLessThan(2)
  })
  test('an uppercase turn id draws what its lowercase form draws (Postgres stores it lowercase)', () => {
    for (const id of ids.slice(0, 200)) { expect(probeDrawn(id.toUpperCase(), 40)).toBe(probeDrawn(id, 40)); expect(probeArm(id.toUpperCase())).toBe(probeArm(id)) }
  })
})

describe('selectProbe', () => {
  const t = taught[0]!, h1 = heldIds[0]!, h2 = heldIds[1]!, t1 = taught[1]!, t2 = taught[2]!
  const edges = related(t, [h1, h2, t1, t2])
  const base = { rate: 100, hops: 1, turnConceptIds: [t], edges, catalogIds, heldOut: held }

  test('with a candidate in both arms: the coin picks the arm, the pick is in it, and the draw records both counts', () => {
    for (let i = 0; i < 50; i++) {
      const turnId = randomUUID(), { probe, draw } = selectProbe({ ...base, turnId })
      expect(probe!.arm).toBe(probeArm(turnId))
      expect(held.has(probe!.conceptId)).toBe(probe!.arm === 'held_out')
      expect([h1, h2, t1, t2]).toContain(probe!.conceptId)
      expect(probe).toMatchObject({ hops: 1, relatedTo: t })
      expect(draw).toEqual({ outcome: 'delivered', rate: 100, hops: 1, arm: probeArm(turnId), heldOutCandidates: 2, taughtCandidates: 2, conceptId: probe!.conceptId })
      expect(selectProbe({ ...base, turnId })).toEqual(selectProbe({ ...base, turnId: turnId.toUpperCase() })) // a replay probes the same concept
    }
  })
  test('within an arm every related concept is about equally likely', () => {
    const picks = new Map<string, number>()
    for (let i = 0; i < 4000; i++) { const p = selectProbe({ ...base, turnId: randomUUID() }).probe!; picks.set(p.conceptId, (picks.get(p.conceptId) ?? 0) + 1) }
    for (const id of [h1, h2, t1, t2]) expect(Math.abs(100 * picks.get(id)! / 4000 - 25)).toBeLessThan(3)
  })
  test('a turn with a candidate in only one arm is probed in NEITHER arm, and the draw says why', () => {
    for (const [only, counts] of [[[t1, t2], { heldOutCandidates: 0, taughtCandidates: 2 }], [[h1, h2], { heldOutCandidates: 2, taughtCandidates: 0 }]] as const)
      for (const arm of ['held_out', 'taught'] as const) {
        const { probe, draw } = selectProbe({ ...base, edges: related(t, [...only]), turnId: turnFor(arm) })
        expect(probe).toBeNull()
        expect(draw).toMatchObject({ outcome: 'arm_empty', arm, conceptId: null, ...counts })
      }
  })
  test('rate 0 never draws; only concepts within the hop distance are candidates; an unconnected turn has none', () => {
    expect(selectProbe({ ...base, rate: 0, turnId: turnFor('taught') })).toEqual({ probe: null, candidates: null, draw: { outcome: 'not_drawn', rate: 0, hops: 1, arm: null, heldOutCandidates: null, taughtCandidates: null, conceptId: null } })
    const far = [...related(t, [t1]), ...related(t1, [h1])]
    const turnId = turnFor('held_out')
    expect(selectProbe({ ...base, edges: far, hops: 1, turnId }).draw).toMatchObject({ outcome: 'arm_empty', heldOutCandidates: 0, taughtCandidates: 1 })
    expect(selectProbe({ ...base, edges: far, hops: 2, turnId }).probe).toMatchObject({ conceptId: h1, hops: 2 })
    expect(selectProbe({ ...base, edges: [], turnId }).draw).toMatchObject({ outcome: 'arm_empty', heldOutCandidates: 0, taughtCandidates: 0 })
    // The turn's own concepts are never candidates.
    expect(probeCandidates({ ...base, turnConceptIds: [t, h1, t1], turnId })).toMatchObject({ held_out: [{ conceptId: h2 }], taught: [{ conceptId: t2 }] })
  })
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
  for (const hops of [1, 2]) test(`${hops} hop${hops > 1 ? 's' : ''}: probes split evenly between the arms and both arms come from the same turns`, () => {
    const draws = turns.map((turn) => ({ ...selectProbe({ ...turn, rate: 100, hops, edges, catalogIds, heldOut: held }), ...turn }))
    const delivered = draws.filter((d) => d.probe)
    const oneArmOnly = draws.filter((d) => !d.probe)
    // The fixture has what the real graph has: many turns with no held-out concept in range.
    expect(share(oneArmOnly.length, draws.length)).toBeGreaterThan(hops === 1 ? 50 : 25)
    expect(oneArmOnly.every((d) => d.draw.outcome === 'arm_empty' && (d.draw.heldOutCandidates === 0 || d.draw.taughtCandidates === 0))).toBe(true)
    // What the old rule did on the same turns (arm first, deliver if THAT arm has a candidate): held-out probes are the minority.
    const old = draws.filter((d) => (d.draw.arm === 'held_out' ? d.draw.heldOutCandidates! : d.draw.taughtCandidates!) > 0)
    expect(share(old.filter((d) => d.draw.arm === 'held_out').length, old.length)).toBeLessThan(hops === 1 ? 36 : 45)
    // The rule: every probed turn had both arms to choose from, and the coin splits them evenly.
    expect(delivered.every((d) => d.draw.heldOutCandidates! > 0 && d.draw.taughtCandidates! > 0 && d.probe!.arm === probeArm(d.turnId) && held.has(d.probe!.conceptId) === (d.probe!.arm === 'held_out'))).toBe(true)
    const heldProbes = delivered.filter((d) => d.probe!.arm === 'held_out'), taughtProbes = delivered.filter((d) => d.probe!.arm === 'taught')
    expect(Math.abs(share(heldProbes.length, delivered.length) - 50)).toBeLessThan(2.5)
    // Same turn population: the turns probed in either arm look alike in what they had on offer.
    const mean = (rows: typeof delivered, key: 'heldOutCandidates' | 'taughtCandidates' | 'size') => rows.reduce((sum, d) => sum + (key === 'size' ? d.turnConceptIds.length : d.draw[key]!), 0) / rows.length
    for (const key of ['heldOutCandidates', 'taughtCandidates', 'size'] as const) expect(Math.abs(mean(heldProbes, key) / mean(taughtProbes, key) - 1)).toBeLessThan(0.06)
    // At the real 20% rate the drawn turns are a fifth of them and split the same way.
    const at20 = delivered.filter((d) => probeDrawn(d.turnId, 20))
    expect(Math.abs(share(at20.length, delivered.length) - 20)).toBeLessThan(2.5)
    expect(Math.abs(share(at20.filter((d) => d.probe!.arm === 'held_out').length, at20.length) - 50)).toBeLessThan(5)
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
    const notDrawn = taskTeachingContext({ ...base, probe: { turnId: turnFor('taught'), rate: 0, hops: 1 } })
    expect({ ...notDrawn, probe: null } as typeof notDrawn).toEqual(off)
    expect(notDrawn.probe).toMatchObject({ outcome: 'not_drawn', arm: null, conceptId: null })
    expect(off.context).not.toContain('probe')
    expect([off.probeConceptId, off.probe]).toEqual([null, null])
  })
  test('on: one probe on its own line, the same shape and words for both arms, never a teaching target', () => {
    const off = taskTeachingContext(base)
    const packets = (['held_out', 'taught'] as const).map((arm) => taskTeachingContext({ ...base, probe: { turnId: turnFor(arm), rate: 100, hops: 1 } }))
    expect(packets.map((p) => p.probeConceptId)).toEqual([h, t1])
    expect(packets.map((p) => p.probe)).toEqual((['held_out', 'taught'] as const).map((arm, i) => ({ outcome: 'delivered', rate: 100, hops: 1, arm, heldOutCandidates: 1, taughtCandidates: 1, conceptId: [h, t1][i]! })))
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
    const p = taskTeachingContext({ ...base, ids: [t, h], edges: [...related(t, [h, t1, h2]), { from: h, to: t, kind: 'hard-prerequisite' as const }, { from: h2, to: t, kind: 'hard-prerequisite' as const }], probe: { turnId: turnFor('held_out'), rate: 100, hops: 1 } })
    for (const id of [h, h2]) { expect(p.conceptIds).not.toContain(id); expect(targetsOf(p.context).map((n) => n.conceptId)).not.toContain(id) }
    // h is one of the turn's own concepts, so it is not a candidate; h2 is the probe and nothing else.
    expect(p.probeConceptId).toBe(h2)
    expect(p.context.split(h2).length - 1).toBe(1)
  })
  test('no taught-only signal: a suppressed (recently taught or demonstrated) concept is still a candidate', () => {
    const p = taskTeachingContext({ ...base, suppressed: new Set([t1]), probe: { turnId: turnFor('taught'), rate: 100, hops: 1 } })
    expect([p.probeConceptId, p.probe!.taughtCandidates]).toEqual([t1, 1])
  })
  test('a concept the packet was about to teach is probed instead when the coin and the pick land on it', () => {
    // t1 is an unmet prerequisite of t: without probes the packet teaches it.
    const prerequisite = [...related(t, [h]), { from: t1, to: t, kind: 'hard-prerequisite' as const }]
    const off = taskTeachingContext({ ...base, edges: prerequisite })
    expect(off.conceptIds).toEqual([t1, t])
    const taughtArm = taskTeachingContext({ ...base, edges: prerequisite, probe: { turnId: turnFor('taught'), rate: 100, hops: 1 } })
    expect([taughtArm.probeConceptId, taughtArm.conceptIds, targetsOf(taughtArm.context).map((n) => n.conceptId)]).toEqual([t1, [t], [t]])
    // The held-out arm of the same kind of turn keeps the packet whole: the turn was probed either way.
    const heldArm = taskTeachingContext({ ...base, edges: prerequisite, probe: { turnId: turnFor('held_out'), rate: 100, hops: 1 } })
    expect([heldArm.probeConceptId, heldArm.conceptIds]).toEqual([h, [t1, t]])
  })
  test('lowest priority: no probe without a task target, none when the five slots are full, none past the size ceiling: decided on the turn, the same for both arms', () => {
    for (const arm of ['held_out', 'taught'] as const) {
      const probe = { turnId: turnFor(arm), rate: 100, hops: 1 }
      // Nothing to teach (the only concept is held out): a probe alone never makes a turn worth injecting,
      // and no probe line reaches the context of a packet without a target.
      const alone = taskTeachingContext({ ...base, ids: [h], edges: related(h, [t1, h2]), probe })
      expect([alone.conceptIds, alone.probeConceptId, alone.probe!.outcome, alone.probe!.arm]).toEqual([[], null, 'no_target', arm])
      expect(alone.context).toBe(taskTeachingContext({ ...base, ids: [h], edges: related(h, [t1, h2]) }).context)
      expect(alone.context).not.toContain('probe')
      const five = taught.slice(0, 5), spare = taught[5]!
      const full = taskTeachingContext({ ...base, ids: five, edges: related(five[0]!, [spare, h]), probe })
      expect(full.conceptIds).toHaveLength(5)
      expect([full.probeConceptId, full.probe!.outcome, full.probe!.heldOutCandidates, full.probe!.taughtCandidates]).toEqual([null, 'packet_full', 1, 1])
      expect(taskTeachingContext({ ...base, ids: five.slice(0, 4), edges: related(five[0]!, [spare, h]), probe }).probeConceptId).toBe(arm === 'taught' ? spare : h)
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
})
