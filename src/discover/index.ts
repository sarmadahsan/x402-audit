/**
 * discover: build the seller/resource universe from CDP Bazaar (plus config/manual-sellers.yaml)
 * into the `sellers` and `resources` tables, and render the discover report.
 *
 * Where things live in real Bazaar items (smoke call 2026-10-23, limit=20, all 20 items):
 * - HTTP method: `extensions.bazaar.info.input.method` ("GET" | "POST"), next to
 *   `info.input.type` ("http"), `queryParams` / `body` / `bodyType` / `bodyFields`.
 *   We also accept the flatter `extensions.bazaar.input.method`; default "GET".
 * - Output description: `extensions.bazaar.info.output` ({ type, example }); the JSON Schema in
 *   `extensions.bazaar.schema` describes the *input/output descriptor*, not the response body.
 * - Some items also carry `extensions.bazaar.category` and `extensions.bazaar.tags`.
 * - accepts[] entries are v2 ({scheme, network CAIP-2, amount, asset, payTo, maxTimeoutSeconds, extra});
 *   a few sellers add v1-style `maxAmountRequired` alongside `amount`, and non-`exact` schemes
 *   (e.g. "batch-settlement") appear.
 */
import type { Db } from "../db/index.js";
import { isExcluded, MAINNET, type ExcludeConfig, type ManualResourceConfig } from "../config/index.js";
import { PaymentRequirementsSchema, V1_NETWORK_TO_CAIP2 } from "../x402/types.js";
import { fetchAllBazaarResources, type BazaarItem, type DiscoverLogger } from "./bazaar.js";
import { categorize, type CategoryRules } from "./categorize.js";

export { fetchAllBazaarResources, BazaarItemSchema, BAZAAR_RESOURCES_URL } from "./bazaar.js";
export type { BazaarItem, DiscoverLogger, FetchAllResult } from "./bazaar.js";
export { categorize, loadCategoryRules, CATEGORIES } from "./categorize.js";
export type { Category, CategoryResult, CategoryRules } from "./categorize.js";

const EXCLUDE_REASON_PREFIX = "exclude.yaml: ";

/** Seller key: lowercase hostname without a leading "www.". */
export function sellerDomain(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

/** CAIP-2 form of a network name (maps legacy v1 names such as "base"). */
export function toCaip2(network: string): string {
  return V1_NETWORK_TO_CAIP2[network] ?? network;
}

// v2 PaymentRequirements, relaxed only on maxTimeoutSeconds (some indexers omit it).
const SelectableAcceptSchema = PaymentRequirementsSchema.extend({
  maxTimeoutSeconds: PaymentRequirementsSchema.shape.maxTimeoutSeconds.optional(),
});

export interface SelectedAccept {
  index: number;
  scheme: "exact";
  network: string; // CAIP-2
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number | undefined;
  mimeType: string | undefined;
  description: string | undefined;
  transferMethod: "permit2" | "eip3009";
  raw: Record<string, unknown>;
}

/**
 * The accept we would buy with: the first entry with scheme "exact" on Base mainnet (CAIP-2
 * "eip155:8453" or legacy "base") that is well formed. v1 entries use maxAmountRequired.
 */
export function selectAccept(accepts: readonly Record<string, unknown>[] | undefined, network = MAINNET): SelectedAccept | null {
  if (!accepts) return null;
  for (let i = 0; i < accepts.length; i++) {
    const a = accepts[i]!;
    if (a.scheme !== "exact" || typeof a.network !== "string" || toCaip2(a.network) !== network) continue;
    const amount = typeof a.amount === "string" ? a.amount : typeof a.maxAmountRequired === "string" ? a.maxAmountRequired : undefined;
    const r = SelectableAcceptSchema.safeParse({ ...a, network, amount });
    if (!r.success || !/^\d+$/.test(r.data.amount)) continue;
    const extra = r.data.extra ?? undefined;
    return {
      index: i,
      scheme: "exact",
      network,
      amount: r.data.amount,
      asset: r.data.asset,
      payTo: r.data.payTo,
      maxTimeoutSeconds: r.data.maxTimeoutSeconds,
      mimeType: typeof a.mimeType === "string" ? a.mimeType : undefined,
      description: typeof a.description === "string" ? a.description : undefined,
      transferMethod: extra?.assetTransferMethod === "permit2" ? "permit2" : "eip3009",
      raw: a,
    };
  }
  return null;
}

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** The bazaar extension's input info and method (see header comment for where it lives). */
export function bazaarInput(item: Pick<BazaarItem, "extensions">): { method: string; input: Record<string, unknown> | undefined; output: unknown } {
  const bz = asRecord(item.extensions?.bazaar);
  const info = asRecord(bz?.info);
  const input = asRecord(info?.input) ?? asRecord(bz?.input);
  const m = input?.method;
  const method = typeof m === "string" && m.trim() ? m.trim().toUpperCase() : "GET";
  return { method, input, output: info?.output ?? bz?.output };
}

function bazaarExtraTags(item: Pick<BazaarItem, "extensions">): string[] {
  const bz = asRecord(item.extensions?.bazaar);
  const out: string[] = [];
  if (typeof bz?.category === "string") out.push(bz.category);
  if (Array.isArray(bz?.tags)) for (const t of bz.tags) if (typeof t === "string") out.push(t);
  return out;
}

const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
const msOrNull = (s: string | undefined): number | null => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : null;
};

// ------------------------------------------------------------------ upsert helpers

const RESOURCE_COLS = [
  "seller_id", "url", "method", "source", "x402_version", "scheme", "network", "asset", "declared_price_atomic",
  "pay_to", "description", "mime_type", "max_timeout_seconds", "output_schema_json", "input_json", "transfer_method",
  "service_name", "tags_json", "curated", "bazaar_calls_30d", "bazaar_unique_payers_30d", "last_called_at",
  "accepts_json", "category", "category_reason", "raw_json", "first_seen_at", "last_seen_at",
] as const;
type ResourceRow = Record<(typeof RESOURCE_COLS)[number], string | number | null>;
const KEY_COLS = new Set(["url", "method", "source", "first_seen_at"]);

function prepare(db: Db) {
  const updates = RESOURCE_COLS.filter((c) => !KEY_COLS.has(c)).map((c) => `${c} = excluded.${c}`).join(", ");
  return {
    findSeller: db.prepare<[string], { id: number }>("SELECT id FROM sellers WHERE domain = ?"),
    insertSeller: db.prepare("INSERT INTO sellers (domain, first_seen_at, last_seen_at) VALUES (?, ?, ?)"),
    touchSeller: db.prepare("UPDATE sellers SET last_seen_at = MAX(last_seen_at, ?) WHERE id = ?"),
    findResource: db.prepare<[string, string, string], { id: number }>("SELECT id FROM resources WHERE url = ? AND method = ? AND source = ?"),
    upsertResource: db.prepare(
      `INSERT INTO resources (${RESOURCE_COLS.join(", ")}) VALUES (${RESOURCE_COLS.map((c) => "@" + c).join(", ")})
       ON CONFLICT (url, method, source) DO UPDATE SET ${updates}`,
    ),
  };
}
type Stmts = ReturnType<typeof prepare>;

interface SellerTally {
  newIds: Set<number>;
  seenIds: Set<number>;
}
function upsertSeller(s: Stmts, domain: string, now: number, tally: SellerTally): number {
  const found = s.findSeller.get(domain);
  if (found) {
    s.touchSeller.run(now, found.id);
    if (!tally.newIds.has(found.id)) tally.seenIds.add(found.id);
    return found.id;
  }
  const id = Number(s.insertSeller.run(domain, now, now).lastInsertRowid);
  tally.newIds.add(id);
  return id;
}

/** Recompute sellers.calls_30d_bazaar (Base-exact resources only) and sellers.category (modal). */
export function refreshSellerAggregates(db: Db): void {
  db.prepare(
    `UPDATE sellers SET calls_30d_bazaar = (
       SELECT SUM(r.bazaar_calls_30d) FROM resources r
       WHERE r.seller_id = sellers.id AND r.scheme = 'exact' AND r.network = ?)`,
  ).run(MAINNET);
  const rows = db
    .prepare<[], { seller_id: number; category: string; n: number; calls: number }>(
      `SELECT seller_id, category, COUNT(*) AS n, COALESCE(SUM(bazaar_calls_30d), 0) AS calls
       FROM resources WHERE category IS NOT NULL GROUP BY seller_id, category`,
    )
    .all();
  // Mode by resource count; ties broken by 30-day calls, then name, so the result is deterministic.
  const best = new Map<number, { category: string; n: number; calls: number }>();
  for (const r of rows) {
    const b = best.get(r.seller_id);
    if (!b || r.n > b.n || (r.n === b.n && (r.calls > b.calls || (r.calls === b.calls && r.category < b.category)))) best.set(r.seller_id, r);
  }
  const upd = db.prepare("UPDATE sellers SET category = ? WHERE id = ?");
  for (const [id, b] of best) upd.run(b.category, id);
}

/**
 * Apply config/exclude.yaml to sellers: excluded=1 with a reason for domain matches, and for sellers
 * whose every resource matches a resource_prefixes entry. Never deletes. Clears exclusions this
 * function set earlier (reason prefixed "exclude.yaml: ") that no longer match; leaves others alone.
 * Returns the number of sellers excluded.
 */
export function applyExclusions(db: Db, exclude: ExcludeConfig): number {
  const sellers = db.prepare<[], { id: number; domain: string; excluded: number; excluded_reason: string | null }>(
    "SELECT id, domain, excluded, excluded_reason FROM sellers",
  ).all();
  const urlsOf = db.prepare<[number], { url: string }>("SELECT url FROM resources WHERE seller_id = ?");
  const set = db.prepare("UPDATE sellers SET excluded = ?, excluded_reason = ? WHERE id = ?");
  let n = 0;
  for (const s of sellers) {
    let reason = isExcluded(exclude, s.domain);
    if (!reason && exclude.resource_prefixes.length > 0) {
      const urls = urlsOf.all(s.id).map((r) => r.url);
      const reasons = urls.map((u) => isExcluded({ sellers: [], resource_prefixes: exclude.resource_prefixes }, s.domain, u));
      if (urls.length > 0 && reasons.every((r) => r)) reason = reasons[0]!;
    }
    if (reason) {
      set.run(1, EXCLUDE_REASON_PREFIX + reason, s.id);
      n++;
    } else if (s.excluded && s.excluded_reason?.startsWith(EXCLUDE_REASON_PREFIX)) {
      set.run(0, null, s.id);
    }
  }
  return n;
}

// ------------------------------------------------------------------ bazaar

export interface BazaarUpsertStats {
  sellersNew: number;
  sellersSeen: number;
  resourcesNew: number;
  resourcesSeen: number;
  /** Items with no well-formed exact accept on Base mainnet (stored, but scheme/price/payTo left NULL). */
  skippedNoBaseExact: number;
  /** Items whose selected accept uses extra.assetTransferMethod = "permit2". */
  permit2: number;
  excludedSellers: number;
}

export interface UpsertOptions {
  exclude?: ExcludeConfig;
  rules?: CategoryRules;
}

export function upsertFromBazaar(db: Db, items: readonly BazaarItem[], now: number, opts: UpsertOptions = {}): BazaarUpsertStats {
  const s = prepare(db);
  const tally: SellerTally = { newIds: new Set(), seenIds: new Set() };
  const stats: BazaarUpsertStats = { sellersNew: 0, sellersSeen: 0, resourcesNew: 0, resourcesSeen: 0, skippedNoBaseExact: 0, permit2: 0, excludedSellers: 0 };

  db.transaction(() => {
    for (const item of items) {
      const domain = sellerDomain(item.resource);
      const sellerId = upsertSeller(s, domain, now, tally);
      const sel = selectAccept(item.accepts);
      const { method, input, output } = bazaarInput(item);
      if (!sel) stats.skippedNoBaseExact++;
      else if (sel.transferMethod === "permit2") stats.permit2++;
      const firstNet = item.accepts?.find((a) => typeof a.network === "string")?.network as string | undefined;
      const description = item.description ?? sel?.description ?? null;
      const cat = categorize({ tags: [...(item.tags ?? []), ...bazaarExtraTags(item)], serviceName: item.serviceName, description: description ?? undefined, url: item.resource }, opts.rules);
      const v1OutputSchema = sel?.raw.outputSchema;
      const row: ResourceRow = {
        seller_id: sellerId,
        url: item.resource,
        method,
        source: "bazaar",
        x402_version: item.x402Version,
        scheme: sel ? sel.scheme : null,
        network: sel ? sel.network : firstNet ? toCaip2(firstNet) : null,
        asset: sel?.asset ?? null,
        declared_price_atomic: sel?.amount ?? null,
        pay_to: sel?.payTo ?? null,
        description,
        mime_type: item.mimeType ?? sel?.mimeType ?? null,
        max_timeout_seconds: sel?.maxTimeoutSeconds ?? null,
        // bazaar.info.output ({type, example}); v1 accepts carried outputSchema directly.
        output_schema_json: json(output ?? v1OutputSchema),
        input_json: json(input),
        transfer_method: sel ? sel.transferMethod : null,
        service_name: item.serviceName ?? null,
        tags_json: json(item.tags),
        curated: item.curated ? 1 : 0,
        bazaar_calls_30d: item.quality?.l30DaysTotalCalls ?? null,
        bazaar_unique_payers_30d: item.quality?.l30DaysUniquePayers ?? null,
        last_called_at: msOrNull(item.quality?.lastCalledAt),
        accepts_json: json((item.raw as { accepts?: unknown } | null)?.accepts ?? item.accepts ?? []),
        category: cat.category,
        category_reason: cat.reason,
        raw_json: JSON.stringify(item.raw),
        first_seen_at: now,
        last_seen_at: now,
      };
      if (s.findResource.get(row.url as string, method, "bazaar")) stats.resourcesSeen++;
      else stats.resourcesNew++;
      s.upsertResource.run(row);
    }
    refreshSellerAggregates(db);
    if (opts.exclude) stats.excludedSellers = applyExclusions(db, opts.exclude);
  })();

  stats.sellersNew = tally.newIds.size;
  stats.sellersSeen = tally.seenIds.size;
  return stats;
}

// ------------------------------------------------------------------ manual

export interface ManualUpsertStats {
  sellersNew: number;
  sellersSeen: number;
  resourcesNew: number;
  resourcesSeen: number;
  excludedSellers: number;
}

/**
 * Upsert config/manual-sellers.yaml entries with source 'manual'. scheme is left NULL: the yaml does
 * not state it, and probe reads the real requirements from the 402.
 */
export function upsertManual(db: Db, manual: readonly ManualResourceConfig[], now: number, opts: { exclude?: ExcludeConfig } = {}): ManualUpsertStats {
  const s = prepare(db);
  const tally: SellerTally = { newIds: new Set(), seenIds: new Set() };
  const stats: ManualUpsertStats = { sellersNew: 0, sellersSeen: 0, resourcesNew: 0, resourcesSeen: 0, excludedSellers: 0 };
  db.transaction(() => {
    for (const m of manual) {
      const domain = m.seller_domain.toLowerCase().replace(/^www\./, "");
      const sellerId = upsertSeller(s, domain, now, tally);
      const method = m.method.toUpperCase();
      const row: ResourceRow = {
        seller_id: sellerId,
        url: m.url,
        method,
        source: "manual",
        x402_version: null,
        scheme: null,
        network: m.network ? toCaip2(m.network) : null,
        asset: m.asset ?? null,
        declared_price_atomic: m.declared_price_atomic ?? null,
        pay_to: m.pay_to ?? null,
        description: m.description || null,
        mime_type: null,
        max_timeout_seconds: null,
        output_schema_json: null,
        input_json: null,
        transfer_method: null,
        service_name: null,
        tags_json: null,
        curated: 0,
        bazaar_calls_30d: null,
        bazaar_unique_payers_30d: null,
        last_called_at: null,
        accepts_json: null,
        category: m.category,
        category_reason: "manual",
        raw_json: JSON.stringify(m),
        first_seen_at: now,
        last_seen_at: now,
      };
      if (s.findResource.get(m.url, method, "manual")) stats.resourcesSeen++;
      else stats.resourcesNew++;
      s.upsertResource.run(row);
    }
    refreshSellerAggregates(db);
    if (opts.exclude) stats.excludedSellers = applyExclusions(db, opts.exclude);
  })();
  stats.sellersNew = tally.newIds.size;
  stats.sellersSeen = tally.seenIds.size;
  return stats;
}

// ------------------------------------------------------------------ run

export interface DiscoverStats {
  startedAt: number;
  finishedAt: number;
  bazaar: BazaarUpsertStats & { pages: number; totalReported: number; received: number; rejected: number; duplicates: number; unique: number };
  manual: ManualUpsertStats;
}

export interface RunDiscoverOptions {
  fetchImpl?: typeof fetch;
  manual: readonly ManualResourceConfig[];
  exclude: ExcludeConfig;
  log: DiscoverLogger;
  now?: () => number;
  rules?: CategoryRules;
  pageSize?: number;
  throttleMs?: number;
  retryDelaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
}

export async function runDiscover(db: Db, opts: RunDiscoverOptions): Promise<DiscoverStats> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const fetched = await fetchAllBazaarResources({
    log: opts.log,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
    ...(opts.throttleMs !== undefined ? { throttleMs: opts.throttleMs } : {}),
    ...(opts.retryDelaysMs ? { retryDelaysMs: opts.retryDelaysMs } : {}),
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    onPage: (p) => opts.log.info(`bazaar page ${p.page}: offset ${p.offset}, ${p.received} items (total ${p.total ?? "?"})`),
  });
  const ts = now();
  const b = upsertFromBazaar(db, fetched.items, ts, { exclude: opts.exclude, ...(opts.rules ? { rules: opts.rules } : {}) });
  const m = upsertManual(db, opts.manual, ts, { exclude: opts.exclude });
  const stats: DiscoverStats = {
    startedAt,
    finishedAt: now(),
    bazaar: { ...b, pages: fetched.pages, totalReported: fetched.totalReported, received: fetched.received, rejected: fetched.rejected, duplicates: fetched.duplicates, unique: fetched.items.length },
    manual: m,
  };
  const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    setMeta.run("discover_last_run_at", String(ts));
    setMeta.run("discover_last_total", String(fetched.totalReported));
    setMeta.run("discover_last_stats", JSON.stringify(stats));
  })();
  opts.log.info("discover done", stats);
  return stats;
}

// ------------------------------------------------------------------ report

/** Atomic USDC (6 dp) to "$1,234.57" (half-up to cents). */
export function formatUsd(atomic: string | bigint | null | undefined): string {
  if (atomic === null || atomic === undefined || atomic === "") return "";
  const a = BigInt(atomic);
  const cents = (a + 5000n) / 10000n;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `$${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

const fmtInt = (n: number | null | undefined): string => (n === null || n === undefined ? "" : n.toLocaleString("en-US"));
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function discoverReport(db: Db, opts: { top?: number } = {}): string {
  const top = opts.top ?? 100;
  const one = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;
  const all = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];

  const hasVolume = one<{ n: number }>("SELECT COUNT(*) AS n FROM sellers WHERE volume_30d_atomic IS NOT NULL").n > 0;
  const order = hasVolume
    ? "s.volume_30d_atomic IS NULL, CAST(s.volume_30d_atomic AS INTEGER) DESC, s.calls_30d_bazaar IS NULL, s.calls_30d_bazaar DESC, s.domain"
    : "s.calls_30d_bazaar IS NULL, s.calls_30d_bazaar DESC, s.domain";
  const rows = all<{
    domain: string; category: string | null; volume_30d_atomic: string | null; volume_30d_calls: number | null;
    calls_30d_bazaar: number | null; base_exact: number; payto: number; excluded: number; excluded_reason: string | null;
  }>(
    `SELECT s.domain, s.category, s.volume_30d_atomic, s.volume_30d_calls, s.calls_30d_bazaar, s.excluded, s.excluded_reason,
       (SELECT COUNT(*) FROM resources r WHERE r.seller_id = s.id AND r.scheme = 'exact' AND r.network = @net) AS base_exact,
       (SELECT COUNT(DISTINCT lower(r.pay_to)) FROM resources r WHERE r.seller_id = s.id AND r.scheme = 'exact' AND r.network = @net) AS payto
     FROM sellers s ORDER BY ${order} LIMIT @top`,
    { net: MAINNET, top },
  );

  const lastRun = one<{ value: string } | undefined>("SELECT value FROM meta WHERE key = 'discover_last_run_at'");
  const lastTotal = one<{ value: string } | undefined>("SELECT value FROM meta WHERE key = 'discover_last_total'");
  const out: string[] = [];
  out.push(`# discover report`, "");
  if (lastRun) out.push(`Last discover run: ${new Date(Number(lastRun.value)).toISOString()}${lastTotal ? ` (Bazaar reported total ${Number(lastTotal.value).toLocaleString("en-US")})` : ""}.`, "");
  out.push(
    hasVolume
      ? `## Top ${top} sellers by 30-day USDC volume on Base`
      : `## Top ${top} sellers by Bazaar 30-day calls (fallback: 30-day USDC volume is not computed yet for any seller; run the chain module to rank by volume)`,
    "",
  );

  out.push("| rank | domain | category | 30d USDC volume | 30d transfers | bazaar 30d calls | #resources (Base exact) | #distinct payTo | excluded? |");
  out.push("|---:|---|---|---:|---:|---:|---:|---:|---|");
  rows.forEach((r, i) => {
    out.push(
      `| ${i + 1} | ${cell(r.domain)} | ${r.category ?? ""} | ${formatUsd(r.volume_30d_atomic)} | ${fmtInt(r.volume_30d_calls)} | ${fmtInt(r.calls_30d_bazaar)} | ${r.base_exact} | ${r.payto} | ${r.excluded ? `yes (${cell(r.excluded_reason ?? "")})` : ""} |`,
    );
  });

  const totalRes = one<{ n: number }>("SELECT COUNT(*) AS n FROM resources").n;
  const byNet = all<{ network: string | null; n: number }>("SELECT network, COUNT(*) AS n FROM resources GROUP BY network ORDER BY n DESC, network LIMIT 8");
  const baseExact = one<{ n: number }>("SELECT COUNT(*) AS n FROM resources WHERE scheme = 'exact' AND network = ?", MAINNET).n;
  const permit2 = one<{ n: number }>("SELECT COUNT(*) AS n FROM resources WHERE transfer_method = 'permit2'").n;
  const sellersTotal = one<{ n: number }>("SELECT COUNT(*) AS n FROM sellers").n;
  const sellersBase = one<{ n: number }>(
    "SELECT COUNT(DISTINCT seller_id) AS n FROM resources WHERE scheme = 'exact' AND network = ?",
    MAINNET,
  ).n;
  const sellersExcluded = one<{ n: number }>("SELECT COUNT(*) AS n FROM sellers WHERE excluded = 1").n;
  const byCat = all<{ category: string | null; n: number }>("SELECT category, COUNT(*) AS n FROM resources GROUP BY category ORDER BY n DESC, category");
  const bySource = new Map(all<{ source: string; n: number }>("SELECT source, COUNT(*) AS n FROM resources GROUP BY source").map((r) => [r.source, r.n]));

  out.push("", "## Summary", "");
  out.push(`- Resources: ${fmtInt(totalRes)}`);
  out.push(`- Resources by network (top 8, network of the selected Base-exact accept, else the first accept): ${byNet.map((r) => `${r.network ?? "(none)"} ${fmtInt(r.n)}`).join(", ") || "none"}`);
  out.push(`- Base-exact resources (scheme exact on ${MAINNET}): ${fmtInt(baseExact)}`);
  out.push(`- Base-exact resources using permit2 (not bought; no EIP-3009 AuthorizationUsed): ${fmtInt(permit2)}`);
  out.push(`- Sellers: ${fmtInt(sellersTotal)} (with >= 1 Base-exact resource: ${fmtInt(sellersBase)}; excluded: ${fmtInt(sellersExcluded)})`);
  out.push(`- Resources by category: ${byCat.map((r) => `${r.category ?? "(none)"} ${fmtInt(r.n)}`).join(", ") || "none"}`);
  out.push(
    `- Sources: bazaar ${fmtInt(bySource.get("bazaar") ?? 0)}, manual ${fmtInt(bySource.get("manual") ?? 0)}, x402scan ${fmtInt(bySource.get("x402scan") ?? 0)} (x402scan API is paid per call; not used in discover, see docs/protocol-notes.md)`,
  );
  out.push("");
  return out.join("\n");
}

// ------------------------------------------------------------------ pay-to list for chain

export interface PayToRow {
  /** Lowercased address (pay_to compared case-insensitively). */
  payTo: string;
  sellerIds: number[];
  resourceCount: number;
  bazaarCalls: number;
}

/**
 * Distinct pay-to addresses on `network` (bazaar rows only carry pay_to when a Base-exact accept was
 * selected; manual rows carry it when the yaml gives one), with aggregate Bazaar 30-day calls, busiest first. */
export function listPayTos(db: Db, opts: { network?: string; minBazaarCalls?: number } = {}): PayToRow[] {
  const network = opts.network ?? MAINNET;
  const min = opts.minBazaarCalls ?? 0;
  const rows = db
    .prepare<[string, number], { pay_to: string; seller_ids: string; n: number; calls: number }>(
      `SELECT lower(pay_to) AS pay_to, group_concat(DISTINCT seller_id) AS seller_ids, COUNT(*) AS n,
              COALESCE(SUM(bazaar_calls_30d), 0) AS calls
       FROM resources WHERE network = ? AND pay_to IS NOT NULL AND pay_to <> ''
       GROUP BY lower(pay_to) HAVING calls >= ? ORDER BY calls DESC, pay_to`,
    )
    .all(network, min);
  return rows.map((r) => ({
    payTo: r.pay_to,
    sellerIds: r.seller_ids.split(",").map(Number).sort((a, b) => a - b),
    resourceCount: r.n,
    bazaarCalls: r.calls,
  }));
}
