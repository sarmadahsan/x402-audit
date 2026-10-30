/**
 * renderMarkdown / writeReport: the human report and its JSON twin.
 * Pure formatting: every number comes from ReportData (computeReport).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicToUsd } from "../config/index.js";
import { HEADLINE_FAILURE_OUTCOMES, PAID_DENOMINATOR_OUTCOMES } from "../taxonomy.js";
import type { CountRate, DollarRate, GroupRow, ReportData } from "./compute.js";

export const SECTION_HEADERS = {
  meta: "## 1. Overview",
  headline: "## 2. Headline failure rate (buy only)",
  by_failure_type: "## 3. By failure type",
  by_tier: "## 4. By seller tier",
  by_category: "## 5. By category",
  top_sellers: "## 6. Top sellers by failure rate",
  stress: "## 7. Stress tests",
  chain_proxy: "## 8. Chain proxy floors",
  telemetry: "## 9. Telemetry by operator source",
  probes: "## 10. Probes",
  reproducibility: "## 11. Reproducibility",
  how_to_reproduce: "## 12. How to reproduce",
} as const;

export const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
export const rateCi = (r: { rate: number; lo: number; hi: number }): string => `${pct(r.rate)} [${pct(r.lo)}, ${pct(r.hi)}]`;
export const usdc = (atomic: string | bigint): string => `${atomicToUsd(atomic)} USDC`;
const esc = (s: unknown): string => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function table(head: string[], rows: (string | number)[][]): string {
  if (!rows.length) return "_No rows._\n";
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n") + "\n";
}

const queriesLine = (data: ReportData, section: string): string =>
  `_Queries: ${(data.queries_used[section] ?? []).map((n) => `\`${n}\``).join(", ") || "none"}._\n`;

function groupTable(rows: GroupRow[], label: string): string {
  return table(
    [label, "n", "failures", "count rate [95% CI]", "dollars", "failed dollars", "dollar rate [approx. CI]"],
    rows.map((r) => [r.key, r.n, r.failures, rateCi(r.count), usdc(r.dollar.total_atomic), usdc(r.dollar.failed_atomic), rateCi(r.dollar)]),
  );
}

export function renderMarkdown(data: ReportData): string {
  const m = data.meta;
  const h = data.headline;
  const out: string[] = [];
  const date = m.generated_at.slice(0, 10);
  out.push(`# x402-audit report ${date}\n`);
  out.push(`Network \`${m.network}\`. Generated ${m.generated_at}. Calls from ${m.date_range.first_call ?? "n/a"} to ${m.date_range.last_call ?? "n/a"}.\n`);

  // 1
  out.push(SECTION_HEADERS.meta + "\n");
  out.push(`Spend: **${usdc(m.spend_atomic)}** across ${m.wallet_count} wallet(s). Config hash(es): ${m.config_hashes.map((c) => `\`${c}\``).join(", ") || "none recorded"}.\n`);
  out.push("Calls by source:\n");
  out.push(table(["source", "rows"], Object.entries(m.calls_by_source).map(([k, v]) => [k, v])));
  out.push("Calls by source and outcome (calls table):\n");
  out.push(table(["source", "outcome", "n"], m.calls_by_source_outcome.map((r) => [r.source, r.outcome, r.n])));
  out.push("Spend by source:\n");
  out.push(table(["source", "signed calls", "signed (upper bound)", "settled on-chain (exact)"], m.spend_by_source.map((r) => [r.source, r.paid_calls, usdc(r.spent_atomic), usdc(r.settled_atomic)])));
  out.push(queriesLine(data, "meta"));

  // 2
  out.push(SECTION_HEADERS.headline + "\n");
  const c: CountRate = h.count;
  const d: DollarRate = h.dollar;
  out.push(table(
    ["measure", "denominator", "failures", "rate [95% CI]"],
    [
      ["count-weighted", c.n, c.failures, rateCi(c)],
      ["dollar-weighted", usdc(d.total_atomic), usdc(d.failed_atomic), `${rateCi(d)} (effective n ${d.effective_n.toFixed(1)}; ${d.note})`],
    ],
  ));
  out.push(`Denominator: \`buy\` rows whose outcome counts in the paid denominator (${[...PAID_DENOMINATOR_OUTCOMES].join(", ")}), excluding unpaid overcharges. Failures: ${[...HEADLINE_FAILURE_OUTCOMES].join(", ")}. Of the denominator, ${h.delivered_without_settlement} row(s) were delivered without a visible settlement (dollar weight from the settlement header, else 0) and ${h.resolved_late_in_denominator} were resolved late.\n`);
  out.push("Reported separately (not in the denominator):\n");
  out.push(table(["line", "count", "note"], [
    ["our_error", h.excluded.our_error, "our fault; excluded"],
    ["indeterminate", h.excluded.indeterminate, "settlement not established"],
    ["not_paid", h.excluded.not_paid, "no money moved, no goods"],
    ["unpaid_overcharge", h.excluded.unpaid_overcharge, `exposure ${usdc(h.excluded.exposure_atomic)} (never spent)`],
    ["unclassified", h.excluded.unclassified, "no outcome yet"],
  ]));
  out.push(`Flagged for human review: **${h.flagged.injection}** \`injection\` row(s) (in the denominator, not counted as failures); ${h.flagged.injection_hit_total} row(s) carry the \`injection_hit\` flag under any outcome.\n`);
  if (h.timeout_below_declared > 0) {
    out.push(`Note: ${h.timeout_below_declared} \`non_delivery\` row(s) are paid calls that timed out in our client before the seller's declared maxTimeoutSeconds elapsed; the seller may still have delivered later, so treat those as an upper bound on the seller's fault.\n`);
  }
  if (h.our_error_reasons.length) {
    out.push("`our_error` by reason (our fault, or a listing we could not form a valid request from; never the seller's):\n");
    out.push(table(["reason", "rows"], h.our_error_reasons.map((r) => [r.reason, r.n])));
  }
  out.push("Secondary flags among denominator rows (a row can carry several):\n");
  out.push(table(["flag", "rows", "of which headline failures", "dollars"], h.flag_counts.map((r) => [r.flag, r.n, r.failed, usdc(r.dollars_atomic)])));
  out.push("Overcharge sensitivity (overcharge only counted when quote / reference >= ratio):\n");
  out.push(table(
    ["min ratio", "overcharge kept", "dropped", "unknown ratio (kept)", "count rate [95% CI]", "dollar rate"],
    h.sensitivity.map((s) => [`>= ${s.min_ratio}`, s.overcharge_kept, s.overcharge_dropped, s.overcharge_unknown_ratio, rateCi(s.count), pct(s.dollar_rate)]),
  ));
  out.push(queriesLine(data, "headline"));

  // 3
  out.push(SECTION_HEADERS.by_failure_type + "\n");
  out.push(table(
    ["outcome", "n", "share of calls", "share of failures", "dollars", "resolved late"],
    data.by_failure_type.map((r) => [r.outcome, r.n, pct(r.share_of_calls), pct(r.share_of_failures), usdc(r.dollars_atomic), r.resolved_late]),
  ));
  out.push(queriesLine(data, "by_failure_type"));

  // 4, 5
  out.push(SECTION_HEADERS.by_tier + "\n");
  out.push(groupTable(data.by_tier, "tier"));
  out.push(queriesLine(data, "by_tier"));
  out.push(SECTION_HEADERS.by_category + "\n");
  out.push(groupTable(data.by_category, "category"));
  out.push(queriesLine(data, "by_category"));

  // 6
  out.push(SECTION_HEADERS.top_sellers + "\n");
  out.push(`Sellers with at least ${m.params.top_sellers_min_calls} denominator calls, top ${data.top_sellers.length} by count failure rate. At n = 30 the 95% interval is about ±10 pp: enough to separate a 5% seller from a 40% seller, not a 5% from a 10%.\n`);
  out.push(table(
    ["seller", "tier", "category", "n", "failures", "count rate [95% CI]", "dollar rate [approx. CI]"],
    data.top_sellers.map((r) => [r.domain, r.tier ?? "", r.category ?? "", r.n, r.failures, rateCi(r.count), rateCi(r.dollar)]),
  ));
  out.push(queriesLine(data, "top_sellers"));

  // 7
  const s = data.stress;
  out.push(SECTION_HEADERS.stress + "\n");
  out.push(table(["test", "intents", "result"], [
    ["stress_duplicate", s.duplicate.intents, `${s.duplicate.intents_with_second_settlement} with a second settlement, ${rateCi(s.duplicate)}`],
    ["stress_timeout", s.timeout.intents, `first call aborted at ${s.timeout.first_call_aborted}, ${s.timeout.settled_despite_abort} of them settled anyway; ${s.timeout.intents_with_retry} retried, ${s.timeout.second_settlement_on_retry} with a second settlement on retry`],
  ]));
  out.push("Stress rows are never mixed into the headline. A retry is a `stress_timeout` row sharing an intent_id with an earlier `stress_timeout` row.\n");
  out.push(queriesLine(data, "stress"));

  // 8
  const cp = data.chain_proxy;
  out.push(SECTION_HEADERS.chain_proxy + "\n");
  out.push(`**Caveat: ${cp.caveat}.** Window ${cp.window.first_transfer_ts == null ? "n/a" : `${new Date(cp.window.first_transfer_ts).toISOString()} to ${new Date(cp.window.last_transfer_ts!).toISOString()}`}; ${cp.pay_tos} pay-to address(es), ${cp.transfers} transfer(s) totalling ${usdc(cp.total_atomic)}; ${cp.dust_transfers} dust transfer(s) below ${usdc(cp.dust_floor_atomic)} ignored.\n`);
  out.push(table(["proxy", "transfers", "dollars", "count rate", "dollar rate", "method"], [
    ["overcharge (above modal price)", cp.overcharge_proxy.count, `${usdc(cp.overcharge_proxy.sum_atomic)} (excess ${usdc(cp.overcharge_proxy.excess_atomic)})`, pct(cp.overcharge_proxy.count_rate), pct(cp.overcharge_proxy.dollar_rate), cp.overcharge_proxy.method],
    ["duplicate (same from/to/value within window)", cp.duplicate_proxy.count, usdc(cp.duplicate_proxy.sum_atomic), pct(cp.duplicate_proxy.count_rate), pct(cp.duplicate_proxy.dollar_rate), `${cp.duplicate_proxy.runs} run(s), window ${cp.duplicate_proxy.window_s} s`],
  ]));
  out.push(table(["pay_to", "transfers", "total", "modal value", "above mode", "duplicates"], cp.per_pay_to.map((p) => [p.pay_to, p.transfers, usdc(p.total_atomic), p.mode_atomic == null ? "" : usdc(p.mode_atomic), p.over_mode, p.duplicates])));
  out.push(queriesLine(data, "chain_proxy"));

  // 9
  out.push(SECTION_HEADERS.telemetry + "\n");
  out.push(table(
    ["source", "label", "rows", "denominator", "failures", "rate [95% CI]", "excluded", "injection (flagged)"],
    data.telemetry.map((t) => [t.source_id, t.label ?? "", t.rows, t.n, t.failures, rateCi(t), t.excluded, t.injection]),
  ));
  out.push("Telemetry is self-reported by operators and is never mixed into the headline.\n");
  out.push(queriesLine(data, "telemetry"));

  // 10
  const p = data.probes;
  out.push(SECTION_HEADERS.probes + "\n");
  out.push(table(["rounds", "probes", "ok", "overcharge", "our_error", "price_discrimination events", "payto_changed events", "quote_drift events"], [
    [p.rounds, p.probes, p.ok, p.overcharge, p.our_error, p.price_discrimination, p.payto_changed, p.quote_drift],
  ]));
  out.push(queriesLine(data, "probes"));

  // 11
  const r = data.reproducibility;
  out.push(SECTION_HEADERS.reproducibility + "\n");
  out.push(table(["item", "value"], [
    ["config hash(es)", r.config_hashes.join(", ") || "none recorded"],
    ["wallet count", r.wallet_count],
    ["date range", `${r.date_range.first_call ?? "n/a"} to ${r.date_range.last_call ?? "n/a"}`],
    ["exact spend", `${r.spend_usdc} USDC (${r.spend_atomic} atomic)`],
    ["db schema_version", r.schema_version ?? "unknown"],
    ["git commit", r.git_commit ?? "not a git checkout"],
    ["runs", r.runs.length],
    ["halts", r.halts.length],
  ]));
  if (r.halts.length) out.push(table(["halt id", "run", "ts", "reason"], r.halts.map((x) => [x.id, x.run_id ?? "", new Date(x.ts).toISOString(), x.reason])));
  out.push(queriesLine(data, "reproducibility"));

  // 12
  out.push(SECTION_HEADERS.how_to_reproduce + "\n");
  const args = [`--network ${m.network}`, `--since ${new Date(m.params.since_ms).toISOString()}`, `--until ${new Date(m.params.until_ms).toISOString()}`];
  out.push("```sh");
  out.push(r.git_commit ? `git checkout ${r.git_commit}` : "# (no git commit recorded)");
  out.push("pnpm install --frozen-lockfile");
  out.push(`pnpm cli report ${args.join(" ")}`);
  out.push("```\n");
  out.push(`Every number above comes from a named SQL query in \`src/report/queries.ts\`, run with \`runQuery(db, name, { since: ${m.params.since_ms}, until: ${m.params.until_ms}, network: "${m.network}" })\` (plus \`min_calls: ${m.params.top_sellers_min_calls}\` for top sellers and \`window_ms: ${m.params.duplicate_run_window_s * 1000}\` for duplicate runs). Chain dust floor: ${m.params.dust_floor_atomic} atomic.\n`);
  out.push(table(["section", "queries"], Object.entries(data.queries_used).map(([k, v]) => [k, v.join(", ")])));
  return out.join("\n");
}

/** JSON.stringify replacer that writes bigint as a decimal string. */
export const bigintReplacer = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

/** Write <dir>/<date>.md and <dir>/<date>.json; date defaults to YYYY-MM-DD of generated_at. */
export function writeReport(data: ReportData, dir: string, date: string = data.meta.generated_at.slice(0, 10)): { mdPath: string; jsonPath: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`writeReport: date must be YYYY-MM-DD, got ${date}`);
  mkdirSync(dir, { recursive: true });
  const mdPath = join(dir, `${date}.md`);
  const jsonPath = join(dir, `${date}.json`);
  writeFileSync(mdPath, renderMarkdown(data));
  writeFileSync(jsonPath, JSON.stringify(data, bigintReplacer, 2) + "\n");
  return { mdPath, jsonPath };
}
