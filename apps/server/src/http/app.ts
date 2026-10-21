import { existsSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { Hono, type Context } from 'hono'
import { HttpError } from '@learner/core/runtime/errors.js'
import type { Session } from '@learner/core/runtime/index.js'
import { resolveSession, type Auth, type AuthConfig } from '../auth.js'
import type { FunctionContext } from '../runtime/define.js'
import type { FunctionRuntime } from '../runtime/host.js'
import type { Services } from '../services.js'
import { ROUTES } from './routes.js'

export interface AppDeps { runtime: FunctionRuntime; services: Services; auth: Auth; authConfig: AuthConfig; webDist?: string | null }

/** Errors map to `{ message }` with their status; anything unexpected is a logged 500. */
function errorResponse(c: Context, services: Services, error: unknown) {
  if (error instanceof HttpError) return c.json({ message: error.message }, error.status as 400)
  services.logger.error({ event: 'http-error', path: c.req.path, message: (error as Error)?.message ?? String(error), stack: (error as Error)?.stack })
  return c.json({ message: 'Internal server error' }, 500)
}

const httpContext = (c: Context): NonNullable<FunctionContext['http']> => ({
  request: { header: (name) => c.req.header(name), params: () => c.req.param() as Record<string, string> },
})

export function createApp({ runtime, services, auth, authConfig, webDist }: AppDeps) {
  const app = new Hono()
  const session = (c: Context): Promise<Session | undefined> => resolveSession(auth, services.kysely, authConfig, c.req.raw.headers)

  app.get('/api/health', async (c) => {
    const db = await services.db.query('SELECT 1').then(() => true, () => false)
    return c.json({ ok: db, db: 'postgres', role: services.config.role, uptime: Math.round(process.uptime()) }, db ? 200 : 503)
  })

  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

  // RPC: POST /rpc/:name with `{ data }`. Exposed and session functions only.
  app.post('/rpc/:name', async (c) => {
    try {
      const body = await c.req.json().catch(() => ({})) as { data?: unknown }
      const result = await runtime.call(c.req.param('name'), body?.data ?? {}, { session: await session(c), external: 'rpc', context: { http: httpContext(c) } })
      return c.json(result === undefined ? null : result)
    } catch (error) { return errorResponse(c, services, error) }
  })

  // REST routes carried over from the previous host's route table.
  for (const route of ROUTES) {
    app.on(route.method.toUpperCase(), route.path, async (c) => {
      try {
        const caller = await session(c)
        if (route.auth !== false && !caller) return c.json({ message: 'Authentication required' }, 401)
        if (route.requireApiKey && !c.req.header('x-api-key')) return c.json({ message: 'This route requires a machine API key' }, 403)
        const body = route.method === 'get' || route.method === 'delete' ? {} : await c.req.json().catch(() => ({}))
        const data = { ...c.req.query(), ...(body && typeof body === 'object' ? body : {}), ...c.req.param() }
        const result = await runtime.call(route.func, data, { session: caller, external: 'route', context: { http: httpContext(c) } })
        return c.json(result === undefined ? null : result)
      } catch (error) { return errorResponse(c, services, error) }
    })
  }

  // The built web app, with SPA fallback for client-side routes.
  if (webDist && existsSync(webDist)) {
    app.get('*', async (c) => {
      const path = normalize(c.req.path).replace(/^(\.\.[/\\])+/, '')
      const file = Bun.file(join(webDist, path))
      if (path !== '/' && await file.exists()) return new Response(file)
      return new Response(Bun.file(join(webDist, 'index.html')), { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
  }
  return app
}
