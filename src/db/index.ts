import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

const SCHEMA_SQL = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

/** Open (and create if needed) the single audit database. ":memory:" is allowed for tests. */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Wait up to a minute for another writer (the daily Bazaar upsert holds the lock for about 30 s) instead of failing.
  db.pragma("busy_timeout = 60000");
  db.exec(SCHEMA_SQL);
  const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (!v) db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  return db;
}

export const nowMs = (): number => Date.now();
