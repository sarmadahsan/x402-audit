/**
 * Moves the raw part of old probes (headers_json, body_text) to S3 and clears it from the database.
 *
 * No code reads those two columns: verdicts, reference prices and reports use the parsed fields, which stay. They are
 * kept for re-parsing quotes and for seller disputes, and at about 7 KB a row they were 88% of the probes table, so they
 * filled the disk (2026-11-09). Each file is gzipped NDJSON covering one UTC day of probe ids.
 *
 * The order is what makes this safe: write the file, read it back and compare, upload with a SHA-256 that S3 checks,
 * record the upload, and only then clear the rows. A failure at any step leaves the rows untouched; a crash during the
 * clearing is finished by the next run from the recorded id range.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, rmSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip, createGzip } from "node:zlib";
import type { Db } from "../db/index.js";

const DAY_MS = 86_400_000;
const PAGE_ROWS = 2000;
const TRIM_BATCH_IDS = 1000;
const DEFAULT_MIN_FREE_BYTES = 1024 ** 3;

/** S3 key prefix, kept outside `audit/` because the bucket's backups expire after 30 days and this must not. */
export const ARCHIVE_PREFIX = "probe-raw/";

/** Stores one finished file; must reject unless the store accepted exactly these bytes. */
export type ArchiveUpload = (file: string, key: string, sha256Base64: string) => Promise<void>;

export interface ArchiveChunk {
  day: string;
  minId: number;
  maxId: number;
}

export interface PlanOptions {
  now: number;
  keepDays: number;
  maxDays: number;
}

export interface ArchiveOptions extends PlanOptions {
  workDir: string;
  upload: ArchiveUpload;
  /** False uploads and records but leaves the rows, so a first archive can be inspected; a later run clears them. */
  trim: boolean;
  minFreeBytes?: number;
  freeBytes?: (dir: string) => number;
  log?: (message: string) => void;
}

export interface ArchiveSummary {
  uploaded: { day: string; key: string | null; rows: number; rawBytes: number; gzBytes: number }[];
  trimmedRanges: number;
}

interface RawRow {
  id: number;
  resource_id: number;
  url: string | null;
  client_identity: string;
  round_id: string | null;
  ts: number;
  status: number | null;
  headers_json: string | null;
  body_text: string | null;
}

const utcDay = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
const dayStart = (ts: number): number => Math.floor(ts / DAY_MS) * DAY_MS;
const rawLength = (s: string | null): number => (s === null ? 0 : Buffer.byteLength(s));

/** Free bytes for an unprivileged writer on the filesystem holding `dir`. */
export function diskFreeBytes(dir: string): number {
  const s = statfsSync(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/** The highest probe id any recorded archive covers; ids at or below it are never archived again. */
function watermark(db: Db): number {
  return (db.prepare("SELECT COALESCE(MAX(max_id), 0) m FROM probe_archives").get() as { m: number }).m;
}

/**
 * The next id ranges to archive, oldest first: one per UTC day, only days that ended at least `keepDays` ago. A range
 * ends at the first row of the next day, so a row written out of time order just lands in the following range; ids
 * decide what a file covers and the key carries them, so two files can never collide.
 */
export function planArchive(db: Db, o: PlanOptions): ArchiveChunk[] {
  const newestDayEnd = dayStart(o.now) - o.keepDays * DAY_MS;
  const page = db.prepare("SELECT id, ts FROM probes WHERE id > ? ORDER BY id LIMIT ?");
  const chunks: ArchiveChunk[] = [];
  let cursor = watermark(db);
  while (chunks.length < o.maxDays) {
    const first = (page.all(cursor, 1) as { id: number; ts: number }[])[0];
    if (!first || dayStart(first.ts) + DAY_MS > newestDayEnd) break;
    const end = dayStart(first.ts) + DAY_MS;
    let maxId = first.id;
    let scan = first.id - 1;
    let done = false;
    while (!done) {
      const rows = page.all(scan, PAGE_ROWS) as { id: number; ts: number }[];
      for (const r of rows) {
        if (r.ts >= end) {
          done = true;
          break;
        }
        maxId = r.id;
      }
      if (rows.length < PAGE_ROWS) done = true;
      else scan = rows[rows.length - 1]!.id;
    }
    chunks.push({ day: utcDay(first.ts), minId: first.id, maxId });
    cursor = maxId;
  }
  return chunks;
}

/** S3 key for a range. */
export function archiveKey(c: ArchiveChunk): string {
  return `${ARCHIVE_PREFIX}${c.day.slice(0, 7)}/${c.day}-ids-${c.minId}-${c.maxId}.ndjson.gz`;
}

async function writeChunk(db: Db, c: ArchiveChunk, file: string): Promise<{ rows: number; rawBytes: number }> {
  const page = db.prepare(
    `SELECT p.id, p.resource_id, r.url, p.client_identity, p.round_id, p.ts, p.status, p.headers_json, p.body_text
     FROM probes p LEFT JOIN resources r ON r.id = p.resource_id
     WHERE p.id > ? AND p.id <= ? AND (p.headers_json IS NOT NULL OR p.body_text IS NOT NULL)
     ORDER BY p.id LIMIT ?`,
  );
  const totals = { rows: 0, rawBytes: 0 };
  function* lines(): Generator<string> {
    let cursor = c.minId - 1;
    for (;;) {
      const rows = page.all(cursor, c.maxId, PAGE_ROWS) as RawRow[];
      for (const r of rows) {
        totals.rows += 1;
        totals.rawBytes += rawLength(r.headers_json) + rawLength(r.body_text);
        yield `${JSON.stringify(r)}\n`;
      }
      if (rows.length < PAGE_ROWS) return;
      cursor = rows[rows.length - 1]!.id;
    }
  }
  await pipeline(Readable.from(lines()), createGzip({ level: 9 }), createWriteStream(file));
  return totals;
}

/** Reads a finished file back through gzip and JSON and compares it with what was written; throws on any difference. */
async function verifyChunk(file: string, c: ArchiveChunk, expected: { rows: number; rawBytes: number }): Promise<void> {
  const input = createReadStream(file).pipe(createGunzip());
  let rows = 0;
  let rawBytes = 0;
  let lastId = c.minId - 1;
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
    const r = JSON.parse(line) as RawRow;
    if (r.id <= lastId || r.id > c.maxId) throw new Error(`archive ${file}: id ${r.id} out of order or out of range`);
    lastId = r.id;
    rows += 1;
    rawBytes += rawLength(r.headers_json) + rawLength(r.body_text);
  }
  if (rows !== expected.rows || rawBytes !== expected.rawBytes)
    throw new Error(`archive ${file}: read back ${rows} rows and ${rawBytes} bytes, wrote ${expected.rows} and ${expected.rawBytes}`);
}

async function fileSha256Base64(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("base64");
}

/** Clears the raw columns over a recorded range in short transactions, so hourly writers are never held up for long. */
async function trimRange(db: Db, minId: number, maxId: number, now: number): Promise<void> {
  const clear = db.prepare(
    "UPDATE probes SET headers_json = NULL, body_text = NULL WHERE id >= ? AND id < ? AND (headers_json IS NOT NULL OR body_text IS NOT NULL)",
  );
  for (let from = minId; from <= maxId; from += TRIM_BATCH_IDS) {
    clear.run(from, Math.min(from + TRIM_BATCH_IDS, maxId + 1));
    await new Promise((resolve) => setImmediate(resolve));
  }
  db.prepare("UPDATE probe_archives SET trimmed_at = ? WHERE min_id = ?").run(now, minId);
}

/** Archives up to `maxDays` days and, when `trim` is on, clears every recorded range still holding raw data. */
export async function archiveRawProbes(db: Db, o: ArchiveOptions): Promise<ArchiveSummary> {
  const say = o.log ?? (() => {});
  const minFree = o.minFreeBytes ?? DEFAULT_MIN_FREE_BYTES;
  const free = o.freeBytes ?? diskFreeBytes;
  mkdirSync(o.workDir, { recursive: true });
  const requireRoom = (): void => {
    const left = free(o.workDir);
    if (left < minFree) throw new Error(`archive stopped: ${left} bytes free in ${o.workDir}, needs at least ${minFree}`);
  };
  const summary: ArchiveSummary = { uploaded: [], trimmedRanges: 0 };
  const trimPending = async (): Promise<void> => {
    if (!o.trim) return;
    const pending = db.prepare("SELECT min_id, max_id FROM probe_archives WHERE trimmed_at IS NULL ORDER BY min_id").all() as { min_id: number; max_id: number }[];
    for (const p of pending) {
      requireRoom();
      await trimRange(db, p.min_id, p.max_id, o.now);
      summary.trimmedRanges += 1;
      say(`archive: cleared raw columns for probes ${p.min_id}..${p.max_id}`);
    }
  };
  await trimPending();
  const record = db.prepare(
    `INSERT INTO probe_archives (min_id, max_id, day, s3_key, rows, raw_bytes, gz_bytes, sha256, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of planArchive(db, o)) {
    requireRoom();
    const key = archiveKey(c);
    const file = join(o.workDir, key.slice(ARCHIVE_PREFIX.length).replace(/\//g, "_"));
    try {
      const written = await writeChunk(db, c, file);
      if (written.rows === 0) {
        record.run(c.minId, c.maxId, c.day, null, 0, 0, 0, null, o.now);
        summary.uploaded.push({ day: c.day, key: null, rows: 0, rawBytes: 0, gzBytes: 0 });
        continue;
      }
      await verifyChunk(file, c, written);
      const sha = await fileSha256Base64(file);
      const gzBytes = statSync(file).size;
      await o.upload(file, key, sha);
      record.run(c.minId, c.maxId, c.day, key, written.rows, written.rawBytes, gzBytes, sha, o.now);
      summary.uploaded.push({ day: c.day, key, rows: written.rows, rawBytes: written.rawBytes, gzBytes });
      say(`archive: ${c.day} uploaded to ${key}: ${written.rows} rows, ${written.rawBytes} raw bytes, ${gzBytes} gzipped`);
    } finally {
      rmSync(file, { force: true });
    }
    await trimPending();
  }
  return summary;
}

/**
 * Uploads with `s3api put-object` and a SHA-256 that S3 itself checks, which needs only s3:PutObject: the server's role
 * cannot read the bucket back.
 */
export function awsUploader(bucket: string): ArchiveUpload {
  const run = promisify(execFile);
  return async (file, key, sha256Base64) => {
    const { stdout } = await run(
      "aws",
      ["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", file, "--content-type", "application/gzip", "--checksum-sha256", sha256Base64, "--output", "json"],
      { timeout: 600_000, maxBuffer: 1024 * 1024 },
    );
    const reply = JSON.parse(stdout) as { ChecksumSHA256?: string };
    if (reply.ChecksumSHA256 !== sha256Base64) throw new Error(`archive ${key}: S3 returned checksum ${reply.ChecksumSHA256 ?? "none"}`);
  };
}

/**
 * Compacts the database so cleared space returns to the disk (and backups shrink). In WAL mode VACUUM can need about
 * twice the live data in free space, so it refuses without that. Run it by hand between loop cycles: it blocks writers.
 */
export function vacuumIfRoom(db: Db, dir: string, freeBytes: (d: string) => number = diskFreeBytes): { beforeBytes: number; afterBytes: number } {
  const size = (): { total: number; live: number } => {
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    const pages = db.pragma("page_count", { simple: true }) as number;
    const freePages = db.pragma("freelist_count", { simple: true }) as number;
    return { total: pages * pageSize, live: (pages - freePages) * pageSize };
  };
  const before = size();
  const needed = before.live * 2 + DEFAULT_MIN_FREE_BYTES;
  const left = freeBytes(dir);
  if (left < needed) throw new Error(`vacuum refused: ${left} bytes free, needs ${needed}`);
  db.exec("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
  return { beforeBytes: before.total, afterBytes: size().total };
}
