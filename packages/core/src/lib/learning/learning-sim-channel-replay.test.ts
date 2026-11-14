import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/rev9-channel-replies.json'
import { factsBySentence } from './learning-sim-matcher.js'
import { replayRow, replaySessions, replayTurn, type ReplayTurn } from './learning-sim-channel-replay.js'
import type { StatedFact } from './learning-sim-matcher.js'

type Entry = ReplayTurn & { expect: { statedFacts: StatedFact[]; withheld: string[]; overBudget: string[]; unoffered: string[]; redacted: number } }
const replies = fixture.replies as unknown as Entry[]

describe('revision 10 channel replay: 20 of revision 9\'s stored replies (scripts/learning/sim-channel-replay.ts)', () => {
  test('the fixture is a seeded draw that covers every path, an unverified claim and an over-budget redaction, with no arm', () => {
    expect(replies.length).toBe(20)
    const paths = new Set(replies.flatMap((r) => r.expect.statedFacts.map((s) => s.path)))
    expect([...paths].sort()).toEqual(['attributed', 'matched', 'matched-claimed'])
    expect(replies.some((r) => r.expect.withheld.length && r.expect.redacted)).toBe(true)
    expect(replies.some((r) => r.expect.overBudget.length)).toBe(true)
    for (const r of replies) expect(Object.keys(r).sort()).toEqual(['budgetLeft', 'claimed', 'counted', 'expect', 'id', 'raw'])
  })

  test('each reply goes through the channel to the pinned delivery, path by path, and nothing beyond the record is read', () => {
    for (const { expect: want, ...turn } of replies) {
      const out = replayTurn(turn)
      expect({ id: turn.id, statedFacts: out.channel.statedFacts, withheld: out.channel.withheld, overBudget: out.channel.overBudget, unoffered: out.channel.unoffered, redacted: out.channel.redacted })
        .toEqual({ id: turn.id, ...want })
      expect(out.channel.statedFacts.length).toBeLessThanOrEqual(turn.budgetLeft)
      expect(out.keptBeyond).toEqual([])
      // A delivered fact's path is what the text and the claim list say: claimed and found, claimed and placed, found.
      const found = new Set(factsBySentence(turn.raw.trim()).flatMap((x) => x.facts))
      for (const s of out.channel.statedFacts) expect(s.path).toBe(!turn.claimed.includes(s.factId) ? 'matched' : found.has(s.factId) ? 'matched-claimed' : 'attributed')
    }
  })

  test('sessions replay in turn order against the budget the replayed channel left', () => {
    const session = (seq: number, raw: string, claimed: string[]) => ({ learnerId: 'l', session: 1, seq, budget: 2, raw, claimed })
    const [a, b, c] = replies.filter((r) => r.expect.statedFacts.length)
    const rows = replaySessions([session(2, b!.raw, b!.claimed), session(1, a!.raw, a!.claimed), session(3, c!.raw, c!.claimed)])
    expect(rows.map((r) => r.reply.seq)).toEqual([1, 2, 3])
    expect(rows.map((r) => r.turn.counted.length)).toEqual([0, ...rows.slice(0, 2).map((_, k) => rows.slice(0, k + 1).flatMap((r) => r.out.channel.budgeted).length)])
    expect(replayRow(rows)).toMatchObject({ replies: 3, overBudgetKept: 0 })
    expect(replayRow(rows).delivered).toBeLessThanOrEqual(2)
  })
})
