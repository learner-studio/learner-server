// Read-only canonical inventory of exposure observations grouped by turn.
// Never prints transcript text or writes state.
import { sql } from 'kysely'
import { LearningExposureService } from '@learner/core/services/learning-exposure-service.js'
import { openLearnerDatabase, usage } from './_db.js'

usage(`
Usage: bun --env-file=/etc/learner/db.env scripts/learning/turn-count-audit.ts
Prints a JSON histogram of exposure turns (human/assistant message counts per
Codex turn or run) from the learner database. Read-only.`)

const handle = openLearnerDatabase({ readOnly: true })
const db = handle.kysely
try {
  const service = new LearningExposureService(db)
  const items: Awaited<ReturnType<typeof service.query>>['items'] = []
  let cursor: string | undefined
  do {
    const page = await service.query({ limit: 100, cursor, includeUnknown: false })
    items.push(...page.items)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  const groups = new Map<string, { humans: Set<string>; agents: number; finals: number }>()
  const unkeyed: Record<string, number> = {}
  for (const item of items) {
    const o = item.observation
    const c = o.correlation
    const key = typeof c.codexThreadId === 'string' && typeof c.codexTurnId === 'string'
      ? `codex:${c.codexThreadId}:${c.codexTurnId}`
      : typeof c.runId === 'string' ? `run:${c.runId}` : null
    if (!key) {
      const category = `${o.direction}:${o.hook}`
      unkeyed[category] = (unkeyed[category] ?? 0) + 1
      continue
    }
    const group = groups.get(key) ?? { humans: new Set<string>(), agents: 0, finals: 0 }
    if (o.direction === 'user_to_model') group.humans.add(item.logicalMessageKey!)
    else {
      group.agents++
      if (o.hook === 'cli.codex.assistant_final_answer' || o.stage === 'delivered') group.finals++
    }
    groups.set(key, group)
  }
  const histogram: Record<string, { groups: number; humanMessages: number; assistantMessages: number }> = {}
  for (const group of groups.values()) {
    const category = `${group.humans.size === 0 ? 'zero' : group.humans.size === 1 ? 'one' : 'multiple'}-human:${group.finals ? 'final' : group.agents ? 'commentary-only' : 'no-agent'}`
    const bin = histogram[category] ?? { groups: 0, humanMessages: 0, assistantMessages: 0 }
    bin.groups++
    bin.humanMessages += group.humans.size
    bin.assistantMessages += group.agents
    histogram[category] = bin
  }
  const unknownInput = await sql<{ hook: string; kinds: unknown; messages: string }>`
    SELECT payload->>'hook' AS hook,payload->'correlation'->'contentItemKinds' AS kinds,
      COUNT(DISTINCT logical_message_key)::text AS messages
    FROM learning_exposure_observations
    WHERE direction='unknown' AND payload->'correlation'->>'phase'='input'
    GROUP BY payload->>'hook',payload->'correlation'->'contentItemKinds'
    ORDER BY COUNT(DISTINCT logical_message_key) DESC LIMIT 20`.execute(db)
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), transactionalSnapshot: false,
    visibleMessages: items.length, humanMessages: items.filter(i => i.observation.direction === 'user_to_model').length,
    histogram, unkeyed, unknownInputMetadata: unknownInput.rows }, null, 2))
} finally { await handle.close() }
