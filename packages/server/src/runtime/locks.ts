import { Pool } from 'pg'
import type { LockService } from '@learner/core/runtime/index.js'

/**
 * Transaction-scoped advisory locks on a DEDICATED pool, ported unchanged in
 * behaviour from the original lock service: a waiter holds its connection while
 * blocked, so waiters must never exhaust the pool the lock holder needs for its
 * own work. COMMIT/ROLLBACK releases the lock even when the body throws.
 */
export class AdvisoryLockService implements LockService {
  private static readonly NAMESPACE = 0x736e6373
  private pool: Pool | null = null
  constructor(private readonly config: { connectionString: string; max?: number; connectionTimeoutMillis?: number }) {}
  private getPool() {
    if (this.pool) return this.pool
    this.pool = new Pool({ connectionString: this.config.connectionString, max: this.config.max ?? 30, idleTimeoutMillis: 30_000, connectionTimeoutMillis: this.config.connectionTimeoutMillis ?? 60_000, application_name: 'learner-locks' })
    this.pool.on('error', (error) => console.error('[locks] idle client error:', error.message))
    return this.pool
  }
  async withLock<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T> {
    const client = await this.getPool().connect()
    try {
      await client.query('BEGIN')
      try {
        await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [AdvisoryLockService.NAMESPACE, `${scope}:${key}`])
        const result = await fn()
        await client.query('COMMIT')
        return result
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    } finally { client.release() }
  }
  async tryWithLock<T>(scope: string, key: string, fn: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const client = await this.getPool().connect()
    try {
      await client.query('BEGIN')
      try {
        const r = await client.query<{ acquired: boolean }>('SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS acquired', [AdvisoryLockService.NAMESPACE, `${scope}:${key}`])
        if (!r.rows[0]?.acquired) { await client.query('COMMIT'); return { acquired: false } }
        const value = await fn()
        await client.query('COMMIT')
        return { acquired: true, value }
      } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    } finally { client.release() }
  }
  async close() { const p = this.pool; this.pool = null; if (p) await p.end() }
}
