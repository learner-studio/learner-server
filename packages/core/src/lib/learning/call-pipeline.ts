import type { z } from 'zod'
import { CallIdentity, CallSpeech, UNKNOWN_SPEAKER, type CallIdentityConfig, type CallNeedingAttribution, type DesktopCallTranscript } from '@learner/contract'
import type { LearnerDesktopHabitsStore } from '../../services/learner-desktop-habits-store.js'
import { metaDbQuery } from '../db-metadata/_shared.js'
import { attributeSpeakers, callTranscript, isTranscript, SAME_MEETING_WINDOW_MS, sameMeeting, type CallRecord } from './call-ingest.js'
import { callTurns, writeDesktopTranscript } from './learner-desktop-transcripts.js'

/**
 * The one path every call takes, whoever sent it and whenever it is re-derived:
 *
 * 1. Its neutral speech is kept in `learning_call_speech`, keyed on the source's session.
 * 2. A session first seen while another source's copy of the same meeting is stored
 *    (`sameMeeting`) is set aside as a duplicate: first arrival wins, so a meeting is
 *    graded once however many sources deliver it.
 * 3. The learner's lines are attributed (`attributeSpeakers`) from the identity and any
 *    choice a person made for that call, the row is upserted into call_transcripts, and
 *    the learner's turns are spooled for grading (an unchanged spool file is a no-op).
 *
 * Steps 3 re-runs over the stored speech when the identity or a choice changes
 * (`reattributeCalls`), so recovered lines are graded without the source resending.
 */
type CallRow = z.infer<typeof DesktopCallTranscript>
type Query = typeof metaDbQuery
export type CallPipelineDeps = { habits: Pick<LearnerDesktopHabitsStore, 'recordCallTranscripts' | 'callsStartingNear'>; uploadRoot: string; query?: Query }
export type CallStoreResult = { accepted: number; updated: number; unchanged: number; duplicates: number; notGraded: number; spooled: Record<string, number> }

type SpeechRow = { session_id: string; source: string; call_id: string; client_id: string; speech: unknown; claimed_speakers: string[] | null; duplicate_of: string | null }

export async function loadCallIdentity(query: Query = metaDbQuery): Promise<CallIdentityConfig> {
  const row = (await query<{ names: unknown; emails: unknown; updated_at: Date }>(`SELECT names, emails, updated_at FROM learning_call_identity WHERE config_key = 'default'`)).rows[0]
  return row ? { ...CallIdentity.parse({ names: row.names, emails: row.emails }), updatedAt: row.updated_at.toISOString() } : { names: [], emails: [], updatedAt: null }
}

export async function saveCallIdentity(identity: CallIdentity, updatedBy: string, query: Query = metaDbQuery): Promise<CallIdentityConfig> {
  const parsed = CallIdentity.parse(identity)
  const unique = { names: [...new Map(parsed.names.map((n) => [n.toLowerCase().replace(/\s+/g, ' '), n])).values()], emails: [...new Set(parsed.emails)] }
  const row = (await query<{ updated_at: Date }>(`INSERT INTO learning_call_identity (config_key, names, emails, updated_by, updated_at) VALUES ('default', $1::jsonb, $2::jsonb, $3, now())
    ON CONFLICT (config_key) DO UPDATE SET names = EXCLUDED.names, emails = EXCLUDED.emails, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
    RETURNING updated_at`, [JSON.stringify(unique.names), JSON.stringify(unique.emails), updatedBy])).rows[0]!
  return { ...unique, updatedAt: row.updated_at.toISOString() }
}

const startedAt = (speech: CallSpeech) => speech.startedAt ?? speech.lines.map((l) => l.at).sort()[0] ?? null

/** Store calls from one client: keep the speech, set duplicates aside, attribute, upsert and spool. Calls under two speaker turns (`isTranscript`) are not stored. */
export async function ingestCalls(deps: CallPipelineDeps, clientId: string, records: readonly CallRecord[]): Promise<CallStoreResult> {
  const query = deps.query ?? metaDbQuery
  const identity = await loadCallIdentity(query)
  const rows: (CallRow & { spoolClientId: string })[] = []
  let duplicates = 0, tooShort = 0
  for (const record of records) {
    if (!isTranscript(record.speech)) { tooShort++; continue }
    const held = (await query<SpeechRow>(`SELECT * FROM learning_call_speech WHERE session_id = $1`, [record.speech.sessionId])).rows[0]
    let duplicateOf = held?.duplicate_of ?? null
    const at = startedAt(record.speech)
    if (!held && at) {
      const title = record.speech.title ?? ''
      duplicateOf = (await deps.habits.callsStartingNear(record.speech.sessionId, at, SAME_MEETING_WINDOW_MS)).find((c) => sameMeeting({ title, at }, c))?.sessionId ?? null
    }
    // The row the upsert leaves is the truth, not the SELECT above: when biztools
    // and the Read AI webhook deliver one meeting at once, both may read no row,
    // and only the first insert's client, call id and duplicate mark survive.
    // The spool path is per client, so every later delivery writes as that
    // owner, or the same call would be spooled (and graded) twice.
    const owner = (await query<{ client_id: string; call_id: string; duplicate_of: string | null }>(`INSERT INTO learning_call_speech (session_id, source, call_id, client_id, speech, duplicate_of) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (session_id) DO UPDATE SET source = EXCLUDED.source, speech = EXCLUDED.speech, updated_at = now()
      RETURNING client_id, call_id, duplicate_of`,
      [record.speech.sessionId, record.source, held?.call_id ?? record.callId, clientId, JSON.stringify(record.speech), duplicateOf])).rows[0]!
    if (owner.duplicate_of) { duplicates++; continue }
    rows.push({ ...callTranscript({ ...record, callId: owner.call_id }, attributeSpeakers(record.speech, identity, held?.claimed_speakers ?? null)), spoolClientId: owner.client_id })
  }
  const stored = await storeCallRows(deps, clientId, rows)
  return { ...stored, duplicates, notGraded: tooShort + (stored.spooled['no-learner-turns'] ?? 0) }
}

async function storeCallRows(deps: CallPipelineDeps, clientId: string, rows: (CallRow & { spoolClientId?: string })[]) {
  // Each call is stored and spooled as the client that owns it (its first deliverer).
  const byOwner = new Map<string, CallRow[]>()
  for (const { spoolClientId, ...row } of rows) byOwner.set(spoolClientId ?? clientId, [...(byOwner.get(spoolClientId ?? clientId) ?? []), row])
  const result = { accepted: 0, updated: 0, unchanged: 0 }
  for (const [owner, owned] of byOwner) {
    const r = await deps.habits.recordCallTranscripts(owner, owned)
    result.accepted += r.accepted; result.updated += r.updated; result.unchanged += r.unchanged
  }
  const spooled: Record<string, number> = {}
  for (const row of rows) {
    const turns = callTurns(row.utterances)
    if (!turns.some((t) => t.role === 'user')) { spooled['no-learner-turns'] = (spooled['no-learner-turns'] ?? 0) + 1; continue }
    const { status } = await writeDesktopTranscript(deps.uploadRoot, row.spoolClientId ?? clientId, 'call', row.callId, turns)
    spooled[status] = (spooled[status] ?? 0) + 1
  }
  return { ...result, spooled }
}

const liveSpeech = async (query: Query, sessionIds?: readonly string[]) => (await query<SpeechRow>(
  `SELECT * FROM learning_call_speech WHERE duplicate_of IS NULL ${sessionIds ? 'AND session_id = ANY($1::text[])' : ''} ORDER BY received_at`,
  sessionIds ? [sessionIds] : [],
)).rows.map((row) => ({ row, speech: CallSpeech.parse(row.speech) }))

/** Re-derive stored calls (all, or the given sessions) from their speech; returns how many rows changed. */
export async function reattributeCalls(deps: CallPipelineDeps, sessionIds?: readonly string[]): Promise<{ reattributed: number; spooled: Record<string, number> }> {
  const query = deps.query ?? metaDbQuery
  const identity = await loadCallIdentity(query)
  const byClient = new Map<string, CallRow[]>()
  for (const { row, speech } of await liveSpeech(query, sessionIds)) {
    if (!isTranscript(speech)) continue
    const call = callTranscript({ source: row.source, callId: row.call_id, speech }, attributeSpeakers(speech, identity, row.claimed_speakers))
    byClient.set(row.client_id, [...(byClient.get(row.client_id) ?? []), call])
  }
  let reattributed = 0
  const spooled: Record<string, number> = {}
  for (const [clientId, rows] of byClient) {
    const r = await storeCallRows(deps, clientId, rows)
    reattributed += r.accepted + r.updated
    for (const [k, v] of Object.entries(r.spooled)) spooled[k] = (spooled[k] ?? 0) + v
  }
  return { reattributed, spooled }
}

/** Calls a person should look at: every `inferred` (to confirm) and `unattributed` (to choose) call, newest first. */
export async function listCallsNeedingAttribution(query: Query = metaDbQuery): Promise<CallNeedingAttribution[]> {
  const identity = await loadCallIdentity(query)
  const calls: CallNeedingAttribution[] = []
  for (const { row, speech } of await liveSpeech(query)) {
    const { kind, learnerSpeakers } = attributeSpeakers(speech, identity, row.claimed_speakers)
    if (!isTranscript(speech)) continue
    if (kind !== 'inferred' && kind !== 'unattributed') continue
    const speakers = new Map<string, { lines: number; sample: string }>()
    for (const l of speech.lines) {
      const s = speakers.get(l.speaker)
      if (s) s.lines++
      else speakers.set(l.speaker, { lines: 1, sample: l.text.slice(0, 160) })
    }
    calls.push({
      sessionId: row.session_id, source: row.source, title: speech.title ?? '', eventTime: startedAt(speech) ?? '', attribution: kind,
      participants: speech.participants.map((p) => p.name ?? p.email!),
      speakers: [...speakers].map(([label, s]) => ({ label, ...s, learner: learnerSpeakers.includes(label) })).sort((a, b) => b.lines - a.lines),
    })
  }
  return calls.sort((a, b) => b.eventTime.localeCompare(a.eventTime))
}

export class CallAttributionError extends Error {}

/**
 * A person's choice of the learner's labels on one call (empty: "I did not speak").
 * With `remember`, each named label also joins the identity, and every stored call
 * is re-derived; otherwise only this call is.
 */
export async function claimCallSpeakers(deps: CallPipelineDeps, input: { sessionId: string; speakers: readonly string[]; remember: boolean }, updatedBy: string): Promise<{ reattributed: number }> {
  const query = deps.query ?? metaDbQuery
  const [held] = await liveSpeech(query, [input.sessionId])
  if (!held) throw new CallAttributionError(`no stored call ${input.sessionId}`)
  const labels = new Set(held.speech.lines.map((l) => l.speaker))
  const unknown = input.speakers.filter((s) => !labels.has(s))
  if (unknown.length) throw new CallAttributionError(`not a speaker on this call: ${unknown.join(', ')}`)
  await query(`UPDATE learning_call_speech SET claimed_speakers = $2::jsonb, updated_at = now() WHERE session_id = $1`, [input.sessionId, JSON.stringify(input.speakers)])
  const remembered = input.speakers.filter((s) => s !== UNKNOWN_SPEAKER)
  if (input.remember && remembered.length) {
    const identity = await loadCallIdentity(query)
    await saveCallIdentity({ names: [...identity.names, ...remembered], emails: identity.emails }, updatedBy, query)
    return { reattributed: (await reattributeCalls(deps)).reattributed }
  }
  return { reattributed: (await reattributeCalls(deps, [input.sessionId])).reattributed }
}
