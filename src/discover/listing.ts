/**
 * The Bazaar listing at purchase time (docs/taxonomy.md "Reference price"). The daily crawl (`discover refresh`) is a
 * snapshot; the Bazaar rewrites a listing at every settlement (its `lastUpdated` equals the resource's last call), so a
 * seller that changed its price is listed at the new price from the first settlement on, and a reference taken from an
 * older snapshot would call every later purchase an overcharge (2026-10-25, Offera Studio's two hosts).
 *
 * refreshListing re-reads the seller's entries just before a purchase through the public, keyless merchant endpoint
 * GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=&limit=&offset= (limit is clamped to 100,
 * entries come newest `lastUpdated` first). Because of that order, one page decides: an entry rewritten since our snapshot
 * is in the first page(s); once a page's oldest entry is older than our snapshot of the target and the target was not
 * seen, the snapshot is current. Every known resource seen on the way is refreshed too, and a changed listed price
 * leaves a `price_events` row (kind listing_changed) so the change is on record next to the call.
 *
 * Read-only on the network; the only writes are to `resources` (declared price, accepts, raw item, last_seen_at) and
 * `price_events`. A failure leaves the snapshot in place and is reported, never thrown: a listing lookup must not stop
 * a purchase.
 */
import type { Db } from "../db/index.js";
import { MAINNET } from "../config/index.js";
import { BazaarItemSchema, type BazaarItem } from "./bazaar.js";
import { bazaarInput, selectAccept } from "./index.js";

export const BAZAAR_MERCHANT_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant";
export const MERCHANT_PAGE_SIZE = 100;
export const LISTING_CHANGED = "listing_changed";

export type ListingRefreshStatus = "updated" | "unchanged" | "not_listed" | "skipped" | "error";

export interface ListingRefreshResult {
  status: ListingRefreshStatus;
  resourceId: number;
  payTo: string | null;
  /** Listed Base-exact amount after the refresh (when the entry was seen). */
  amountAtomic?: string;
  previousAmountAtomic?: string | null;
  lastUpdated?: string;
  pages: number;
  reason?: string;
}

interface PageCache {
  fetchedAt: number;
  /** Pages fetched so far, in order. */
  items: BazaarItem[];
  /** Oldest lastUpdated seen so far (ms), or +Infinity when nothing was fetched. */
  minLastUpdated: number;
  nextOffset: number;
  total: number | undefined;
  complete: boolean;
}

/** Pages per pay-to, kept for `ttlMs` and dropped when one of our own purchases to that pay-to settles. */
export class ListingCache {
  private readonly pages = new Map<string, PageCache>();
  constructor(readonly ttlMs = 60_000) {}
  get(payTo: string, now: number): PageCache | undefined {
    const c = this.pages.get(payTo.toLowerCase());
    if (!c) return undefined;
    if (now - c.fetchedAt > this.ttlMs) {
      this.pages.delete(payTo.toLowerCase());
      return undefined;
    }
    return c;
  }
  set(payTo: string, c: PageCache): void {
    this.pages.set(payTo.toLowerCase(), c);
  }
  /** Our settlement rewrote the seller's listing: forget what we fetched. */
  invalidate(payTo: string): void {
    this.pages.delete(payTo.toLowerCase());
  }
}

export interface RefreshListingOptions {
  resourceId: number;
  now: number;
  fetchImpl?: typeof fetch;
  cache?: ListingCache;
  /** Pages (of 100) read at most per lookup before giving up on finding the entry. Default 5. */
  maxPages?: number;
  network?: string;
  baseUrl?: string;
  timeoutMs?: number;
  log?: { info(msg: string): void; warn(msg: string): void };
}

interface ResourceRow { id: number; url: string; method: string; source: string; pay_to: string | null; declared_price_atomic: string | null; last_updated: string | null }

const parseMs = (s: string | undefined | null): number => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

async function fetchPage(o: RefreshListingOptions, payTo: string, offset: number): Promise<{ items: BazaarItem[]; total: number | undefined }> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const url = `${o.baseUrl ?? BAZAAR_MERCHANT_URL}?payTo=${encodeURIComponent(payTo)}&limit=${MERCHANT_PAGE_SIZE}&offset=${offset}`;
  const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
  if (!res.ok) throw new Error(`merchant listing HTTP ${res.status}`);
  const body = (await res.json()) as { resources?: unknown[]; pagination?: { total?: number } };
  const items: BazaarItem[] = [];
  for (const raw of body.resources ?? []) {
    const p = BazaarItemSchema.safeParse(raw);
    if (p.success) items.push({ ...p.data, raw });
  }
  return { items, total: typeof body.pagination?.total === "number" ? body.pagination.total : undefined };
}

/**
 * Apply fetched entries to the resources we know (same key as the crawl: url, method, source bazaar). Returns the
 * resource ids whose listed price changed. Writes a listing_changed price event per change.
 */
export function applyListingItems(db: Db, items: readonly BazaarItem[], now: number, o: { network?: string; via: string }): { changed: number[]; seen: number } {
  const find = db.prepare<[string, string], ResourceRow>(
    "SELECT id, url, method, source, pay_to, declared_price_atomic, json_extract(raw_json, '$.lastUpdated') AS last_updated FROM resources WHERE url = ? AND method = ? AND source = 'bazaar'",
  );
  const upd = db.prepare("UPDATE resources SET declared_price_atomic = ?, pay_to = ?, accepts_json = ?, raw_json = ?, last_seen_at = MAX(last_seen_at, ?) WHERE id = ?");
  const ev = db.prepare("INSERT INTO price_events (resource_id, ts, kind, old_value, new_value, details_json) VALUES (?, ?, ?, ?, ?, ?)");
  const changed: number[] = [];
  let seen = 0;
  db.transaction(() => {
    for (const item of items) {
      const { method } = bazaarInput(item);
      const row = find.get(item.resource, method);
      if (!row) continue;
      seen++;
      const sel = selectAccept(item.accepts, o.network ?? MAINNET);
      if (!sel) continue;
      const newer = !(parseMs(item.lastUpdated) <= parseMs(row.last_updated)); // NaN on either side counts as newer
      if (!newer) continue;
      const priceChanged = row.declared_price_atomic !== sel.amount;
      upd.run(sel.amount, sel.payTo, JSON.stringify((item.raw as { accepts?: unknown } | null)?.accepts ?? item.accepts ?? []), JSON.stringify(item.raw), now, row.id);
      if (priceChanged) {
        ev.run(row.id, now, LISTING_CHANGED, row.declared_price_atomic, sel.amount, JSON.stringify({ lastUpdated: item.lastUpdated ?? null, previousLastUpdated: row.last_updated, fetchedAt: new Date(now).toISOString(), via: o.via }));
        changed.push(row.id);
      }
    }
  })();
  return { changed, seen };
}

/** Re-read one resource's Bazaar listing (and refresh its seller's other known entries on the way). Never throws. */
export async function refreshListing(db: Db, o: RefreshListingOptions): Promise<ListingRefreshResult> {
  const row = db
    .prepare("SELECT id, url, method, source, pay_to, declared_price_atomic, json_extract(raw_json, '$.lastUpdated') AS last_updated FROM resources WHERE id = ?")
    .get(o.resourceId) as ResourceRow | undefined;
  if (!row) return { status: "skipped", resourceId: o.resourceId, payTo: null, pages: 0, reason: "unknown resource" };
  if (!row.pay_to) return { status: "skipped", resourceId: row.id, payTo: null, pages: 0, reason: "no listed pay-to (not a Bazaar resource)" };
  const payTo = row.pay_to;
  const cache = o.cache ?? new ListingCache();
  const storedMs = parseMs(row.last_updated); // NaN: no snapshot time, read pages until found or exhausted
  const maxPages = o.maxPages ?? 5;
  let c = cache.get(payTo, o.now) ?? { fetchedAt: o.now, items: [], minLastUpdated: Infinity, nextOffset: 0, total: undefined, complete: false };
  let pagesFetched = 0;
  const previous = row.declared_price_atomic;

  const finish = (status: ListingRefreshStatus, extra: Partial<ListingRefreshResult> = {}): ListingRefreshResult => ({ status, resourceId: row.id, payTo, pages: pagesFetched, previousAmountAtomic: previous, ...extra });

  try {
    for (let page = 0; ; page++) {
      const hit = c.items.find((i) => i.resource === row.url && bazaarInput(i).method === row.method);
      if (hit) {
        applyListingItems(db, c.items, o.now, { via: "buy_refresh", ...(o.network ? { network: o.network } : {}) });
        const after = (db.prepare("SELECT declared_price_atomic FROM resources WHERE id = ?").get(row.id) as { declared_price_atomic: string | null }).declared_price_atomic;
        const sel = selectAccept(hit.accepts, o.network ?? MAINNET);
        if (!sel) return finish("not_listed", { reason: "entry has no Base exact option", ...(hit.lastUpdated ? { lastUpdated: hit.lastUpdated } : {}) });
        const r = finish(after !== previous ? "updated" : "unchanged", { amountAtomic: sel.amount, ...(hit.lastUpdated ? { lastUpdated: hit.lastUpdated } : {}) });
        if (r.status === "updated") o.log?.info(`listing refreshed: resource ${row.id} ${row.url} listed ${previous ?? "-"} -> ${sel.amount} (Bazaar lastUpdated ${hit.lastUpdated ?? "?"})`);
        return r;
      }
      // The target is not in what we have. Older than our snapshot already? Then nothing about it changed.
      if (Number.isFinite(storedMs) && c.minLastUpdated < storedMs) {
        applyListingItems(db, c.items, o.now, { via: "buy_refresh", ...(o.network ? { network: o.network } : {}) });
        return finish("unchanged", { ...(previous !== null ? { amountAtomic: previous } : {}), ...(row.last_updated ? { lastUpdated: row.last_updated } : {}) });
      }
      if (c.complete) {
        applyListingItems(db, c.items, o.now, { via: "buy_refresh", ...(o.network ? { network: o.network } : {}) });
        return finish("not_listed", { reason: "not among the pay-to's Bazaar entries" });
      }
      if (pagesFetched >= maxPages) {
        applyListingItems(db, c.items, o.now, { via: "buy_refresh", ...(o.network ? { network: o.network } : {}) });
        return finish("skipped", { reason: `not found in the ${c.items.length} most recently updated entries (${maxPages} pages); snapshot kept` });
      }
      const { items, total } = await fetchPage(o, payTo, c.nextOffset);
      pagesFetched++;
      const min = items.reduce((m, i) => Math.min(m, Number.isFinite(parseMs(i.lastUpdated)) ? parseMs(i.lastUpdated) : m), c.minLastUpdated);
      c = {
        fetchedAt: c.items.length ? c.fetchedAt : o.now,
        items: [...c.items, ...items],
        minLastUpdated: min,
        nextOffset: c.nextOffset + items.length,
        total,
        complete: items.length < MERCHANT_PAGE_SIZE || (typeof total === "number" && c.nextOffset + items.length >= total),
      };
      cache.set(payTo, c);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    o.log?.warn(`listing refresh failed for resource ${row.id} (${row.url}): ${reason}; snapshot kept`);
    return finish("error", { reason });
  }
}
