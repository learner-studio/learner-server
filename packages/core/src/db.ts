import type { Kysely } from 'kysely'
import type { DB } from './db/db.types.js'
import { database, type QueryResult, type RawClient } from './db/handle.js'

/**
 * Accessors over the bound database handle (see db/handle.ts), keeping the call
 * shapes the ported Learning modules were written against.
 */
export type Row = Record<string, unknown>
export type { QueryResult, RawClient }
export async function getKysely(): Promise<Kysely<DB>> { return database().kysely }
export async function getDurableKysely(): Promise<Kysely<DB>> { return database().kysely }
export const resolveDatabaseUrl = (): string => database().url
/** Raw SQL whose result keys are camelCased (the camelCasing connection). */
export async function query<T = Row>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
  const { CompiledQuery } = await import('kysely')
  const res = await database().kysely.executeQuery<T>(CompiledQuery.raw(text, params as unknown[]))
  return { rows: res.rows as T[], rowCount: res.numAffectedRows != null ? Number(res.numAffectedRows) : res.rows.length }
}
/** Raw SQL with snake_case result keys exactly as Postgres names them. */
export const snakeQuery = <T = Row>(text: string, params: readonly unknown[] = []) => database().query<T>(text, params)
export const withClient = <T>(fn: (client: RawClient) => Promise<T>) => database().withClient(fn)
export async function healthcheck(): Promise<{ ok: boolean; error?: string }> {
  try { await database().query('SELECT 1'); return { ok: true } } catch (e) { return { ok: false, error: (e as Error).message } }
}
