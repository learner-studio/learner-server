import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { archivePlaygroundTurn } from '@learner/core/lib/learning/learning-playground-archive.js'
import { indexCoalescer, markIndexDirty } from '@learner/core/lib/learning/learning-index-admission.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * learningSemanticIndexWorkflow on the framework runtime, Hindsight stubbed at its HTTP contract. Each run used to
 * insert the FULL canonical membership (~58k ids on the live box, 3-31 runs an hour: 180 M rows, 45 GB). A run now
 * keeps only its unsettled work set: N runs over a growing archive write the new messages, not N full copies.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('semantic index membership, framework runtime', () => {
  process.env.LEARNING_SEMANTIC_INDEX_ENABLED = 'true'
  delete process.env.LEARNING_VECTOR_TURNS_READ_VIEW_ENABLED
  const originalFetch = globalThis.fetch
  const documents = new Map<string, string>()
  const operations = new Set<string>()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.startsWith('http://127.0.0.1:18925/')) return originalFetch(input as Request, init)
    if (url.endsWith('/version')) return Response.json({ api_version: '0.9.2', features: { observations: false, bank_config_api: false, store_document_text: true } })
    if (url.endsWith('/config')) return Response.json({ config: { retain_extraction_mode: 'chunks', store_document_text: true, enable_observations: false, enable_auto_consolidation: false, retain_chunk_size: 3000 } })
    if (url.includes('/operations/')) {
      const operationId = url.split('/').at(-1)!
      return Response.json({ operation_id: operationId, status: operations.has(operationId) ? 'completed' : 'not_found' })
    }
    if (url.endsWith('/memories') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { operation_id: string; items: Array<{ document_id: string; content: string }> }
      operations.add(body.operation_id)
      for (const item of body.items) documents.set(item.document_id, item.content)
      return Response.json({ operation_id: body.operation_id })
    }
    if (url.includes('/documents/')) {
      const text = documents.get(url.split('/').at(-1)!)
      return text === undefined ? new Response('', { status: 404 }) : Response.json({ original_text: text })
    }
    throw new Error(`Unrecognized isolated HTTP contract: ${url}`)
  }) as typeof fetch
  const runtime = bootRuntime({ schemaPrefix: 'lp_boss_semantic_members_' })
  const userId = `semantic-members-${randomUUID()}`
  afterAll(async () => { await runtime.stop(); globalThis.fetch = originalFetch })

  test('three runs over a growing archive store each run\'s new messages, not three full memberships', async () => {
    const services = await runtime.booted
    const q = services.db.query
    const runs: Array<{ runId: string; mine: number; members: number; canonical: number }> = []
    const conversations: string[] = []
    for (let turn = 0; turn < 3; turn++) {
      const conversationId = randomUUID()
      conversations.push(conversationId)
      await archivePlaygroundTurn(services.learningLosslessArchiveService, services.learningExposureService, { requestId: randomUUID(), conversationId, userId,
        provider: 'codex', message: `Fixture learner question ${turn} about spaced repetition.`, response: `Fixture answer ${turn}.`, receivedAt: new Date().toISOString() })
      // The production arrival path: mark the index dirty, dispatch the claimed generation as a workflow.
      await markIndexDirty(randomUUID())
      let runId = ''
      await indexCoalescer.dispatchArchiveSessions(async data => (runId = await runtime.start('learningSemanticIndexWorkflow', data)))
      const run = await runtime.awaitRun(runId, 120_000)
      if (run?.status !== 'completed') console.log(JSON.stringify((await services.workflowRunService.getRunSteps(runId)).map((s: { stepName: string; status: string; error?: unknown }) => [s.stepName, s.status, s.error])))
      expect(run?.status).toBe('completed')
      const counts = (await q<{ members: number; mine: number; canonical: number }>(`SELECT
        (SELECT count(*)::int FROM learning_semantic_index_members WHERE run_id=$1::uuid) AS members,
        (SELECT count(*)::int FROM learning_semantic_index_members b JOIN learning_semantic_index_messages m USING(message_id)
          WHERE b.run_id=$1::uuid AND m.conversation_id=$2) AS mine,
        (SELECT canonical_messages FROM learning_semantic_index_runs WHERE run_id=$1::uuid) AS canonical`, [runId, conversationId])).rows[0]!
      runs.push({ runId, ...counts })
    }
    // Every run froze its new turn (user + assistant) as its work set and indexed it.
    expect(runs.map(r => r.mine)).toEqual([2, 2, 2])
    expect(new Set(runs.map(r => r.runId)).size).toBe(3)
    // The watermark still covers the whole canonical set; earlier turns are not copied again.
    expect(runs[2]!.canonical).toBeGreaterThanOrEqual(runs[0]!.canonical + 4)
    for (const run of runs.slice(1)) expect(run.members).toBeLessThan(run.canonical)
    const indexed = (await q<{ n: number }>(`SELECT count(*)::int AS n FROM learning_semantic_index_messages
      WHERE current_canonical AND status='indexed' AND conversation_id=ANY($1)`, [conversations])).rows[0]!.n
    expect(indexed).toBe(6)
  }, 400_000)
})
