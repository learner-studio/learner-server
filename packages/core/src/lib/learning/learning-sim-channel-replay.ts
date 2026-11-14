import { factSheet } from './learning-sim-facts.js'
import { factsBySentence, redactReply, type DeliveryPath } from './learning-sim-matcher.js'
import { SIM_SHEETS } from './learning-sim-experiment.js'

/**
 * Revision 10's channel replay (design A3, review B4; 0 model calls): stored raw agent replies run again through
 * today's channel with every sheet offered (A2), session by session in turn order, so each reply sees the budget the
 * replayed channel left it. It never reads ATTRIBUTION_THRESHOLD: the channel applies it.
 */
export type ReplayReply = { learnerId: string; session: number; seq: number; budget: number; raw: string; claimed: string[] }
/** One reply with the channel state before it: what the session had counted and the budget left. */
export type ReplayTurn = { id: string; raw: string; claimed: string[]; counted: string[]; budgetLeft: number }

const ALL_FACTS = new Set(SIM_SHEETS.flatMap((id) => factSheet(id).facts.map((f) => f.id)))

/** The channel on one stored reply, with the offered set every turn gets while budget is left. */
export function replayTurn(t: ReplayTurn) {
  const counted = new Set(t.counted)
  const channel = redactReply(t.raw.trim(), t.budgetLeft ? ALL_FACTS : new Set(), counted, t.budgetLeft, new Set(t.claimed))
  const claimed = new Set(t.claimed)
  // Matcher hits in the raw reply on facts the claim list omits (new to the session), and of those, the delivered.
  const hits = [...new Set(factsBySentence(t.raw.trim()).flatMap((x) => x.facts))].filter((id) => !claimed.has(id) && !counted.has(id))
  // What the learner reads beyond the session's record: must be empty (the channel gate's overBudgetKept).
  const record = new Set([...counted, ...channel.budgeted])
  const keptBeyond = [...new Set(factsBySentence(channel.text).flatMap((x) => x.facts))].filter((id) => !record.has(id))
  const verified = channel.attributed.filter((id) => channel.budgeted.includes(id) || channel.overBudget.includes(id))
  return { channel, missedClaims: channel.attributed.length, verified: verified.length, unverified: channel.attributed.length - verified.length,
    unclaimedHits: hits.length, unclaimedHitsDelivered: hits.filter((id) => channel.budgeted.includes(id)).length, keptBeyond }
}

/** Every reply, each session replayed in turn order from an empty count. */
export function replaySessions(replies: ReplayReply[]) {
  const sessions = new Map<string, ReplayReply[]>()
  for (const r of replies) { const k = `${r.learnerId}|${r.session}`; sessions.set(k, [...(sessions.get(k) ?? []), r]) }
  return [...sessions.values()].flatMap((turns) => {
    const counted: string[] = []
    return [...turns].sort((a, b) => a.seq - b.seq).map((r) => {
      const turn: ReplayTurn = { id: `${r.learnerId}/s${r.session}t${r.seq}`, raw: r.raw, claimed: r.claimed, counted: [...counted], budgetLeft: Math.max(0, r.budget - counted.length) }
      const out = replayTurn(turn)
      counted.push(...out.channel.budgeted)
      return { reply: r, turn, out, overSession: counted.length > r.budget }
    })
  })
}

/** The replay table's row for a set of replayed turns. */
export function replayRow(rows: ReturnType<typeof replaySessions>) {
  const paths = (p: DeliveryPath) => rows.reduce((n, r) => n + r.out.channel.statedFacts.filter((s) => s.path === p).length, 0)
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0)
  const delivered = sum((r) => r.out.channel.budgeted.length)
  return {
    replies: rows.length, claims: sum((r) => r.turn.claimed.length), delivered,
    missedClaims: sum((r) => r.out.missedClaims), verified: sum((r) => r.out.verified), withheld: sum((r) => r.out.channel.withheld.length), unverified: sum((r) => r.out.unverified),
    matched: paths('matched'), matchedClaimed: paths('matched-claimed'), attributed: paths('attributed'),
    unclaimedHits: sum((r) => r.out.unclaimedHits), unclaimedHitsDelivered: sum((r) => r.out.unclaimedHitsDelivered),
    overBudgetKept: sum((r) => r.out.keptBeyond.length) + rows.filter((r) => r.overSession).length,
  }
}
