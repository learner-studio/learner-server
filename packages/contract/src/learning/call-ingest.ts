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
/** Someone on the call's invite or roster. Either field may be all a provider knows. */
export const CallParticipant = z.object({ name: z.string().max(320).nullish(), email: z.string().max(320).nullish() })
export type CallParticipant = z.infer<typeof CallParticipant>

/** The label an adapter gives a line whose provider named no speaker. Never a learner alias. */
export const UNKNOWN_SPEAKER = 'UNKNOWN_SPEAKER'

/** A provider-neutral call: what every adapter produces and what `format: 'speech'` sends. */
export const CallSpeech = z.object({
  /** The provider's own meeting id; the call is upserted on it. */
  sessionId: z.string().min(1).max(200),
  title: z.string().max(500).nullish(),
  startedAt: IsoInstant.nullish(),
  endedAt: IsoInstant.nullish(),
  platform: z.string().max(100).nullish(),
  participants: z.array(CallParticipant).max(500).default([]),
  lines: z.array(CallSpeechLine).max(20_000),
  /** A sender's own classification of the call, carried onto the stored row. */
  category: z.string().max(50).nullish(),
  isDemo: z.boolean().default(false),
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
  /** The same meeting already arrived from another source; this copy is kept aside, not stored or graded. */
  duplicates: z.number().int(),
})

/**
 * Who the learner is on a call. A line is the learner's when its speaker label
 * matches a name here; the learner is present when a participant matches a
 * name or an email. Matching ignores case and spacing.
 */
export const CallIdentity = z.object({
  names: z.array(z.string().trim().min(1).max(120).refine((n) => n !== UNKNOWN_SPEAKER, 'a provider\'s unknown-speaker label cannot be a name')).max(50),
  emails: z.array(z.string().trim().toLowerCase().email().max(320)).max(50),
})
export type CallIdentity = z.infer<typeof CallIdentity>
export const CallIdentityConfig = CallIdentity.extend({ updatedAt: z.string().nullable() })
export type CallIdentityConfig = z.infer<typeof CallIdentityConfig>
export const SaveCallIdentityOutput = CallIdentityConfig.extend({ reattributed: z.number().int() })

/**
 * How a call's learner lines were found:
 * - `named`: a speaker label is one of the identity's names.
 * - `claimed`: the learner chose the labels for this call (an empty choice means "I did not speak").
 * - `inferred`: no label is the learner's name, but the learner was present and exactly one
 *   label belongs to no participant while every other participant has a label of their own.
 * - `unattributed`: the learner was present and no rule can tell which label, if any, is theirs.
 * - `absent`: the learner was not on the call.
 */
export const CallAttributionKind = z.enum(['named', 'claimed', 'inferred', 'unattributed', 'absent'])
export type CallAttributionKind = z.infer<typeof CallAttributionKind>

/** A call whose learner lines a person should confirm or choose: every `inferred` and `unattributed` call. */
export const CallNeedingAttribution = z.object({
  sessionId: z.string(),
  source: z.string(),
  title: z.string(),
  eventTime: z.string(),
  attribution: z.enum(['inferred', 'unattributed']),
  participants: z.array(z.string()),
  /** Every speaker label with its line count and first line; `learner` marks the inferred choice. */
  speakers: z.array(z.object({ label: z.string(), lines: z.number().int(), sample: z.string(), learner: z.boolean() })),
})
export type CallNeedingAttribution = z.infer<typeof CallNeedingAttribution>
export const ListCallsNeedingAttributionOutput = z.object({ calls: z.array(CallNeedingAttribution) })

/** The learner's lines on one call. `remember` also adds each named label (never the unknown one) to the identity. */
export const ClaimCallSpeakersInput = z.object({
  sessionId: z.string().min(1).max(200),
  speakers: z.array(z.string().min(1).max(120)).max(20),
  remember: z.boolean().default(false),
})
export const ClaimCallSpeakersOutput = z.object({ reattributed: z.number().int() })
