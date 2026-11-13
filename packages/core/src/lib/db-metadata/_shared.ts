// Shared helpers, types, and DB connection used across every domain module
// in lib/db-metadata/. Owns the single source of truth for the metaDbQuery /
// metaDbWithClient handles + the row-shape types so domain modules don't
// re-import from db-pg directly.

// This layer reads rows as snake_case — every result access in db-metadata/*, the
// LeadImportSourceRow type, and the whole test suite assume it. So metaDbQuery uses
// `snakeQuery`, a plugin-free view of the same pool, NOT `query` (which applies
// CamelCasePlugin for the callers migrated with the Kysely switch).
//
// Repointing this at the camelCasing connection is what silently broke
// aiComparisonWorkflow for two months (72/72 runs failed) and turned 26 tests red:
// the rows are Record<string, any>, so every `row.first_seen_at` became `undefined`
// with nothing to fail at compile time. See db.ts:snakeQuery.
//
// metaDbWithClient stays on the shared connection. Its uses: two DELETE-only purge
// transactions that read rowCount, and the sim's grading reservation
// (reserveSimGrading: one transaction on one connection under an advisory
// lock), which reads only an existence row and the sum it names `n`.
import { database } from "../../db/handle.js";

// =============================================================================
// PG types
// =============================================================================

export interface MetaPgQueryFn {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	<R = any>(
		sql: string,
		params?: ReadonlyArray<unknown>,
	): Promise<{ rows: R[]; rowCount: number }>;
}
export interface MetaPgClient {
	query: MetaPgQueryFn;
}
export interface MetaDbPgModule {
	query: MetaPgQueryFn;
	withClient: <T>(fn: (client: MetaPgClient) => Promise<T>) => Promise<T>;
}

// Local aliases — same reasoning as lib/db-pg-impl.ts: avoid colliding with
// global/ambient `query`/`withClient` declarations the TS compiler picks up.
export const metaDbQuery: MetaPgQueryFn = (sql, params) => database().query(sql, params);
export const metaDbWithClient: MetaDbPgModule["withClient"] = (fn) => database().withClient(fn);
