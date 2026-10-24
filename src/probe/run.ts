/**
 * One probe round: an unpaid request per (resource in the active probe set) x (client identity),
 * recording every 402 quote in `probes`, plus price_events for drift, pay-to changes and
 * price discrimination. Never signs or pays.
 *
 * Probe outcomes (docs/taxonomy.md "Probe rows"): ok | overcharge | our_error, or NULL when the
 * resource was not probeable (no 402, no Base-exact requirement, unreachable). NULL rows are
 * reported as counts by `error` and never blamed on the seller or on us.
 */
import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.js";
import { classify } from "../classify.js";
import { haltRequested } from "../safety.js";
import type { log as defaultLog } from "../log.js";
import { fetchQuote, selectRequirements, type QuoteResult } from "../x402/quote.js";
import type { FetchImpl } from "../x402/http.js";
import { errMsg, type NormalizedRequirements } from "../x402/types.js";
import {
  ALL_FLAGS,
  FLAGS,
  MODAL_PRICE_WINDOW_MS,
  OUTCOMES,
  PRICE_DISCRIMINATION_WINDOW_MS,
  REFERENCE_SOURCES,
  type Flag,
  type Outcome,
  type ReferenceSource,
} from "../taxonomy.js";
import { CLIENT_IDENTITIES, type ClientIdentity } from "./identities.js";
import { listProbeSet, mulberry32, shuffle, type ProbeSetRow } from "./set.js";

export type Logger = typeof defaultLog;

/** Harness default when a quote declares no maxTimeoutSeconds (v2 requires it, v1 too; kept for safety). */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 30;
/** Largest request body we will derive from a bazaar input example. */
const MAX_EXAMPLE_BODY_BYTES = 2048;

export interface ProbeRoundOptions {
  runId?: number;
  /** CAIP-2 network whose `exact` requirement is selected from each 402. */
  network: string;
  identities?: readonly ClientIdentity[];
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  perRequestGapMs?: number;
  log: Logger;
  /** Clock (ms). Default Date.now. */
  now?: () => number;
  /** Directory checked for a `halt` file before each resource. Default process.cwd(). */
  haltRoot?: string;
  /** Seed for the per-round visiting order. Default: random. */
  orderSeed?: number;
  /** Aborts between requests (used by probeLoop). */
  signal?: AbortSignal;
}

export interface RoundStats {
  roundId: string;
  /** Resources visited (fully or partially) this round. */
  resources: number;
  /** HTTP requests sent. */
  requests: number;
  got402: number;
  /** Rows with outcome NULL because the response was not a usable 402 (no_402:*, no_base_exact_requirement, invalid quote). */
  notProbeable: number;
  /** Rows with outcome NULL because of DNS / connect / reset / timeout. */
  unreachable: number;
  /** Rows with outcome our_error (exceptions in our code, and 429 rate limits per the taxonomy). */
  ourErrors: number;
  /** Subset of ourErrors: HTTP 429 responses. The seller's remaining resources are skipped this round. */
  rateLimited: number;
  overcharge: number;
  /** Resources with a price_discrimination event this round. */
  priceDiscrimination: number;
  payToChanged: number;
  slow: number;
  /** quote_drift events written this round. */
  quoteDrift: number;
  halted: boolean;
  durationMs: number;
}

interface PreparedRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** Dig a tiny JSON body example out of resources.input_json (bazaar extension input info), if present. */
export function exampleBodyFromInput(inputJson: string | null): unknown {
  if (!inputJson) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(inputJson);
  } catch {
    return undefined;
  }
  const get = (o: unknown, path: string[]): unknown => {
    let cur = o;
    for (const k of path) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
  };
  // Accept the extension object at several depths: the whole extensions map, extensions.bazaar,
  // bazaar.info, or info.input directly.
  const roots = [
    get(v, ["extensions", "bazaar", "info", "input"]),
    get(v, ["bazaar", "info", "input"]),
    get(v, ["info", "input"]),
    get(v, ["input"]),
    v,
  ];
  for (const input of roots) {
    if (!input || typeof input !== "object") continue;
    for (const key of ["body", "bodyExample", "example"]) {
      const b = (input as Record<string, unknown>)[key];
      if (b !== undefined && b !== null && typeof b === "object") {
        const s = JSON.stringify(b);
        if (Buffer.byteLength(s) <= MAX_EXAMPLE_BODY_BYTES) return b;
      }
    }
  }
  // No example: synthesise a minimal body from a `bodyFields` descriptor ({ name: { type, description } }),
  // which is how many Bazaar entries describe POST inputs.
  for (const input of roots) {
    if (!input || typeof input !== "object") continue;
    const fields = (input as Record<string, unknown>)["bodyFields"];
    if (fields && typeof fields === "object" && !Array.isArray(fields)) {
      const body = synthesizeBodyFromFields(fields as Record<string, unknown>);
      if (body && Object.keys(body).length > 0) return body;
    }
  }
  return undefined;
}

/** Example query parameters from the Bazaar input info (`queryParams: { name: exampleValue | {type,description} }`). */
export function exampleQueryFromInput(inputJson: string | null): Record<string, string> | undefined {
  if (!inputJson) return undefined;
  let v: unknown;
  try { v = JSON.parse(inputJson); } catch { return undefined; }
  const get = (o: unknown, path: string[]): unknown => path.reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Record<string, unknown>)[k] : undefined), o);
  const qp = [get(v, ["extensions", "bazaar", "info", "input", "queryParams"]), get(v, ["info", "input", "queryParams"]), get(v, ["input", "queryParams"]), get(v, ["queryParams"])].find((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<string, unknown> | undefined;
  if (!qp) return undefined;
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(qp)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== "object") { out[k] = String(raw); continue; }
    // Typed descriptor rather than an example value: only use it when it carries a concrete example
    // (example/default/enum/"e.g."). Query parameters are usually optional filters, and an invented value
    // (category=x402-audit) gets the whole request rejected.
    const d = raw as { example?: unknown; default?: unknown; enum?: unknown[]; description?: string };
    if (d.example === undefined && d.default === undefined && !(Array.isArray(d.enum) && d.enum.length) && !/e\.g\./i.test(d.description ?? "")) continue;
    const synth = synthesizeBodyFromFields({ [k]: raw });
    const val = synth?.[k];
    if (val !== undefined && typeof val !== "object") out[k] = String(val);
  }
  return Object.keys(out).length ? out : undefined;
}

/** Append example query parameters to a URL that has none of its own. The URL actually sent is stored on every row. */
export function urlWithExampleQuery(url: string, inputJson: string | null): string {
  try {
    const u = new URL(url);
    if (u.search) return url;
    const q = exampleQueryFromInput(inputJson);
    if (!q) return url;
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Minimal, auditable body from typed field descriptors. Rules, in order:
 *  - an example in the description ("e.g., gpt-4o-mini, claude-haiku") -> its first item;
 *  - a field named `messages` -> one user message "ping" (chat-completions shape);
 *  - `stream` -> false; `max_tokens`/`maxTokens` -> 1 (keeps inference cheap);
 *  - otherwise by type: string "x402-audit", integer/number 1, boolean false, array [], object {}.
 * The exact body sent is stored on every row (calls.request_json / probes.request_headers_json),
 * so a seller's 400 on a synthesised body is auditable and lands in our_error, never on the seller.
 */
export function synthesizeBodyFromFields(fields: Record<string, unknown>): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(fields)) {
    const f = (spec && typeof spec === "object" ? spec : {}) as { type?: string; description?: string; example?: unknown; enum?: unknown[]; default?: unknown };
    if (f.example !== undefined) { out[name] = f.example; continue; }
    if (f.default !== undefined) { out[name] = f.default; continue; }
    if (Array.isArray(f.enum) && f.enum.length > 0) { out[name] = f.enum[0]; continue; }
    const eg = /e\.g\.,?\s*([^)\]\n]+)/i.exec(f.description ?? "");
    if (eg && (f.type === undefined || f.type === "string")) {
      const first = eg[1]!.split(/,|;| or /)[0]!.trim().replace(/^['"`]|['"`.]+$/g, "");
      if (first) { out[name] = first; continue; }
    }
    if (name === "messages") { out[name] = [{ role: "user", content: "ping" }]; continue; }
    if (name === "stream") { out[name] = false; continue; }
    if (name === "max_tokens" || name === "maxTokens") { out[name] = 1; continue; }
    switch (f.type) {
      case "integer": case "number": out[name] = 1; break;
      case "boolean": out[name] = false; break;
      case "array": out[name] = []; break;
      case "object": out[name] = {}; break;
      case "string": default: out[name] = "x402-audit"; break;
    }
  }
  return out;
}

export function buildRequest(row: Pick<ProbeSetRow, "method" | "inputJson">, identity: ClientIdentity): PreparedRequest {
  const method = (row.method || "GET").toUpperCase();
  const headers: Record<string, string> = { ...identity.headers };
  const out: PreparedRequest = { method, headers };
  if (BODY_METHODS.has(method)) {
    headers["content-type"] = "application/json";
    const ex = exampleBodyFromInput(row.inputJson);
    out.body = ex !== undefined ? JSON.stringify(ex) : "{}";
  }
  return out;
}

function isAtomic(s: string | null | undefined): s is string {
  return typeof s === "string" && /^\d+$/.test(s);
}

function sameAtomic(a: string, b: string): boolean {
  if (isAtomic(a) && isAtomic(b)) return BigInt(a) === BigInt(b);
  return a === b;
}

/** Modal amount (ties toward the lower amount). */
export function modalAmount(amounts: string[]): string | undefined {
  const counts = new Map<string, { n: number; v: bigint }>();
  for (const a of amounts) {
    if (!isAtomic(a)) continue;
    const v = BigInt(a);
    const k = v.toString();
    const c = counts.get(k);
    if (c) c.n++;
    else counts.set(k, { n: 1, v });
  }
  let best: { n: number; v: bigint } | undefined;
  for (const c of counts.values()) {
    if (!best || c.n > best.n || (c.n === best.n && c.v < best.v)) best = c;
  }
  return best?.v.toString();
}

/** Reference price rules (docs/taxonomy.md "Reference price"): bazaar > modal_7d > first_seen. */
export function referencePrice(
  db: Db,
  row: Pick<ProbeSetRow, "resourceId" | "resourceSource" | "declaredPriceAtomic">,
  now: number,
): { price: string; source: ReferenceSource } | undefined {
  if ((row.resourceSource === "bazaar" || row.resourceSource === "manual") && isAtomic(row.declaredPriceAtomic)) {
    return { price: BigInt(row.declaredPriceAtomic).toString(), source: REFERENCE_SOURCES.BAZAAR };
  }
  const recent = db
    .prepare(`SELECT amount_atomic FROM probes WHERE resource_id = ? AND amount_atomic IS NOT NULL AND ts >= ?`)
    .all(row.resourceId, now - MODAL_PRICE_WINDOW_MS) as { amount_atomic: string }[];
  const modal = modalAmount(recent.map((r) => r.amount_atomic));
  if (modal !== undefined) return { price: modal, source: REFERENCE_SOURCES.MODAL_7D };
  const first = db
    .prepare(
      `SELECT amount_atomic FROM probes WHERE resource_id = ? AND amount_atomic IS NOT NULL ORDER BY ts ASC, id ASC LIMIT 1`,
    )
    .get(row.resourceId) as { amount_atomic: string } | undefined;
  if (first && isAtomic(first.amount_atomic)) return { price: BigInt(first.amount_atomic).toString(), source: REFERENCE_SOURCES.FIRST_SEEN };
  return undefined;
}

function unreachableKind(q: QuoteResult): string {
  if (q.error?.kind === "timeout") return "timeout";
  const m = (q.error?.message ?? "").toUpperCase();
  if (m.includes("ENOTFOUND") || m.includes("EAI_AGAIN")) return "dns";
  if (m.includes("ECONNREFUSED")) return "refused";
  if (m.includes("ECONNRESET") || m.includes("SOCKET") || m.includes("UND_ERR_SOCKET")) return "reset";
  if (m.includes("CERT") || m.includes("TLS") || m.includes("SSL")) return "tls";
  return "network";
}

function canonicalFlags(flags: Iterable<string>): string[] {
  const set = new Set(flags);
  const known = ALL_FLAGS.filter((f) => set.has(f));
  const unknown = [...set].filter((f) => !(ALL_FLAGS as readonly string[]).includes(f)).sort();
  return [...known, ...unknown];
}

function addFlag(db: Db, probeId: number, flag: Flag): boolean {
  const r = db.prepare(`SELECT flags_json FROM probes WHERE id = ?`).get(probeId) as { flags_json: string } | undefined;
  if (!r) return false;
  let flags: string[] = [];
  try {
    const parsed = JSON.parse(r.flags_json) as unknown;
    if (Array.isArray(parsed)) flags = parsed.map(String);
  } catch {
    /* keep empty */
  }
  if (flags.includes(flag)) return false;
  db.prepare(`UPDATE probes SET flags_json = ? WHERE id = ?`).run(JSON.stringify(canonicalFlags([...flags, flag])), probeId);
  return true;
}

interface ProbeInsert {
  run_id: number | null;
  resource_id: number;
  client_identity: string;
  round_id: string;
  ts: number;
  method: string;
  request_headers_json: string;
  status: number | null;
  headers_json: string | null;
  body_text: string | null;
  requirements_json: string | null;
  accepts_json: string | null;
  x402_version: number | null;
  amount_atomic: string | null;
  asset: string | null;
  network: string | null;
  pay_to: string | null;
  max_timeout_seconds: number | null;
  latency_ms: number | null;
  outcome: Outcome | null;
  flags_json: string;
  reference_price_atomic: string | null;
  reference_source: string | null;
  error: string | null;
}

const INSERT_PROBE_SQL = `INSERT INTO probes (
  run_id, resource_id, client_identity, round_id, ts, method, request_headers_json, status, headers_json,
  body_text, requirements_json, accepts_json, x402_version, amount_atomic, asset, network, pay_to,
  max_timeout_seconds, latency_ms, outcome, flags_json, reference_price_atomic, reference_source, error
) VALUES (
  @run_id, @resource_id, @client_identity, @round_id, @ts, @method, @request_headers_json, @status, @headers_json,
  @body_text, @requirements_json, @accepts_json, @x402_version, @amount_atomic, @asset, @network, @pay_to,
  @max_timeout_seconds, @latency_ms, @outcome, @flags_json, @reference_price_atomic, @reference_source, @error
)`;

function insertEvent(
  db: Db,
  e: { resourceId: number; ts: number; kind: string; oldValue: string | null; newValue: string | null; probeId: number | null; details?: unknown },
): void {
  db.prepare(
    `INSERT INTO price_events (resource_id, ts, kind, old_value, new_value, probe_id, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(e.resourceId, e.ts, e.kind, e.oldValue, e.newValue, e.probeId, e.details === undefined ? null : JSON.stringify(e.details));
}

/** Pick the network's `exact` requirement, preferring the resource's recorded asset when the 402 offers several. */
function pickRequirement(accepts: NormalizedRequirements[], network: string, asset: string | null): NormalizedRequirements | undefined {
  if (asset) {
    const byAsset = selectRequirements(accepts, { network, scheme: "exact", asset });
    if (byAsset) return byAsset;
  }
  return selectRequirements(accepts, { network, scheme: "exact" });
}

type RowKind = "quote" | "not_probeable" | "unreachable" | "rate_limited" | "our_error";

interface ProbeOutcome {
  probeId: number | null;
  kind: RowKind;
  amount?: string;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

export async function runProbeRound(db: Db, opts: ProbeRoundOptions): Promise<RoundStats> {
  const now = opts.now ?? Date.now;
  const identities = opts.identities ?? CLIENT_IDENTITIES;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const gapMs = opts.perRequestGapMs ?? 250;
  const log = opts.log;
  const started = Date.now();
  const roundId = randomUUID();

  const stats: RoundStats = {
    roundId,
    resources: 0,
    requests: 0,
    got402: 0,
    notProbeable: 0,
    unreachable: 0,
    ourErrors: 0,
    rateLimited: 0,
    overcharge: 0,
    priceDiscrimination: 0,
    payToChanged: 0,
    slow: 0,
    quoteDrift: 0,
    halted: false,
    durationMs: 0,
  };

  const set = shuffle(listProbeSet(db), mulberry32(opts.orderSeed ?? Math.floor(Math.random() * 2 ** 32)));
  const insertProbe = db.prepare(INSERT_PROBE_SQL);
  const rateLimitedSellers = new Set<number>();
  let firstRequest = true;

  log.info(`probe round ${roundId}: ${set.length} resources x ${identities.length} identities`);

  const probeOne = async (row: ProbeSetRow, identity: ClientIdentity): Promise<ProbeOutcome> => {
    const req = buildRequest(row, identity);
    const ts = now();
    const base: ProbeInsert = {
      run_id: opts.runId ?? null,
      resource_id: row.resourceId,
      client_identity: identity.id,
      round_id: roundId,
      ts,
      method: req.method,
      request_headers_json: JSON.stringify(req.headers),
      status: null,
      headers_json: null,
      body_text: null,
      requirements_json: null,
      accepts_json: null,
      x402_version: null,
      amount_atomic: null,
      asset: null,
      network: null,
      pay_to: null,
      max_timeout_seconds: null,
      latency_ms: null,
      outcome: null,
      flags_json: "[]",
      reference_price_atomic: null,
      reference_source: null,
      error: null,
    };

    let q: QuoteResult | undefined;
    try {
      const qopts: Parameters<typeof fetchQuote>[1] = { method: req.method, headers: req.headers, timeoutMs };
      if (req.body !== undefined) qopts.body = req.body;
      if (opts.fetchImpl) qopts.fetchImpl = opts.fetchImpl;
      stats.requests++;
      q = await fetchQuote(row.url, qopts);

      const rec: ProbeInsert = { ...base, latency_ms: q.latencyMs };
      if (q.status !== undefined) rec.status = q.status;
      if (q.headers) rec.headers_json = JSON.stringify(q.headers);
      if (q.bodyText !== undefined) rec.body_text = q.bodyText;

      if (q.error) {
        rec.error = `unreachable:${unreachableKind(q)} | ${q.error.message}`;
        const id = Number(insertProbe.run(rec).lastInsertRowid);
        return { probeId: id, kind: "unreachable" };
      }

      if (q.status === 429) {
        // Taxonomy: a 429 is our_error with the rate_limited flag. Not retried this round.
        rec.outcome = OUTCOMES.OUR_ERROR;
        rec.flags_json = JSON.stringify([FLAGS.RATE_LIMITED]);
        rec.error = "rate_limited:429";
        const id = Number(insertProbe.run(rec).lastInsertRowid);
        return { probeId: id, kind: "rate_limited" };
      }

      if (q.status !== 402) {
        rec.error = `no_402:${q.status ?? "none"}`;
        const id = Number(insertProbe.run(rec).lastInsertRowid);
        return { probeId: id, kind: "not_probeable" };
      }

      const parsed = q.parsed;
      if (parsed) {
        if (parsed.version !== null) rec.x402_version = parsed.version;
        rec.accepts_json = JSON.stringify(parsed.accepts.map((a) => a.raw));
      }
      const sel = parsed ? pickRequirement(parsed.accepts, opts.network, row.asset) : undefined;
      if (!sel) {
        rec.error = parsed?.parseError ? `no_base_exact_requirement | ${parsed.parseError}` : "no_base_exact_requirement";
        const id = Number(insertProbe.run(rec).lastInsertRowid);
        return { probeId: id, kind: "not_probeable" };
      }

      rec.requirements_json = JSON.stringify(sel.raw);
      rec.amount_atomic = sel.amountAtomic;
      rec.asset = sel.asset;
      rec.network = opts.network;
      rec.pay_to = sel.payTo;
      rec.max_timeout_seconds = sel.maxTimeoutSeconds;

      if (!/^\d+$/.test(sel.amountAtomic)) {
        // The seller's quote is not an atomic-unit integer: a seller-side defect, not ours.
        rec.error = `invalid_amount:${sel.amountAtomic.slice(0, 64)}`;
        const id = Number(insertProbe.run(rec).lastInsertRowid);
        return { probeId: id, kind: "not_probeable" };
      }

      // Context from earlier probes of this resource (computed before this row is inserted).
      // With no earlier probe at all, this quote is the first price ever seen for the resource.
      const ref = referencePrice(db, row, ts) ?? { price: BigInt(sel.amountAtomic).toString(), source: REFERENCE_SOURCES.FIRST_SEEN };
      const prevPayTo = db
        .prepare(`SELECT pay_to FROM probes WHERE resource_id = ? AND pay_to IS NOT NULL ORDER BY ts DESC, id DESC LIMIT 1`)
        .get(row.resourceId) as { pay_to: string } | undefined;
      // Drift is measured per identity, so identity-dependent pricing shows up as price_discrimination
      // and not as an endless alternation of drift events.
      const prevAmount = db
        .prepare(
          `SELECT amount_atomic FROM probes WHERE resource_id = ? AND client_identity = ? AND amount_atomic IS NOT NULL
           ORDER BY ts DESC, id DESC LIMIT 1`,
        )
        .get(row.resourceId, identity.id) as { amount_atomic: string } | undefined;
      const payToChanged = prevPayTo !== undefined && prevPayTo.pay_to.toLowerCase() !== sel.payTo.toLowerCase();

      const cls = classify({
        paymentSent: false,
        paid: false,
        settlementCount: 0,
        responseReceived: true,
        responseStatus: 402,
        elapsedSinceSignMs: 0,
        quoteAmountAtomic: sel.amountAtomic,
        referencePriceAtomic: ref.price,
        referenceSource: ref.source,
        latencyMs: q.latencyMs,
        ...(Number.isFinite(sel.maxTimeoutSeconds) && sel.maxTimeoutSeconds > 0
          ? { declaredMaxTimeoutSeconds: sel.maxTimeoutSeconds }
          : {}),
        defaultMaxTimeoutSeconds: DEFAULT_MAX_TIMEOUT_SECONDS,
        // Probe rows never assess goods, so schema_missing is meaningless here.
        serviceConfigPresent: true,
        payToChanged,
      });
      rec.outcome = cls.outcome;
      rec.flags_json = JSON.stringify(cls.flags);
      rec.reference_price_atomic = ref.price;
      rec.reference_source = ref.source;

      const id = db.transaction(() => {
        const pid = Number(insertProbe.run(rec).lastInsertRowid);
        if (payToChanged && prevPayTo) {
          insertEvent(db, {
            resourceId: row.resourceId,
            ts,
            kind: "payto_changed",
            oldValue: prevPayTo.pay_to,
            newValue: sel.payTo,
            probeId: pid,
            details: { identity: identity.id, roundId },
          });
        }
        if (prevAmount && !sameAtomic(prevAmount.amount_atomic, sel.amountAtomic)) {
          insertEvent(db, {
            resourceId: row.resourceId,
            ts,
            kind: "quote_drift",
            oldValue: prevAmount.amount_atomic,
            newValue: sel.amountAtomic,
            probeId: pid,
            details: { identity: identity.id, roundId },
          });
          stats.quoteDrift++;
        }
        return pid;
      })();

      if (cls.outcome === OUTCOMES.OVERCHARGE) stats.overcharge++;
      if (cls.flags.includes(FLAGS.SLOW)) stats.slow++;
      if (payToChanged) stats.payToChanged++;
      return { probeId: id, kind: "quote", amount: sel.amountAtomic };
    } catch (e) {
      // A bug on our side. Record it so it is counted, never blamed on the seller.
      log.error(`probe: exception probing ${row.url} as ${identity.id}`, errMsg(e));
      try {
        const rec: ProbeInsert = { ...base, outcome: OUTCOMES.OUR_ERROR, error: `exception:${errMsg(e)}`.slice(0, 1000) };
        if (q?.status !== undefined) rec.status = q.status;
        if (q) rec.latency_ms = q.latencyMs;
        const id = Number(insertProbe.run(rec).lastInsertRowid);
        return { probeId: id, kind: "our_error" };
      } catch (e2) {
        log.error("probe: failed to record our_error row", errMsg(e2));
        return { probeId: null, kind: "our_error" };
      }
    }
  };

  for (const row of set) {
    if (haltRequested(opts.haltRoot)) {
      log.warn(`probe round ${roundId}: halt file present, stopping`);
      stats.halted = true;
      break;
    }
    if (opts.signal?.aborted) break;
    if (rateLimitedSellers.has(row.sellerId)) {
      log.debug(`probe: skipping ${row.url}, seller ${row.sellerDomain} rate-limited this round`);
      continue;
    }
    stats.resources++;

    const results: { identity: ClientIdentity; out: ProbeOutcome }[] = [];
    for (const identity of identities) {
      if (!firstRequest) await sleep(gapMs, opts.signal);
      firstRequest = false;
      const out = await probeOne(row, identity);
      results.push({ identity, out });
      switch (out.kind) {
        case "quote":
          stats.got402++;
          break;
        case "not_probeable":
          stats.notProbeable++;
          break;
        case "unreachable":
          stats.unreachable++;
          break;
        case "rate_limited":
          stats.rateLimited++;
          stats.ourErrors++;
          break;
        case "our_error":
          stats.ourErrors++;
          break;
      }
      if (out.kind === "rate_limited") {
        rateLimitedSellers.add(row.sellerId);
        break;
      }
    }

    try {
      if (detectPriceDiscrimination(db, row.resourceId, results, now(), roundId)) stats.priceDiscrimination++;
    } catch (e) {
      log.error(`probe: price discrimination check failed for ${row.url}`, errMsg(e));
    }
  }

  stats.durationMs = Date.now() - started;
  log.info(`probe round ${roundId} done`, stats);
  return stats;
}

/**
 * Any two probes of the same resource from different identities within
 * PRICE_DISCRIMINATION_WINDOW_MS with different amounts. Flags every involved row
 * and writes one price_events row per resource per round.
 */
function detectPriceDiscrimination(
  db: Db,
  resourceId: number,
  results: { identity: ClientIdentity; out: ProbeOutcome }[],
  at: number,
  roundId: string,
): boolean {
  const current = results.filter((r) => r.out.kind === "quote" && r.out.probeId !== null && r.out.amount !== undefined);
  if (current.length === 0) return false;
  const window = db
    .prepare(
      `SELECT id, client_identity, amount_atomic, ts FROM probes
       WHERE resource_id = ? AND amount_atomic IS NOT NULL AND ts >= ?
       ORDER BY ts, id`,
    )
    .all(resourceId, at - PRICE_DISCRIMINATION_WINDOW_MS) as { id: number; client_identity: string; amount_atomic: string; ts: number }[];

  const involved = new Map<number, { identity: string; amount: string }>();
  for (const c of current) {
    const cid = c.out.probeId as number;
    const camt = c.out.amount as string;
    const cts = window.find((w) => w.id === cid)?.ts ?? at;
    for (const w of window) {
      if (w.client_identity === c.identity.id) continue;
      if (Math.abs(w.ts - cts) > PRICE_DISCRIMINATION_WINDOW_MS) continue;
      if (sameAtomic(w.amount_atomic, camt)) continue;
      involved.set(cid, { identity: c.identity.id, amount: camt });
      involved.set(w.id, { identity: w.client_identity, amount: w.amount_atomic });
    }
  }
  if (involved.size === 0) return false;

  db.transaction(() => {
    for (const id of involved.keys()) addFlag(db, id, FLAGS.PRICE_DISCRIMINATION);
    const byIdentity: Record<string, string> = {};
    for (const c of current) byIdentity[c.identity.id] = c.out.amount as string;
    // For identities not quoted this round, fall back to their in-window amount.
    for (const v of involved.values()) if (byIdentity[v.identity] === undefined) byIdentity[v.identity] = v.amount;
    const ids = Object.keys(byIdentity).sort();
    const last = current[current.length - 1];
    insertEvent(db, {
      resourceId,
      ts: at,
      kind: "price_discrimination",
      oldValue: byIdentity[ids[0] as string] ?? null,
      newValue: byIdentity[ids[ids.length - 1] as string] ?? null,
      probeId: last?.out.probeId ?? null,
      details: { ...byIdentity, probeIds: [...involved.keys()].sort((a, b) => a - b), roundId },
    });
  })();
  return true;
}
