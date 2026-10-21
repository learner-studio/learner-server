import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import type { LearningLosslessArchiveService, CapturedArchiveBytes } from '../../services/learning-lossless-archive-service.js'
import type { LearningExposureService } from '../../services/learning-exposure-service.js'
import type { ExposureObservation } from './learning-exposure-schemas.js'

const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const stableUuid = (key: string) => { const h = digest(key); return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}` }

/** Seal original turn bytes, then project them through the existing canonical exposure API. */
export async function archivePlaygroundTurn(archive: Pick<LearningLosslessArchiveService, 'registerSource' | 'getCheckpoint' | 'claimSource' | 'commitCapture' | 'releaseClaim' | 'verifyVersion'>, exposure: Pick<LearningExposureService, 'ingestObservation'>, input: {
  requestId: string; conversationId?: string | undefined; userId: string; provider: 'codex' | 'claude' | 'agy'; message: string; response: string | null; receivedAt: string
}) {
  const conversationId = input.conversationId ?? input.requestId
  const roles: Array<'user' | 'assistant'> = input.response === null ? ['user'] : ['user','assistant']
  const observations: ExposureObservation[] = roles.map((role, ordinal) => ({
    schemaVersion: 1, observationId: stableUuid(`${input.requestId}:${role}`), dedupeKey: `learning-playground:${input.requestId}:${role}`,
    hook: 'learning-playground', observedAt: new Date(Date.parse(input.receivedAt)+ordinal).toISOString(),
    logicalMessageKey: `learning-playground:${conversationId}:${input.requestId}:${role}`,
    direction: role === 'user' ? 'user_to_model' : 'model_to_user', stage: role === 'user' ? 'received' : 'user_facing',
    authorship: role === 'user' ? 'human' : 'agent', visibility: 'intended',
    correlation: { conversationId, sessionId: conversationId, threadId: conversationId, turnId: input.requestId, userId: input.userId, provider: input.provider, role },
    parts: [{ ordinal: 0, type: 'text', role: 'original', text: role === 'user' ? input.message : input.response!, captureStatus: 'captured' }], gaps: [],
  }))
  const raw = Buffer.from(observations.map(item => JSON.stringify(item)).join('\n')+'\n')
  const encoded = gzipSync(raw)
  const source = await archive.registerSource({ host: 'biztools-playground', provider: input.provider, rootPath: '/learning/playground', relativePath: `${input.userId}/${input.requestId}.jsonl`, fileKind: 'jsonl', observedAt: input.receivedAt,
    sourceSize: raw.length, metadata: { origin: 'application-turn', conversationId } })
  const checkpoint = await archive.getCheckpoint(source.sourceId, source.generation)
  let versionId = checkpoint?.lastVerifiedVersionId
  if (!versionId) {
    const claim = await archive.claimSource({ sourceId: source.sourceId, generation: source.generation, ownerId: input.requestId, leaseMs: 60_000 })
    if (!claim) throw new Error('Playground archive source is already claimed')
    const capture: CapturedArchiveBytes = { captureKind: 'opaque-complete', consistency: 'stable-file', coverage: 'complete',
      source: { deviceId: '0', inodeId: '0', mode: 384, size: raw.length, mtimeNs: '0', ctimeNs: '0' },
      captureStartedAt: input.receivedAt, captureEndedAt: input.receivedAt, offset: 0, rawLength: raw.length, rawSha256: digest(raw),
      chunks: [{ ordinal: 0, offset: 0, rawLength: raw.length, rawSha256: digest(raw), codec: 'gzip', codecVersion: 'rfc1952', encodedLength: encoded.length, encodedSha256: digest(encoded), encodedBytes: encoded }], limitations: ['Application-native playground turn bytes; not a filesystem capture.'] }
    try { versionId = (await archive.commitCapture({ claim, expectedCursor: 0, checkpointCursorAfter: raw.length, capture })).versionId }
    finally { await archive.releaseClaim(claim) }
  }
  const verified = await archive.verifyVersion(versionId)
  if (verified.sha256 !== digest(raw) || verified.rawLength !== raw.length) throw new Error('Sealed playground archive bytes differ from the replayed turn; projection refused')
  for (const observation of observations) await exposure.ingestObservation(observation, versionId)
  return { conversationId, rawVersionId: versionId, observationIds: observations.map(item => item.observationId) }
}
