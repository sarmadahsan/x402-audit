/**
 * `export`: the public, machine-readable twin of the report, written to public-data/.
 * Fast and hacky by request. Every rate comes from the same named queries and Wilson code as the report
 * (src/report/queries.ts, src/report/compute.ts); nothing here re-derives the methodology.
 * Never writes request bodies, response bodies, validator evidence, or our wallet addresses.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicToUsd, MAINNET } from "../config/index.js";
import type { Db } from "../db/index.js";
import { computeReport, countRate, dollarRate, modeOf } from "../report/compute.js";
import { runQuery, type QueryParams } from "../report/queries.js";
import { probeReport } from "../probe/report.js";
import { stressReport } from "../stress/index.js";
import { AUDIT_SOURCES, HEADLINE_FAILURE_OUTCOMES } from "../taxonomy.js";

export const SELLER_MIN_CALLS = 30;
export const SELLER_LOW_SAMPLE_MIN_CALLS = 5;
export const RESOURCE_MIN_CALLS = 10;
export const EVIDENCE_PER_SELLER = 25;
const FAILURE_TYPES = ["non_delivery", "overcharge", "duplicate", "wrong_goods"] as const;

export interface ExportOptions { network: string; now: number; outDir: string; gitCommit?: string | null }

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const big = (v: unknown): bigint => (v == null || v === "" ? 0n : BigInt(String(v)));
const iso = (ms: number | null | undefined): string | null => (ms ? new Date(ms).toISOString() : null);
const usdc = (atomic: unknown): string | null => (atomic != null && /^\d+$/.test(String(atomic)) ? atomicToUsd(String(atomic)) : null);
const round = (x: number, d = 6): number => Math.round(x * 10 ** d) / 10 ** d;

/** Registrable-domain approximation: lowercase, no port, no "www.", last two labels, or three under a known shared suffix. */
const SHARED_SUFFIXES = ["workers.dev", "pages.dev", "vercel.app", "up.railway.app", "railway.app", "netlify.app", "onrender.com", "herokuapp.com", "fly.dev", "replit.app", "deno.dev", "github.io", "ngrok-free.app", "ngrok.app", "azurewebsites.net", "appspot.com", "web.app", "firebaseapp.com", "co.uk", "com.au", "co.jp", "com.br"];
export function canonicalDomain(domain: string): string {
  const d = domain.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\./, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(d)) return d;
  const suffix = SHARED_SUFFIXES.filter((s) => d === s || d.endsWith(`.${s}`)).sort((a, b) => b.length - a.length)[0];
  const keep = suffix ? suffix.split(".").length + 1 : 2;
  return d.split(".").slice(-keep).join(".");
}

function medianOf(hist: { value: bigint; n: number }[]): bigint | null {
  const total = hist.reduce((a, h) => a + h.n, 0);
  if (!total) return null;
  const sorted = [...hist].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  // Lower median for an even count, so the result is always a price somebody actually quoted.
  let k = Math.floor((total - 1) / 2);
  for (const h of sorted) {
    if (k < h.n) return h.value;
    k -= h.n;
  }
  return null;
}

/** Markdown tables and "- key: value" bullets from a report, grouped by heading. */
export function markdownTables(md: string): { summary: Record<string, string>; sections: { heading: string; rows: Record<string, string>[] }[] } {
  const clean = (s: string) => s.trim().replace(/\*\*/g, "").replace(/`/g, "");
  const lines = md.split("\n");
  const summary: Record<string, string> = {};
  const sections: { heading: string; rows: Record<string, string>[] }[] = [];
  let heading = "";
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^#{1,6} /.test(l)) { heading = l.replace(/^#+ /, "").trim(); continue; }
    const kv = /^- ([^:]+): (.*)$/.exec(l);
    if (kv && !heading.startsWith("Per") && sections.length === 0) { summary[clean(kv[1]!)] = clean(kv[2]!); continue; }
    if (l.startsWith("|") && lines[i + 1]?.startsWith("|---")) {
      const split = (row: string) => row.replace(/^\|/, "").replace(/\|$/, "").split("|").map(clean);
      const header = split(l);
      const rows: Record<string, string>[] = [];
      i += 2;
      for (; i < lines.length && lines[i]!.startsWith("|"); i++) {
        const cells = split(lines[i]!);
        if (cells[0] === "(none)") continue;
        rows.push(Object.fromEntries(header.map((h, j) => [h, cells[j] ?? ""])));
      }
      i--;
      sections.push({ heading, rows });
    }
  }
  return { summary, sections };
}

export function runExport(db: Db, o: ExportOptions): { files: string[]; sellers: number; lowSample: number; resources: number; evidenceFiles: number } {
  const now = o.now;
  const base: QueryParams = { since: 0, until: now, network: o.network };
  const q = <T>(name: Parameters<typeof runQuery>[1], extra: QueryParams = {}) => runQuery<T>(db, name, { ...base, ...extra });
  const report = computeReport(db, { network: o.network, now });
  const generatedAt = new Date(now).toISOString();
  const gitCommit = o.gitCommit !== undefined ? o.gitCommit : report.reproducibility.git_commit;
  const header = { generated_at: generatedAt, network: o.network, git_commit: gitCommit };

  // ------------------------------------------------------------ summary.json
  const reached = q<{ sellers: number; resources: number }>("buy_reached")[0];
  const runs = q<{ subcommand: string; started_at: number; finished_at: number | null; status: string | null; last_activity: number | null }>("last_runs");
  const lastRun = (sub: string) => {
    const r = runs.find((x) => x.subcommand === sub);
    return r ? { started_at: iso(num(r.started_at)), finished_at: iso(r.finished_at == null ? null : num(r.finished_at)), status: r.status, last_activity: iso(r.last_activity == null ? null : num(r.last_activity)) } : null;
  };
  const h = report.headline;
  const summary = {
    ...header,
    last_updated: generatedAt,
    last_buy_run: lastRun("buy run"),
    last_probe_run: lastRun("probe run"),
    study_window: { first_call: report.meta.date_range.first_call, last_call: report.meta.date_range.last_call },
    denominator_paid_calls: h.count.n,
    count_weighted: { failures: h.count.failures, rate: h.count.rate, wilson_low: h.count.lo, wilson_high: h.count.hi },
    dollar_weighted: {
      denominator_usdc: atomicToUsd(h.dollar.total_atomic),
      failed_usdc: atomicToUsd(h.dollar.failed_atomic),
      rate: h.dollar.rate,
      wilson_low: h.dollar.lo,
      wilson_high: h.dollar.hi,
      effective_n: round(h.dollar.effective_n, 1),
      interval_note: h.dollar.note,
    },
    failures_by_type: report.by_failure_type.map((f) => ({ outcome: f.outcome, n: f.n, share_of_calls: f.share_of_calls, share_of_failures: f.share_of_failures, usdc: atomicToUsd(f.dollars_atomic), resolved_late: f.resolved_late })),
    sellers_reached: num(reached?.sellers),
    resources_reached: num(reached?.resources),
    sellers_with_min_calls: null as number | null,
    usdc_spent: atomicToUsd(report.meta.spend_by_source.reduce((a, s) => a + big(s.settled_atomic), 0n)),
    usdc_signed: report.meta.spend_usdc,
    usdc_spent_by_source: report.meta.spend_by_source.map((s) => ({ source: s.source, paid_calls: s.paid_calls, spent_usdc: s.spent_usdc, settled_usdc: s.settled_usdc })),
    outside_denominator: { our_error: h.excluded.our_error, indeterminate: h.excluded.indeterminate, not_paid: h.excluded.not_paid, unclassified: h.excluded.unclassified, unpaid_overcharge: h.excluded.unpaid_overcharge, unpaid_overcharge_exposure_usdc: atomicToUsd(h.excluded.exposure_atomic) },
    flagged_injection: h.flagged.injection,
    overcharge_sensitivity: h.sensitivity.map((r) => ({ min_ratio: r.min_ratio, overcharge_kept: r.overcharge_kept, overcharge_dropped: r.overcharge_dropped, rate: r.count.rate, wilson_low: r.count.lo, wilson_high: r.count.hi, dollar_rate: r.dollar_rate })),
    by_tier: report.by_tier.map((g) => ({ tier: g.key, n: g.n, failures: g.failures, rate: g.count.rate, wilson_low: g.count.lo, wilson_high: g.count.hi, dollar_rate: g.dollar.rate })),
    by_category: report.by_category.map((g) => ({ category: g.key, n: g.n, failures: g.failures, rate: g.count.rate, wilson_low: g.count.lo, wilson_high: g.count.hi, dollar_rate: g.dollar.rate })),
    audit_purchases: Object.fromEntries(
      AUDIT_SOURCES.map((src) => {
        const r = q<{ source: string; paid_calls: number; sellers: number }>("audit_purchases_by_source").find((x) => x.source === src);
        return [src, { paid_calls: num(r?.paid_calls), sellers: num(r?.sellers) }];
      }),
    ) as Record<string, { paid_calls: number; sellers: number }>,
  };

  // ------------------------------------------------------------ sellers.json
  type RateAgg = { n: number; failures: number; w_sum: string; w_failed: string; w_sumsq: number };
  const sellerRates = q<RateAgg & { seller_id: number }>("buy_sellers_min_calls", { min_calls: SELLER_LOW_SAMPLE_MIN_CALLS });
  const ftRows = q<{ seller_id: number; outcome: string; n: number }>("buy_seller_failure_types");
  const quoteRows = q<{ seller_id: number; resource_id: number; quote_atomic: string; n: number }>("buy_denominator_quotes");
  const meta = new Map(q<{ seller_id: number; domain: string; tier: string | null; category: string | null; volume_30d_atomic: string | null; volume_30d_source: string | null; volume_30d_computed_at: number | null; bazaar_listings: number; last_seen_ts: number }>("seller_meta").map((m) => [num(m.seller_id), m]));
  const payTos = new Map<number, string[]>();
  for (const r of q<{ seller_id: number; pay_to: string }>("seller_pay_tos")) {
    const l = payTos.get(num(r.seller_id)) ?? [];
    l.push(r.pay_to);
    payTos.set(num(r.seller_id), l);
  }
  const typesOf = (rows: { outcome: string; n: number }[]) => Object.fromEntries(FAILURE_TYPES.map((t) => [t, num(rows.find((r) => r.outcome === t)?.n)]));
  const histBy = <K>(key: (r: (typeof quoteRows)[number]) => K) => {
    const m = new Map<K, { value: bigint; n: number }[]>();
    for (const r of quoteRows) {
      const l = m.get(key(r)) ?? [];
      l.push({ value: big(r.quote_atomic), n: num(r.n) });
      m.set(key(r), l);
    }
    return m;
  };
  const sellerHist = histBy((r) => num(r.seller_id));
  const auditBySeller = new Map<number, Record<string, number>>();
  for (const r of q<{ seller_id: number; source: string; paid_calls: number }>("audit_purchases_by_seller")) {
    const m = auditBySeller.get(num(r.seller_id)) ?? {};
    m[r.source] = num(r.paid_calls);
    auditBySeller.set(num(r.seller_id), m);
  }
  const candidateSellers = new Map(q<{ seller_id: number; imported_at: number; checks: number; payments: number }>("candidate_sellers").map((r) => [num(r.seller_id), r]));

  const sellerRows = sellerRates.map((r) => {
    const id = num(r.seller_id);
    const m = meta.get(id)!;
    const c = countRate(num(r.failures), num(r.n));
    const d = dollarRate(big(r.w_sum), big(r.w_failed), num(r.w_sumsq));
    const median = medianOf(sellerHist.get(id) ?? []);
    return {
      seller_id: id,
      domain: m.domain,
      canonical_domain: canonicalDomain(m.domain),
      tier: m.tier,
      category: m.category,
      denominator_calls: c.n,
      failures: c.failures,
      failure_rate: c.rate,
      wilson_low: c.lo,
      wilson_high: c.hi,
      failures_by_type: typesOf(ftRows.filter((x) => num(x.seller_id) === id)),
      dollar_weighted_rate: d.rate,
      median_quote_usdc: median == null ? null : atomicToUsd(median),
      last_seen: iso(num(m.last_seen_ts)),
      onchain_inflow_30d_usdc: m.volume_30d_source === "chain" ? usdc(m.volume_30d_atomic) : null,
      onchain_inflow_computed_at: m.volume_30d_source === "chain" ? iso(num(m.volume_30d_computed_at)) : null,
      pay_to_addresses: payTos.get(id) ?? [],
      bazaar_listing_count: num(m.bazaar_listings),
      audit_purchases: Object.values(auditBySeller.get(id) ?? {}).reduce((a, n) => a + n, 0),
      audit_purchases_by_source: Object.fromEntries(AUDIT_SOURCES.map((src) => [src, auditBySeller.get(id)?.[src] ?? 0])),
      ...(() => {
        const c = candidateSellers.get(id);
        return c
          ? { source: "user" as const, entered_at: iso(num(c.imported_at)), entered_after_checks: num(c.checks), entered_after_payments: num(c.payments) }
          : { source: "discovery" as const };
      })(),
    };
  });
  const bySort = (a: (typeof sellerRows)[number], b: (typeof sellerRows)[number]) => b.failure_rate - a.failure_rate || b.denominator_calls - a.denominator_calls || a.domain.localeCompare(b.domain);
  const main = sellerRows.filter((s) => s.denominator_calls >= SELLER_MIN_CALLS).sort(bySort);
  const low = sellerRows.filter((s) => s.denominator_calls < SELLER_MIN_CALLS).sort(bySort).map((s) => ({ ...s, low_sample: true }));
  summary.sellers_with_min_calls = main.length;
  const sellersJson = { ...header, min_calls: SELLER_MIN_CALLS, low_sample_min_calls: SELLER_LOW_SAMPLE_MIN_CALLS, sellers: main, low_sample: low };

  // ---------------------------------------------------------- resources.json
  const resRates = q<RateAgg & { resource_id: number }>("buy_resources_min_calls", { min_calls: RESOURCE_MIN_CALLS });
  const resFt = q<{ resource_id: number; outcome: string; n: number }>("buy_resource_failure_types");
  const resMeta = new Map(q<{ resource_id: number; url: string; method: string; domain: string; listed_atomic: string | null }>("resource_meta").map((r) => [num(r.resource_id), r]));
  const resHist = histBy((r) => num(r.resource_id));
  const resources = resRates
    .map((r) => {
      const id = num(r.resource_id);
      const m = resMeta.get(id)!;
      const hist = resHist.get(id) ?? [];
      const mode = modeOf(hist);
      const max = hist.reduce<bigint | null>((a, x) => (a == null || x.value > a ? x.value : a), null);
      const listed = m.listed_atomic && /^\d+$/.test(m.listed_atomic) ? BigInt(m.listed_atomic) : null;
      const c = countRate(num(r.failures), num(r.n));
      return {
        url: m.url,
        method: m.method,
        seller: m.domain,
        listed_price_usdc: listed == null ? null : atomicToUsd(listed),
        modal_quote_usdc: mode == null ? null : atomicToUsd(mode),
        max_quote_usdc: max == null ? null : atomicToUsd(max),
        overcharge_ratio: listed && max != null ? round(Number(max) / Number(listed), 4) : null,
        calls: c.n,
        failures: c.failures,
        failure_rate: c.rate,
        wilson_low: c.lo,
        wilson_high: c.hi,
        failures_by_type: typesOf(resFt.filter((x) => num(x.resource_id) === id)),
      };
    })
    .sort((a, b) => b.failure_rate - a.failure_rate || b.calls - a.calls || a.url.localeCompare(b.url));
  const resourcesJson = { ...header, min_calls: RESOURCE_MIN_CALLS, resources };

  // ------------------------------------------------------------ evidence/
  const explorer = o.network === MAINNET ? "https://basescan.org/tx/" : "https://sepolia.basescan.org/tx/";
  const vf = new Map<number, { validator: string; reason: string | null }[]>();
  for (const v of q<{ call_id: number; validator: string; reason: string | null }>("validator_failures")) {
    const l = vf.get(num(v.call_id)) ?? [];
    l.push({ validator: v.validator, reason: v.reason });
    vf.set(num(v.call_id), l);
  }
  const samples = new Map<number, unknown[]>();
  for (const s of q<{ call_id: number; seller_id: number; outcome: string; ts: number; url: string; method: string; source: string; quote_atomic: string | null; reference_atomic: string | null; reference_source: string | null; http_status: number | null; tx_hash: string | null }>("buy_failure_samples")) {
    if (!HEADLINE_FAILURE_OUTCOMES.has(s.outcome as never)) continue;
    const l = samples.get(num(s.seller_id)) ?? [];
    if (l.length >= EVIDENCE_PER_SELLER) continue;
    const tx = s.tx_hash && /^0x[0-9a-fA-F]{64}$/.test(s.tx_hash) ? s.tx_hash : null;
    l.push({
      outcome: s.outcome,
      source: s.source,
      timestamp: iso(num(s.ts)),
      resource: s.url,
      method: s.method,
      quote_usdc: usdc(s.quote_atomic),
      reference_price_usdc: usdc(s.reference_atomic),
      reference_source: s.reference_source,
      http_status: s.http_status,
      validator_failures: vf.get(num(s.call_id)) ?? [],
      settlement_tx_hash: tx,
      basescan_url: tx ? explorer + tx : null,
    });
    samples.set(num(s.seller_id), l);
  }

  // ------------------------------------------------------- stress / probe
  const stressMd = markdownTables(stressReport(db));
  const probeMd = markdownTables(probeReport(db));
  const stressJson = { ...header, summary: report.stress, tables: stressMd.sections };
  const probeJson = { ...header, summary: report.probes, report_summary: probeMd.summary, tables: probeMd.sections };

  // ------------------------------------------------------------ write
  const out = resolve(o.outDir);
  const files: Record<string, unknown> = {
    "summary.json": summary,
    "sellers.json": sellersJson,
    "resources.json": resourcesJson,
    "stress.json": stressJson,
    "probe.json": probeJson,
  };
  const safeName = (d: string) => d.toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  for (const s of [...main, ...low]) {
    files[`evidence/${safeName(s.domain)}.json`] = { ...header, domain: s.domain, seller_id: s.seller_id, failures_total: s.failures, shown: (samples.get(s.seller_id) ?? []).length, samples: samples.get(s.seller_id) ?? [] };
  }

  // Refuse to publish any of our wallet addresses.
  const wallets = q<{ wallet: string }>("our_wallets").map((w) => w.wallet).filter(Boolean);
  const texts = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, JSON.stringify(v, null, 2) + "\n"]));
  for (const [k, t] of Object.entries(texts)) {
    const lower = t.toLowerCase();
    const hit = wallets.find((w) => lower.includes(w));
    if (hit) throw new Error(`export: ${k} would contain one of our wallet addresses; nothing written`);
  }

  mkdirSync(join(out, "evidence"), { recursive: true });
  // Evidence files for sellers that dropped out of the export are removed.
  for (const f of readdirSync(join(out, "evidence"))) if (!(`evidence/${f}` in texts)) rmSync(join(out, "evidence", f));
  for (const [k, t] of Object.entries(texts)) writeFileSync(join(out, k), t);
  writeFileSync(join(out, "README.md"), README);
  return { files: [...Object.keys(texts), "README.md"], sellers: main.length, lowSample: low.length, resources: resources.length, evidenceFiles: main.length + low.length };
}

const README = `# paidfor-data

Machine-readable twin of the x402 buyer-failure report, refreshed hourly by the audit loop (\`x402-audit export\` over its SQLite database). Every file below sits at the root of this repository; fetch it from \`https://raw.githubusercontent.com/sarmadahsan/paidfor-data/main/<file>\`.
Every rate uses the report's definitions: the paid denominator is ok, overcharge, non_delivery, wrong_goods, injection and duplicate buy rows;
a failure is overcharge, non_delivery, wrong_goods or duplicate. Intervals are 95% Wilson. Rates are fractions in [0, 1]. Money is USDC (6 decimals) as decimal strings.
All files carry \`generated_at\`, \`network\` (CAIP-2) and \`git_commit\` (harness commit that wrote them).

## summary.json
- \`last_updated\`: when this export ran (ISO 8601 UTC).
- \`study_window.first_call\` / \`last_call\`: first and last buy or stress call in the database.
- \`denominator_paid_calls\`: buy calls in the paid denominator.
- \`count_weighted\`: failures, rate and Wilson interval over denominator calls.
- \`dollar_weighted\`: USDC in the denominator, USDC on failed calls, rate, and approximate Wilson interval using Kish effective n.
- \`failures_by_type\`: per failure outcome, count, share of denominator calls, share of failures, USDC, and how many were resolved late on-chain.
- \`sellers_reached\` / \`resources_reached\`: distinct sellers and resources with at least one buy call.
- \`sellers_with_min_calls\`: sellers with at least 30 denominator calls (the rows in sellers.json \`sellers\`).
- \`usdc_spent\`: USDC settled on-chain for our paid calls, buy and stress; \`usdc_signed\` is the upper bound we authorized (some authorizations were never settled); \`usdc_spent_by_source\` splits both by source.
- \`outside_denominator\`: rows kept out of the rate (our_error, indeterminate, not_paid, unclassified, unpaid overcharge and its quoted exposure).
- \`flagged_injection\`: denominator rows flagged for possible prompt injection, not counted as failures.
- \`overcharge_sensitivity\`: headline rate if overcharges below a quote/reference ratio of 1.1 or 2.0 were not counted.
- \`by_tier\` / \`by_category\`: denominator calls, failures, rate, Wilson interval and dollar-weighted rate per seller tier and category.
- \`audit_purchases\`: paid audit calls and sellers audited, by source (\`audit_disagreement\`, \`audit_demand\`). Audit purchases count in each seller's own figures and evidence, never in the headline (\`count_weighted\`, \`dollar_weighted\`, \`failures_by_type\`), \`by_tier\` or \`by_category\`: triggered sampling oversamples contested and popular sellers. Sellers that entered through the user-candidate import stay out of those three until their first scheduled purchase is 7 days old.

## sellers.json
\`sellers\` holds sellers with at least 30 denominator calls; \`low_sample\` holds sellers with 5 to 29, each marked \`low_sample: true\`. Both are sorted by failure rate descending, then by calls descending.
- \`seller_id\`: internal id, stable within this database.
- \`domain\`: host the seller serves x402 resources from.
- \`canonical_domain\`: registrable domain (lowercased, no www, last two labels, three under shared hosts such as workers.dev or vercel.app).
- \`tier\`: \`top\` (top 20 by 30-day on-chain volume), \`tail\` (random sample of the rest), or null (added in widened phases).
- \`category\`: inference, data, scraping, compute or other, from listing keywords.
- \`denominator_calls\` / \`failures\` / \`failure_rate\` / \`wilson_low\` / \`wilson_high\`: count-weighted rate and 95% Wilson interval.
- \`failures_by_type\`: failures split into non_delivery, overcharge, duplicate, wrong_goods.
- \`dollar_weighted_rate\`: share of the seller's denominator USDC that went to failed calls.
- \`median_quote_usdc\`: median quoted price across the seller's denominator calls (lower median).
- \`last_seen\`: latest buy call or unpaid probe to any of the seller's resources.
- \`onchain_inflow_30d_usdc\`: USDC transferred to the seller's pay-to addresses in the 30-day chain scan; \`onchain_inflow_computed_at\` is when that scan ran.
- \`pay_to_addresses\`: addresses the seller listed or quoted for payment (lowercase).
- \`bazaar_listing_count\`: resources the seller lists in the Coinbase Bazaar discovery API.
- \`audit_purchases\` / \`audit_purchases_by_source\`: paid audit calls included in this seller's figures ("includes N audit purchases").
- \`source\`: \`discovery\` (Bazaar, chain scan or our own list) or \`user\` (entered through the user-candidate import); a \`user\` seller also has \`entered_at\`, \`entered_after_checks\` and \`entered_after_payments\` (the index's counts at import).

## resources.json
Resources with at least 10 denominator calls, sorted by failure rate descending.
- \`url\` / \`method\`: the resource as listed.
- \`seller\`: seller domain.
- \`listed_price_usdc\`: price declared in the Bazaar listing.
- \`modal_quote_usdc\` / \`max_quote_usdc\`: most common and highest price the resource quoted on denominator calls.
- \`overcharge_ratio\`: max quote divided by listed price (null without a listed price).
- \`calls\` / \`failures\` / \`failure_rate\` / \`wilson_low\` / \`wilson_high\`: as for sellers.
- \`failures_by_type\`: failures split into non_delivery, overcharge, duplicate, wrong_goods.

## evidence/<domain>.json
One file per seller in sellers.json (both arrays); up to 25 most recent failures.
- \`failures_total\` / \`shown\`: failures for the seller and how many samples follow.
- \`outcome\`: failure type.
- \`source\`: \`buy\` (scheduled purchase), \`audit_disagreement\` or \`audit_demand\` (triggered audit purchase).
- \`timestamp\`: when the call was made.
- \`resource\` / \`method\`: resource called.
- \`quote_usdc\`: price the seller quoted in its 402 response.
- \`reference_price_usdc\` / \`reference_source\`: price the quote was judged against and where it came from (bazaar, modal_7d, first_seen).
- \`http_status\`: status of the paid response (null if none arrived).
- \`validator_failures\`: validators that failed, with their reason code.
- \`settlement_tx_hash\` / \`basescan_url\`: on-chain settlement of the payment, if one was matched.

## stress.json
- \`summary\`: duplicate test (intents, intents settled twice, rate, Wilson interval) and timeout test (intents, settled despite abort, retried, second settlement on retry).
- \`tables\`: the stress report's tables (duplicate per resource, timeout per resource, totals) as rows keyed by column header.

## probe.json
- \`summary\`: probe rounds, probes, outcomes, and price event counts (price discrimination, pay-to changes, quote drift).
- \`report_summary\`: date range, rounds, probes, probe set size, client identities.
- \`tables\`: the probe report's tables (per seller, not probeable) as rows keyed by column header.
`;
