import { describe, expect, mock, test } from 'bun:test'
import * as auth from '@learner/server/auth.js'
import type { Session } from '@learner/core/runtime/index.js'

// Real requests through Pikku's own HTTP runner over the generated bootstrap: the REGISTERED global and HTTP
// middleware (wirings/middleware.wiring.ts) run in Pikku's order, then Pikku's function runner applies its own
// session and scope rules. No database: the owning user's session (sessionForUser) is mocked, and Better Auth is a
// stand-in that resolves a credential to its user id from a header.
const owners: Record<string, Session | undefined> = {
  'u-admin': { userId: 'u-admin', email: 'a@example.org', scopes: ['admin'] },
  'u-app': { userId: 'u-app', email: 'b@example.org', scopes: ['app'] },
  'u-td': { userId: 'u-td', email: 'td@devices.learner.invalid', scopes: ['app', 'test-device'] },
  'u-ci': { userId: 'u-ci', email: 'ci@devices.learner.invalid', scopes: ['ci-mint'] },
}
mock.module('@learner/server/auth.js', () => ({ ...auth, sessionForUser: async (_k: unknown, _c: unknown, userId: string) => owners[userId] }))

await import('../.pikku/pikku-bootstrap.gen.js')
await import('../src/services.js') // registers Learner's error classes with Pikku (status mapping)
const { setSingletonServices } = await import('@pikku/core/state')
const { fetch } = await import('@pikku/core/http')
const { CFWorkerSchemaService } = await import('@pikku/schema-cfworker')
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {}, setLevel: () => {} }
const betterAuth = async () => ({ api: { getSession: async ({ headers }: { headers: Headers }) => {
  const id = headers.get('x-test-user')
  return id ? { user: { id, email: `${id}@example.org` }, session: { userId: id } } : null
} } })
setSingletonServices({
  logger, schema: new CFWorkerSchemaService(logger as never), auth: betterAuth, kysely: {}, authConfig: {},
  db: { query: async () => ({ rows: [] }) }, config: { role: 'api' }, variables: { get: () => undefined },
} as never)

const request = async (method: string, path: string, user?: string, body?: unknown) =>
  (await fetch(new Request(`http://local${path}`, {
    method, headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  }))).status
const rpc = (name: string, user?: string, extra: Record<string, unknown> = {}) => request('POST', `/rpc/${name}`, user, { data: {}, ...extra })
/** Past every access rule: the body ran (and here fails on the stub services) instead of a 401, 403 or 404. */
const admitted = (status: number) => ![401, 403, 404].includes(status)

describe('access over real HTTP, through the registered middleware', () => {
  test('/rpc: a native admin function needs a session (401) and the scope (403); confined credentials are refused', async () => {
    expect(await rpc('selectLearningDriftPanel')).toBe(401)
    expect(await rpc('selectLearningDriftPanel', 'u-app')).toBe(403)
    expect(await rpc('selectLearningDriftPanel', 'u-td')).toBe(403)
    expect(await rpc('selectLearningDriftPanel', 'u-ci')).toBe(403)
    expect(admitted(await rpc('selectLearningDriftPanel', 'u-admin'))).toBe(true)
  })

  test('/rpc: an unexposed step, a workflow, an unknown or versioned name is not found; the body cannot rename the target', async () => {
    for (const name of ['planLearningDriftPanelWeekStep', 'learningDriftPanelWorkflow', 'noSuchFunction', 'selectLearningDriftPanel@v1']) {
      expect(await rpc(name, 'u-admin')).toBe(404)
    }
    // A body `rpcName` that differs from the path is refused (Pikku merges path and body and rejects the conflict).
    expect(await rpc('selectLearningDriftPanel', 'u-admin', { rpcName: 'planLearningDriftPanelWeekStep' })).toBe(422)
  })

  test('/rpc: confined admission and the ci-mint opt-in (shared or native alike)', async () => {
    expect(admitted(await rpc('getPairingEndpoints', 'u-td'))).toBe(true)
    expect(await rpc('recordHabitEvents', 'u-td')).toBe(403)
    expect(admitted(await rpc('createTestDevice', 'u-ci'))).toBe(true)
    expect(await rpc('createTestDevice', 'u-admin')).toBe(403)
  })

  test('declared routes: the route rules, no expose needed; confined credentials refused', async () => {
    expect(await request('GET', '/api/learning/graph')).toBe(401)
    expect(admitted(await request('GET', '/api/learning/graph', 'u-app'))).toBe(true)
    expect(await request('GET', '/api/learning/graph', 'u-td')).toBe(403)
  })

  test('the health route and Pikku\'s own /api/auth routes are open to every credential, confined ones included', async () => {
    expect(await request('GET', '/api/health')).toBe(200)
    expect(await request('GET', '/api/health', 'u-ci')).toBe(200)
    for (const user of ['u-td', 'u-ci']) expect(admitted(await request('GET', '/api/auth/get-session', user))).toBe(true)
  })

  test('a valid credential whose user has no Learner session (a revoked test device) is refused, not served anonymously', async () => {
    expect(await request('GET', '/api/health', 'u-revoked')).toBe(401)
    expect(await rpc('getPairingEndpoints', 'u-revoked')).toBe(401)
  })
})
