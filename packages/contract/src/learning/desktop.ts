import { z } from 'zod'

/**
 * Wire shapes for learner-desktop, the macOS app (`learner-studio/learner-desktop`).
 * Spec: docs/learner-desktop-api.md. Every write is idempotent on a
 * client-generated id, so a client may resend a batch after any failure.
 * The caller's device key fixes `clientId`: a mismatch is refused.
 */
export const DesktopClientId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
const IsoInstant = z.string().datetime({ offset: true })
const Seconds = z.number().finite().min(0)

/** One habit_events row. Free-string categories: analysis filters, the writer accepts. */
export const DesktopHabitEvent = z.object({
  eventId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  callApp: z.string().max(100).nullable().optional(),
  callCategory: z.string().max(50).nullable().optional(),
  /** When the turn was spoken (audio clock where available), ISO-8601 with an offset. */
  timestamp: IsoInstant,
  habitType: z.string().min(1).max(50),
  treatmentArm: z.string().min(1).max(50),
  turnDurationSec: Seconds,
  wordsSpoken: z.number().int().min(0).nullable().optional(),
  /** Streak length in SECONDS when the 30 s cue fired; not a timestamp. */
  warningFiredAtSec: Seconds.nullable().optional(),
  /** Streak length in SECONDS when the 60 s stimulus fired; not a timestamp. */
  shockFiredAtSec: Seconds.nullable().optional(),
  latencyToYieldSec: Seconds.nullable().optional(),
  breached30s: z.boolean(),
  breached60s: z.boolean(),
  wasRewarded: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export const RecordHabitEventsInput = z.object({ clientId: DesktopClientId, events: z.array(DesktopHabitEvent).min(1).max(500) })
export const RecordHabitEventsOutput = z.object({ accepted: z.number().int(), duplicates: z.number().int() })

/** One call_transcripts row; upserted on callId. */
export const DesktopCallTranscript = z.object({
  callId: z.string().uuid(),
  sessionId: z.string().min(1).max(200),
  filename: z.string().min(1).max(500),
  meetingTitle: z.string().max(500),
  platform: z.string().max(100).nullable().optional(),
  eventTime: IsoInstant,
  participants: z.array(z.unknown()).default([]),
  benPresent: z.boolean().nullable().optional(),
  benSpoke: z.boolean().nullable().optional(),
  isDemo: z.boolean().default(false),
  callCategory: z.string().max(50).nullable().optional(),
  totalTurns: z.number().int().min(0).nullable().optional(),
  benTurns: z.number().int().min(0).nullable().optional(),
  benTotalSpeechSec: Seconds.nullable().optional(),
  /** Read.ai lines, `(MM:SS) Speaker Name: text` one per line. */
  cleanTranscript: z.string().max(2_000_000),
  /** Speaker labels that are the learner; their turns are scored, everyone else's are context. */
  learnerSpeakers: z.array(z.string().min(1).max(80)).min(1).default(['Ben Pollack', 'Ben', 'Benjamin', 'Benjamin Pollack']),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export const RecordCallTranscriptsInput = z.object({ clientId: DesktopClientId, calls: z.array(DesktopCallTranscript).min(1).max(50) })
export const RecordCallTranscriptsOutput = z.object({ accepted: z.number().int(), updated: z.number().int(), unchanged: z.number().int() })

/** One message of an exported conversation, in order. `user` is the learner. */
export const DesktopConversationMessage = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(500_000),
  /** When the message was sent; the conversation's `occurredAt` when the export does not say. */
  at: IsoInstant.optional(),
})

/**
 * One exported web conversation (ChatGPT / Claude.ai / Gemini), parsed into
 * messages on the device, which owns the export format. Resending a grown
 * conversation is the normal case: unchanged messages are not scored twice.
 */
export const DesktopConversationDocument = z.object({
  /** e.g. `ai-vault:chatgpt:<conversation-id>`; stable across re-exports. */
  documentId: z.string().min(1).max(300).regex(/^[A-Za-z0-9._:-]+$/),
  source: z.enum(['chatgpt', 'claude-ai', 'gemini', 'other']),
  title: z.string().max(500).nullable().optional(),
  occurredAt: IsoInstant,
  messages: z.array(DesktopConversationMessage).min(1).max(5000),
  metadata: z.record(z.string(), z.unknown()).default({}),
})
export const ArchiveConversationDocumentsInput = z.object({ clientId: DesktopClientId, documents: z.array(DesktopConversationDocument).min(1).max(50) })
export const ArchiveConversationDocumentsOutput = z.object({ accepted: z.number().int(), updated: z.number().int(), unchanged: z.number().int() })

export const RecordAppHeartbeatInput = z.object({
  clientId: DesktopClientId,
  appVersion: z.string().max(100),
  screenpipeVersion: z.string().max(100).nullable().optional(),
  captureState: z.enum(['recording', 'paused', 'stopped', 'error']),
  outboxDepth: z.number().int().min(0),
  lastSentAt: IsoInstant.nullable().optional(),
  lastVaultExportAt: IsoInstant.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).default({}),
})
export const RecordAppHeartbeatOutput = z.object({ serverTime: z.string() })
