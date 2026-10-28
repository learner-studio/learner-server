import { z } from 'zod'
import {
  ArchiveConversationDocumentsInput, GetPairingEndpointsInput, GetPairingEndpointsOutput, PAIRING_CONTRACT, PairingReport, ArchiveConversationDocumentsOutput, RecordAppHeartbeatInput, RecordAppHeartbeatOutput, RecordCallTranscriptsInput, RecordCallTranscriptsOutput,
  RecordCallsInput, RecordCallsOutput,
  RecordHabitEventsInput, RecordHabitEventsOutput,
} from '@learner/contract'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { writeDesktopTranscript } from '@learner/core/lib/learning/learner-desktop-transcripts.js'
import { callRecord, desktopSpeech, ingestSpeech, type CallRecord } from '@learner/core/lib/learning/call-ingest.js'
import { ingestCalls, type CallPipelineDeps } from '@learner/core/lib/learning/call-pipeline.js'
import { ForbiddenError } from '@learner/core/runtime/errors.js'
import type { Session } from '@learner/core/runtime/index.js'
import { deviceClientId } from '../../auth.js'
import { defineFunction } from '../../runtime/define.js'
import { apiUrls, endpointsVersion, pairingState } from '../../pairing.js'
import { SERVER_VERSION } from '../../version.js'

/**
 * learner-desktop's upload surface (docs/learner-desktop-api.md). Callers hold a
 * device key (scope `app`), and that key's device user fixes the clientId: a
 * device can only write as itself.
 */
export function assertDeviceClient(session: Session, clientId: string): void {
  const bound = deviceClientId(session)
  if (bound !== clientId) throw new ForbiddenError(`this key belongs to ${bound ? `device ${bound}` : 'a non-device user'}, not ${clientId}`)
}

/** Count what a device delivered, so the status view can show it without reading `habits`. */
export async function noteDeviceUpload(clientId: string, userId: string, column: 'habit_events_received' | 'calls_received' | 'documents_received', n: number): Promise<void> {
  await metaDbQuery(
    `INSERT INTO learner_desktop_devices (client_id, user_id, app_version, capture_state, outbox_depth, ${column}, last_upload_at, last_heartbeat_at)
     VALUES ($1, $2, 'unknown', 'unknown', 0, $3, now(), '-infinity')
     ON CONFLICT (client_id) DO UPDATE SET ${column} = learner_desktop_devices.${column} + $3, last_upload_at = now()`,
    [clientId, userId, n],
  )
}

export const recordHabitEvents = defineFunction({
  title: 'Store a batch of learner-desktop habit events (idempotent on eventId)', expose: true, scopes: ['app'],
  input: RecordHabitEventsInput, output: RecordHabitEventsOutput,
  func: async ({ learnerDesktopHabits, logger }, { clientId, events }, { session }) => {
    assertDeviceClient(session, clientId)
    const result = await learnerDesktopHabits().recordHabitEvents(clientId, events)
    if (result.accepted) await noteDeviceUpload(clientId, session.userId, 'habit_events_received', result.accepted)
    logger.info({ event: 'desktop-habit-events', clientId, ...result })
    return result
  },
})

type CallServices = { learnerDesktopHabits: () => CallPipelineDeps['habits']; config: { transcriptUploadRoot: string } }
const pipeline = ({ learnerDesktopHabits, config }: CallServices): CallPipelineDeps => ({ habits: learnerDesktopHabits(), uploadRoot: config.transcriptUploadRoot })

/** Every call, from either RPC, goes through the one pipeline (call-pipeline.ts): the server attributes the learner's lines. */
async function storeCalls(services: CallServices, session: Session, clientId: string, records: CallRecord[]) {
  const result = await ingestCalls(pipeline(services), clientId, records)
  if (result.accepted) await noteDeviceUpload(clientId, session.userId, 'calls_received', result.accepted)
  return result
}

export const recordCallTranscripts = defineFunction({
  title: 'Store learner-desktop call transcripts (upsert on sessionId; the server attributes the learner\'s lines)', expose: true, scopes: ['app'],
  input: RecordCallTranscriptsInput, output: RecordCallTranscriptsOutput,
  func: async (services, { clientId, calls }, { session }) => {
    assertDeviceClient(session, clientId)
    const records = calls.map((c) => callRecord(typeof c.metadata.source === 'string' ? c.metadata.source : 'desktop', desktopSpeech(c), c.callId))
    const { accepted, updated, unchanged, ...rest } = await storeCalls(services, session, clientId, records)
    services.logger.info({ event: 'desktop-call-transcripts', clientId, accepted, updated, unchanged, ...rest })
    return { accepted, updated, unchanged }
  },
})

export const recordCalls = defineFunction({
  title: 'Store meeting transcripts from any provider and grade the learner\'s speech (upsert on the provider session)', expose: true, scopes: ['app'],
  input: RecordCallsInput, output: RecordCallsOutput,
  func: async (services, { clientId, calls }, { session }) => {
    assertDeviceClient(session, clientId)
    const { spooled, ...result } = await storeCalls(services, session, clientId, calls.map((item) => { const { source, speech } = ingestSpeech(item); return callRecord(source, speech) }))
    services.logger.info({ event: 'call-transcripts-ingested', clientId, ...result, spooled })
    return result
  },
})

export const archiveConversationDocuments = defineFunction({
  title: 'Spool learner-desktop chat exports as transcripts for mastery scoring', expose: true, scopes: ['app'],
  input: ArchiveConversationDocumentsInput, output: ArchiveConversationDocumentsOutput,
  func: async ({ config, logger }, { clientId, documents }, { session }) => {
    assertDeviceClient(session, clientId)
    let accepted = 0, updated = 0, unchanged = 0
    for (const doc of documents) {
      const turns = doc.messages.map((m) => ({ role: m.role, text: m.text, at: m.at ?? doc.occurredAt }))
      const { status } = await writeDesktopTranscript(config.transcriptUploadRoot, clientId, 'chat', doc.documentId, turns)
      if (status === 'created') accepted++
      else if (status === 'unchanged') unchanged++
      else updated++
    }
    if (accepted) await noteDeviceUpload(clientId, session.userId, 'documents_received', accepted)
    logger.info({ event: 'desktop-conversation-documents', clientId, accepted, updated, unchanged })
    return { accepted, updated, unchanged }
  },
})

export const recordAppHeartbeat = defineFunction({
  title: 'Record a learner-desktop heartbeat', expose: true, scopes: ['app'],
  input: RecordAppHeartbeatInput, output: RecordAppHeartbeatOutput,
  func: async ({ config }, h, { session }) => {
    assertDeviceClient(session, h.clientId)
    // A heartbeat without a pairing report keeps the last one (older clients send none).
    await metaDbQuery(
      `INSERT INTO learner_desktop_devices (client_id, user_id, app_version, screenpipe_version, capture_state, outbox_depth, last_sent_at, last_vault_export_at, detail, last_heartbeat_at, pairing, pairing_reported_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now(), $10::jsonb, CASE WHEN $10::jsonb IS NULL THEN NULL ELSE now() END)
       ON CONFLICT (client_id) DO UPDATE SET user_id = $2, app_version = $3, screenpipe_version = $4, capture_state = $5, outbox_depth = $6,
         last_sent_at = $7, last_vault_export_at = $8, detail = $9::jsonb, last_heartbeat_at = now(),
         pairing = COALESCE($10::jsonb, learner_desktop_devices.pairing),
         pairing_reported_at = CASE WHEN $10::jsonb IS NULL THEN learner_desktop_devices.pairing_reported_at ELSE now() END`,
      [h.clientId, session.userId, h.appVersion, h.screenpipeVersion ?? null, h.captureState, h.outboxDepth, h.lastSentAt ?? null,
        h.lastVaultExportAt ?? null, JSON.stringify(h.detail), h.pairing ? JSON.stringify(h.pairing) : null],
    )
    return { serverTime: new Date().toISOString(), endpointsVersion: endpointsVersion(config.endpoints) }
  },
})

export const getPairingEndpoints = defineFunction({
  title: 'Every URL this server advertises to a learner-desktop device, and how it sees that device', expose: true, readonly: true, scopes: ['app'],
  input: GetPairingEndpointsInput, output: GetPairingEndpointsOutput,
  func: async ({ config }, { clientId }, { session }) => {
    assertDeviceClient(session, clientId)
    const endpoints = config.endpoints
    const row = (await metaDbQuery<{ pairing: unknown; pairing_reported_at: Date | null }>(
      `SELECT pairing, pairing_reported_at FROM learner_desktop_devices WHERE client_id = $1`, [clientId])).rows[0]
    // A stored report that no longer parses (an older shape) counts as none.
    const report = row?.pairing ? PairingReport.safeParse(row.pairing).data ?? null : null
    return {
      topology: endpoints.topology, contract: PAIRING_CONTRACT, serverVersion: SERVER_VERSION, endpointsVersion: endpointsVersion(endpoints),
      api: apiUrls(endpoints), web: endpoints.web, growthbook: endpoints.growthbook,
      uploader: { required: endpoints.topology === 'remote' },
      device: { pairingState: pairingState(endpoints, report), lastPairing: report, lastPairingAt: report ? row?.pairing_reported_at?.toISOString() ?? null : null },
    }
  },
})

export const LearnerDesktopStatus = z.object({
  devices: z.array(z.object({
    clientId: z.string(), appVersion: z.string(), captureState: z.string(), outboxDepth: z.number(),
    lastHeartbeatAt: z.string().nullable(), lastUploadAt: z.string().nullable(), lastVaultExportAt: z.string().nullable(),
    habitEventsReceived: z.number(), callsReceived: z.number(), documentsReceived: z.number(),
    /** `silent`: no heartbeat for 24 h. `no-exports`: alive, but no vault export for 7 days. */
    health: z.enum(['ok', 'silent', 'no-exports', 'never-seen']),
  })),
})

export const getLearnerDesktopStatus = defineFunction({
  title: 'learner-desktop devices: last heartbeat, uploads received, and whether each is silent', expose: true, readonly: true, scopes: ['admin'],
  input: z.object({}), output: LearnerDesktopStatus,
  func: async () => {
    const rows = await metaDbQuery<Record<string, any>>(
      `SELECT client_id, app_version, capture_state, outbox_depth, habit_events_received, calls_received, documents_received,
              nullif(last_heartbeat_at, '-infinity') AS last_heartbeat_at, last_upload_at, last_vault_export_at
         FROM learner_desktop_devices ORDER BY client_id`, [])
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null)
    const day = 86_400_000
    return {
      devices: rows.rows.map((r) => ({
        clientId: r.client_id, appVersion: r.app_version, captureState: r.capture_state, outboxDepth: r.outbox_depth,
        lastHeartbeatAt: iso(r.last_heartbeat_at), lastUploadAt: iso(r.last_upload_at), lastVaultExportAt: iso(r.last_vault_export_at),
        habitEventsReceived: r.habit_events_received, callsReceived: r.calls_received, documentsReceived: r.documents_received,
        health: !r.last_heartbeat_at ? 'never-seen' as const
          : Date.now() - +new Date(r.last_heartbeat_at) > day ? 'silent' as const
          : !r.last_vault_export_at || Date.now() - +new Date(r.last_vault_export_at) > 7 * day ? 'no-exports' as const : 'ok' as const,
      })),
    }
  },
})
