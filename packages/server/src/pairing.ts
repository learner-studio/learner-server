import { createHash } from 'node:crypto'
export { LEARNER_PRODUCT, PAIRING_CONTRACT } from '@learner/contract'
import { PairingUrl, type PairingReport, type PairingState, type PairingTopology } from '@learner/contract'
import type { z } from 'zod'

/**
 * The URLs this install advertises to learner-desktop
 * (docs/specs/server-desktop-pairing.md). Computed once from config; the
 * pairing RPC, the heartbeat and the installer all read this one record.
 */
export interface PairingEndpoints {
  topology: z.infer<typeof PairingTopology>
  /** The API base clients use, without a trailing slash. */
  apiBase: string
  web: string | null
  growthbook: { app: string; api: string } | null
}

export interface EndpointSettings {
  port: number
  /** LEARNER_PUBLIC_API_URL; default http://127.0.0.1:<port>. */
  publicApiUrl?: string
  /** LEARNER_WEB_URL; default `<api>/` when same-machine and the API serves a web build. */
  webUrl?: string
  servesWeb: boolean
  /** LEARNER_GROWTHBOOK_URL / LEARNER_GROWTHBOOK_API_URL: both or neither. */
  growthbookUrl?: string
  growthbookApiUrl?: string
}

const url = (name: string, value: string): string => {
  const parsed = PairingUrl.safeParse(value)
  if (!parsed.success) throw new Error(`${name}: ${parsed.error.issues[0]?.message ?? 'invalid URL'} (got ${JSON.stringify(value)})`)
  return value
}
const trimSlash = (value: string) => value.replace(/\/+$/, '')

/** Loopback means the desktop on this machine is the only client that can reach it. */
export function isLoopback(value: string): boolean {
  const host = new URL(value).hostname.replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

export function resolveEndpoints(settings: EndpointSettings): PairingEndpoints {
  const apiBase = trimSlash(url('LEARNER_PUBLIC_API_URL', settings.publicApiUrl || `http://127.0.0.1:${settings.port}`))
  const topology = isLoopback(apiBase) ? 'same-machine' : 'remote'
  const web = settings.webUrl ? url('LEARNER_WEB_URL', settings.webUrl) : topology === 'same-machine' && settings.servesWeb ? `${apiBase}/` : null
  if (Boolean(settings.growthbookUrl) !== Boolean(settings.growthbookApiUrl)) {
    throw new Error('LEARNER_GROWTHBOOK_URL and LEARNER_GROWTHBOOK_API_URL must be set together (GrowthBook APP_ORIGIN and API_HOST)')
  }
  const growthbook = settings.growthbookUrl && settings.growthbookApiUrl
    ? { app: url('LEARNER_GROWTHBOOK_URL', settings.growthbookUrl), api: url('LEARNER_GROWTHBOOK_API_URL', settings.growthbookApiUrl) }
    : null
  return { topology, apiBase, web, growthbook }
}

/** Changes whenever any advertised URL does, and only then. */
export function endpointsVersion(endpoints: PairingEndpoints): string {
  const { topology, apiBase, web, growthbook } = endpoints
  return createHash('sha256').update(JSON.stringify([topology, apiBase, web, growthbook?.app ?? null, growthbook?.api ?? null])).digest('hex').slice(0, 16)
}

export function pairingState(endpoints: PairingEndpoints, report: z.infer<typeof PairingReport> | null): z.infer<typeof PairingState> {
  if (!report) return 'unknown'
  if (trimSlash(report.apiUrlInUse) !== endpoints.apiBase) return 'mismatch'
  return report.endpointsVersionHeld === endpointsVersion(endpoints) ? 'ok' : 'stale'
}

export const apiUrls = (endpoints: PairingEndpoints) => ({
  base: endpoints.apiBase, rpcBase: `${endpoints.apiBase}/rpc`, health: `${endpoints.apiBase}/api/health`,
})
