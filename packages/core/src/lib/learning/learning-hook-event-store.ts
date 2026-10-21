import { metaDbQuery } from '../db-metadata/_shared.js'
import type { LearningHookEvent } from './learning-hooks.js'

/**
 * The learning application owns this durable event store. The harness is only
 * a provider transport and must not write learning failures or events into its
 * receipt/event files. The event id is the idempotency key for both retries and
 * duplicate provider deliveries.
 */
export async function storeLearningHookEvent(
  event: LearningHookEvent,
): Promise<{ stored: boolean; eventId: string }> {
  const result = await metaDbQuery<{ event_id: string }>(
    `INSERT INTO learning_hook_events (
       event_id, provider, source_event, kind, role, text, thread_id,
       exchange_id, agent, agent_id, model, transcript_path, cwd, occurred_at,
       received_at, payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      event.id,
      event.provider,
      event.sourceEvent,
      event.kind,
      event.role,
      event.text,
      event.threadId,
      event.exchangeId,
      event.agent,
      event.agentId,
      event.model,
      event.transcriptPath,
      event.cwd,
      event.occurredAt,
      event.receivedAt,
      JSON.stringify(event.payload),
    ],
  )
  return { stored: result.rowCount > 0, eventId: event.id }
}
