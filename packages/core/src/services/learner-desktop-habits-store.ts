import type { z } from 'zod'
import type { DesktopCallTranscript, DesktopHabitEvent } from '@learner/contract'
import type { QueryFn } from '../db/handle.js'

type HabitEvent = z.infer<typeof DesktopHabitEvent>
type CallTranscript = z.infer<typeof DesktopCallTranscript>

/**
 * Writes learner-desktop's rows into the `habits` database, which GrowthBook
 * reads as its datasource. The tables keep their original shape (integer
 * breach flags, `*_fired_at` columns holding streak seconds), so the
 * experiment queries are unchanged. Every write is idempotent: habit events
 * on `event_id`, calls on `call_id`. Each row carries
 * `metadata.client_id` so its origin stays visible.
 */
export class LearnerDesktopHabitsStore {
  constructor(private readonly query: QueryFn) {}

  async recordHabitEvents(clientId: string, events: readonly HabitEvent[]): Promise<{ accepted: number; duplicates: number }> {
    const cols = ['event_id', 'session_id', 'call_app', 'call_category', 'timestamp', 'habit_type', 'treatment_arm', 'turn_duration_sec', 'words_spoken',
      'warning_fired_at', 'shock_fired_at', 'latency_to_yield_sec', 'breached_30s', 'breached_60s', 'was_rewarded', 'metadata'] as const
    const params: unknown[] = []
    const tuples = events.map((e) => {
      const row = [e.eventId, e.sessionId, e.callApp ?? null, e.callCategory ?? null, e.timestamp, e.habitType, e.treatmentArm,
        e.turnDurationSec, e.wordsSpoken ?? null, e.warningFiredAtSec ?? null, e.shockFiredAtSec ?? null, e.latencyToYieldSec ?? null,
        e.breached30s ? 1 : 0, e.breached60s ? 1 : 0, e.wasRewarded ? 1 : 0, JSON.stringify({ ...e.metadata, client_id: clientId })]
      const start = params.length
      params.push(...row)
      return `(${row.map((_, i) => `$${start + i + 1}${cols[i] === 'metadata' ? '::jsonb' : cols[i] === 'timestamp' ? '::timestamptz' : ''}`).join(', ')})`
    })
    const result = await this.query(
      `insert into habit_events (${cols.map((c) => `"${c}"`).join(', ')}) values ${tuples.join(', ')} on conflict (event_id) do nothing returning event_id`,
      params,
    )
    return { accepted: result.rows.length, duplicates: events.length - result.rows.length }
  }

  async recordCallTranscripts(clientId: string, calls: readonly CallTranscript[]): Promise<{ accepted: number; updated: number; unchanged: number }> {
    let accepted = 0, updated = 0, unchanged = 0
    for (const c of calls) {
      // `xmax = 0` is true only for a freshly inserted row; an update that
      // changed nothing is filtered by the WHERE and returns no row.
      // The conflict target is session_id (Read.ai's id, unique in the table):
      // rows written before the API carry random call_ids, so a resend adopts
      // the client's callId instead of colliding on the session.
      const r = await this.query<{ inserted: boolean }>(
        `insert into call_transcripts (call_id, session_id, filename, meeting_title, platform, event_time, participants, ben_present, ben_spoke,
           is_demo, call_category, total_turns, ben_turns, ben_total_speech_sec, clean_transcript, metadata)
         values ($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
         on conflict (session_id) do update set call_id = excluded.call_id, filename = excluded.filename, meeting_title = excluded.meeting_title,
           platform = excluded.platform, event_time = excluded.event_time, participants = excluded.participants, ben_present = excluded.ben_present,
           ben_spoke = excluded.ben_spoke, is_demo = excluded.is_demo, call_category = excluded.call_category, total_turns = excluded.total_turns,
           ben_turns = excluded.ben_turns, ben_total_speech_sec = excluded.ben_total_speech_sec, clean_transcript = excluded.clean_transcript,
           metadata = excluded.metadata
         where (call_transcripts.call_id, call_transcripts.clean_transcript, call_transcripts.metadata, call_transcripts.event_time)
           is distinct from (excluded.call_id, excluded.clean_transcript, excluded.metadata, excluded.event_time)
         returning (xmax = 0) as inserted`,
        [c.callId, c.sessionId, c.filename, c.meetingTitle, c.platform ?? null, c.eventTime, JSON.stringify(c.participants),
          c.benPresent ?? null, c.benSpoke ?? null, c.isDemo, c.callCategory ?? null, c.totalTurns ?? null, c.benTurns ?? null,
          c.benTotalSpeechSec ?? null, c.cleanTranscript, JSON.stringify({ ...c.metadata, client_id: clientId })],
      )
      if (!r.rows[0]) unchanged++
      else if (r.rows[0].inserted) accepted++
      else updated++
    }
    return { accepted, updated, unchanged }
  }

  /** Stored calls, other than `sessionId` itself, that started within `windowMs` of `at`: the candidates for the same meeting. */
  async callsStartingNear(sessionId: string, at: string, windowMs: number): Promise<{ sessionId: string; title: string; at: string }[]> {
    const r = await this.query<{ session_id: string; meeting_title: string; event_time: Date }>(
      `select session_id, meeting_title, event_time from call_transcripts
       where session_id <> $1 and event_time between $2::timestamptz - make_interval(secs => $3) and $2::timestamptz + make_interval(secs => $3)`,
      [sessionId, at, windowMs / 1000],
    )
    return r.rows.map((row) => ({ sessionId: row.session_id, title: row.meeting_title, at: row.event_time.toISOString() }))
  }
}
