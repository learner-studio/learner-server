import { defineFunction } from '../../runtime/define.js'
import { ForbiddenError } from '@learner/core/runtime/errors.js'
import type { Session } from '@learner/core/runtime/index.js'
import {
  appendUploadedTranscript, GetTranscriptUploadStateInput, GetTranscriptUploadStateOutput, transcriptUploadState, UploadTranscriptInput, UploadTranscriptOutput,
} from '@learner/core/lib/learning/transcript-uploads.js'
import { deviceClientId } from '../../auth.js'

/**
 * Who may write a client's spool: the device key bound to that clientId (the
 * uploader on the client machine), or an admin. A device key never reaches
 * another device's spool, so one leaked laptop key cannot rewrite the rest.
 */
export function assertTranscriptUploader(session: Session, clientId: string): void {
  const bound = deviceClientId(session)
  if (bound ? bound === clientId : session.scopes.includes('admin')) return
  throw new ForbiddenError(bound ? `this key belongs to device ${bound}, not ${clientId}` : 'Missing scope: admin or app')
}

export const uploadTranscript = defineFunction({
  title: 'Append a chunk of a remote client\'s Claude/Codex transcript to the ingest spool',
  description: 'Offset-addressed and replay-safe. The spool is read by the same transcript ingest as the local provider directories. Accepts the device key bound to clientId, or an admin.',
  expose: true,
  input: UploadTranscriptInput, output: UploadTranscriptOutput,
  func: async ({ config, logger }, data, { session }) => {
    assertTranscriptUploader(session, data.clientId)
    const result = await appendUploadedTranscript(config.transcriptUploadRoot, data)
    if (result.appended) logger.info({ event: 'transcript-uploaded', provider: data.provider, clientId: data.clientId, path: data.path, size: result.size })
    return result
  },
})

export const getTranscriptUploadState = defineFunction({
  title: 'What the spool holds of a remote client\'s transcripts (size + sha256 per path)',
  description: 'Lets an uploader that lost its offsets, or was refused with a 409, resume from the server\'s copy instead of resending history.',
  expose: true, readonly: true,
  input: GetTranscriptUploadStateInput, output: GetTranscriptUploadStateOutput,
  func: async ({ config }, data, { session }) => {
    assertTranscriptUploader(session, data.clientId)
    return transcriptUploadState(config.transcriptUploadRoot, data)
  },
})
