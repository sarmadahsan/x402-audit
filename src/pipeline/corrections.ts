/**
 * Operator corrections to classified call rows (docs/taxonomy.md "Corrections"), the second audit trail next to
 * `reclassifications`. Nothing here touches the chain or the seller; nothing is deleted or overwritten silently.
 *
 *  - correctReference: the reference price a row was judged against was wrong at purchase time, typically because the
 *    Bazaar listing had already been rewritten (the Bazaar rewrites a listing at every settlement) and our snapshot
 *    had not. Writes a `corrections` row with the old and new reference, replaces the row's reference, and re-runs the
 *    classifier through reclassifyCalls so `reclassifications` records the outcome change with the correction's id.
 *  - annotate: the row stands but deserves a public note (kind `stale_listing`: the listing really said the lower
 *    price when we bought, the seller had raised its price without re-registering).
 *  - staleOverchargeCandidates: every overcharge row that may be a stale-snapshot measurement (we had already paid the
 *    quoted price for that resource earlier, so the Bazaar listing had been rewritten to it) for the operator to review.
 */
import { execSync } from "node:child_process";
import type { Db } from "../db/index.js";
import { MEASURED_SOURCES, type ReferenceSource } from "../taxonomy.js";
import { reclassifyCalls, type ReclassifyChange } from "./reclassify.js";
import type { ServiceConfig } from "../validators/types.js";

export const CORRECTION_KINDS = { REFERENCE_PRICE: "reference_price", STALE_LISTING: "stale_listing" } as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[keyof typeof CORRECTION_KINDS];

export interface CorrectionRow {
  id: number;
  call_id: number;
  ts: number;
  kind: CorrectionKind;
  old_reference_atomic: string | null;
  old_reference_source: string | null;
  new_reference_atomic: string | null;
  new_reference_source: string | null;
  old_outcome: string | null;
  new_outcome: string | null;
  reason: string;
  note: string | null;
  evidence_json: string | null;
  code_commit: string | null;
}

export interface CorrectReferenceOptions {
  callIds: number[];
  referenceAtomic: string;
  referenceSource: ReferenceSource;
  reason: string;
  note?: string;
  /** What the correction rests on (public): e.g. the Bazaar entry's lastUpdated and our earlier settlement. */
  evidence?: unknown;
  apply: boolean;
  now?: () => number;
  services?: (domain: string) => ServiceConfig | undefined;
}

export interface CorrectionChange {
  callId: number;
  url: string;
  oldReference: string | null;
  newReference: string;
  oldOutcome: string | null;
  newOutcome: string | null;
  correctionId: number | null;
}

interface CallRef { id: number; url: string; reference_price_atomic: string | null; reference_source: string | null; outcome: string | null }

function currentCommit(): string | null {
  try { return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim(); } catch { return null; }
}

function callRefs(db: Db, ids: readonly number[]): CallRef[] {
  if (!ids.length) return [];
  return db
    .prepare(`SELECT c.id, r.url, c.reference_price_atomic, c.reference_source, c.outcome FROM calls c JOIN resources r ON r.id = c.resource_id WHERE c.id IN (${ids.map(() => "?").join(",")}) ORDER BY c.id`)
    .all(...ids) as CallRef[];
}

const INSERT = `INSERT INTO corrections (call_id, ts, kind, old_reference_atomic, old_reference_source, new_reference_atomic, new_reference_source, old_outcome, new_outcome, reason, note, evidence_json, code_commit)
  VALUES (@call_id, @ts, @kind, @old_reference_atomic, @old_reference_source, @new_reference_atomic, @new_reference_source, @old_outcome, @new_outcome, @reason, @note, @evidence_json, @code_commit)`;

/** Replace the reference price of the given rows and re-classify them, with a corrections row per call. */
export async function correctReference(db: Db, o: CorrectReferenceOptions): Promise<{ changes: CorrectionChange[]; applied: boolean; missing: number[] }> {
  if (!/^\d+$/.test(o.referenceAtomic)) throw new Error(`reference must be an atomic-unit integer, got ${o.referenceAtomic}`);
  const now = o.now ?? Date.now;
  const rows = callRefs(db, o.callIds);
  const found = new Set(rows.map((r) => r.id));
  const missing = o.callIds.filter((id) => !found.has(id));
  const commit = currentCommit();
  const changes: CorrectionChange[] = [];

  if (!o.apply) {
    const override = new Map(rows.map((r) => [r.id, { amountAtomic: o.referenceAtomic, source: o.referenceSource }]));
    const preview = await reclassifyCalls(db, { reason: "preview", apply: false, callIds: rows.map((r) => r.id), referenceOverride: override, now, ...(o.services ? { services: o.services } : {}) });
    const by = new Map<number, ReclassifyChange>(preview.changed.map((c) => [c.callId, c]));
    for (const r of rows) {
      changes.push({ callId: r.id, url: r.url, oldReference: r.reference_price_atomic, newReference: o.referenceAtomic, oldOutcome: r.outcome, newOutcome: by.get(r.id)?.newOutcome ?? r.outcome, correctionId: null });
    }
    return { changes, applied: false, missing };
  }

  const ins = db.prepare(INSERT);
  const upd = db.prepare("UPDATE calls SET reference_price_atomic = ?, reference_source = ? WHERE id = ?");
  const setOutcome = db.prepare("UPDATE corrections SET new_outcome = ? WHERE id = ?");
  for (const r of rows) {
    const t = now();
    const correctionId = db.transaction(() => {
      const id = Number(
        ins.run({
          call_id: r.id, ts: t, kind: CORRECTION_KINDS.REFERENCE_PRICE,
          old_reference_atomic: r.reference_price_atomic, old_reference_source: r.reference_source,
          new_reference_atomic: o.referenceAtomic, new_reference_source: o.referenceSource,
          old_outcome: r.outcome, new_outcome: null, reason: o.reason, note: o.note ?? null,
          evidence_json: o.evidence === undefined ? null : JSON.stringify(o.evidence), code_commit: commit,
        }).lastInsertRowid,
      );
      upd.run(o.referenceAtomic, o.referenceSource, r.id);
      return id;
    })();
    const re = await reclassifyCalls(db, { reason: `correction #${correctionId}: ${o.reason}`, apply: true, callIds: [r.id], now, ...(o.services ? { services: o.services } : {}) });
    const after = (db.prepare("SELECT outcome FROM calls WHERE id = ?").get(r.id) as { outcome: string | null }).outcome;
    setOutcome.run(after, correctionId);
    const ch = re.changed.find((c) => c.callId === r.id);
    changes.push({ callId: r.id, url: r.url, oldReference: r.reference_price_atomic, newReference: o.referenceAtomic, oldOutcome: r.outcome, newOutcome: ch?.newOutcome ?? after, correctionId });
  }
  return { changes, applied: true, missing };
}

export interface AnnotateOptions {
  callIds: number[];
  kind: CorrectionKind;
  reason: string;
  note: string;
  evidence?: unknown;
  apply: boolean;
  now?: () => number;
}

/** A public note on rows that stand (no reference or outcome change). */
export function annotate(db: Db, o: AnnotateOptions): { annotated: { callId: number; url: string; outcome: string | null; correctionId: number | null }[]; applied: boolean; missing: number[] } {
  const now = o.now ?? Date.now;
  const rows = callRefs(db, o.callIds);
  const found = new Set(rows.map((r) => r.id));
  const missing = o.callIds.filter((id) => !found.has(id));
  const commit = currentCommit();
  const ins = db.prepare(INSERT);
  const annotated = db.transaction(() =>
    rows.map((r) => {
      if (!o.apply) return { callId: r.id, url: r.url, outcome: r.outcome, correctionId: null };
      const id = Number(
        ins.run({
          call_id: r.id, ts: now(), kind: o.kind,
          old_reference_atomic: r.reference_price_atomic, old_reference_source: r.reference_source,
          new_reference_atomic: r.reference_price_atomic, new_reference_source: r.reference_source,
          old_outcome: r.outcome, new_outcome: r.outcome, reason: o.reason, note: o.note,
          evidence_json: o.evidence === undefined ? null : JSON.stringify(o.evidence), code_commit: commit,
        }).lastInsertRowid,
      );
      return { callId: r.id, url: r.url, outcome: r.outcome, correctionId: id };
    }),
  )();
  return { annotated, applied: o.apply, missing };
}

/** Every correction, newest first; the export joins them to evidence rows and lists them per seller. */
export function listCorrections(db: Db, o: { sellerId?: number } = {}): (CorrectionRow & { seller_id: number; call_ts: number; url: string; method: string; tx_hash: string | null })[] {
  const where = o.sellerId !== undefined ? "WHERE c.seller_id = ?" : "";
  return db
    .prepare(
      `SELECT k.*, c.seller_id, c.ts AS call_ts, r.url, r.method,
         COALESCE(c.settlement_tx_hash, (SELECT s.tx_hash FROM settlements s WHERE s.call_id = c.id ORDER BY s.id LIMIT 1)) AS tx_hash
       FROM corrections k JOIN calls c ON c.id = k.call_id JOIN resources r ON r.id = c.resource_id ${where}
       ORDER BY k.ts DESC, k.id DESC`,
    )
    .all(...(o.sellerId !== undefined ? [o.sellerId] : [])) as (CorrectionRow & { seller_id: number; call_ts: number; url: string; method: string; tx_hash: string | null })[];
}

export interface StaleOverchargeRow {
  domain: string;
  seller_id: number;
  call_id: number;
  ts: number;
  url: string;
  quote_atomic: string;
  reference_atomic: string;
  /** The resource's listed price now. */
  listed_now_atomic: string | null;
  /** Our first paid call to this resource at this quote, before this row: by then the Bazaar had been rewritten to the quote. */
  first_paid_at_quote: number | null;
  corrected: boolean;
}

export interface StaleOverchargeSummary {
  domain: string;
  seller_id: number;
  overcharge_rows: number;
  /** Rows after our own earlier settlement at the same quote (the listing already read the quote). */
  repeat_after_own_purchase: number;
  /** Rows whose quote is what the listing says now (the listing caught up). */
  listing_now_equals_quote: number;
  /** Both: the measurement-error candidates. */
  candidates: number;
  already_corrected: number;
}

/** Overcharge rows judged against a Bazaar snapshot that an earlier settlement of ours had already made stale. Reads only. */
export function staleOverchargeCandidates(db: Db): { rows: StaleOverchargeRow[]; summary: StaleOverchargeSummary[] } {
  const rows = db
    .prepare(
      `SELECT s.domain, c.seller_id, c.id AS call_id, c.ts, r.url, c.quote_amount_atomic AS quote_atomic, c.reference_price_atomic AS reference_atomic,
         r.declared_price_atomic AS listed_now_atomic,
         (SELECT MIN(p.ts) FROM calls p WHERE p.resource_id = c.resource_id AND p.paid = 1 AND p.ts < c.ts
            AND p.quote_amount_atomic = c.quote_amount_atomic AND p.settlement_count >= 1) AS first_paid_at_quote,
         EXISTS (SELECT 1 FROM corrections k WHERE k.call_id = c.id) AS corrected
       FROM calls c JOIN resources r ON r.id = c.resource_id JOIN sellers s ON s.id = c.seller_id
       WHERE c.outcome = 'overcharge' AND c.paid = 1 AND c.reference_source = 'bazaar'
         AND c.source IN (${MEASURED_SOURCES.map((x) => `'${x}'`).join(",")})
         AND c.quote_amount_atomic GLOB '[0-9]*' AND c.reference_price_atomic GLOB '[0-9]*'
       ORDER BY s.domain, c.ts`,
    )
    .all() as (Omit<StaleOverchargeRow, "corrected"> & { corrected: number })[];
  const by = new Map<string, StaleOverchargeSummary>();
  const out: StaleOverchargeRow[] = [];
  for (const r of rows) {
    const row: StaleOverchargeRow = { ...r, corrected: r.corrected === 1 };
    out.push(row);
    const s = by.get(r.domain) ?? { domain: r.domain, seller_id: r.seller_id, overcharge_rows: 0, repeat_after_own_purchase: 0, listing_now_equals_quote: 0, candidates: 0, already_corrected: 0 };
    s.overcharge_rows++;
    const repeat = r.first_paid_at_quote !== null;
    const caught = r.listed_now_atomic !== null && /^\d+$/.test(r.listed_now_atomic) && BigInt(r.listed_now_atomic) === BigInt(r.quote_atomic);
    if (repeat) s.repeat_after_own_purchase++;
    if (caught) s.listing_now_equals_quote++;
    if (repeat && caught) s.candidates++;
    if (row.corrected) s.already_corrected++;
    by.set(r.domain, s);
  }
  return { rows: out, summary: [...by.values()].filter((s) => s.candidates > 0).sort((a, b) => b.candidates - a.candidates || a.domain.localeCompare(b.domain)) };
}
