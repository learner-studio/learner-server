import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import {
  RecordLearningHookHealthInput, RecordLearningHookHealthOutput, LearningHookHealth,
  deriveLearningHookHealth, sessionFromTranscript,
} from '@learner/core/lib/learning/learning-hook-health.js'

export const recordLearningHookHealth = defineFunction({
  title: 'Record a native Learning hook toggle or failure from a CLI session', expose: true, scopes: ['admin'],
  input: RecordLearningHookHealthInput, output: RecordLearningHookHealthOutput,
  func: async ({ logger }, { provider, sessionId, level, kind, stage, detail, status, occurredAt }, { session }) => {
    await metaDbQuery(
      `INSERT INTO learning_hook_health_events(user_id,provider,session_id,level,kind,stage,detail,status,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [session.userId, provider, sessionId, level, kind, stage ?? null, detail ?? null, status ?? null, occurredAt],
    )
    const line = `[learning-hook] ${provider} ${sessionId} ${kind}${stage ? ` at ${stage}` : ''}${detail ? `: ${detail}` : ''}`
    if (level === 'error') logger.error(line)
    else if (level === 'warning') logger.warn(line)
    else logger.info(line)
    return { recorded: true }
  },
})

export const GetLearningHookHealthInput = z.object({ windowMinutes: z.number().int().min(5).max(1440).default(30) })

export const getLearningHookHealth = defineFunction({
  title: 'Cross-check CLI prompts against Learning hook turns and report silent or failing hooks', expose: true, readonly: true, scopes: ['admin'],
  input: GetLearningHookHealthInput, output: LearningHookHealth,
  func: async ({ logger }, { windowMinutes }, { session }) => {
    const window = `${windowMinutes} minutes`
    const [prompts, turns, toggles, codex, failures] = await Promise.all([
      metaDbQuery<{ session_id: string; at: Date }>(
        `SELECT split_part(logical_message_key,':',2) AS session_id, max(observed_at) AS at FROM learning_semantic_index_messages
          WHERE payload->>'hook'='cli.claude.user' AND observed_at > now()-$1::interval GROUP BY 1`, [window]),
      // The transcript archive is this machine's, with no owner column, so "did the hook run for that prompt" is
      // answered machine-wide; only hook-reported failures are scoped to whoever reported them.
      metaDbQuery<{ session_id: string; at: Date }>(
        `SELECT session_id, max(created_at) AS at FROM learning_live_feedback_turns GROUP BY 1`, []),
      metaDbQuery<{ session_id: string; kind: string; at: Date }>(
        `SELECT DISTINCT ON (session_id) session_id, kind, occurred_at AS at FROM learning_hook_health_events
          WHERE kind IN ('session_disabled','session_enabled') ORDER BY session_id, occurred_at DESC`, []),
      metaDbQuery<{ relative_path: string; at: Date }>(
        // The archiver re-reads every rollout each pass, so last_success_at is scan time; the file's mtime is activity.
        `SELECT relative_path, to_timestamp(source_mtime_ns/1e9) AS at FROM learning_archive_sources
          WHERE provider='codex' AND root_path='/root/.codex/sessions' AND to_timestamp(source_mtime_ns/1e9) > now()-$1::interval`, [window]),
      metaDbQuery<{ provider: 'claude' | 'codex'; session_id: string; level: 'warning' | 'error'; kind: 'service_delayed' | 'hook_failed'; stage: string | null; detail: string | null; at: Date }>(
        `SELECT provider, session_id, level, kind, stage, detail, occurred_at AS at FROM learning_hook_health_events
          WHERE user_id=$1 AND level IN ('warning','error') AND occurred_at > now()-$2::interval`, [session.userId, window]),
    ])
    const health = deriveLearningHookHealth({
      now: new Date(), windowMinutes,
      prompts: prompts.rows.map(r => ({ sessionId: r.session_id, at: new Date(r.at) })),
      turns: turns.rows.map(r => ({ sessionId: r.session_id, at: new Date(r.at) })),
      toggles: toggles.rows.map(r => ({ sessionId: r.session_id, mode: r.kind === 'session_disabled' ? 'off' as const : 'on' as const, at: new Date(r.at) })),
      codexActivity: codex.rows.flatMap(r => { const sessionId = sessionFromTranscript('codex', r.relative_path); return sessionId ? [{ sessionId, at: new Date(r.at) }] : [] }),
      failures: failures.rows.map(r => ({ provider: r.provider, sessionId: r.session_id, level: r.level, kind: r.kind, stage: r.stage, detail: r.detail, at: new Date(r.at) })),
    })
    if (health.status === 'error') logger.error(`[learning-hook] health error: ${health.messages.join(' | ')}`)
    else if (health.status === 'warning') logger.warn(`[learning-hook] health warning: ${health.messages.join(' | ')}`)
    return health
  },
})
