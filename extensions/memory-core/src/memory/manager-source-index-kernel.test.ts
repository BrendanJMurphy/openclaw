import { constants, DatabaseSync } from "node:sqlite";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { runSqliteImmediateTransactionSync } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

const databases: MemoryIndexDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.release();
  }
});

async function createDatabase(): Promise<MemoryIndexDatabase> {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  const database = new MemoryIndexDatabase(db);
  databases.push(database);
  const schema = ensureMemoryIndexSchema({ db, cacheEnabled: false, ftsEnabled: true });
  expect(schema.ftsAvailable).toBe(true);
  const vector = await loadSqliteVecExtension({ db });
  expect(vector.ok).toBe(true);
  db.exec(
    "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3])",
  );
  database.fts.enabled = true;
  database.fts.available = true;
  database.vector.enabled = true;
  database.vector.available = true;
  return database;
}

function replacement(
  path: string,
  hash = "original",
  chunkCount = 1,
): MemorySourceIndexReplacement {
  return {
    source: "memory",
    entry: { path, hash, mtimeMs: 100.25, size: 12 },
    model: "test-model",
    now: 100,
    vectorReady: true,
    embeddings: Array.from({ length: chunkCount }, () => [1, 0, 0]),
    chunks: Array.from({ length: chunkCount }, (_, index) => ({
      startLine: index + 1,
      endLine: index + 1,
      text: `${hash} indexed text`,
      hash,
      importance: 7,
      triggers: "indexed",
      projectKey: "project",
      provenance: { originClass: "owner", sessionKind: "interactive", observedAt: 90 },
    })),
  };
}

function write(database: MemoryIndexDatabase, value: MemorySourceIndexReplacement) {
  return runSqliteImmediateTransactionSync(database.db, () => database.sourceIndex.replace(value));
}

function snapshot(db: DatabaseSync) {
  return [
    "memory_index_sources",
    "memory_index_chunks",
    "memory_index_chunk_recall_metadata",
    "memory_index_chunk_provenance",
    "memory_index_chunks_fts",
    "memory_index_paths_fts",
    "memory_index_state",
  ]
    .map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    .concat([
      db
        .prepare("SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id")
        .all(),
    ]);
}

describe("memory source index native kernel", () => {
  it("uses native vector point lookups for replacement and source deletion", async () => {
    const database = await createDatabase();
    const pathname = "memory/current.md";
    write(database, replacement(pathname, "original", 3));
    write(database, replacement("memory/sibling.md"));
    write(database, {
      ...replacement(pathname),
      source: "sessions",
      agentId: "main",
      sessionId: "sibling-session",
    });
    const siblings = database.db
      .prepare("SELECT id FROM memory_index_chunks WHERE path != ? OR source != ? ORDER BY id")
      .all(pathname, "memory");
    for (const phase of ["replace", "delete"] as const) {
      const prepare = vi.spyOn(database.db, "prepare");
      let deletes: string[];
      try {
        if (phase === "replace") {
          write(database, replacement(pathname, "updated", 3));
        } else {
          runSqliteImmediateTransactionSync(database.db, () =>
            database.sourceIndex.deleteIfCurrent({
              path: pathname,
              source: "memory",
              expectedHash: "updated",
            }),
          );
        }
        deletes = prepare.mock.calls
          .map(([sql]) => sql)
          .filter((sql) => /^DELETE FROM memory_index_chunks_vec\b/.test(sql));
      } finally {
        prepare.mockRestore();
      }
      const vectorPlans = deletes.flatMap((sql) =>
        database.db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all()
          .map((row) => String(row.detail))
          .filter((detail) => detail.includes("memory_index_chunks_vec VIRTUAL TABLE INDEX")),
      );
      expect(vectorPlans.length).toBeGreaterThan(0);
      // sqlite-vec's native plan 2 uses the primary key; plan 1 scans every vector.
      expect(vectorPlans.every((detail) => /VIRTUAL TABLE INDEX \d+:2\b/.test(detail))).toBe(true);
      const vectors = database.db
        .prepare("SELECT id FROM memory_index_chunks_vec ORDER BY id")
        .all();
      expect(vectors).toEqual(expect.arrayContaining(siblings));
      expect(vectors).toHaveLength(phase === "replace" ? 5 : 2);
      expect(
        database.db
          .prepare("SELECT id FROM memory_index_chunks WHERE hash = 'original' ORDER BY id")
          .all(),
      ).toEqual(siblings);
    }
  });

  it.each([
    { failAt: 2, rollback: false },
    { failAt: 3, rollback: false },
    { failAt: 2, rollback: true },
    { failAt: 3, rollback: true },
  ])(
    "rolls back partial native vector deletes at $failAt (outer rollback: $rollback)",
    async ({ failAt, rollback }) => {
      const database = await createDatabase();
      const db = database.db;
      const pathname = "memory/current.md";
      write(database, replacement(pathname, "original", 3));
      write(database, replacement("memory/sibling.md"));
      const readVectors = () =>
        db
          .prepare(
            "SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id",
          )
          .all();
      const readDebt = () =>
        db
          .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
          .get();
      const before = readVectors();
      const previousDebt = readDebt();
      if (rollback) {
        db.exec(`CREATE TRIGGER fail_cleanup_commit BEFORE DELETE ON memory_index_chunks
        BEGIN SELECT RAISE(ABORT, 'forced outer cleanup rollback'); END`);
      }
      let nativeDeletes = 0;
      db.setAuthorizer((action, table) => {
        if (
          action === constants.SQLITE_DELETE &&
          table === "memory_index_chunks_vec_rowids" &&
          ++nativeDeletes === failAt
        ) {
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      });
      try {
        const remove = () =>
          runSqliteImmediateTransactionSync(db, () =>
            database.sourceIndex.deleteIfCurrent({
              path: pathname,
              source: "memory",
              expectedHash: "original",
            }),
          );
        if (rollback) {
          expect(remove).toThrow("forced outer cleanup rollback");
        } else {
          expect(remove()).toBe(true);
        }
      } finally {
        db.setAuthorizer(null);
      }
      expect(nativeDeletes).toBe(failAt);
      expect(db.isTransaction).toBe(false);
      expect(readVectors()).toEqual(before);
      expect(readDebt()).toEqual(rollback ? previousDebt : { value: "1" });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE path = ?")
          .get(pathname),
      ).toEqual({ count: rollback ? 3 : 0 });
      expect(db.prepare("SELECT path FROM memory_index_sources ORDER BY path").all()).toEqual(
        rollback
          ? [{ path: pathname }, { path: "memory/sibling.md" }]
          : [{ path: "memory/sibling.md" }],
      );
    },
  );

  it("rolls back every index representation when the final source upsert fails", async () => {
    const database = await createDatabase();
    const beforeValue = replacement("memory/current.md");
    write(database, beforeValue);
    write(database, replacement("memory/sibling.md"));
    const before = snapshot(database.db);
    database.db.exec(`CREATE TRIGGER fail_source_update
      AFTER UPDATE ON memory_index_sources
      BEGIN SELECT RAISE(FAIL, 'source upsert failed'); END`);
    expect(() => write(database, replacement(beforeValue.entry.path, "updated"))).toThrow(
      "source upsert failed",
    );
    expect(snapshot(database.db)).toEqual(before);
    database.db.exec("DROP TRIGGER fail_source_update");
    write(database, replacement(beforeValue.entry.path, "updated"));
    expect(database.db.prepare("SELECT text FROM memory_index_chunks ORDER BY path").all()).toEqual(
      [{ text: "updated indexed text" }, { text: "original indexed text" }],
    );
  });

  it("conditionally removes all source representations while retaining a sibling", async () => {
    const database = await createDatabase();
    write(database, replacement("memory/current.md"));
    write(database, replacement("memory/sibling.md"));
    const before = snapshot(database.db);
    const remove = (expectedHash: string) =>
      runSqliteImmediateTransactionSync(database.db, () =>
        database.sourceIndex.deleteIfCurrent({
          path: "memory/current.md",
          source: "memory",
          expectedHash,
        }),
      );
    expect(remove("stale")).toBe(false);
    expect(snapshot(database.db)).toEqual(before);
    expect(remove("original")).toBe(true);
    for (const table of [
      "memory_index_sources",
      "memory_index_chunks",
      "memory_index_chunks_fts",
      "memory_index_paths_fts",
    ]) {
      expect(database.db.prepare(`SELECT path FROM ${table}`).all()).toEqual([
        { path: "memory/sibling.md" },
      ]);
    }
    for (const table of [
      "memory_index_chunk_recall_metadata",
      "memory_index_chunk_provenance",
      "memory_index_chunks_vec",
    ]) {
      expect(database.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 1,
      });
    }
  });
});
