import { ATTEMPT_LEASE_MS, type LeaseRow, type LeaseStore } from '../llm-attempt-lease.js'

/** In-memory leases for unit tests with a fake query function. `dead` lists owners the test declares gone. */
export function memoryLeaseStore(state: { leases: Map<string, LeaseRow & { heartbeatAt: number }>; dead: Set<string>; audit: Array<{ key: string; action: string }> } =
  { leases: new Map(), dead: new Set(), audit: [] }): LeaseStore & { state: typeof state } {
  const staleOf = (row: { heartbeatAt: number }) => Date.now() - row.heartbeatAt > ATTEMPT_LEASE_MS()
  return {
    state,
    async holdOwner() {},
    async get(key) { const r = state.leases.get(key); return r ? { ...r, stale: staleOf(r) } : null },
    async insert(key, row) { if (state.leases.has(key)) return false; state.leases.set(key, { owner: row.owner, repeatFree: row.repeatFree, takeovers: row.takeovers, stale: false, heartbeatAt: Date.now() }); return true },
    async takeOver(key, from, owner) {
      const r = state.leases.get(key)
      if (!r || r.owner !== from.owner || r.takeovers !== from.takeovers) return null
      r.owner = owner; r.takeovers++; r.heartbeatAt = Date.now(); return r.takeovers
    },
    async heartbeat(key, owner) { const r = state.leases.get(key); if (!r || r.owner !== owner) return false; r.heartbeatAt = Date.now(); return true },
    async release(key, owner) { const r = state.leases.get(key); if (r && r.owner === owner) r.heartbeatAt = -Infinity },
    async finish(key) { const r = state.leases.get(key); if (r) r.heartbeatAt = Date.now() },
    async ownerIsDead(owner) { return state.dead.has(owner) },
    async audit(key, action) { state.audit.push({ key, action }) },
  }
}
