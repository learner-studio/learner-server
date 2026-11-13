import { afterAll, describe, expect, test } from 'bun:test'
import { rpcService } from '@pikku/core/rpc'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { getRunUserId } from '@learner/core/lib/workflow/workflow-runs.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * A run started by a Pikku-native function keeps the owner the shared start wrote (`{ type: 'http', userId }`):
 * startLearningTranscriptArchiveSweep passes that wire explicitly, so `getRunUserId` (what every ownership check
 * reads) is the caller. On this checkout's OWN database, with the transcript scan replaced by a fixed result.
 */
const url = await ownTestDatabaseUrl('archive')
const SCAN = { archiveOnlyConfigVerified: true as const, sourcesDiscovered: 0, sourcesScanned: 0, recordsRead: 0, messagesStored: 0, replaysVerified: 0, bytesRead: 0, newestSourceMtime: null, errors: [] }

describe.skipIf(!url)('a native start keeps the run owner (learner_archive_test_<checkout>)', () => {
  process.env.LEARNING_TRANSCRIPT_ARCHIVE_SCHEDULE_ENABLED = 'true'
  const runtime = bootRuntime({ databaseUrl: url!, schemaPrefix: 'learner_pikku_boss_test_arch_', prepare: (services) => {
    services.learningTranscriptArchiveService = { discoverSources: async () => [], scan: async () => SCAN }
  } })
  afterAll(() => runtime.stop())

  test('startLearningTranscriptArchiveSweep: the run is the caller\'s, an http run, and the default scanMode applies', async () => {
    const services = await runtime.booted
    const userId = `archive-owner-${crypto.randomUUID()}`
    const rpc = rpcService.getContextRPCService(services, { session: { userId, email: 'owner@example.invalid', scopes: ['admin'] } }, false)
    const { runId } = await rpc.invoke('startLearningTranscriptArchiveSweep', {})
    const run = await runtime.awaitRun(runId)
    expect(run?.wire?.type).toBe('http')
    expect(getRunUserId(run!)).toBe(userId)
    expect(run?.status).toBe('completed')
    expect(run?.output).toMatchObject({ scanMode: 'periodic', sourcesDiscovered: 0 })
  }, 120_000)
})
