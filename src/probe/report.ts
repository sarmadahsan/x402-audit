/** `probe report`: markdown summary of what probing observed. Read-only. */
import type { Db } from "../db/index.js";
import { atomicToUsd } from "../config/index.js";
import { CLIENT_IDENTITIES, IDENTITY_NOTE } from "./identities.js";
import { modalAmount } from "./run.js";

export interface ProbeReportOptions {
  /** Only probes/events with ts >= sinceMs. Default: everything. */
  sinceMs?: number;
}

interface ProbeRow {
  resource_id: number;
  seller_id: number;
  domain: string;
  client_identity: string;
  round_id: string | null;
  ts: number;
  status: number | null;
  amount_atomic: string | null;
  latency_ms: number | null;
  outcome: string | null;
  flags_json: string;
  error: string | null;
}

interface EventRow {
  resource_id: number;
  seller_id: number;
  domain: string;
  url: string;
  ts: number;
  kind: string;
  old_value: string | null;
  new_value: string | null;
  details_json: string | null;
}

const iso = (t: number) => new Date(t).toISOString().replace(".000Z", "Z");
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function usd(atomic: string | undefined | null): string {
  if (!atomic || !/^\d+$/.test(atomic)) return "-";
  return `$${atomicToUsd(atomic).replace(/0+$/, "").replace(/\.$/, ".00")}`;
}

function median(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
}

function parseFlags(j: string): string[] {
  try {
    const v = JSON.parse(j) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function probeReport(db: Db, opts: ProbeReportOptions = {}): string {
  const since = opts.sinceMs ?? 0;
  const probes = db
    .prepare(
      `SELECT p.resource_id, r.seller_id, s.domain, p.client_identity, p.round_id, p.ts, p.status,
              p.amount_atomic, p.latency_ms, p.outcome, p.flags_json, p.error
       FROM probes p JOIN resources r ON r.id = p.resource_id JOIN sellers s ON s.id = r.seller_id
       WHERE p.ts >= ? ORDER BY p.ts, p.id`,
    )
    .all(since) as ProbeRow[];
  const events = db
    .prepare(
      `SELECT e.resource_id, r.seller_id, s.domain, r.url, e.ts, e.kind, e.old_value, e.new_value, e.details_json
       FROM price_events e JOIN resources r ON r.id = e.resource_id JOIN sellers s ON s.id = r.seller_id
       WHERE e.ts >= ? ORDER BY e.ts DESC, e.id DESC`,
    )
    .all(since) as EventRow[];
  const setCounts = db
    .prepare(`SELECT stratum, COUNT(*) AS n FROM probe_set WHERE active = 1 GROUP BY stratum`)
    .all() as { stratum: string; n: number }[];

  const out: string[] = [];
  out.push("# Probe report", "");
  if (probes.length === 0) {
    out.push("No probes recorded" + (since ? ` since ${iso(since)}` : "") + ".", "");
  }
  const first = probes[0]?.ts;
  const last = probes[probes.length - 1]?.ts;
  const rounds = new Set(probes.map((p) => p.round_id).filter((r): r is string => r !== null));
  const top = setCounts.find((c) => c.stratum === "top")?.n ?? 0;
  const tail = setCounts.find((c) => c.stratum === "tail")?.n ?? 0;
  const usedIds = [...new Set(probes.map((p) => p.client_identity))].sort();

  out.push(`- Date range: ${first !== undefined && last !== undefined ? `${iso(first)} to ${iso(last)}` : "-"}`);
  out.push(`- Rounds: ${rounds.size}`);
  out.push(`- Probes: ${probes.length}`);
  out.push(`- Resources in active probe set: ${top + tail} (top ${top}, tail ${tail})`);
  out.push(`- Client identities used: ${usedIds.length ? usedIds.join(", ") : "-"}`);
  for (const id of usedIds) {
    const known = CLIENT_IDENTITIES.find((c) => c.id === id);
    if (known) {
      const h = Object.entries(known.headers)
        .map(([k, v]) => `\`${k}: ${v}\``)
        .join(", ");
      out.push(`  - ${id} (${known.description}): ${h}`);
    }
  }
  out.push(`- Note: ${IDENTITY_NOTE}`);
  out.push("");

  // ---- per seller ----
  interface Agg {
    domain: string;
    resources: Set<number>;
    probes: number;
    got402: number;
    amounts: string[];
    latencies: number[];
    drift: number;
    payto: number;
    discrimination: number;
    overcharge: number;
    slow: number;
  }
  const bySeller = new Map<number, Agg>();
  const agg = (sellerId: number, domain: string): Agg => {
    let a = bySeller.get(sellerId);
    if (!a) {
      a = {
        domain,
        resources: new Set(),
        probes: 0,
        got402: 0,
        amounts: [],
        latencies: [],
        drift: 0,
        payto: 0,
        discrimination: 0,
        overcharge: 0,
        slow: 0,
      };
      bySeller.set(sellerId, a);
    }
    return a;
  };
  for (const p of probes) {
    const a = agg(p.seller_id, p.domain);
    a.resources.add(p.resource_id);
    a.probes++;
    if (p.status === 402) a.got402++;
    if (p.amount_atomic && /^\d+$/.test(p.amount_atomic)) a.amounts.push(p.amount_atomic);
    if (p.latency_ms !== null) a.latencies.push(p.latency_ms);
    if (p.outcome === "overcharge") a.overcharge++;
    if (parseFlags(p.flags_json).includes("slow")) a.slow++;
  }
  for (const e of events) {
    const a = agg(e.seller_id, e.domain);
    if (e.kind === "quote_drift") a.drift++;
    else if (e.kind === "payto_changed") a.payto++;
    else if (e.kind === "price_discrimination") a.discrimination++;
  }
  const sellers = [...bySeller.values()].sort(
    (x, y) => y.drift + y.payto - (x.drift + x.payto) || y.probes - x.probes || x.domain.localeCompare(y.domain),
  );

  out.push("## Per seller", "");
  out.push(
    "| Seller | Resources | Probes | 402 rate | Modal price | Min | Max | Drift events | Pay-to changes | Price discrimination | Overcharge probes | Slow probes | Median latency |",
  );
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const a of sellers) {
    const big = a.amounts.map((x) => BigInt(x));
    const min = big.length ? big.reduce((m, v) => (v < m ? v : m)).toString() : undefined;
    const max = big.length ? big.reduce((m, v) => (v > m ? v : m)).toString() : undefined;
    const rate = a.probes ? `${((100 * a.got402) / a.probes).toFixed(1)}%` : "-";
    const med = median(a.latencies);
    out.push(
      `| ${md(a.domain)} | ${a.resources.size} | ${a.probes} | ${rate} | ${usd(modalAmount(a.amounts))} | ${usd(min)} | ${usd(max)} | ${a.drift} | ${a.payto} | ${a.discrimination} | ${a.overcharge} | ${a.slow} | ${med === undefined ? "-" : `${med} ms`} |`,
    );
  }
  out.push("", "Prices assume a 6-decimal asset (USDC). Drift is measured per client identity.", "");

  // ---- quote drift ----
  const drift = events.filter((e) => e.kind === "quote_drift");
  out.push(`## Quote drift events (latest ${Math.min(50, drift.length)} of ${drift.length})`, "");
  if (drift.length === 0) out.push("None.");
  for (const e of drift.slice(0, 50)) {
    out.push(`- ${iso(e.ts)} ${md(e.url)}: ${usd(e.old_value)} -> ${usd(e.new_value)} (${e.old_value} -> ${e.new_value} atomic)`);
  }
  out.push("");

  // ---- pay-to changes ----
  const payto = events.filter((e) => e.kind === "payto_changed");
  out.push(`## Pay-to changes (${payto.length})`, "");
  if (payto.length === 0) out.push("None.");
  for (const e of payto) out.push(`- ${iso(e.ts)} ${md(e.url)}: ${e.old_value} -> ${e.new_value}`);
  out.push("");

  // ---- price discrimination ----
  const disc = events.filter((e) => e.kind === "price_discrimination");
  out.push(`## Price discrimination events (${disc.length})`, "");
  if (disc.length === 0) out.push("None.");
  for (const e of disc.slice(0, 50)) {
    let detail = "";
    try {
      const d = JSON.parse(e.details_json ?? "{}") as Record<string, unknown>;
      detail = Object.entries(d)
        .filter(([k]) => k !== "probeIds" && k !== "roundId")
        .map(([k, v]) => `${k}=${usd(String(v))}`)
        .join(", ");
    } catch {
      /* ignore */
    }
    out.push(`- ${iso(e.ts)} ${md(e.url)}: ${detail}`);
  }
  out.push("");

  // ---- not probeable ----
  const np = new Map<string, number>();
  let ourErrors = 0;
  for (const p of probes) {
    if (p.outcome === "our_error") ourErrors++;
    if (p.outcome !== null || p.error === null) continue;
    const key = (p.error.split(" | ")[0] ?? p.error).trim();
    np.set(key, (np.get(key) ?? 0) + 1);
  }
  const npTotal = [...np.values()].reduce((s, n) => s + n, 0);
  out.push(`## Not probeable (${npTotal} probes)`, "");
  if (npTotal === 0) out.push("None.");
  else {
    out.push("| Reason | Probes |", "|---|---:|");
    for (const [k, n] of [...np.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) out.push(`| ${md(k)} | ${n} |`);
  }
  out.push("", `our_error probes (our bugs and 429 rate limits, excluded from everything above): ${ourErrors}`, "");
  return out.join("\n");
}
