// Shared helpers, types, and DB connection used across every domain module
// in lib/db-metadata/. Owns the single source of truth for the metaDbQuery /
// metaDbWithClient handles + the row-shape types so domain modules don't
// re-import from db-pg directly.

import * as cryptoMd2 from "node:crypto";
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
// metaDbWithClient stays on the shared connection: its only two uses are
// DELETE-only purge transactions that read rowCount, never column names.
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

/**
 * Permissive row shape used by row mappers. Callers consume normalized
 * camelCased return shapes; per-column typing of every snake_case column
 * would be churn for zero downstream type benefit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MetaDbRow = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MetaAnyArgs = Record<string, any>;

// =============================================================================
// Pure helpers (no DB calls)
// =============================================================================

export function metaGenerateId(prefix = "meta") {
	const bytes = cryptoMd2.randomBytes(8);
	return `${prefix}_${bytes.toString("hex")}`;
}

export function unixNow() {
	return Math.floor(Date.now() / 1000);
}

export function toUnix(v: unknown): number | null {
	if (v === null || v === undefined || v === "") return null;
	if (typeof v === "number") return Number.isFinite(v) ? Math.floor(v) : null;
	if (v instanceof Date) return Math.floor(v.getTime() / 1000);
	const parsed = new Date(v as string | number).getTime();
	return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/**
 * Normalize a human-readable text field (company_name, product_name, etc.) before
 * it hits the DB. Trims, collapses internal whitespace runs, strips control
 * characters, and rejects values that come out below 2 chars. Returns null if
 * the input is null/undefined/empty-after-cleanup.
 */
export function cleanNameField(raw: unknown) {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "string") raw = String(raw);
	// Strip control chars + zero-width chars that mimic spaces.
	// Zero-width range is U+200B..U+200D plus U+FEFF, written as escapes so the
	// character class is not a run of invisible literals in the source.
	const stripped = (raw as string).replace(
		/[\x00-\x1F\x7F\u200B-\u200D\uFEFF]/g,
		"",
	);
	// Collapse any whitespace run to one space.
	const collapsed = stripped.replace(/\s+/g, " ").trim();
	if (collapsed.length < 2) return null;
	if (collapsed.length > 255) return collapsed.slice(0, 255);
	return collapsed;
}

export function boolToPg(v: unknown) {
	if (v === true || v === 1 || v === "1") return true;
	if (v === false || v === 0 || v === "0" || v === null || v === undefined)
		return false;
	return Boolean(v);
}

export function metaSafeParseJson(value: unknown) {
	if (value === null || value === undefined || value === "") return null;
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

// Rows come back snake_case (see the import note above), which is what callers
// access directly. Return the raw row unchanged.
export function passthroughRow(row: MetaDbRow) {
	return row || null;
}

export function normalizeCrunchbasePayload(
	rawIn: unknown,
): MetaAnyArgs | null {
	if (!rawIn || typeof rawIn !== "object") return null;
	const raw = rawIn as MetaAnyArgs;
	const funding = (raw.funding || {}) as MetaAnyArgs;
	const employees = (raw.employees || {}) as MetaAnyArgs;
	return {
		url: raw.crunchbaseUrl || raw.url || null,
		companyName: raw.companyName || null,
		fundingStage: raw.fundingStage || funding.fundingStage || null,
		totalFunding:
			raw.totalFunding || funding.totalRaised || funding.totalFunding || null,
		lastRound: raw.lastRound || funding.lastRound || null,
		lastRoundDate: raw.lastRoundDate || funding.lastRoundDate || null,
		investors: raw.investors || funding.investors || [],
		employeeCount: raw.employeeCount ?? employees.count ?? null,
		employeeRange: raw.employeeRange || employees.range || null,
		founded: raw.founded || null,
		headquarters: raw.headquarters || null,
		description: raw.description || null,
		extractedAt: raw.extractedAt || raw.updatedAt || null,
		manuallyAdded: raw.manuallyAdded === true,
	};
}

// =============================================================================
// Schema / lifecycle (no-ops in PG mode — migrations handle schema)
// =============================================================================
