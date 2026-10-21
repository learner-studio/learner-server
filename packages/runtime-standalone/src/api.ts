import { publishRuntimeState } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { authConfigFromEnv, createAuth } from '@learner/server/auth.js'
import { bootstrap } from './bootstrap.js'
import { createApp } from './http/app.js'

/** The API process: RPCs, REST routes, auth, and the built web app. */
const { config, services, runtime } = await bootstrap('api')
const authConfig = authConfigFromEnv(config)
const auth = createAuth(services.kysely, authConfig)
const app = createApp({ runtime, services, auth, authConfig, webDist: config.webDist })

const server = Bun.serve({ port: config.port, hostname: config.host, fetch: app.fetch, idleTimeout: 255 })
services.logger.info({ event: 'api-listening', url: `http://${config.host}:${server.port}` })
const heartbeat = setInterval(() => { try { publishRuntimeState([], { ok: true }) } catch { /* runtime dir optional */ } }, 10_000)

const shutdown = async () => {
  clearInterval(heartbeat)
  server.stop()
  await services.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
