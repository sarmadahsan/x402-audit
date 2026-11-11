/** The raw-probe archive (src/probe/archive.ts): what gets archived, and that no row is cleared unless its copy is safe. */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { archiveKey, archiveRawProbes, planArchive, vacuumIfRoom, type ArchiveUpload } from "./archive.js";
import { insertResource, insertSeller } from "./test-helpers.js";

const NET = "eip155:8453";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);
const dirs: string[] = [];
/** A temporary directory removed after each test. */
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "probe-archive-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An in-memory database with one resource, and a helper that adds a probe at a time with or without raw data. */
function fixture(): { db: Db; resource: number; add: (ts: number, raw?: boolean) => number } {
  const db = openDb(":memory:");
  const resource = insertResource(db, { sellerId: insertSeller(db, "one.example"), url: "https://one.example/a", network: NET });
  const stmt = db.prepare(
    "INSERT INTO probes (resource_id, client_identity, round_id, ts, status, headers_json, body_text, amount_atomic, pay_to, network, outcome) VALUES (?, 'A', 'r', ?, 402, ?, ?, '1000', '0xabc', ?, 'ok')",
  );
  const add = (ts: number, raw = true): number =>
    Number(stmt.run(resource, ts, raw ? `{"h":"${ts}"}` : null, raw ? `body é ${ts}` : null, NET).lastInsertRowid);
  return { db, resource, add };
}

interface Stored {
  key: string;
  bytes: Buffer;
  sha: string;
}
/** An upload stand-in that keeps each file's bytes, key and checksum. */
function recorder(): { stored: Stored[]; upload: ArchiveUpload } {
  const stored: Stored[] = [];
  return {
    stored,
    upload: async (file, key, sha) => {
      stored.push({ key, bytes: readFileSync(file), sha });
    },
  };
}
/** The parsed NDJSON rows of a stored file. */
const lines = (s: Stored): Record<string, unknown>[] => gunzipSync(s.bytes).toString("utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
/** Probe rows still holding raw headers or body. */
const rawLeft = (db: Db): number => (db.prepare("SELECT COUNT(*) n FROM probes WHERE headers_json IS NOT NULL OR body_text IS NOT NULL").get() as { n: number }).n;
/** Default archive options for the tests: plenty of disk, clearing on. */
const base = (o: { workDir: string; upload: ArchiveUpload }) => ({ now: NOW, keepDays: 7, maxDays: 10, trim: true, freeBytes: () => 1e12, ...o });

describe("planArchive", () => {
  it("takes whole days that ended at least keepDays ago, oldest first, up to maxDays", () => {
    const { db, add } = fixture();
    const old = NOW - 10 * DAY;
    const a = add(old);
    const b = add(old + 60_000);
    const c = add(old + DAY);
    const d = add(NOW - 8 * DAY);
    add(NOW - 3 * DAY);
    expect(planArchive(db, { now: NOW, keepDays: 7, maxDays: 10 }).map((x) => [x.minId, x.maxId])).toEqual([[a, b], [c, c], [d, d]]);
    expect(planArchive(db, { now: NOW, keepDays: 7, maxDays: 1 })).toHaveLength(1);
  });
  it("keeps a day that ended less than keepDays ago", () => {
    const { db, add } = fixture();
    add(NOW - 7 * DAY); // that UTC day ends six days and some hours ago
    expect(planArchive(db, { now: NOW, keepDays: 7, maxDays: 10 })).toEqual([]);
  });
  it("gives a row written out of time order its own key instead of overwriting the day's file", () => {
    const { db, add } = fixture();
    const old = NOW - 10 * DAY;
    add(old);
    add(old + DAY);
    add(old + 5);
    const keys = planArchive(db, { now: NOW, keepDays: 7, maxDays: 10 }).map(archiveKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("archiveRawProbes", () => {
  it("uploads the exact raw values with the url, clears only them, and records the file", async () => {
    const { db, add } = fixture();
    const ts = NOW - 10 * DAY;
    const id = add(ts);
    const recent = add(NOW - DAY);
    const r = recorder();
    const workDir = tmp();
    const s = await archiveRawProbes(db, base({ workDir, upload: r.upload }));
    expect(s.uploaded).toHaveLength(1);
    expect(r.stored[0]!.key).toMatch(/^probe-raw\/2026-11\/2026-11-10-ids-1-1\.ndjson\.gz$/);
    expect(lines(r.stored[0]!)).toEqual([expect.objectContaining({ id, ts, url: "https://one.example/a", status: 402, headers_json: `{"h":"${ts}"}`, body_text: `body é ${ts}` })]);
    const row = db.prepare("SELECT headers_json h, body_text b, amount_atomic a, pay_to p, status s, outcome o FROM probes WHERE id = ?").get(id);
    expect(row).toEqual({ h: null, b: null, a: "1000", p: "0xabc", s: 402, o: "ok" });
    expect(db.prepare("SELECT body_text b FROM probes WHERE id = ?").get(recent)).toEqual({ b: expect.any(String) });
    expect(db.prepare("SELECT s3_key, rows, sha256, trimmed_at FROM probe_archives").get()).toEqual({ s3_key: r.stored[0]!.key, rows: 1, sha256: r.stored[0]!.sha, trimmed_at: NOW });
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("a failed upload clears nothing, records nothing and leaves no file", async () => {
    const { db, add } = fixture();
    add(NOW - 10 * DAY);
    const workDir = tmp();
    await expect(archiveRawProbes(db, base({ workDir, upload: async () => { throw new Error("AccessDenied"); } }))).rejects.toThrow("AccessDenied");
    expect(rawLeft(db)).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM probe_archives").get()).toEqual({ n: 0 });
    expect(readdirSync(workDir)).toEqual([]);
  });

  it("stops before writing when the disk is low", async () => {
    const { db, add } = fixture();
    add(NOW - 10 * DAY);
    const r = recorder();
    await expect(archiveRawProbes(db, { ...base({ workDir: tmp(), upload: r.upload }), freeBytes: () => 10 })).rejects.toThrow("archive stopped");
    expect(r.stored).toEqual([]);
    expect(rawLeft(db)).toBe(1);
  });

  it("upload-only leaves the rows, a later run clears them without uploading again", async () => {
    const { db, add } = fixture();
    add(NOW - 10 * DAY);
    const r = recorder();
    await archiveRawProbes(db, { ...base({ workDir: tmp(), upload: r.upload }), trim: false });
    expect(r.stored).toHaveLength(1);
    expect(rawLeft(db)).toBe(1);
    const s = await archiveRawProbes(db, base({ workDir: tmp(), upload: r.upload }));
    expect(r.stored).toHaveLength(1);
    expect(s.trimmedRanges).toBe(1);
    expect(rawLeft(db)).toBe(0);
  });

  it("finishes a clear that a crash interrupted, across a range longer than one batch", async () => {
    const { db, add } = fixture();
    const ts = NOW - 10 * DAY;
    let last = 0;
    for (let i = 0; i < 2300; i++) last = add(ts + i);
    db.prepare("INSERT INTO probe_archives (min_id, max_id, day, s3_key, rows, raw_bytes, gz_bytes, sha256, archived_at) VALUES (1, ?, 'd', 'k', 2300, 1, 1, 's', 1)").run(last);
    db.prepare("UPDATE probes SET headers_json = NULL, body_text = NULL WHERE id <= 900").run();
    const r = recorder();
    await archiveRawProbes(db, base({ workDir: tmp(), upload: r.upload }));
    expect(rawLeft(db)).toBe(0);
    expect(r.stored).toEqual([]);
  });

  it("does not archive a recorded range twice, and archives more than one page of rows in a day", async () => {
    const { db, add } = fixture();
    const ts = NOW - 10 * DAY;
    for (let i = 0; i < 4500; i++) add(ts + i);
    const r = recorder();
    await archiveRawProbes(db, base({ workDir: tmp(), upload: r.upload }));
    expect(lines(r.stored[0]!)).toHaveLength(4500);
    await archiveRawProbes(db, base({ workDir: tmp(), upload: r.upload }));
    expect(r.stored).toHaveLength(1);
  });

  it("records a range with no raw data without uploading, and moves past it", async () => {
    const { db, add } = fixture();
    add(NOW - 10 * DAY, false);
    add(NOW - 9 * DAY);
    const r = recorder();
    const s = await archiveRawProbes(db, base({ workDir: tmp(), upload: r.upload }));
    expect(s.uploaded.map((u) => u.rows)).toEqual([0, 1]);
    expect(r.stored).toHaveLength(1);
  });
});

describe("vacuumIfRoom", () => {
  it("refuses without room and shrinks the file with it", async () => {
    const d = tmp();
    const path = join(d, "a.sqlite");
    const db = openDb(path);
    const resource = insertResource(db, { sellerId: insertSeller(db, "one.example"), url: "https://one.example/a", network: NET });
    const big = "x".repeat(20_000);
    const ins = db.prepare("INSERT INTO probes (resource_id, client_identity, ts, body_text) VALUES (?, 'A', 1, ?)");
    db.transaction(() => { for (let i = 0; i < 300; i++) ins.run(resource, big); })();
    db.prepare("UPDATE probes SET body_text = NULL").run();
    expect(() => vacuumIfRoom(db, d, () => 10)).toThrow("vacuum refused");
    const r = vacuumIfRoom(db, d, () => 1e12);
    expect(r.afterBytes).toBeLessThan(r.beforeBytes / 2);
    expect(db.prepare("SELECT COUNT(*) n FROM probes").get()).toEqual({ n: 300 });
    db.close();
  });
});
