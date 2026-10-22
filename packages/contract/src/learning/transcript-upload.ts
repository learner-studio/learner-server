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
