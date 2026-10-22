import { defineFunction } from '../../runtime/define.js'
import { appendUploadedTranscript, UploadTranscriptInput, UploadTranscriptOutput } from '@learner/core/lib/learning/transcript-uploads.js'

export const uploadTranscript = defineFunction({
  title: 'Append a chunk of a remote client\'s Claude/Codex transcript to the ingest spool',
  description: 'Offset-addressed and replay-safe. The spool is read by the same transcript ingest as the local provider directories.',
  expose: true, scopes: ['admin'],
  input: UploadTranscriptInput, output: UploadTranscriptOutput,
  func: async ({ config, logger }, data) => {
    const result = await appendUploadedTranscript(config.transcriptUploadRoot, data)
    if (result.appended) logger.info({ event: 'transcript-uploaded', provider: data.provider, clientId: data.clientId, path: data.path, size: result.size })
    return result
  },
})
