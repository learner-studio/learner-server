import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import { PROBE_GUIDANCE, probeArm, probeDrawn, selectProbe, type ProbeArm } from './learning-blind-probes.js'
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
})

describe('selectProbe', () => {
  const t = taught[0]!, h1 = heldIds[0]!, h2 = heldIds[1]!, t1 = taught[1]!, t2 = taught[2]!
  const edges = related(t, [h1, h2, t1, t2])
  const base = { rate: 100, hops: 1, turnConceptIds: [t], edges, catalogIds, heldOut: held, skip: new Set<string>() }

  test('draws only from the arm the coin chose, never from the turn\'s own concepts or the skipped ones', () => {
    for (let i = 0; i < 50; i++) {
      const turnId = randomUUID(), probe = selectProbe({ ...base, turnId })!
      expect(probe.arm).toBe(probeArm(turnId))
      expect(held.has(probe.conceptId)).toBe(probe.arm === 'held_out')
      expect([h1, h2, t1, t2]).toContain(probe.conceptId)
      expect(probe).toMatchObject({ hops: 1, relatedTo: t })
      expect(selectProbe({ ...base, turnId })).toEqual(probe) // a replay probes the same concept
      const other = selectProbe({ ...base, turnId, skip: new Set([probe.conceptId]) })!
      expect(other.conceptId).not.toBe(probe.conceptId)
      expect(other.arm).toBe(probe.arm)
    }
  })
  test('within an arm every related concept is about equally likely', () => {
    const picks = new Map<string, number>()
    for (let i = 0; i < 4000; i++) { const p = selectProbe({ ...base, turnId: randomUUID() })!; picks.set(p.conceptId, (picks.get(p.conceptId) ?? 0) + 1) }
    for (const id of [h1, h2, t1, t2]) expect(Math.abs(100 * picks.get(id)! / 4000 - 25)).toBeLessThan(3)
  })
  test('an empty arm means no probe: it never falls back to the other arm', () => {
    const onlyTaught = { ...base, edges: related(t, [t1, t2]) }
    expect(selectProbe({ ...onlyTaught, turnId: turnFor('held_out') })).toBeNull()
    expect(selectProbe({ ...onlyTaught, turnId: turnFor('taught') })).not.toBeNull()
  })
  test('rate 0 never probes; only concepts within the hop distance are candidates; an unconnected turn has none', () => {
    expect(selectProbe({ ...base, rate: 0, turnId: turnFor('taught') })).toBeNull()
    const far = [...related(t, [t1]), ...related(t1, [t2])]
    const turnId = turnFor('taught')
    expect(selectProbe({ ...base, edges: far, hops: 1, turnId, skip: new Set([t1]) })).toBeNull()
    expect(selectProbe({ ...base, edges: far, hops: 2, turnId, skip: new Set([t1]) })).toMatchObject({ conceptId: t2, hops: 2 })
    expect(selectProbe({ ...base, edges: [], turnId })).toBeNull()
  })
})

describe('a probe in the turn\'s guidance', () => {
  const t = taught[0]!, h = heldIds[0]!, t1 = taught[1]!
  const edges = related(t, [h, t1])
  const base = { catalog, assessments: [], suppressed: new Set<string>(), gaps: [], foundationFirst: true, prerequisites: prerequisitePolicy(DEFAULT_LEARNING_POLICY), heldOut: held, ids: [t], edges }
  const probeOf = (context: string) => { const line = context.split('\nBlind probe: ')[1]?.split('\n')[0]; return line ? JSON.parse(line) as Record<string, unknown> : null }
  const targetsOf = (context: string) => JSON.parse(context.split('address only remainingGap): ')[1]!.split('\nPrerequisite selection: ')[0]!) as Array<{ conceptId: string }>

  test('off is byte-identical: no probe field, null and rate 0 all give the guidance without probes', () => {
    const off = taskTeachingContext(base)
    expect(taskTeachingContext({ ...base, probe: null })).toEqual(off)
    expect(taskTeachingContext({ ...base, probe: { turnId: turnFor('taught'), rate: 0, hops: 1 } })).toEqual(off)
    expect(off.context).not.toContain('probe')
    expect(off.probeConceptId).toBeNull()
  })
  test('on: one probe on its own line, the same shape and words for both arms, never a teaching target', () => {
    const off = taskTeachingContext(base)
    const packets = (['held_out', 'taught'] as const).map((arm) => taskTeachingContext({ ...base, probe: { turnId: turnFor(arm), rate: 100, hops: 1 } }))
    expect(packets.map((p) => p.probeConceptId)).toEqual([h, t1])
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
    const p = taskTeachingContext({ ...base, ids: [t, h], edges: [...edges, { from: h, to: t, kind: 'hard-prerequisite' as const }], probe: { turnId: turnFor('held_out'), rate: 100, hops: 1 } })
    expect(p.conceptIds).not.toContain(h)
    expect(targetsOf(p.context).map((n) => n.conceptId)).not.toContain(h)
    // h is one of the turn's own concepts here, so it is not a probe candidate either.
    expect(p.probeConceptId).toBeNull()
  })
  test('lowest priority: no probe without a teaching target, none when the five slots are full, dropped first under the size ceiling', () => {
    const probe = { turnId: turnFor('taught'), rate: 100, hops: 1 }
    // Nothing to teach (the only concept is held out): a probe alone never makes a turn worth injecting.
    const alone = taskTeachingContext({ ...base, ids: [h], edges: related(h, [t1]), probe })
    expect([alone.conceptIds, alone.probeConceptId]).toEqual([[], null])
    const five = taught.slice(0, 5), spare = taught[5]!
    const full = taskTeachingContext({ ...base, ids: five, edges: related(five[0]!, [spare]), probe })
    expect(full.conceptIds).toHaveLength(5)
    expect(full.probeConceptId).toBeNull()
    expect(taskTeachingContext({ ...base, ids: five.slice(0, 4), edges: related(five[0]!, [spare]), probe }).probeConceptId).toBe(spare)
    // A gap long enough that targets + probe pass 4,000 characters but the targets alone do not.
    const short = taskTeachingContext({ ...base, gaps: [{ conceptId: t, remainingGap: '' }] }).context.length
    const gaps = [{ conceptId: t, remainingGap: 'g'.repeat(3900 - short) }]
    expect(taskTeachingContext({ ...base, gaps: [{ conceptId: t, remainingGap: 'g' }], probe }).probeConceptId).toBe(t1) // it fits with a short gap
    const tight = taskTeachingContext({ ...base, gaps, probe })
    expect(tight.probeConceptId).toBeNull()
    expect(tight).toEqual(taskTeachingContext({ ...base, gaps }))
    expect(tight.conceptIds).toEqual([t])
    expect(tight.context.length).toBeLessThanOrEqual(4000)
  })
})
