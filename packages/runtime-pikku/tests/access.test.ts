import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pikkuState } from '@pikku/core/state'
import { buildRegistry } from '@learner/server/functions/registry.js'
import { ROUTES } from '@learner/server/http/routes.js'
import { z } from 'zod'
import { checkAccess } from '@learner/server/runtime/invoke.js'
import { defineFunction, defineSessionlessFunction, FUNCTION } from '@learner/server/runtime/define.js'
import { currentCliContext } from '@learner/llm/lib/cli/cli-telemetry.js'
import { ForbiddenError, UnauthorizedError, UnprocessableContentError } from '@learner/core/runtime/errors.js'
import type { Session } from '@learner/core/runtime/index.js'
import { accessFor, learnerCallScope } from '../src/middleware.js'
import { runShared } from '../src/adapt.js'
import '../.pikku/function/pikku-functions-meta.gen.js'

const ROOT = join(import.meta.dir, '..')
const routed = new Set(ROUTES.map((r) => r.func))
const session = (scopes: string[]): Session => ({ userId: 'u', email: 'x@devices.learner.invalid', scopes })
const services = { logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } } as never
afterEach(() => { delete process.env.LEARNER_FAULT_PAUSE_AFTER_STEP_RPC })

// A confined credential (docs/specs/server-desktop-pairing.md, "Confined credentials") reaches only the functions
// that opt in; every other externally reachable function, shared or Pikku-native, including any added later, refuses it.
describe('confined credentials', () => {
  const names = new Set([...buildRegistry().keys(), ...Object.keys(pikkuState(null, 'function', 'meta'))])
  const reachable = [...names].flatMap((name) => {
    const access = accessFor(name)
    return access && (access.expose || routed.has(name)) ? [[name, access] as const] : []
  })
  const callable = (s: Session) => reachable.filter(([name, access]) => {
    try {
      checkAccess(name, access, s, routed.has(name) && !access.expose ? 'route' : 'rpc')
      return true
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error
      return false
    }
  }).map(([name]) => name).sort()

  test('Pikku-native functions are judged from Pikku\'s own meta', () => {
    expect(accessFor('selectLearningDriftPanel')).toEqual({ kind: 'session', expose: true, scopes: ['admin'] })
    expect(accessFor('learningDriftPanelWorkflow')?.kind).toBe('workflow')
    expect(reachable.map(([name]) => name)).toContain('runLearningDriftPanel')
  })

  test('ci-mint reaches only the test-device lifecycle', () => {
    expect(callable(session(['ci-mint']))).toEqual(['createTestDevice', 'revokeTestDevice', 'seedMasteryGain'])
  })

  test('a test device reaches only its heartbeat, its endpoints, its own feed and feedback, and the coach design', () => {
    expect(callable(session(['app', 'test-device']))).toEqual(
      ['getBaselineStatus', 'getMasteryNotifications', 'getPairingEndpoints', 'getSpeakingCoachDesign', 'recordAppHeartbeat', 'recordNotificationFeedback'])
  })

  test('a real device key is not narrowed, and an admin cannot call the ci-mint functions', () => {
    const app = callable(session(['app']))
    for (const name of ['recordHabitEvents', 'recordCalls', 'uploadTranscript', 'getBaselineStatus']) expect(app).toContain(name)
    expect(app).not.toContain('selectLearningDriftPanel')
    expect(callable(session(['admin']))).not.toContain('createTestDevice')
    expect(callable(session(['admin']))).toContain('selectLearningDriftPanel')
  })
})

// The access rules themselves are driven through real requests in http-access.test.ts.
describe('externalAccess', () => {
  test('is on every HTTP route (the \'*\' group), so no route skips it', () => {
    const meta = JSON.parse(readFileSync(join(ROOT, '.pikku/http/pikku-http-wirings-meta.gen.json'), 'utf8')) as Record<string, Record<string, { middleware?: unknown[] }>>
    const routes = Object.entries(meta).flatMap(([method, byRoute]) => Object.entries(byRoute).map(([route, m]) => ({ id: `${method} ${route}`, middleware: m.middleware ?? [] })))
    expect(routes.length).toBeGreaterThan(20)
    expect(routes.filter((r) => !r.middleware.some((m) => JSON.stringify(m) === JSON.stringify({ type: 'http', route: '*' }))).map((r) => r.id)).toEqual([])
  })
})

describe('learnerCallScope (telemetry scope and fault pause around a native function)', () => {
  const run = async (functionId: string, wire: Record<string, unknown>) => {
    let seen: { label?: string; jobId?: string } = {}
    const started = Date.now()
    await learnerCallScope(services, { functionId, ...wire } as never, async () => { const { label, jobId } = currentCliContext(); seen = { label, jobId } })
    return { ...seen, ms: Date.now() - started }
  }

  test('a step\'s model calls carry the function and its run; a shared function keeps runShared\'s own scope', async () => {
    expect(await run('regradeLearningDriftPanelItemStep', { workflowStep: { runId: 'run-1', invocationId: 'i', stepId: 's' } }))
      .toMatchObject({ label: 'regradeLearningDriftPanelItemStep', jobId: 'run-1' })
    expect(await run('runLearningDriftPanel', {})).toMatchObject({ label: 'runLearningDriftPanel', jobId: undefined })
    const shared = [...buildRegistry()].find(([, def]) => def[FUNCTION] !== 'workflow')![0] // any function still in the registry
    expect((await run(shared, {})).label).toBeUndefined()
  })

  test('LEARNER_FAULT_PAUSE_AFTER_STEP_RPC holds the named step after its body, and only a step', async () => {
    process.env.LEARNER_FAULT_PAUSE_AFTER_STEP_RPC = 'planLearningDriftPanelWeekStep:300'
    expect((await run('planLearningDriftPanelWeekStep', { workflowStep: { runId: 'run-2', invocationId: 'i', stepId: 's' } })).ms).toBeGreaterThanOrEqual(290)
    expect((await run('planLearningDriftPanelWeekStep', {})).ms).toBeLessThan(200)
    expect((await run('summarizeLearningDriftPanelWeekStep', { workflowStep: { runId: 'run-3', invocationId: 'i', stepId: 's' } })).ms).toBeLessThan(200)
  })
})

describe('runShared (the internal rules for a function still written with runtime/define.js)', () => {
  test('a session function called without a session is refused, and bad input never reaches the body', async () => {
    let ran = 0
    const body = async () => { ran++ }
    await expect(runShared('needsSession', defineFunction({ func: body }), services, {}, {} as never)).rejects.toBeInstanceOf(UnauthorizedError)
    await expect(runShared('typed', defineSessionlessFunction({ input: z.object({ n: z.number() }), func: body }), services, { n: 'x' }, {} as never))
      .rejects.toBeInstanceOf(UnprocessableContentError)
    expect(ran).toBe(0)
  })
})
