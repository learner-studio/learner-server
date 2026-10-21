import { expect, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { archivePlaygroundTurn } from './learning-playground-archive.js'
import { LearningExposureObservation } from './learning-exposure-schemas.js'
import type { CapturedArchiveBytes } from '../../services/learning-lossless-archive-service.js'

test('playground seals full original roles and bytes before projection and adopts its sealed replay', async () => {
  let sealed: CapturedArchiveBytes | undefined
  let version: string | null = null
  let seals = 0
  const projected: unknown[] = []
  const id = '3d799a31-51e2-43f7-a803-766d860a4512'
  const input = { requestId: id, conversationId: id, userId: 'admin', provider: 'agy' as const, message: 'Human original 🙂\n'.repeat(2000), response: 'Assistant original\n'.repeat(2000), receivedAt: '2026-09-06T00:00:00.000Z' }
  const archive: Parameters<typeof archivePlaygroundTurn>[0] = {
    registerSource: async () => ({ sourceId: id, host: 'test', provider: 'agy', rootPath: '/learning/playground', relativePath: 'test', fileKind: 'jsonl', deviceId: null, inodeId: null, generation: 0, discoveryState: 'discovered', sourceSize: 0, fencingToken: 0, leaseExpiresAt: null }),
    getCheckpoint: async () => ({ sourceId: id, generation: 0, cursorOffset: 0, lastVersionNumber: 0, lastVerifiedVersionId: version, recoveryState: 'ready', lastSuccessAt: null, lastErrorCode: null, lastErrorMessage: null }),
    claimSource: async () => ({ sourceId: id, generation: 0, ownerId: id, claimToken: id, fencingToken: 1, leaseExpiresAt: '2026-09-06T00:01:00Z' }),
    commitCapture: async ({ capture }) => { sealed = capture; version = id; seals++; return { versionId: id, versionNumber: 1, rawBytes: capture.rawLength, encodedBytes: capture.chunks[0]!.encodedLength, deduplicatedBytes: 0, idempotent: false } },
    releaseClaim: async () => true,
    verifyVersion: async () => ({ versionId: id, sha256: sealed!.rawSha256, rawLength: sealed!.rawLength, chunkCount: 1 }),
  }
  const exposure: Parameters<typeof archivePlaygroundTurn>[1] = { ingestObservation: async (value, rawVersionId) => {
    expect(version).toBe(rawVersionId)
    projected.push(value)
    return { observationId: LearningExposureObservation.parse(value).observationId, inserted: true }
  } }
  await archivePlaygroundTurn(archive, exposure, input)
  if (!sealed) throw new Error('Expected original bytes to be sealed')
  const observations = gunzipSync(sealed.chunks[0]!.encodedBytes).toString().trim().split('\n').map(line => LearningExposureObservation.parse(JSON.parse(line)))
  expect(observations[0]!.parts[0]!.text).toBe(input.message)
  expect(observations[1]!.parts[0]!.text).toBe(input.response)
  expect(observations.map(item => item.authorship)).toEqual(['human','agent'])
  await archivePlaygroundTurn(archive, exposure, input)
  expect(seals).toBe(1)
  expect(projected[0]).toEqual(projected[2])
  expect(projected[1]).toEqual(projected[3])
  await expect(archivePlaygroundTurn(archive, exposure, { ...input, response: 'changed output' })).rejects.toThrow('Sealed playground archive bytes differ')
  expect(projected).toHaveLength(4)
  version = null
  await archivePlaygroundTurn(archive, exposure, { ...input, requestId: 'b0b95adf-4e11-4d11-a73c-bdd2a9080129', response: null })
  const failedTurn = gunzipSync(sealed.chunks[0]!.encodedBytes).toString().trim().split('\n').map(line => LearningExposureObservation.parse(JSON.parse(line)))
  expect(failedTurn).toHaveLength(1)
  expect(failedTurn[0]!.authorship).toBe('human')
  expect(failedTurn[0]!.parts[0]!.text).toBe(input.message)
})
