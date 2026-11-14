import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/rev9-channel-replies.json'
import { factSheet } from './learning-sim-facts.js'
import { factsBySentence, redactReply, type StatedFact } from './learning-sim-matcher.js'
import { SIM_SHEETS } from './learning-sim-experiment.js'

/** One stored reply with the channel state before it (what its session had counted, the budget left), and the
 * channel's pinned outputs. Drawn once, by a seeded sample, from revision 9's run ccec88a3 (`meta.raw`); no arm. */
type Entry = { id: string; raw: string; claimed: string[]; counted: string[]; budgetLeft: number
  expect: { statedFacts: StatedFact[]; withheld: string[]; overBudget: string[]; unoffered: string[]; redacted: number } }
const replies = fixture.replies as unknown as Entry[]
const ALL_FACTS = new Set(SIM_SHEETS.flatMap((id) => factSheet(id).facts.map((f) => f.id)))

describe('revision 10 channel on 20 of revision 9\'s stored agent replies', () => {
  test('the fixture covers every path, an unverified claim and an over-budget redaction, with no arm', () => {
    expect(replies.length).toBe(20)
    const paths = new Set(replies.flatMap((r) => r.expect.statedFacts.map((s) => s.path)))
    expect([...paths].sort()).toEqual(['attributed', 'matched', 'matched-claimed'])
    expect(replies.some((r) => r.expect.withheld.length && r.expect.redacted)).toBe(true)
    expect(replies.some((r) => r.expect.overBudget.length)).toBe(true)
    for (const r of replies) expect(Object.keys(r).sort()).toEqual(['budgetLeft', 'claimed', 'counted', 'expect', 'id', 'raw'])
  })

  test('each reply, every sheet offered while budget is left, reaches its pinned delivery path by path, and the learner reads nothing beyond the record', () => {
    for (const { expect: want, id, raw, claimed, counted, budgetLeft } of replies) {
      const out = redactReply(raw.trim(), budgetLeft ? ALL_FACTS : new Set(), new Set(counted), budgetLeft, new Set(claimed))
      expect({ id, statedFacts: out.statedFacts, withheld: out.withheld, overBudget: out.overBudget, unoffered: out.unoffered, redacted: out.redacted }).toEqual({ id, ...want })
      expect(out.budgeted.length).toBeLessThanOrEqual(budgetLeft)
      const record = new Set([...counted, ...out.budgeted])
      expect(factsBySentence(out.text).flatMap((x) => x.facts).filter((f) => !record.has(f))).toEqual([])
      // A delivered fact's path is what the text and the claim list say: claimed and found, claimed and placed, found.
      const found = new Set(factsBySentence(raw.trim()).flatMap((x) => x.facts))
      for (const s of out.statedFacts) expect(s.path).toBe(!claimed.includes(s.factId) ? 'matched' : found.has(s.factId) ? 'matched-claimed' : 'attributed')
    }
  })
})
