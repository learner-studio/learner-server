import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { database, isDatabaseBound } from '@learner/core/db/handle.js'
import { buildRegistry } from '@learner/server/functions/registry.js'
import type { Services } from '@learner/server/services.js'
import { FunctionRuntime } from '../host.js'
import { DurableEngine } from './durable.js'

/**
 * learningReactiveStallCheckWorkflow in the standalone durable engine on learner_test.
 * A stalled owner fails the run at the named step with the stall reason; an idle
 * owner completes green. Fixture owners have their own ids and are removed after;
 * no shared row is truncated. The default runtime's adapter package has a twin
 * (tests/reactive-stall-check.test.ts) that applies the same checks.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL || !isDatabaseBound())('reactive stall check workflow (learner_test)', () => {
  const db = database()
  const quiet = { info() {}, warn() {}, debug() {}, error() {} }
  const services = { db, kysely: db.kysely, logger: quiet } as unknown as Services
  const engine = new DurableEngine(db).attach(new FunctionRuntime(buildRegistry(), () => services))
  const stalled = `stall-check-red-${randomUUID()}`, idle = `stall-check-idle-${randomUUID()}`
  const owner = (user: string, activatedHoursAgo: number) => db.query(`INSERT INTO learning_reactive_settings(user_id,enabled,activated_at,config,revision)
    VALUES($1,true,now()-make_interval(hours=>$2::int),'{"enabled":true,"assessmentEnabled":true,"concurrency":4}','stall-check-fixture')`, [user, activatedHoursAgo])
  afterAll(async () => {
    await db.query('DELETE FROM learning_reactive_admission WHERE user_id=ANY($1)', [[stalled, idle]])
    await db.query('DELETE FROM learning_reactive_settings WHERE user_id=ANY($1)', [[stalled, idle]])
  })

  test('a concept waiting past the bound with no settled pass fails the named step with its reason', async () => {
    // Switched on before the concept began waiting (7 h): health floors its waiting rules at the switch-on.
    await owner(stalled, 8)
    await db.query(`INSERT INTO learning_reactive_admission(user_id,session_id,requested_generation,captured_generation,attempts,last_notified_at)
      VALUES($1,$2,1,0,0,now()-interval '7 hours')`, [stalled, randomUUID()])
    const { runId } = await engine.startWorkflow('learningReactiveStallCheckWorkflow', { userId: stalled }, { type: 'internal' }, undefined, { inline: true })
    expect((await engine.getRun(runId))?.status).toBe('failed')
    const steps = await engine.getRunSteps(runId)
    expect(steps.map(s => [s.stepName, s.status])).toEqual([['Measure reactive grading progress', 'succeeded'], ['Fail when grading has stalled', 'failed']])
    // Arrivals are global: other files' fixtures in the window may add a routing message, so the two are checked apart.
    expect(JSON.stringify(steps[1]!.error)).toContain(`Reactive grading stalled: ${stalled}: `)
    expect(JSON.stringify(steps[1]!.error)).toContain('Grading stalled: 1 concepts waiting since')
  }, 60_000)

  test('an idle owner completes green', async () => {
    await owner(idle, 0)
    const { runId } = await engine.startWorkflow('learningReactiveStallCheckWorkflow', { userId: idle }, { type: 'internal' }, undefined, { inline: true })
    const run = await engine.getRun(runId)
    expect(run?.status).toBe('completed')
    expect(run?.output).toEqual({ checked: 1, status: 'ok', messages: [] })
  }, 60_000)
})
