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

/** One line of a call as spoken. The device decides which lines are the learner's. */
export const DesktopCallUtterance = z.object({
  speaker: z.string().min(1).max(120),
  text: z.string().min(1).max(200_000),
  /** When the line was spoken: the call's eventTime plus its offset. */
  at: IsoInstant,
  /** True only for the learner's own lines; an unattributed speaker is false. */
  learner: z.boolean(),
})

/** One call_transcripts row; upserted on sessionId (Read.ai's id), adopting callId. */
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
  /** Read.ai lines, `(MM:SS) Speaker Name: text` one per line; stored verbatim, not parsed. */
  cleanTranscript: z.string().max(2_000_000),
  /**
   * The call in spoken order. The learner's lines are scored; each is graded
   * with the lines spoken just before it, as a chat reply is with its prompt.
   */
  utterances: z.array(DesktopCallUtterance).min(1).max(20_000),
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

// ---------------------------------------------------------------------------
// Pairing (docs/specs/server-desktop-pairing.md): which URLs each side uses.

/** `product` and `contract` in GET /api/health: a URL answers as a learner-server before a key is sent to it. */
export const LEARNER_PRODUCT = 'learner-server'
export const PAIRING_CONTRACT = 1

/** An absolute http(s) URL with no credentials, query or fragment; a trailing slash is kept as given. */
export const PairingUrl = z.string().max(2000).refine((value) => {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}, 'expected an absolute http(s) URL without credentials, query or fragment')

/** same-machine: the API is on a loopback address; remote: anything else. Derived, never configured. */
export const PairingTopology = z.enum(['same-machine', 'remote'])

/**
 * The pairing payload, mode-600 JSON written by `mint-api-key.ts --device <id> --pairing <file>`.
 * It is the desktop's trust anchor: it pins `apiUrl` and never sends `apiKey` to another origin.
 */
export const PairingPayload = z.object({ apiUrl: PairingUrl, clientId: DesktopClientId, apiKey: z.string().min(16) })

/** What the desktop reports about its side in each heartbeat. `services` are display-only; the server never calls them. */
export const PairingReport = z.object({
  apiUrlInUse: PairingUrl,
  endpointsVersionHeld: z.string().max(100).nullable().optional(),
  hostname: z.string().max(255).optional(),
  services: z.array(z.object({ name: z.string().min(1).max(50), url: PairingUrl })).max(20).default([]),
})

/**
 * ok: the desktop uses the advertised API URL and holds the current endpointsVersion.
 * stale: right URL, older version (it refetches). mismatch: it uses a URL the server
 * does not advertise. unknown: no pairing report yet.
 */
export const PairingState = z.enum(['ok', 'stale', 'mismatch', 'unknown'])

export const GetPairingEndpointsInput = z.object({ clientId: DesktopClientId })
export const GetPairingEndpointsOutput = z.object({
  topology: PairingTopology,
  contract: z.number().int(),
  serverVersion: z.string(),
  /** Hash of every advertised URL; the heartbeat echoes it so a change is seen within one beat. */
  endpointsVersion: z.string(),
  api: z.object({ base: PairingUrl, rpcBase: PairingUrl, health: PairingUrl }),
  /** Null: this install publishes no web UI to this client. */
  web: PairingUrl.nullable(),
  /** Null: this install publishes no GrowthBook. `app` is GrowthBook's APP_ORIGIN, `api` its API_HOST. */
  growthbook: z.object({ app: PairingUrl, api: PairingUrl }).nullable(),
  /** remote: the server cannot read this machine's CLI sessions, so the desktop runs learner-upload. */
  uploader: z.object({ required: z.boolean() }),
  device: z.object({ pairingState: PairingState, lastPairing: PairingReport.nullable(), lastPairingAt: z.string().nullable() }),
})

export const RecordAppHeartbeatInput = z.object({
  clientId: DesktopClientId,
  appVersion: z.string().max(100),
  screenpipeVersion: z.string().max(100).nullable().optional(),
  captureState: z.enum(['recording', 'paused', 'stopped', 'error']),
  outboxDepth: z.number().int().min(0),
  lastSentAt: IsoInstant.nullable().optional(),
  lastVaultExportAt: IsoInstant.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).default({}),
  pairing: PairingReport.optional(),
})
export const RecordAppHeartbeatOutput = z.object({ serverTime: z.string(), endpointsVersion: z.string() })
