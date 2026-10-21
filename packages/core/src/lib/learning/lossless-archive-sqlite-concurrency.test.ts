import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { createStagedSqliteSnapshot } from "./lossless-archive-files.js";

const roots: string[] = [];
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const readProgress = async (path: string): Promise<number> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const value = Number((await readFile(path, "utf8")).trim());
      if (Number.isSafeInteger(value) && value > 0) return value;
    } catch {
      // The writer publishes progress after its first complete transaction.
    }
    await Bun.sleep(5);
  }
  throw new Error("SQLite writer did not publish transaction progress");
};

const waitForProgressAfter = async (
  path: string,
  previous: number,
): Promise<number> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await readProgress(path);
    if (current > previous) return current;
    await Bun.sleep(5);
  }
  throw new Error(`SQLite writer did not progress beyond ${previous}`);
};

describe("SQLite online backup under concurrent committed writes", () => {
  test("seals one coherent boundary while a separate writer remains active and leaves the source WAL uncheckpointed", async () => {
    const root = await mkdtemp(join(tmpdir(), "lossless-sqlite-concurrency-"));
    roots.push(root);
    const sourcePath = join(root, "provider.db");
    const stagingRoot = join(root, "staging");
    const writerPath = join(root, "writer.ts");
    const progressPath = join(root, "writer.progress");
    const stopPath = join(root, "writer.stop");

    const seed = new Database(sourcePath, { create: true, strict: true });
    seed.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      CREATE TABLE provider_future_events (
        id INTEGER PRIMARY KEY,
        future_field TEXT NOT NULL,
        opaque_payload BLOB NOT NULL,
        unknown_counter INTEGER NOT NULL
      );
      CREATE TABLE snapshot_padding (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL);
      INSERT INTO snapshot_padding (id, bytes) VALUES (1, zeroblob(8388608));
    `);
    seed.close();
    const sourceDigestBefore = sha256(await readFile(sourcePath));

    await writeFile(
      writerPath,
      `import { existsSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
const [sourcePath, progressPath, stopPath] = process.argv.slice(2);
if (!sourcePath || !progressPath || !stopPath) throw new Error("missing writer paths");
const database = new Database(sourcePath, { strict: true });
database.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=5000");
const insert = database.query("INSERT INTO provider_future_events (id, future_field, opaque_payload, unknown_counter) VALUES (?, ?, ?, ?)");
let nextId = 1;
const commitBatch = database.transaction(() => {
  for (let index = 0; index < 8; index += 1) {
    const id = nextId++;
    const payload = Buffer.alloc(1024, id % 251);
    payload.writeUInt32BE(id, 0);
    insert.run(id, \`future-\${id}\`, payload, id * 17);
  }
});
while (!existsSync(stopPath)) {
  commitBatch();
  writeFileSync(progressPath, String(nextId - 1));
  await Bun.sleep(5);
}
database.close();
`,
      { mode: 0o600 },
    );

    const writer = Bun.spawn(
      [process.execPath, writerPath, sourcePath, progressPath, stopPath],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const beforeSnapshot = await readProgress(progressPath);
      const walBefore = await stat(`${sourcePath}-wal`);
      const staged = await createStagedSqliteSnapshot(sourcePath, {
        approvedRoot: root,
        stagingRoot,
        stagingKey: "concurrent-boundary",
      });
      const afterSnapshot = await waitForProgressAfter(
        progressPath,
        beforeSnapshot,
      );
      const stillWriting = await waitForProgressAfter(
        progressPath,
        afterSnapshot,
      );

      expect(afterSnapshot).toBeGreaterThan(beforeSnapshot);
      expect(stillWriting).toBeGreaterThan(afterSnapshot);
      expect(sha256(await readFile(sourcePath))).toBe(sourceDigestBefore);
      const walAfter = await stat(`${sourcePath}-wal`);
      expect(walAfter.ino).toBe(walBefore.ino);
      expect(walAfter.size).toBeGreaterThan(0);

      const snapshot = new Database(staged.path, {
        readonly: true,
        strict: true,
      });
      try {
        expect(
          snapshot
            .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
            .get()?.integrity_check,
        ).toBe("ok");
        const rows = snapshot
          .query<
            {
              id: number;
              future_field: string;
              opaque_payload: Uint8Array;
              unknown_counter: number;
            },
            []
          >(
            "SELECT id, future_field, opaque_payload, unknown_counter FROM provider_future_events ORDER BY id",
          )
          .all();
        expect(rows.length).toBeGreaterThanOrEqual(beforeSnapshot);
        expect(rows.length).toBeLessThanOrEqual(afterSnapshot);
        expect(rows.length % 8).toBe(0);
        for (const [index, row] of rows.entries()) {
          const id = index + 1;
          const expectedPayload = Buffer.alloc(1024, id % 251);
          expectedPayload.writeUInt32BE(id, 0);
          expect(row.id).toBe(id);
          expect(row.future_field).toBe(`future-${id}`);
          expect(row.unknown_counter).toBe(id * 17);
          expect(Buffer.from(row.opaque_payload)).toEqual(expectedPayload);
        }
      } finally {
        snapshot.close();
      }

      expect(staged.reused).toBe(false);
      expect(staged.limitations.join(" ")).toContain(
        "not the exact physical database",
      );
    } finally {
      await writeFile(stopPath, "stop\n");
      const exitCode = await writer.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(writer.stderr).text();
        throw new Error(`SQLite writer exited ${exitCode}: ${stderr}`);
      }
    }
  }, 60_000);
});
