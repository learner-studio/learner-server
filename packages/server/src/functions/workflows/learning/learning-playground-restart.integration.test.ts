import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindDatabase, createDatabase } from '@learner/core/db/handle.js'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { metaDbQuery as q } from '@learner/core/lib/db-metadata/_shared.js'
import { assessmentHash } from '@learner/core/lib/learning/learning-concept-assessment.js'
import { FAKE_CODEX, fakeCli } from '@learner/llm/lib/cli/testing/crash-harness.js'

// The playground's live response is a CLI call under the shared lease (restart-safety.md). A worker killed after
// reserving it leaves a reservation with no receipt and no lease owner: the replay runs the (repeat-free) call once
// and records one receipt; a metered backend answers provider_error and calls nothing.
// The CLI agents read their binary at import: point codex at the fake BEFORE the step module loads.
process.env.CODEX_CLI_BIN = FAKE_CODEX
const { respondLearningPlaygroundStep } = await import('./learning-playground-steps.function.js')
const url = await ownTestDatabaseUrl('playground')
if (url) bindDatabase(createDatabase(url, { max: 2, applicationName: 'learner-test-playground' }))
describe.skipIf(!url)('playground response after a restart (learner_playground_test_<checkout>)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'playground-restart-'))
  const orphaned = async () => {
    const requestId = `restart-${randomUUID()}`, userId = 'playground-restart-test', prompt = 'Say hello.'
    await q(`INSERT INTO learning_playground_response_attempts(request_id,user_id,input_hash,reserved_at) VALUES($1,$2,$3,now() - interval '1 hour')`,
      [requestId, userId, assessmentHash({ userId, provider: 'codex', prompt })])
    return { mode: 'live', provider: 'codex', contextMode: 'retrieval', requestId, userId, scenario: 'normal', lookup: { prompt, invocationCount: 0, matches: [], decision: 'none' } }
  }
  const run = (input: unknown) => respondLearningPlaygroundStep.func({} as never, input as never, {} as never)
  const withEnv = async <T>(env: Record<string, string>, f: () => Promise<T>) => {
    const saved = { ...process.env }
    Object.assign(process.env, { LEARNING_LOCAL_MVP_ENABLED: 'true', LEARNER_LLM_ATTEMPT_DIR: join(scratch, 'attempts'), ...env })
    try { return await f() } finally { process.env = saved }
  }

  test('repeat-free: the orphaned call runs once, one receipt, a takeover row; a replay returns the receipt', async () => {
    const input = await orphaned()
    const cli = fakeCli(scratch, input.requestId, 'hello from the fake', 0)
    await withEnv(cli.env, async () => {
      expect(await run(input)).toMatchObject({ outcome: 'response', response: expect.stringContaining('hello from the fake') })
      expect(await run(input)).toMatchObject({ outcome: 'response' })
    })
    expect(cli.calls()).toBe(1)
    expect((await q('SELECT action FROM learning_llm_attempt_reclaims WHERE attempt_key=$1', [`playground:${input.requestId}`])).rows).toEqual([{ action: 'takeover' }])
  })

  test('metered: the orphaned call is never repeated', async () => {
    const input = await orphaned()
    const cli = fakeCli(scratch, input.requestId, 'hello', 0, { LEARNER_METERED_BACKENDS: 'codex' })
    await withEnv(cli.env, async () => expect(await run(input)).toMatchObject({ outcome: 'provider_error', response: null }))
    expect(cli.calls()).toBe(0)
  })
})
