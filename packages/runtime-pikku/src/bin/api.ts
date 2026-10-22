// The API process under this runtime: generated HTTP wirings (RPC, REST
// routes, /api/auth) on the framework's Bun server, plus the built web app.
// It enqueues work and starts workflow runs; the worker executes them.
import { publishRuntimeState, setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'

setRuntimeRole('api')
await import('../../.pikku/pikku-bootstrap.gen.js')
const { PikkuBunServer } = await import('@pikku/bun-server')
const { createConfig } = await import('../config.js')
const { createSingletonServices } = await import('../services.js')

const config = await createConfig()
const services = await createSingletonServices(config)
const { backgroundJobs } = services
if (!backgroundJobs) throw new Error('services.ts must provide backgroundJobs')
const server = new PikkuBunServer({
  ...config,
  port: config.port,
  hostname: config.host,
  staticMounts: config.webDist ? [{ urlPrefix: '/', directory: config.webDist, spaFallback: true }] : [],
}, services.logger)
await server.init()
await server.start()
services.logger.info({ event: 'api-listening', url: `http://${config.host}:${server.port}`, runtime: 'pikku' })

const heartbeat = setInterval(() => { try { publishRuntimeState([], { ok: true }) } catch { /* runtime dir optional */ } }, 10_000)
server.enableExitOnSignals({
  beforeStop: () => clearInterval(heartbeat),
  afterStop: () => backgroundJobs.stop(),
})
