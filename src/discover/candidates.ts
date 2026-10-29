/**
 * `discover import-candidates` (docs/PLAN.md "Candidates"): resources users checked or paid that we had never measured,
 * from the index's GET /v1/candidates (paidfor-index Prompt 10). Each resource URL not already in `resources` is added
 * with source `user` (a new seller too, when the host is new) and probed once with a free, unpaid request:
 *
 *   queued         answered 402 with a Base `exact` option quoting at or under the per-call cap: enters the next
 *                  scheduled run's candidate lane (only when CANDIDATE_BUYS_ENABLED=1)
 *   too_expensive  answered 402 above the cap: recorded with the quoted amount, never bought
 *   not_x402       did not answer 402, or offered no Base `exact` option
 *   measuring      set by the export once the first purchase lands
 *
 * Until the index serves /v1/candidates (404), the import is a logged no-op.
 */
import type { Db } from "../db/index.js";
import { atomicToUsd, MAINNET } from "../config/index.js";
import { fetchQuote, selectRequirements } from "../x402/quote.js";
import type { FetchImpl } from "../x402/http.js";
import { recordTooExpensive, clearTooExpensive } from "../buy/states.js";
import { toCaip2 } from "./index.js";

export type CandidateState = "queued" | "too_expensive" | "not_x402" | "measuring";

export interface CandidateItem {
  url: string;
  host: string;
  checks: number;
  payments: number;
  first_seen: string | null;
  last_seen: string | null;
}

const normHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/** Scheme, host and path only: never a query string or fragment, never anything but http(s). */
export function candidateUrl(host: string, path?: string | null): string | null {
  const h = normHost(host);
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(h) || !h.includes(".")) return null;
  let p = (path ?? "/").trim();
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      if (normHost(u.host) !== h) return null;
      p = u.pathname;
    } catch {
      return null;
    }
  }
  p = p.split(/[?#]/)[0]!;
  if (!p.startsWith("/")) p = "/" + p;
  return `https://${h}${p}`;
}

const int = (v: unknown) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/**
 * Lenient reader for the Prompt 10 shape: `{ candidates | hosts: [{ host, checks, payments, first_seen, last_seen,
 * paths: [{ path, checks, payments, first_seen, last_seen } | "<path>"] }] }`. A host with no paths becomes one
 * candidate at its root. Anything unreadable is dropped.
 */
export function parseCandidates(body: unknown): CandidateItem[] {
  const list = Array.isArray(body) ? body : body && typeof body === "object" ? ((body as Record<string, unknown>).candidates ?? (body as Record<string, unknown>).hosts) : null;
  if (!Array.isArray(list)) return [];
  const out = new Map<string, CandidateItem>();
  for (const h of list) {
    if (!h || typeof h !== "object") continue;
    const rec = h as Record<string, unknown>;
    const host = str(rec.host);
    if (!host) continue;
    const paths = Array.isArray(rec.paths) ? rec.paths : [];
    const entries = paths.length
      ? paths.map((p) => (typeof p === "string" ? { path: p } : p && typeof p === "object" ? (p as Record<string, unknown>) : null)).filter((p): p is Record<string, unknown> => p !== null)
      : [{ path: "/", checks: rec.checks, payments: rec.payments, first_seen: rec.first_seen, last_seen: rec.last_seen }];
    for (const p of entries) {
      const url = candidateUrl(host, str(p.path) ?? str(p.url));
      if (!url) continue;
      const prev = out.get(url);
      const item: CandidateItem = {
        url,
        host: normHost(host),
        checks: int(p.checks ?? (paths.length ? 0 : rec.checks)),
        payments: int(p.payments ?? (paths.length ? 0 : rec.payments)),
        first_seen: str(p.first_seen) ?? str(rec.first_seen),
        last_seen: str(p.last_seen) ?? str(rec.last_seen),
      };
      out.set(url, prev ? { ...item, checks: prev.checks + item.checks, payments: prev.payments + item.payments } : item);
    }
  }
  return [...out.values()];
}

export type CandidateFetch = { status: "ok"; items: CandidateItem[] } | { status: "not_live" } | { status: "error"; message: string };

export async function fetchCandidates(index: string, fetchImpl: FetchImpl = fetch, days = 30): Promise<CandidateFetch> {
  try {
    const res = await fetchImpl(`${index.replace(/\/$/, "")}/v1/candidates?days=${days}`, { headers: { accept: "application/json", "x-paidfor-client": "x402-audit" } });
    if (res.status === 404) return { status: "not_live" };
    if (!res.ok) return { status: "error", message: `GET /v1/candidates answered ${res.status}` };
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { status: "error", message: "GET /v1/candidates: not JSON" };
    }
    return { status: "ok", items: parseCandidates(body) };
  } catch (e) {
    return { status: "error", message: (e as Error).message };
  }
}

export interface ImportStats {
  received: number;
  alreadyKnown: number;
  imported: number;
  newSellers: number;
  updated: number;
}

/** Add every candidate URL not already in `resources` (any source) as a `user` resource; refresh counts on known ones. */
export function importCandidates(db: Db, items: readonly CandidateItem[], now: number): ImportStats {
  const st: ImportStats = { received: items.length, alreadyKnown: 0, imported: 0, newSellers: 0, updated: 0 };
  const knownUrl = db.prepare<[string], { id: number }>("SELECT id FROM resources WHERE url = ? AND source != 'user' LIMIT 1");
  const findCand = db.prepare<[string], { id: number }>("SELECT id FROM candidates WHERE url = ?");
  const updCand = db.prepare("UPDATE candidates SET checks = ?, payments = ?, first_seen = COALESCE(first_seen, ?), last_seen = ? WHERE id = ?");
  const findSeller = db.prepare<[string], { id: number }>("SELECT id FROM sellers WHERE domain = ?");
  const insSeller = db.prepare("INSERT INTO sellers (domain, first_seen_at, last_seen_at) VALUES (?, ?, ?)");
  const insRes = db.prepare(
    "INSERT INTO resources (seller_id, url, method, source, description, raw_json, first_seen_at, last_seen_at) VALUES (?, ?, 'GET', 'user', ?, ?, ?, ?) ON CONFLICT (url, method, source) DO UPDATE SET last_seen_at = excluded.last_seen_at RETURNING id",
  );
  const insCand = db.prepare(
    `INSERT INTO candidates (url, host, checks, payments, first_seen, last_seen, imported_at, seller_id, resource_id, seller_new)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const c of items) {
      const cand = findCand.get(c.url);
      if (cand) {
        updCand.run(c.checks, c.payments, c.first_seen, c.last_seen, cand.id);
        st.updated++;
        continue;
      }
      if (knownUrl.get(c.url)) {
        st.alreadyKnown++;
        continue;
      }
      let sellerNew = 0;
      let sellerId = findSeller.get(c.host)?.id;
      if (sellerId === undefined) {
        sellerId = Number(insSeller.run(c.host, now, now).lastInsertRowid);
        sellerNew = 1;
        st.newSellers++;
      }
      const rid = (insRes.get(sellerId, c.url, `user candidate: ${c.checks} check(s), ${c.payments} payment(s)`, JSON.stringify(c), now, now) as { id: number }).id;
      insCand.run(c.url, c.host, c.checks, c.payments, c.first_seen, c.last_seen, now, sellerId, rid, sellerNew);
      st.imported++;
    }
  })();
  return st;
}

export interface ProbeCandidatesOptions {
  /** Per-call cap the quote is judged against (the scheduled-run cap). */
  perCallCapAtomic: bigint;
  network?: string;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  now?: () => number;
  /** Re-probe candidates already classified (default: only unprobed ones). */
  all?: boolean;
}

export interface ProbedCandidate {
  url: string;
  host: string;
  state: CandidateState;
  quoted_usdc: string | null;
  note: string;
}

/** One free 402 quote per unprobed candidate, then its state. Never signs or pays. */
export async function probeCandidates(db: Db, o: ProbeCandidatesOptions): Promise<ProbedCandidate[]> {
  const network = o.network ?? MAINNET;
  const now = o.now ?? Date.now;
  const rows = db
    .prepare(`SELECT id, url, host, resource_id FROM candidates WHERE resource_id IS NOT NULL ${o.all ? "AND state IS NOT 'measuring'" : "AND state IS NULL"} ORDER BY id`)
    .all() as { id: number; url: string; host: string; resource_id: number }[];
  const setState = db.prepare("UPDATE candidates SET state = ?, quoted_atomic = ?, probed_at = ?, note = ? WHERE id = ?");
  const fillRes = db.prepare(
    `UPDATE resources SET x402_version = ?, scheme = ?, network = ?, asset = ?, declared_price_atomic = ?, pay_to = ?, max_timeout_seconds = ?,
       accepts_json = ?, mime_type = COALESCE(?, mime_type), description = COALESCE(?, description), last_seen_at = ? WHERE id = ?`,
  );
  const out: ProbedCandidate[] = [];
  for (const r of rows) {
    const q = await fetchQuote(r.url, { timeoutMs: o.timeoutMs ?? 15_000, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
    let state: CandidateState;
    let quoted: bigint | null = null;
    let note: string;
    if (q.error) {
      state = "not_x402";
      note = `unreachable: ${q.error.kind}`;
    } else if (q.status !== 402) {
      state = "not_x402";
      note = `answered ${q.status}, not 402`;
    } else {
      const req = q.parsed ? selectRequirements(q.parsed.accepts, { network, scheme: "exact" }) : undefined;
      if (!req || !/^\d+$/.test(req.amountAtomic)) {
        state = "not_x402";
        note = "answered 402 without a Base exact option";
      } else {
        quoted = BigInt(req.amountAtomic);
        fillRes.run(req.x402Version, req.scheme, toCaip2(req.network), req.asset, req.amountAtomic, req.payTo, req.maxTimeoutSeconds, JSON.stringify(q.parsed!.accepts.map((a) => a.raw)), req.mimeType ?? null, req.description ?? null, now(), r.resource_id);
        if (quoted <= o.perCallCapAtomic) {
          state = "queued";
          note = `quotes ${atomicToUsd(quoted)} USDC; queued for the next scheduled run`;
          clearTooExpensive(db, r.resource_id);
        } else {
          state = "too_expensive";
          note = `quotes ${atomicToUsd(quoted)} USDC, above the per-call cap ${atomicToUsd(o.perCallCapAtomic)}`;
          recordTooExpensive(db, { resourceId: r.resource_id, quotedAtomic: quoted, capAtomic: o.perCallCapAtomic, basis: "probe", now: now() });
        }
      }
    }
    setState.run(state, quoted?.toString() ?? null, now(), note, r.id);
    out.push({ url: r.url, host: r.host, state, quoted_usdc: quoted === null ? null : atomicToUsd(quoted), note });
  }
  return out;
}

/** Candidates whose first purchase has landed become `measuring`. */
export function markMeasuring(db: Db): number {
  return db
    .prepare(
      `UPDATE candidates SET state = 'measuring' WHERE state = 'queued'
         AND EXISTS (SELECT 1 FROM calls c WHERE c.resource_id = candidates.resource_id AND c.paid = 1)`,
    )
    .run().changes;
}

export interface CandidateRow {
  url: string;
  host: string;
  state: CandidateState | null;
  quoted_atomic: string | null;
  checks: number;
  payments: number;
  first_seen: string | null;
  last_seen: string | null;
  imported_at: number;
  probed_at: number | null;
  seller_new: number;
  note: string | null;
}

export function listCandidates(db: Db): CandidateRow[] {
  return db
    .prepare("SELECT url, host, state, quoted_atomic, checks, payments, first_seen, last_seen, imported_at, probed_at, seller_new, note FROM candidates ORDER BY checks + payments DESC, url")
    .all() as CandidateRow[];
}
