import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { LosslessArchiveProvider } from './lossless-archive-files.js'

const DEFAULT_SCAN_BYTES = 1024 * 1024
const DEFAULT_RECORD_BYTES = 256 * 1024
const MAX_REPORTED_GAPS = 256
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

export type ReferenceApprovedRoot = { id: string; path: string }
export type ArchiveReferenceResolution =
  | 'available-approved'
  | 'missing'
  | 'out-of-approved-roots'
  | 'remote-uri'
  | 'embedded'
  | 'unsupported'

export type LosslessArchiveReference = {
  sourceId: string
  provider: LosslessArchiveProvider
  provenanceUri: string
  recordKind: string
  referenceKind: 'attachment' | 'image' | 'file'
  locatorDigest: string
  resolution: ArchiveReferenceResolution
  approvedRootId?: string
  absolutePath?: string
  relativePath?: string
  byteLength?: number
}

export type ArchiveReferenceGap = {
  code: 'malformed-record' | 'oversize-record' | 'reference-limit' | 'missing-reference'
    | 'out-of-approved-roots' | 'remote-reference' | 'unsupported-reference' | 'source-mutated'
  provenanceUri: string
  locatorDigest?: string
  reason: string
}

export type LosslessArchiveReferenceScan = {
  references: LosslessArchiveReference[]
  gaps: ArchiveReferenceGap[]
  bytesScanned: number
  recordsScanned: number
  nextOffset: number
  discardingOversizeRecord: boolean
  complete: boolean
  limitations: string[]
}

export type LosslessArchiveReferenceScanInput = {
  sourceId: string
  provider: LosslessArchiveProvider
  sourcePath: string
  approvedRoots: ReferenceApprovedRoot[]
  startOffset?: number
  discardingOversizeRecord?: boolean
  maxSourceBytes?: number
  maxRecordBytes?: number
  maxReferences?: number
}

type Candidate = { locator: string; kind: LosslessArchiveReference['referenceKind'] }
type JsonObject = Record<string, unknown>

const object = (value: unknown): JsonObject | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as JsonObject : null
const string = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const provenance = (sourceId: string, offset: number): string => `archive-source://${encodeURIComponent(sourceId)}#byte=${offset}`
const within = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

const add = (items: Candidate[], value: unknown, kind: Candidate['kind']): void => {
  const locator = string(value)
  if (locator) items.push({ locator, kind })
}

const codexCandidates = (row: JsonObject): Candidate[] => {
  const items: Candidate[] = []
  const payload = object(row.payload)
  const item = object(payload?.item)
  if (row.type === 'event_msg' && item?.type === 'ImageView') add(items, item.path, 'image')
  const collectImages = (value: unknown): void => {
    if (Array.isArray(value)) for (const child of value) collectImages(child)
    else {
      const entry = object(value)
      if (!entry) return
      if (typeof entry.image_url === 'string') add(items, entry.image_url, 'image')
      for (const child of Object.values(entry)) collectImages(child)
    }
  }
  if (row.type === 'response_item' || row.type === 'compacted') collectImages(payload)
  return items
}

const claudeCandidates = (row: JsonObject): Candidate[] => {
  const items: Candidate[] = []
  const attachment = object(row.attachment)
  if (row.type === 'attachment' && attachment) {
    const attachmentType = string(attachment.type)
    if (attachmentType === 'file' || attachmentType === 'compact_file_reference') {
      add(items, object(object(attachment.content)?.file)?.filePath, 'attachment')
      add(items, attachment.path, 'attachment')
      add(items, attachment.filename, 'attachment')
      const files = Array.isArray(attachment.files) ? attachment.files : []
      for (const file of files) add(items, object(file)?.path, 'attachment')
    }
    add(items, attachment.url, attachmentType === 'file' ? 'attachment' : 'file')
  }
  const tool = object(row.toolUseResult)
  if (row.type === 'user' && tool) {
    add(items, tool.persistedOutputPath, 'file')
    if (tool.isImage === true) {
      add(items, tool.filePath, 'image')
      add(items, object(tool.file)?.filePath, 'image')
      add(items, tool.originalFile, 'image')
    }
  }
  return items
}

const candidates = (provider: LosslessArchiveProvider, row: JsonObject): Candidate[] => {
  if (provider === 'codex') return codexCandidates(row)
  if (provider === 'claude') return claudeCandidates(row)
  // Current AGY external paths observed in brain transcripts are tool-call
  // filesystem arguments, not attachment declarations. The approved brain tree
  // is inventoried directly; arbitrary tool AbsolutePath values are excluded.
  return []
}

const recordKind = (row: JsonObject): string => string(row.type) ?? 'unknown'

async function resolveCandidate(
  candidate: Candidate,
  input: LosslessArchiveReferenceScanInput,
  roots: Array<ReferenceApprovedRoot & { realPath: string }>,
  provenanceUri: string,
  kind: string,
): Promise<{ reference: LosslessArchiveReference; gap?: ArchiveReferenceGap }> {
  const locatorDigest = sha256(candidate.locator)
  const base = {
    sourceId: input.sourceId, provider: input.provider, provenanceUri, recordKind: kind,
    referenceKind: candidate.kind, locatorDigest,
  }
  if (/^data:/i.test(candidate.locator)) return { reference: { ...base, resolution: 'embedded' } }
  if (/^https?:/i.test(candidate.locator)) return {
    reference: { ...base, resolution: 'remote-uri' },
    gap: { code: 'remote-reference', provenanceUri, locatorDigest, reason: 'Remote references are recorded but never fetched automatically' },
  }
  let path: string
  try {
    path = candidate.locator.startsWith('file:') ? fileURLToPath(candidate.locator) : candidate.locator
  } catch {
    return {
      reference: { ...base, resolution: 'unsupported' },
      gap: { code: 'unsupported-reference', provenanceUri, locatorDigest, reason: 'Structured reference uses an invalid file URI' },
    }
  }
  if (!isAbsolute(path)) return {
    reference: { ...base, resolution: 'unsupported' },
    gap: { code: 'unsupported-reference', provenanceUri, locatorDigest, reason: 'Relative attachment reference has no provider-declared resolution base' },
  }
  const lexical = resolve(path)
  const lexicalRoot = roots.find((root) => within(root.realPath, lexical))
  if (!lexicalRoot) return {
    reference: { ...base, resolution: 'out-of-approved-roots' },
    gap: { code: 'out-of-approved-roots', provenanceUri, locatorDigest, reason: 'Referenced path is outside explicitly approved archive roots' },
  }
  let details: Awaited<ReturnType<typeof lstat>>
  try { details = await lstat(lexical) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {
      reference: { ...base, resolution: 'missing', approvedRootId: lexicalRoot.id },
      gap: { code: 'missing-reference', provenanceUri, locatorDigest, reason: 'Referenced attachment is unavailable under its approved root' },
    }
    throw error
  }
  if (!details.isFile() || details.isSymbolicLink()) return {
    reference: { ...base, resolution: 'unsupported', approvedRootId: lexicalRoot.id },
    gap: { code: 'unsupported-reference', provenanceUri, locatorDigest, reason: 'Referenced attachment is not a regular file and was not followed' },
  }
  const actual = await realpath(lexical)
  const actualRoot = roots.find((root) => within(root.realPath, actual))
  if (!actualRoot) return {
    reference: { ...base, resolution: 'out-of-approved-roots' },
    gap: { code: 'out-of-approved-roots', provenanceUri, locatorDigest, reason: 'Referenced file resolves outside explicitly approved archive roots' },
  }
  return { reference: {
    ...base, resolution: 'available-approved', approvedRootId: actualRoot.id, absolutePath: actual,
    relativePath: relative(actualRoot.realPath, actual) || '.', byteLength: details.size,
  } }
}

export async function scanLosslessArchiveReferences(
  input: LosslessArchiveReferenceScanInput,
): Promise<LosslessArchiveReferenceScan> {
  const startOffset = input.startOffset ?? 0
  const maxSourceBytes = input.maxSourceBytes ?? DEFAULT_SCAN_BYTES
  const maxRecordBytes = input.maxRecordBytes ?? DEFAULT_RECORD_BYTES
  const maxReferences = input.maxReferences ?? 256
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) throw new Error('reference scan startOffset must be a non-negative safe integer')
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 64 || maxSourceBytes > DEFAULT_SCAN_BYTES) throw new Error('reference maxSourceBytes must be 64 bytes to 1 MiB')
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 32 || maxRecordBytes > maxSourceBytes) throw new Error('reference maxRecordBytes must be 32 bytes through maxSourceBytes')
  if (!Number.isSafeInteger(maxReferences) || maxReferences < 1 || maxReferences > 2_000) throw new Error('reference maxReferences must be 1 to 2000')

  const roots = (await Promise.all(input.approvedRoots.map(async (root) => ({ ...root, realPath: await realpath(root.path).catch(() => '') }))))
    .filter((root) => root.realPath)
  const sourceReal = await realpath(input.sourcePath)
  if (!roots.some((root) => within(root.realPath, sourceReal))) throw new Error('reference scan source is outside approved roots')
  const sourceLink = await lstat(input.sourcePath)
  if (!sourceLink.isFile() || sourceLink.isSymbolicLink()) throw new Error('reference scan source must be a regular file')
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const handle = await open(sourceReal, constants.O_RDONLY | noFollow)
  const references: LosslessArchiveReference[] = []
  const gaps: ArchiveReferenceGap[] = []
  let gapCapacityRecorded = false
  let referenceLimitRecorded = false
  const addGap = (gap: ArchiveReferenceGap): void => {
    if (gaps.length < MAX_REPORTED_GAPS - 1) gaps.push(gap)
    else if (!gapCapacityRecorded) {
      gaps.push({ code: 'reference-limit', provenanceUri: gap.provenanceUri,
        reason: 'Additional metadata gaps in this bounded sweep were aggregated after the reporting limit' })
      gapCapacityRecorded = true
    }
  }
  let recordsScanned = 0
  let nextOffset = startOffset
  let discarding = input.discardingOversizeRecord ?? false
  try {
    const before = await handle.stat()
    if (startOffset > before.size) throw new Error('reference scan cursor exceeds source size')
    if (startOffset > 0 && !discarding) {
      const previous = Buffer.alloc(1)
      const read = await handle.read(previous, 0, 1, startOffset - 1)
      if (read.bytesRead !== 1 || previous[0] !== 10) throw new Error('reference scan cursor is not at a record boundary')
    }
    const requested = Math.min(maxSourceBytes, before.size - startOffset)
    const buffer = Buffer.alloc(requested)
    const read = await handle.read(buffer, 0, requested, startOffset)
    const bytes = buffer.subarray(0, read.bytesRead)
    let local = 0
    while (local < bytes.length) {
      const absoluteOffset = startOffset + local
      const newline = bytes.indexOf(10, local)
      const atObservedEof = startOffset + bytes.length >= before.size
      if (discarding) {
        if (newline === -1) { nextOffset = startOffset + bytes.length; local = bytes.length; break }
        local = newline + 1; nextOffset = startOffset + local; discarding = false; continue
      }
      const end = newline === -1 ? bytes.length : newline
      const length = end - local
      if (newline === -1 && !atObservedEof) {
        if (length <= maxRecordBytes) {
          // The window ended in the middle of an otherwise bounded record. Keep
          // the cursor at the record boundary so the next sweep can parse it.
          nextOffset = absoluteOffset
        } else {
          addGap({ code: 'oversize-record', provenanceUri: provenance(input.sourceId, absoluteOffset), reason: 'JSONL record exceeds the configured metadata parser bound and is skipped until its delimiter' })
          discarding = true
          nextOffset = startOffset + bytes.length
        }
        local = bytes.length
        break
      }
      const consumed = length + (newline === -1 ? 0 : 1)
      const provenanceUri = provenance(input.sourceId, absoluteOffset)
      if (length > maxRecordBytes) {
        addGap({ code: 'oversize-record', provenanceUri, reason: 'JSONL record exceeds the configured metadata parser bound' })
      } else if (length > 0) {
        let row: JsonObject | null = null
        try { row = object(JSON.parse(strictUtf8.decode(bytes.subarray(local, end)))) }
        catch { addGap({ code: 'malformed-record', provenanceUri, reason: 'Malformed JSONL metadata record was retained opaquely but not reference-parsed' }) }
        if (row) {
          recordsScanned += 1
          const seen = new Set<string>()
          for (const candidate of candidates(input.provider, row)) {
            const key = `${candidate.kind}\0${candidate.locator}`
            if (seen.has(key)) continue
            seen.add(key)
            if (references.length >= maxReferences) {
              if (!referenceLimitRecorded) {
                addGap({ code: 'reference-limit', provenanceUri, reason: 'Reference count reached the configured per-sweep bound; additional locators were not resolved' })
                referenceLimitRecorded = true
              }
              continue
            }
            const resolved = await resolveCandidate(candidate, input, roots, provenanceUri, recordKind(row))
            references.push(resolved.reference)
            if (resolved.gap) addGap(resolved.gap)
          }
        }
      }
      if (local >= bytes.length) break
      local += consumed
      nextOffset = startOffset + local
    }
    const after = await handle.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || after.size < nextOffset
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('reference source mutated during metadata scan')
    }
    return {
      references, gaps, bytesScanned: read.bytesRead, recordsScanned, nextOffset,
      discardingOversizeRecord: discarding, complete: nextOffset >= after.size && !discarding,
      limitations: [
        'Reference scanning is a bounded metadata pass; opaque archival bytes remain authoritative.',
        'Only explicit Codex ImageView and Claude attachment/image/persisted-output fields are recognized.',
        'AGY brain sidecars are inventoried directly; arbitrary tool filesystem arguments are not attachments.',
        'Relative paths without a provider-declared base, remote URLs, and paths outside approved roots are never fetched.',
      ],
    }
  } finally { await handle.close() }
}
