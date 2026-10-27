import { z } from 'zod'
import type { ReadAiCallPayload } from './call-ingest.js'

/**
 * The Read AI webhook: Read.ai POSTs each finished meeting to
 * `<api>/api/webhooks/readai/<token>`. Read.ai signs nothing, so the URL token
 * is the only credential; the server keeps its sha256, never the token.
 */
export const ReadAiWebhookToken = z.string().regex(/^[A-Za-z0-9._~-]{24,256}$/, 'A token is 24-256 URL-safe characters (letters, digits, . _ ~ -)')

/** What a delivery did. A test never stores anything. */
export const ReadAiWebhookOutcome = z.enum(['stored', 'updated', 'unchanged', 'duplicate', 'not-stored', 'test-ok'])
export const ReadAiWebhookDelivery = z.object({
  at: z.string(),
  test: z.boolean(),
  sessionId: z.string(),
  title: z.string().nullable(),
  outcome: ReadAiWebhookOutcome,
  /** Stored, but no line is the learner's (or the call is silent): nothing is graded. */
  graded: z.boolean(),
  lines: z.number().int(),
})
export type ReadAiWebhookDelivery = z.infer<typeof ReadAiWebhookDelivery>

export const ReadAiWebhookStatus = z.object({
  configured: z.boolean(),
  /** The token's last four characters, to tell tokens apart. */
  tokenHint: z.string().nullable(),
  updatedAt: z.string().nullable(),
  lastDelivery: ReadAiWebhookDelivery.nullable(),
})
export type ReadAiWebhookStatus = z.infer<typeof ReadAiWebhookStatus>

export const SaveReadAiWebhookInput = z.object({ token: ReadAiWebhookToken })
export const ReceiveReadAiWebhookOutput = z.object({ ok: z.literal(true), test: z.boolean(), sessionId: z.string(), outcome: ReadAiWebhookOutcome })
export type ReceiveReadAiWebhookOutput = z.infer<typeof ReceiveReadAiWebhookOutput>

/** Header that turns a delivery into a test: the token and payload are checked end to end, nothing is stored. */
export const READAI_WEBHOOK_TEST_HEADER = 'x-learner-webhook-test'

/**
 * A synthetic Read.ai meeting in the webhook's shape: the fixture behind the
 * settings card's Test button and the webhook's tests. No real person or call.
 */
export const READAI_WEBHOOK_TEST_PAYLOAD = {
  session_id: 'learner-webhook-test',
  title: 'Learner webhook test',
  start_time: '2026-10-27T15:00:00.000Z',
  end_time: '2026-10-27T15:02:00.000Z',
  platform: 'zoom',
  report_url: 'https://app.read.ai/analytics/meetings/learner-webhook-test',
  owner: { name: 'Test Learner', email: 'learner@example.com' },
  participants: [{ name: 'Test Learner', email: 'learner@example.com' }, { name: 'Ada Example', email: 'ada@example.com' }],
  transcript: {
    speaker_blocks: [
      { start_time: Date.parse('2026-10-27T15:00:05.000Z'), end_time: Date.parse('2026-10-27T15:00:20.000Z'), speaker: { name: 'Ada Example' }, words: 'Can you walk me through how the index is chosen?' },
      { start_time: Date.parse('2026-10-27T15:00:21.000Z'), end_time: Date.parse('2026-10-27T15:00:50.000Z'), speaker: { name: 'Test Learner' }, words: 'The planner compares the cost of a sequential scan against each usable index.' },
    ],
  },
} as const satisfies ReadAiCallPayload
