import { createHash } from 'node:crypto'
import type { z } from 'zod'
import type { CallSpeech, DesktopCallTranscript, IngestCall, ReadAiCallPayload } from '@learner/contract'
import { stableUuid } from './learner-desktop-transcripts.js'

type CallTranscript = z.infer<typeof DesktopCallTranscript>

/**
 * Meeting transcripts from any provider, in two steps:
 *
 * 1. An adapter turns the provider's payload into provider-neutral `CallSpeech`
 *    (lines of speaker, text, time). That is the only provider-specific code.
 * 2. `callTranscript` designates the learner's lines by speaker name and builds
 *    the call_transcripts row; the shared call path then merges lines into
 *    turns, stores the row and grades the learner's speech.
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
    participants: (payload.participants ?? []).map((p) => p.name?.trim() || p.email?.trim()).filter((p): p is string => !!p),
    lines: (payload.transcript?.speaker_blocks ?? []).flatMap((b) => {
      const text = (b.words ?? '').trim()
      return text ? [{ speaker: b.speaker?.name?.trim() || 'UNKNOWN_SPEAKER', text, at: iso(b.start_time)!, endAt: iso(b.end_time) }] : []
    }),
    metadata: { report_url: payload.report_url ?? null, owner_email: payload.owner?.email ?? null },
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
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `(${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')})`
}

/**
 * A provider-neutral call as a call_transcripts row. The learner is whoever
 * speaks under one of `learnerSpeakers` (case and spacing ignored); every other
 * speaker is context. Lines are put in spoken order. `utterances` is empty for
 * a call with no speech, which the caller must not store.
 */
export function callTranscript(source: string, speech: CallSpeech, learnerSpeakers: readonly string[]): CallTranscript {
  const learner = new Set(learnerSpeakers.map(normalName))
  const isLearner = (name: string) => learner.has(normalName(name))
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
  return {
    callId: stableUuid(source, speech.sessionId),
    sessionId: speech.sessionId,
    filename: `${source}/${speech.sessionId}`,
    meetingTitle: speech.title ?? '',
    platform: speech.platform ?? null,
    eventTime: speech.startedAt ?? new Date(startMs).toISOString(),
    participants: speech.participants,
    benPresent: mine.length > 0 || speech.participants.some(isLearner),
    benSpoke: mine.length > 0,
    isDemo: false,
    callCategory: null,
    totalTurns,
    benTurns: learnerTurns,
    benTotalSpeechSec: Math.round(mine.reduce((s, l) => s + Math.max(0, Date.parse(l.endAt ?? l.at) - Date.parse(l.at)), 0) / 1000),
    cleanTranscript,
    utterances,
    metadata: {
      ...speech.metadata,
      source,
      ended_at: speech.endedAt ?? null,
      transcript_sha256: createHash('sha256').update(cleanTranscript).digest('hex'),
    },
  }
}
