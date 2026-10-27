import { z } from 'zod'

/** Wire shape of `uploadTranscript`: one offset-addressed chunk of a remote client's transcript file. */
export const TRANSCRIPT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024

export const UploadTranscriptInput = z.object({
  provider: z.enum(['claude', 'codex']),
  /** Stable name of the uploading machine; keeps two clients' identical paths apart. */
  clientId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  /** The transcript's path under the provider's root on the client, e.g. `-home-me-repo/<uuid>.jsonl`. */
  path: z.string().max(512).regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,7}$/).refine((p) => p.endsWith('.jsonl') && !p.split('/').some((s) => s === '.' || s === '..'), 'path must be a relative .jsonl path'),
  /** Byte offset of `content` in the client's file. */
  offset: z.number().int().min(0),
  content: z.string(),
  /** sha256 (hex) of `content` as UTF-8. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export const UploadTranscriptOutput = z.object({ size: z.number().int(), appended: z.number().int(), replayed: z.boolean() })

/** Paths answered per `getTranscriptUploadState` call. */
export const TRANSCRIPT_UPLOAD_STATE_MAX_PATHS = 200
/**
 * What the server holds of each named transcript: its size and the sha256 of
 * those bytes. An uploader that lost its offsets (or got a 409) re-reads this,
 * checks its own file's prefix against the digest and resumes at `size`.
 */
export const GetTranscriptUploadStateInput = UploadTranscriptInput.pick({ provider: true, clientId: true }).extend({
  paths: z.array(UploadTranscriptInput.shape.path).min(1).max(TRANSCRIPT_UPLOAD_STATE_MAX_PATHS),
})
export const GetTranscriptUploadStateOutput = z.object({
  files: z.array(z.object({ path: z.string(), size: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/) })),
})
