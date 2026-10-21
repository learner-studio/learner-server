import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import type { DB } from "../types/db.types.js";
import { LearningExposureWorkService } from "./learning-exposure-work-service.js";

const integrationUrl = process.env.LEARNING_EXPOSURE_TEST_DATABASE_URL;
const describePostgres = integrationUrl ? describe : describe.skip;

describePostgres("LearningExposureWorkService PostgreSQL fencing", () => {
  let kysely: Kysely<DB>;
  let first: LearningExposureWorkService;
  let second: LearningExposureWorkService;

  beforeAll(() => {
    kysely = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: integrationUrl!, max: 4 }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    first = new LearningExposureWorkService(kysely);
    second = new LearningExposureWorkService(kysely);
  });

  beforeEach(async () => {
    await sql`TRUNCATE learning_exposure_work`.execute(kysely);
  });

  afterAll(async () => {
    await kysely?.destroy();
  });

  test("allows exactly one concurrent worker to claim a work key", async () => {
    const claims = await Promise.all([
      first.claim("version:one"),
      second.claim("version:one"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
  });

  test("expired lease can be reclaimed and the stale worker is fenced", async () => {
    const stale = await first.claim("version:expired", 10);
    expect(stale).not.toBeNull();
    await sql`UPDATE learning_exposure_work SET lease_until=NOW()-INTERVAL '1 second'
      WHERE work_key='version:expired'`.execute(kysely);
    const current = await second.claim("version:expired");
    expect(current).not.toBeNull();
    expect(current!.token).not.toBe(stale!.token);
    await expect(
      first.fenced(stale!, async () => "stale-write"),
    ).rejects.toThrow("lost its claim lease");
    await expect(
      second.fenced(current!, async () => "current-write"),
    ).resolves.toBe("current-write");
  });

  test("stale release cannot clear a replacement worker lease", async () => {
    const stale = await first.claim("version:release", 10);
    await sql`UPDATE learning_exposure_work SET lease_until=NOW()-INTERVAL '1 second'
      WHERE work_key='version:release'`.execute(kysely);
    const current = await second.claim("version:release");
    expect(await first.release(stale!)).toBe(false);
    expect(await second.claim("version:release")).toBeNull();
    expect(await second.release(current!)).toBe(true);
  });

  test("finish persists cursor and counters only for the live token", async () => {
    const claim = await first.claim("version:finish");
    await first.finish(claim!, { offset: 42 }, { projected: 3, gaps: 1 });
    const stored = await sql<{
      cursor: unknown;
      counters: unknown;
      token: string | null;
    }>`
      SELECT cursor,counters,token FROM learning_exposure_work WHERE work_key='version:finish'`.execute(
      kysely,
    );
    expect(stored.rows[0]).toEqual({
      cursor: { offset: 42 },
      counters: { projected: 3, gaps: 1 },
      token: null,
    });
  });
});
