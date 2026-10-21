import { defineSessionlessFunction } from '../../../runtime/define.js'
import { z } from 'zod'

export const DiscoverLearningTranscriptSourcesStepInput = z.object({
  scanMode: z.enum(['periodic', 'daily']),
})

export const DiscoverLearningTranscriptSourcesStepOutput = z.object({
  scanMode: z.enum(['periodic', 'daily']),
  sourcesDiscovered: z.number().int().nonnegative(),
})

export const RunLearningTranscriptArchiveScanStepInput = DiscoverLearningTranscriptSourcesStepOutput

export const RunLearningTranscriptArchiveScanStepOutput = z.object({
  archiveOnlyConfigVerified: z.literal(true),
  scanMode: z.enum(['periodic', 'daily']),
  sourcesDiscovered: z.number().int().nonnegative(),
  sourcesScanned: z.number().int().nonnegative(),
  recordsRead: z.number().int().nonnegative(),
  messagesStored: z.number().int().nonnegative(),
  replaysVerified: z.number().int().nonnegative(),
  bytesRead: z.number().int().nonnegative(),
  newestSourceMtime: z.string().nullable(),
  errors: z.array(z.string()),
})

export const discoverLearningTranscriptSourcesStep = defineSessionlessFunction({
  title: 'Discover local CLI transcript sources',
  input: DiscoverLearningTranscriptSourcesStepInput,
  output: DiscoverLearningTranscriptSourcesStepOutput,
  func: async ({ learningTranscriptArchiveService }, input) => ({
    scanMode: input.scanMode,
    sourcesDiscovered: (await learningTranscriptArchiveService.discoverSources()).length,
  }),
})

export const runLearningTranscriptArchiveScanStep = defineSessionlessFunction({
  title: 'Archive a bounded local CLI transcript batch',
  input: RunLearningTranscriptArchiveScanStepInput,
  output: RunLearningTranscriptArchiveScanStepOutput,
  func: async ({ learningTranscriptArchiveService }, input) => ({
    scanMode: input.scanMode,
    ...await learningTranscriptArchiveService.scan(),
  }),
})
