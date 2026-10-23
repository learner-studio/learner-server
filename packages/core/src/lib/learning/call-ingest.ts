import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { UNKNOWN_SPEAKER, type CallAttributionKind, type CallIdentity, type CallParticipant, type CallSpeech, type DesktopCallTranscript, type IngestCall, type ReadAiCallPayload } from '@learner/contract'
import { stableUuid } from './learner-desktop-transcripts.js'

type CallTranscript = z.infer<typeof DesktopCallTranscript>

/**
 * Meeting transcripts from any provider, in two steps:
 *
 * 1. An adapter turns the provider's payload into provider-neutral `CallSpeech`
 *    (lines of speaker, text, time). That is the only provider-specific code.
 * 2. `attributeSpeakers` finds the learner's lines (see CallAttributionKind) and
 *    `callTranscript` builds the call_transcripts row; the shared call path
 *    then merges lines into turns, stores the row and grades the learner's
 *    speech. Both are pure, so a changed identity or a person's choice
 *    re-derives every stored call the same way.
 */
const iso = (value: string | number | null | undefined): string | null => {
  if (value === null || value === undefined || value === '') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Read.ai: speaker blocks carry a display name and epoch-ms times; empty blocks are dropped. */
export function readAiSpeech(payload: ReadAiCallPayload): CallSpeech {
  return {
    sessionId: payload.session_id,
    title: payload.title ?? null,
    startedAt: iso(payload.start_time),
    endedAt: iso(payload.end_time),
    platform: payload.platform ?? null,
    participants: (payload.participants ?? []).map((p) => ({ name: p.name?.trim() || null, email: p.email?.trim() || null })).filter((p) => p.name || p.email),
    lines: (payload.transcript?.speaker_blocks ?? []).flatMap((b) => {
      const text = (b.words ?? '').trim()
      return text ? [{ speaker: b.speaker?.name?.trim() || UNKNOWN_SPEAKER, text, at: iso(b.start_time)!, endAt: iso(b.end_time) }] : []
    }),
    isDemo: false,
    metadata: { report_url: payload.report_url ?? null, owner_email: payload.owner?.email ?? null },
  }
}

/**
 * A row learner-desktop attributed on the device, back to neutral speech: the
 * device's learner flags are dropped so the server's rules decide, like every
 * other source. A participant is a bare string there; one with an `@` is an email.
 */
export function desktopSpeech(call: z.infer<typeof DesktopCallTranscript>): CallSpeech {
  const participants = call.participants.flatMap((p): CallParticipant[] => {
    if (typeof p === 'string') return p.trim() ? [p.includes('@') ? { email: p.trim(), name: null } : { name: p.trim(), email: null }] : []
    if (p && typeof p === 'object') {
      const { name, email } = p as { name?: unknown; email?: unknown }
      const person = { name: typeof name === 'string' && name.trim() ? name.trim() : null, email: typeof email === 'string' && email.trim() ? email.trim() : null }
      return person.name || person.email ? [person] : []
    }
    return []
  })
  return {
    sessionId: call.sessionId,
    title: call.meetingTitle,
    startedAt: call.eventTime,
    endedAt: null,
    platform: call.platform ?? null,
    participants,
    lines: call.utterances.map((u) => ({ speaker: u.speaker, text: u.text, at: u.at, endAt: null })),
    category: call.callCategory ?? null,
    isDemo: call.isDemo,
    metadata: { ...call.metadata, filename: call.filename },
  }
}

/** The provider-neutral speech for any accepted format, with the source it is filed under. */
export function ingestSpeech(item: IngestCall): { source: string; speech: CallSpeech } {
  switch (item.format) {
    case 'readai': return { source: 'readai', speech: readAiSpeech(item.payload) }
    case 'speech': return { source: item.source, speech: item.call }
  }
}

const normalName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase()

/** The same meeting delivered by two sources: one title (ignoring case, spacing and punctuation), starting within this window. */
export const SAME_MEETING_WINDOW_MS = 45 * 60_000
const normalTitle = (title: string) => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
export function sameMeeting(a: { title: string; at: string }, b: { title: string; at: string }): boolean {
  return normalTitle(a.title) !== '' && normalTitle(a.title) === normalTitle(b.title) && Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= SAME_MEETING_WINDOW_MS
}

export type CallAttribution = { kind: CallAttributionKind; learnerSpeakers: string[] }

/**
 * Which speaker labels are the learner's. A person's choice for this call
 * (`claimed`, possibly empty) wins; then the identity's names; then, when the
 * learner is present, elimination: if every other participant has a label of
 * their own and exactly one label belongs to no participant, that label is the
 * learner. Anything else is `unattributed` and waits for a person.
 */
export function attributeSpeakers(speech: Pick<CallSpeech, 'participants' | 'lines'>, identity: CallIdentity, claimed: readonly string[] | null): CallAttribution {
  const labels = [...new Set(speech.lines.map((l) => l.speaker))]
  if (claimed) {
    const chosen = new Set(claimed.map(normalName))
    return { kind: 'claimed', learnerSpeakers: labels.filter((l) => chosen.has(normalName(l))) }
  }
  const names = new Set(identity.names.map(normalName))
  const emails = new Set(identity.emails.map((e) => e.toLowerCase()))
  const named = labels.filter((l) => names.has(normalName(l)))
  if (named.length) return { kind: 'named', learnerSpeakers: named }
  const isLearner = (p: CallParticipant) => (!!p.name && names.has(normalName(p.name))) || (!!p.email && emails.has(p.email.toLowerCase()))
  if (!speech.participants.some(isLearner)) return { kind: 'absent', learnerSpeakers: [] }
  const labelSet = new Set(labels.map(normalName))
  const others = speech.participants.filter((p) => !isLearner(p))
  const unaccounted = others.filter((p) => !p.name || !labelSet.has(normalName(p.name)))
  const participantNames = new Set(others.flatMap((p) => p.name ? [normalName(p.name)] : []))
  const strangers = labels.filter((l) => !participantNames.has(normalName(l)))
  return unaccounted.length === 0 && strangers.length === 1
    ? { kind: 'inferred', learnerSpeakers: strangers }
    : { kind: 'unattributed', learnerSpeakers: [] }
}
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `(${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')})`
}

/** One call as the pipeline holds it: where it came from, the id its row and spool file keep, and its speech. */
export type CallRecord = { source: string; callId: string; speech: CallSpeech }
export const callRecord = (source: string, speech: CallSpeech, callId = stableUuid(source, speech.sessionId)): CallRecord => ({ source, callId, speech })

/**
 * A provider-neutral call as a call_transcripts row. The learner is whoever
 * speaks under one of `attribution.learnerSpeakers`; every other speaker is
 * context. Lines are put in spoken order. `utterances` is empty for a call
 * with no speech, which the caller must not store.
 */
export function callTranscript({ source, callId, speech }: CallRecord, attribution: CallAttribution): CallTranscript {
  const learner = new Set(attribution.learnerSpeakers)
  const isLearner = (name: string) => learner.has(name)
  const lines = [...speech.lines].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const startMs = Date.parse(speech.startedAt ?? lines[0]?.at ?? new Date(0).toISOString())
  const utterances = lines.map((l) => ({ speaker: l.speaker, text: l.text, at: l.at, learner: isLearner(l.speaker) }))
  const mine = lines.filter((l) => isLearner(l.speaker))
  const cleanTranscript = lines.map((l) => `${clock(Date.parse(l.at) - startMs)} ${l.speaker}: ${l.text}`).join('\n')
  let totalTurns = 0, learnerTurns = 0, previous: string | null = null
  for (const u of utterances) {
    if (u.speaker !== previous) { totalTurns++; if (u.learner) learnerTurns++ }
    previous = u.speaker
  }
  const filename = typeof speech.metadata.filename === 'string' ? speech.metadata.filename : `${source}/${speech.sessionId}`
  return {
    callId,
    sessionId: speech.sessionId,
    filename,
    meetingTitle: speech.title ?? '',
    platform: speech.platform ?? null,
    eventTime: speech.startedAt ?? new Date(startMs).toISOString(),
    participants: speech.participants.map((p) => p.name ?? p.email!),
    benPresent: attribution.kind !== 'absent' || mine.length > 0,
    benSpoke: mine.length > 0,
    isDemo: speech.isDemo,
    callCategory: speech.category ?? null,
    totalTurns,
    benTurns: learnerTurns,
    benTotalSpeechSec: Math.round(mine.reduce((s, l) => s + Math.max(0, Date.parse(l.endAt ?? l.at) - Date.parse(l.at)), 0) / 1000),
    cleanTranscript,
    utterances,
    metadata: {
      ...speech.metadata,
      source,
      attribution: attribution.kind,
      learner_speakers: attribution.learnerSpeakers,
      ended_at: speech.endedAt ?? null,
      transcript_sha256: createHash('sha256').update(cleanTranscript).digest('hex'),
    },
  }
}
