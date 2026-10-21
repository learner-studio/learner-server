import { z } from 'zod'

export const LosslessArchiveMode = z.enum(['periodic', 'backfill'])
export const LosslessArchiveCounts = z.object({
  sourcesDiscovered: z.number(), sourcesScanned: z.number(), bytesRead: z.number(),
  bytesWritten: z.number(), rawBytes: z.number(), encodedBytes: z.number(),
  versionsSealed: z.number(), versionsVerified: z.number(), gaps: z.number(), errors: z.number(),
  providerCalls: z.literal(0), llmCalls: z.literal(0), masteryMutations: z.literal(0),
})
export const LosslessArchiveBatchResult = z.object({
  runId: z.string().uuid(), status: z.enum(['completed', 'partial', 'failed']),
  totals: LosslessArchiveCounts,
  providers: z.array(z.object({
    provider: z.string(), sourcesDiscovered: z.number(), sourcesScanned: z.number(),
    bytesRead: z.number(), versionsSealed: z.number(), gaps: z.number(),
  })),
  versionIds: z.array(z.string().uuid()), limitations: z.array(z.string()),
  startedAt: z.string(), finishedAt: z.string(), elapsedMs: z.number(),
})
export const LosslessArchiveRunInput = z.object({ runId: z.string().uuid() })
// Root ids, or absolute path prefixes, whose sources a sweep should plan before
// the normal last-success ordering. Never widens the approved-root boundary: a
// preference only reorders sources the inventory already discovered.
export const LosslessArchivePrefer = z.array(z.string().min(1))
export const LosslessArchiveStartInput = z.object({
  mode: LosslessArchiveMode.default('backfill'), prefer: LosslessArchivePrefer.optional(),
})
export const LosslessArchiveDiscoveryInput = z.object({
  runId: z.string().uuid(), mode: LosslessArchiveMode, prefer: LosslessArchivePrefer.optional(),
})
export const LosslessArchiveDiscoveryOutput = z.object({ runId: z.string().uuid(), sourcesDiscovered: z.number() })
export const LosslessArchiveStatusOutput = z.object({
  enabled: z.boolean(), scheduleEnabled: z.boolean(), retention: z.literal('keep-originals'),
  sources: z.array(z.object({
    sourceId: z.string().uuid(), provider: z.string(), rootId: z.string(), relativePathDigest: z.string(),
    fileKind: z.string(), size: z.number(), generation: z.number(), cursor: z.number(),
    state: z.string(), lastSuccessfulCapture: z.string().nullable(), errorCode: z.string().nullable(),
  })),
  recentRuns: z.array(LosslessArchiveBatchResult),
  pendingSources: z.number(), backlogBytes: z.number(), limitations: z.array(z.string()),
})
