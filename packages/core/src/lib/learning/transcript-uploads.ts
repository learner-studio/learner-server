import { createHash } from 'node:crypto'
import { mkdir, open, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { z } from 'zod'
import { TRANSCRIPT_UPLOAD_MAX_BYTES, UploadTranscriptInput, UploadTranscriptOutput } from '@learner/contract'
import { BadRequestError, ConflictError } from '../../runtime/errors.js'

/**
 * Transcripts uploaded by a remote client (a desktop agent that has no access
 * to this machine's disk). Each upload appends one chunk to a spool file at
 * `<root>/<provider>/<clientId>/<path>`, and the spool directories are extra
 * roots for the same disk ingest that reads `~/.claude/projects` and
 * `~/.codex/sessions` (transcript archive and lossless archive). Nothing else
 * changes downstream: an uploaded transcript is a local file by the time it
 * is read.
 *
 * Appends are offset-addressed, so a client that lost an answer can resend
 * the same chunk: bytes the spool already holds are compared, not written
 * twice, and a chunk that disagrees with them is refused.
 */
export { TRANSCRIPT_UPLOAD_MAX_BYTES, UploadTranscriptInput, UploadTranscriptOutput }
type UploadTranscriptInput = z.infer<typeof UploadTranscriptInput>

/** The spool directory each provider's uploads land in. */
export const transcriptUploadRoots = (root: string) => ({ claude: join(root, 'claude'), codex: join(root, 'codex') })

// One writer per spool file at a time (the API is one process).
const writers = new Map<string, Promise<unknown>>()
const serialized = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const next = (writers.get(key) ?? Promise.resolve()).then(fn, fn)
  writers.set(key, next.catch(() => undefined))
  return next
}

export async function appendUploadedTranscript(root: string, input: UploadTranscriptInput): Promise<z.infer<typeof UploadTranscriptOutput>> {
  const bytes = Buffer.from(input.content, 'utf8')
  if (bytes.length > TRANSCRIPT_UPLOAD_MAX_BYTES) throw new BadRequestError(`chunk is ${bytes.length} bytes; the limit is ${TRANSCRIPT_UPLOAD_MAX_BYTES}`)
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new BadRequestError('sha256 does not match content')
  const file = join(transcriptUploadRoots(root)[input.provider], input.clientId, input.path)
  return serialized(file, async () => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const size = await stat(file).then((s) => s.size, () => 0)
    if (input.offset > size) throw new ConflictError(`gap: the server holds ${size} bytes of this transcript, the chunk starts at ${input.offset}`)
    const handle = await open(file, 'a+', 0o600)
    try {
      // Bytes already held must equal the chunk's view of them.
      const overlap = Math.min(size, input.offset + bytes.length) - input.offset
      if (overlap > 0) {
        const held = Buffer.alloc(overlap)
        await handle.read(held, 0, overlap, input.offset)
        if (!held.equals(bytes.subarray(0, overlap))) throw new ConflictError(`the chunk at ${input.offset} differs from the ${overlap} bytes the server already holds`)
      }
      const fresh = bytes.subarray(Math.max(overlap, 0))
      if (fresh.length) {
        await handle.appendFile(fresh)
        await handle.sync()
      }
      return { size: size + fresh.length, appended: fresh.length, replayed: fresh.length === 0 }
    } finally {
      await handle.close()
    }
  })
}
