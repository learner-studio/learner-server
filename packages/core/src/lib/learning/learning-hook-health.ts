import { z } from 'zod'

/**
 * Health of the native Learning hooks in every Claude/Codex CLI session.
 *
 * Two independent signals, because a hook that never RUNS cannot report its
 * own failure. The hook reports what it saw go wrong (recordLearningHookHealth);
 * the cross-check compares human prompts the transcript archiver captured from
 * disk against the turns the hook recorded live. A prompt with no turn beside it
 * is a silent hook — the shape that hid a three-week outage behind a stale
 * single-session gate (2026-09-29..10-21).
 */
export const LearningHookProvider = z.enum(['claude', 'codex'])
export const LearningHookHealthLevel = z.enum(['info', 'warning', 'error'])
export const LearningHookHealthKind = z.enum(['session_disabled', 'session_enabled', 'service_delayed', 'hook_failed'])

export const RecordLearningHookHealthInput = z.object({
  provider: LearningHookProvider,
  sessionId: z.string().uuid(),
  level: LearningHookHealthLevel,
  kind: LearningHookHealthKind,
  stage: z.string().max(64).optional(),
  detail: z.string().max(1000).optional(),
  status: z.number().int().optional(),
  occurredAt: z.string().datetime(),
})
export const RecordLearningHookHealthOutput = z.object({ recorded: z.boolean() })

const TOGGLE = /^\s*(?:\/(?:prompts:)?|\$)learner-(off|on)(?![\w-])|<!-- learner-toggle:(off|on) -->/i

/** Claude `/learner-off` / `/learner-on`; Codex has no custom slash commands, so its skills arrive as `$learner-…`. */
export function parseLearnerToggle(prompt: string | undefined): 'off' | 'on' | null {
  const match = prompt?.match(TOGGLE)
  return (match?.[1] ?? match?.[2])?.toLowerCase() as 'off' | 'on' | undefined ?? null
}

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
const TRANSCRIPT = { claude: new RegExp(`^[^/]+/${UUID}\\.jsonl$`), codex: new RegExp(`rollout-[^/]*-${UUID}\\.jsonl$`) }

/** Session id of a top-level CLI transcript; subagent and tool files are not sessions. */
export function sessionFromTranscript(provider: z.infer<typeof LearningHookProvider>, relativePath: string) {
  return relativePath.match(TRANSCRIPT[provider])?.[1] ?? null
}

type Stamp = { sessionId: string; at: Date }
type Failure = { provider: z.infer<typeof LearningHookProvider>; sessionId: string; level: 'warning' | 'error'; kind: z.infer<typeof LearningHookHealthKind>; stage?: string | null; detail?: string | null; at: Date }
export type LearningHookHealthInput = {
  now: Date; windowMinutes: number
  /** Human prompts from Claude transcripts (semantic index `cli.claude.user`). */
  prompts: Stamp[]
  /** Hook-recorded turns (learning_live_feedback_turns), any provider. */
  turns: Stamp[]
  toggles: (Stamp & { mode: 'off' | 'on' })[]
  /** Codex prompts are not indexed; transcript activity stands in for them. */
  codexActivity: Stamp[]
  failures: Failure[]
}

/** A turn is recorded before the prompt reaches the transcript; allow index clock skew. */
const TURN_SLACK_MS = 2 * 60_000

export const LearningHookSession = z.object({
  provider: LearningHookProvider, sessionId: z.string(), state: z.enum(['live', 'off', 'silent']),
  lastPromptAt: z.string(), lastTurnAt: z.string().nullable(),
})
export const LearningHookHealth = z.object({
  status: z.enum(['ok', 'warning', 'error']), checkedAt: z.string(), windowMinutes: z.number(),
  sessions: z.array(LearningHookSession),
  failures: z.array(z.object({ provider: LearningHookProvider, sessionId: z.string(), level: z.enum(['warning', 'error']), kind: LearningHookHealthKind, stage: z.string().nullable(), detail: z.string().nullable(), at: z.string() })),
  messages: z.array(z.string()),
})

const latestBy = <T extends Stamp>(rows: T[]) => rows.reduce((map, row) => {
  const prior = map.get(row.sessionId)
  if (!prior || prior.at < row.at) map.set(row.sessionId, row)
  return map
}, new Map<string, T>())

export function deriveLearningHookHealth(input: LearningHookHealthInput): z.infer<typeof LearningHookHealth> {
  const since = input.now.getTime() - input.windowMinutes * 60_000
  const recent = (rows: Stamp[]) => rows.filter(row => row.at.getTime() >= since)
  const turns = latestBy(input.turns)
  const toggles = latestBy(input.toggles)
  const sessions = ([['claude', recent(input.prompts)], ['codex', recent(input.codexActivity)]] as const).flatMap(([provider, rows]) =>
    [...latestBy(rows).values()].map(({ sessionId, at }) => {
      const turnAt = turns.get(sessionId)?.at ?? null
      const off = toggles.get(sessionId)?.mode === 'off'
      // Codex activity is not a prompt timestamp, so any turn at all proves the hook ran.
      const heard = turnAt !== null && (provider === 'codex' || turnAt.getTime() >= at.getTime() - TURN_SLACK_MS)
      return { provider, sessionId, state: off ? 'off' as const : heard ? 'live' as const : 'silent' as const, lastPromptAt: at.toISOString(), lastTurnAt: turnAt?.toISOString() ?? null }
    }))
  const failures = input.failures.filter(f => f.at.getTime() >= since).sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 20)
  const silentClaude = sessions.filter(s => s.state === 'silent' && s.provider === 'claude')
  const silentCodex = sessions.filter(s => s.state === 'silent' && s.provider === 'codex')
  const messages = [
    ...silentClaude.map(s => `Claude session ${s.sessionId.slice(0, 8)} sent a prompt at ${s.lastPromptAt} that the Learning hook never recorded.`),
    ...silentCodex.map(s => `Codex session ${s.sessionId.slice(0, 8)} is active with no Learning hook turn — trust the Learning hooks in Codex /hooks.`),
    ...failures.map(f => `${f.provider} ${f.sessionId.slice(0, 8)}: ${f.kind}${f.stage ? ` at ${f.stage}` : ''}${f.detail ? ` (${f.detail})` : ''}`),
  ]
  const status = silentClaude.length || failures.some(f => f.level === 'error') ? 'error' : silentCodex.length || failures.length ? 'warning' : 'ok'
  return {
    status, checkedAt: input.now.toISOString(), windowMinutes: input.windowMinutes, sessions,
    failures: failures.map(f => ({ provider: f.provider, sessionId: f.sessionId, level: f.level, kind: f.kind, stage: f.stage ?? null, detail: f.detail ?? null, at: f.at.toISOString() })),
    messages,
  }
}
