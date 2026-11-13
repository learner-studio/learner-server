import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { pikkuState } from '@pikku/core/state'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'

/**
 * Deploying core 0.12.156 over runs started under 0.12.102: those stored no workflow version and carry a graph hash
 * the new codegen no longer produces, so the framework would fail them with VERSION_NOT_FOUND. The worker moves such a
 * run to the current hash at boot (recovery.ts adoptUnversionedRuns), and leaves one whose version is stored to the
 * framework's own resume-from-stored-graph path. Its own migrated database: the adoption reads every run in it.
 */
const url = await ownTestDatabaseUrl('adopt')
describe.skipIf(!url)('runs started before workflow versions were stored (learner_adopt_test_<checkout>)', () => {
  Object.assign(process.env, { LEARNER_DATABASE_URL: url!, DATABASE_URL: url! })
  setRuntimeRole('api')
  const booted = (async () => {
    await import('../.pikku/pikku-bootstrap.gen.js')
    const { createConfig } = await import('../src/config.js')
    const { createSingletonServices } = await import('../src/services.js')
    return createSingletonServices(await createConfig())
  })()
  const WORKFLOW = 'learningWorkerProbeWorkflow'
  const unversioned = randomUUID(), versioned = randomUUID(), settled = randomUUID()
  const stale = `fixture-${randomUUID().slice(0, 8)}`
  afterAll(async () => {
    const { db, close } = await booted
    await db.query('DELETE FROM learner_workflow_runs WHERE workflow_run_id = ANY($1)', [[unversioned, versioned, settled]])
    await db.query('DELETE FROM learner_workflow_versions WHERE workflow_name = $1 AND graph_hash = $2', [WORKFLOW, `${stale}-v`])
    await close()
  })

  test('an unversioned in-flight run moves to the current hash; a versioned or settled one is left alone', async () => {
    const services = await booted
    const insert = (id: string, status: string, hash: string) => services.db.query(
      `INSERT INTO learner_workflow_runs (workflow_run_id, workflow, status, input, graph_hash) VALUES ($1, $2, $3, '{}', $4)`, [id, WORKFLOW, status, hash])
    await insert(unversioned, 'running', stale)
    await insert(versioned, 'suspended', `${stale}-v`)
    await insert(settled, 'completed', stale)
    await services.db.query(`INSERT INTO learner_workflow_versions (workflow_name, graph_hash, graph, source) VALUES ($1, $2, '{}', 'dsl')`, [WORKFLOW, `${stale}-v`])
    const { adoptUnversionedRuns } = await import('../src/recovery.js')
    expect(await adoptUnversionedRuns(services.kysely, services.workflowService, services.logger)).toContain(unversioned)
    const current = (pikkuState(null, 'workflows', 'meta') as Record<string, { graphHash: string }>)[WORKFLOW]!.graphHash
    const hashes = (await services.db.query<{ id: string; hash: string }>('SELECT workflow_run_id AS id, graph_hash AS hash FROM learner_workflow_runs WHERE workflow_run_id = ANY($1)', [[unversioned, versioned, settled]])).rows
    expect(Object.fromEntries(hashes.map((r) => [r.id, r.hash]))).toEqual({ [unversioned]: current, [versioned]: `${stale}-v`, [settled]: stale })
  })
})
