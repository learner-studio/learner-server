import { z } from 'zod'
import { DesktopClientId } from './desktop.js'

/**
 * Meeting transcripts from any provider. A client sends either a provider's raw
 * payload (the server owns the adapter) or speech it already normalised. The
 * server alone decides which lines are the learner's, by speaker name, so no
 * client or adapter carries that rule.
 */
const IsoInstant = z.string().datetime({ offset: true })

/** One line as spoken. No learner flag: attribution happens on the server. */
export const CallSpeechLine = z.object({
  speaker: z.string().min(1).max(120),
  text: z.string().min(1).max(200_000),
  at: IsoInstant,
  endAt: IsoInstant.nullish(),
})
/** A provider-neutral call: what every adapter produces and what `format: 'speech'` sends. */
export const CallSpeech = z.object({
  /** The provider's own meeting id; the call is upserted on it. */
  sessionId: z.string().min(1).max(200),
  title: z.string().max(500).nullish(),
  startedAt: IsoInstant.nullish(),
  endedAt: IsoInstant.nullish(),
  platform: z.string().max(100).nullish(),
  participants: z.array(z.string().min(1).max(320)).max(500).default([]),
  lines: z.array(CallSpeechLine).max(20_000),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export type CallSpeech = z.infer<typeof CallSpeech>

/**
 * A Read.ai meeting webhook payload, as biztools stores and forwards it. Only
 * the fields the adapter reads are declared. Objects are loose: a third-party
 * payload grows fields, and an unknown key must never reject a delivery.
 * `speaker_blocks[].start_time` is epoch milliseconds.
 */
const ReadAiPerson = z.looseObject({ name: z.string().nullish(), email: z.string().nullish() })
export const ReadAiCallPayload = z.looseObject({
  session_id: z.string().min(1).max(200),
  title: z.string().nullish(),
  start_time: z.string().nullish(),
  end_time: z.string().nullish(),
  platform: z.string().nullish(),
  report_url: z.string().nullish(),
  owner: ReadAiPerson.nullish(),
  participants: z.array(ReadAiPerson).nullish(),
  transcript: z.looseObject({
    speaker_blocks: z.array(z.looseObject({
      start_time: z.number().finite(),
      end_time: z.number().finite().nullish(),
      speaker: z.looseObject({ name: z.string().nullish() }).nullish(),
      words: z.string().nullish(),
    })).max(20_000),
  }).nullish(),
})
export type ReadAiCallPayload = z.infer<typeof ReadAiCallPayload>

/** One call to ingest. A new provider adds a member here and an adapter in core's call-ingest. */
export const IngestCall = z.discriminatedUnion('format', [
  z.object({ format: z.literal('speech'), source: z.string().min(1).max(50), call: CallSpeech }),
  z.object({ format: z.literal('readai'), payload: ReadAiCallPayload }),
])
export type IngestCall = z.infer<typeof IngestCall>

export const RecordCallsInput = z.object({ clientId: DesktopClientId, calls: z.array(IngestCall).min(1).max(20) })
export const RecordCallsOutput = z.object({
  accepted: z.number().int(), updated: z.number().int(), unchanged: z.number().int(),
  /** Calls with no speech or no line by the learner: stored (when spoken), not graded. */
  notGraded: z.number().int(),
})
