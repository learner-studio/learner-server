import { CamelCasePlugin, CompiledQuery, Kysely, PostgresDialect } from 'kysely'
import { Pool } from 'pg'
import type { DB } from './db.types.js'

/**
 * The one database handle every Learning module uses.
 *
 * Two views of ONE pool, kept from the original host because the ported code
 * depends on both:
 *  - `kysely` runs through CamelCasePlugin: typed query-builder code (services)
 *    reads `firstSeenAt`.
 *  - `query` / `withClient` are raw parameterised SQL with NO plugin: the raw
 *    SQL modules read rows exactly as Postgres names them (`first_seen_at`).
 * Do not "unify" them: every raw reader would silently get `undefined`.
 *
 * The handle is constructed by the process entry point (apps/server) and bound
 * once with `bindDatabase`; nothing in this repo reads DATABASE_URL by itself.
 */
export interface QueryResult<R> { rows: R[]; rowCount: number }
export interface QueryFn {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  <R = any>(sql: string, params?: ReadonlyArray<unknown>): Promise<QueryResult<R>>
}
export interface RawClient { query: QueryFn }
export interface DatabaseHandle {
  readonly url: string
  readonly pool: Pool
  readonly kysely: Kysely<DB>
  readonly snake: Kysely<DB>
  readonly query: QueryFn
  withClient<T>(fn: (client: RawClient) => Promise<T>): Promise<T>
  close(): Promise<void>
}

const toResult = <R>(res: { rows: readonly R[]; numAffectedRows?: bigint }): QueryResult<R> => ({
  rows: res.rows as R[],
  rowCount: res.numAffectedRows != null ? Number(res.numAffectedRows) : res.rows.length,
})

export function createDatabase(url: string, options: { max?: number; applicationName?: string } = {}): DatabaseHandle {
  const pool = new Pool({ connectionString: url, max: options.max ?? 20, application_name: options.applicationName ?? 'learner' })
  // An idle client that errors must not crash the process (pg emits on the pool).
  pool.on('error', (error) => console.error(JSON.stringify({ event: 'pg-pool-error', message: error.message })))
  const kysely = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] })
  const snake = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) })
  const query: QueryFn = async (text, params = []) =>
    toResult(await snake.executeQuery(CompiledQuery.raw(text, params as unknown[])))
  return {
    url, pool, kysely, snake, query,
    withClient: (fn) => snake.connection().execute((conn) => fn({
      query: async (text, params = []) => toResult(await conn.executeQuery(CompiledQuery.raw(text, params as unknown[]))),
    })),
    async close() { await kysely.destroy().catch(() => undefined) },
  }
}

let bound: DatabaseHandle | undefined
export function bindDatabase(handle: DatabaseHandle): DatabaseHandle { bound = handle; return handle }
export function database(): DatabaseHandle {
  if (!bound) throw new Error('No database bound: the process entry point must call bindDatabase()')
  return bound
}
export const isDatabaseBound = () => bound !== undefined
