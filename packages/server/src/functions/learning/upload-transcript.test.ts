import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ForbiddenError, UnauthorizedError } from '@learner/core/runtime/errors.js'
import { checkAccess } from '../../runtime/invoke.js'
import { deviceEmail } from '../../auth.js'
import { getTranscriptUploadState, uploadTranscript } from './upload-transcript.function.js'

// The uploader on a client machine signs in with its device key (scope `app`),
// so both RPCs take that key for its own clientId, and an admin for any.
describe('uploadTranscript / getTranscriptUploadState access', () => {
  const root = mkdtempSync(join(tmpdir(), 'upload-access-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const services = { config: { transcriptUploadRoot: root }, logger: { info: () => {} } } as never
  const device = (clientId: string) => ({ userId: `u-${clientId}`, email: deviceEmail(clientId), scopes: ['app'] })
  const admin = { userId: 'admin', email: 'admin@example.com', scopes: ['admin'] }
  const human = { userId: 'human', email: 'someone@example.com', scopes: [] }
  const chunk = (clientId: string) => ({ provider: 'claude' as const, clientId, path: 'proj/s.jsonl', offset: 0, content: '{"a":1}\n', sha256: createHash('sha256').update('{"a":1}\n').digest('hex') })
  const run = async (session: typeof admin | undefined, clientId: string) => {
    checkAccess('uploadTranscript', uploadTranscript, session, 'rpc')
    return uploadTranscript.func(services, chunk(clientId), { session } as never)
  }

  test('a device key uploads to its own clientId and reads back its state', async () => {
    expect(await run(device('my-mac'), 'my-mac')).toMatchObject({ appended: 8 })
    checkAccess('getTranscriptUploadState', getTranscriptUploadState, device('my-mac'), 'rpc')
    expect(await getTranscriptUploadState.func(services, { provider: 'claude', clientId: 'my-mac', paths: ['proj/s.jsonl', 'proj/none.jsonl'] }, { session: device('my-mac') } as never)).toEqual({ files: [
      { path: 'proj/s.jsonl', size: 8, sha256: createHash('sha256').update('{"a":1}\n').digest('hex') },
      { path: 'proj/none.jsonl', size: 0, sha256: createHash('sha256').digest('hex') },
    ] })
  })

  test('a device key never reaches another device\'s spool, for writes or reads', async () => {
    await expect(run(device('my-mac'), 'other-mac')).rejects.toBeInstanceOf(ForbiddenError)
    await expect(Promise.resolve().then(() => getTranscriptUploadState.func(services, { provider: 'claude', clientId: 'other-mac', paths: ['proj/s.jsonl'] }, { session: device('my-mac') } as never))).rejects.toBeInstanceOf(ForbiddenError)
  })

  test('an admin may upload for any client; a plain user and no session may not', async () => {
    expect(await run(admin, 'gate')).toMatchObject({ appended: 8 })
    await expect(run(human, 'my-mac')).rejects.toBeInstanceOf(ForbiddenError)
    await expect(run(undefined, 'my-mac')).rejects.toBeInstanceOf(UnauthorizedError)
  })
})
