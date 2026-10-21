import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";

import type { DB } from "../types/db.types.js";

export type LearningExposureWorkClaim = {
  key: string;
  token: string;
  cursor: Record<string, unknown>;
  counters: Record<string, unknown>;
};

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export class LearningExposureWorkService {
  constructor(private readonly kysely: Kysely<DB>) {}

  async claim(
    key: string,
    leaseMs = 300_000,
  ): Promise<LearningExposureWorkClaim | null> {
    if (!key.trim()) throw new Error("Exposure work key must not be empty");
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
      throw new Error("Exposure work lease must be a positive integer");
    const token = randomUUID();
    const result = await sql<{
      key: string;
      token: string;
      cursor: unknown;
      counters: unknown;
    }>`INSERT INTO learning_exposure_work(work_key,token,lease_until,updated_at)
      VALUES(${key},${token}::uuid,NOW()+(${leaseMs} * INTERVAL '1 millisecond'),NOW())
      ON CONFLICT(work_key) DO UPDATE SET token=EXCLUDED.token,
        lease_until=EXCLUDED.lease_until,last_error=NULL,updated_at=NOW()
      WHERE learning_exposure_work.lease_until IS NULL
         OR learning_exposure_work.lease_until<=NOW()
      RETURNING work_key AS key,token,cursor,counters`.execute(this.kysely);
    const row = result.rows[0];
    return row
      ? {
          key: row.key,
          token: row.token,
          cursor: object(row.cursor),
          counters: object(row.counters),
        }
      : null;
  }

  async fenced<T>(
    claim: LearningExposureWorkClaim,
    callback: (trx: Transaction<DB>) => Promise<T>,
  ): Promise<T> {
    return this.kysely.transaction().execute(async (trx) => {
      const locked = await sql<{ token: string | null; live: boolean }>`
        SELECT token,lease_until>NOW() AS live FROM learning_exposure_work
        WHERE work_key=${claim.key} FOR UPDATE`.execute(trx);
      const row = locked.rows[0];
      if (!row || row.token !== claim.token || row.live !== true)
        throw new Error(`Exposure work ${claim.key} lost its claim lease`);
      return callback(trx);
    });
  }

  async renew(
    claim: LearningExposureWorkClaim,
    leaseMs = 300_000,
  ): Promise<LearningExposureWorkClaim> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
      throw new Error("Exposure work lease must be a positive integer");
    return this.fenced(claim, async (trx) => {
      const renewed = await sql<{
        cursor: unknown;
        counters: unknown;
      }>`UPDATE learning_exposure_work
        SET lease_until=NOW()+(${leaseMs} * INTERVAL '1 millisecond'),updated_at=NOW()
        WHERE work_key=${claim.key} AND token=${claim.token}::uuid
        RETURNING cursor,counters`.execute(trx);
      if (!renewed.rows[0])
        throw new Error(`Exposure work ${claim.key} lost its claim lease`);
      return {
        ...claim,
        cursor: object(renewed.rows[0].cursor),
        counters: object(renewed.rows[0].counters),
      };
    });
  }

  async finish(
    claim: LearningExposureWorkClaim,
    cursor: Record<string, unknown>,
    counters: Record<string, unknown>,
  ): Promise<void> {
    await this.fenced(claim, async (trx) => {
      await sql`UPDATE learning_exposure_work SET cursor=${JSON.stringify(cursor)}::jsonb,
        counters=${JSON.stringify(counters)}::jsonb,token=NULL,lease_until=NULL,last_error=NULL,updated_at=NOW()
        WHERE work_key=${claim.key} AND token=${claim.token}::uuid`.execute(
        trx,
      );
    });
  }

  async fail(claim: LearningExposureWorkClaim, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.fenced(claim, async (trx) => {
      await sql`UPDATE learning_exposure_work SET token=NULL,lease_until=NULL,
        last_error=${message.slice(0, 4_000)},updated_at=NOW()
        WHERE work_key=${claim.key} AND token=${claim.token}::uuid`.execute(
        trx,
      );
    });
  }

  async release(claim: LearningExposureWorkClaim): Promise<boolean> {
    const result =
      await sql`UPDATE learning_exposure_work SET token=NULL,lease_until=NULL,updated_at=NOW()
      WHERE work_key=${claim.key} AND token=${claim.token}::uuid`.execute(
        this.kysely,
      );
    return Number(result.numAffectedRows ?? 0) === 1;
  }
}
