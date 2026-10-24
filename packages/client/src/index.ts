/**
 * @x402-audit/client: opt-in, anonymised outcome telemetry for x402 paid API calls.
 *
 * `withAudit(fetchWithPayment, opts)` returns a fetch-compatible function. The caller always gets
 * the inner Response object untouched and without extra delay; validation, classification and the
 * telemetry POST happen in the background and can never throw into the caller.
 *
 * What the client can and cannot see:
 * - It cannot see the chain. `settlementCount` is 1 when the seller's settlement header says
 *   success, else 0. Duplicate settlements are therefore never detected client-side.
 * - It has no reference price, so `overcharge` is never produced client-side.
 * - It sits outside the x402 payment wrapper, so it learns that a payment happened from a
 *   PAYMENT-SIGNATURE / X-PAYMENT header on the caller's own request, or from a
 *   PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header on the response. Calls with neither are not
 *   reported (nothing was paid as far as the client can tell).
 */
import { classify } from "x402-audit/classify";
import { MAX_BODY_BYTES, type Flag, type Outcome, type ValidatorName } from "x402-audit/taxonomy";
import { readBodyCapped } from "x402-audit/x402/http";
import { runAllValidators } from "x402-audit/validators";
import type { RequestRecord, ResponseRecord, ServiceConfig, ValidationContext, ValidatorResult } from "x402-audit/validators/types";

export const CLIENT_VERSION = "0.1.0";
export const TELEMETRY_ENV_VAR = "X402_AUDIT_TELEMETRY";
export const SEND_TIMEOUT_MS = 3000;
const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ValidatorStatus = "pass" | "fail" | "skipped";

/** The exact record POSTed to the ingest endpoint. Nothing else is ever sent. */
export interface TelemetryRecord {
  v: 1;
  source_id: string;
  client_version: string;
  /** Client clock, ms since epoch, when the call started. */
  ts: number;
  /** sha256 hex of `${METHOD} ${origin}${pathname}` (no query string, no fragment). */
  resource_hash: string;
  seller_domain: string;
  /** From the settlement header, when present. */
  network?: string;
  outcome: Outcome;
  flags: Flag[];
  /** Atomic units from the settlement header `amount`, when present. */
  amount_atomic?: string;
  latency_ms: number;
  /** HTTP status, or 0 when no response was received. */
  status: number;
  validators: Partial<Record<ValidatorName, ValidatorStatus>>;
  /** Only when includeWallet === true and the settlement header carries `payer`. */
  wallet?: string;
}

export interface AuditOptions {
  /** Ingest URL, e.g. https://ingest.example/v1/calls */
  endpoint: string;
  /** Stable, operator-chosen identifier for this agent/deployment. */
  sourceId: string;
  /** Sent as `Authorization: Bearer <token>` to the ingest endpoint. */
  token?: string;
  /** Copy the settlement header's `payer` address into the record. Default false. */
  includeWallet?: boolean;
  /** Optional per-seller validation config, keyed by hostname (same shape as config/schemas/<domain>.json). */
  serviceConfigs?: Record<string, ServiceConfig>;
  /** Used for the `slow` flag. Default 60. */
  defaultMaxTimeoutSeconds?: number;
  /** Called with each record before it is sent (also when sending is disabled by env). Errors are swallowed. */
  onRecord?: (r: TelemetryRecord) => void;
  /** fetch used to POST records. Defaults to globalThis.fetch (never the wrapped payment fetch). */
  sendFetch?: FetchLike;
}

interface SettlementInfo {
  success: boolean;
  network?: string;
  payer?: string;
  amount?: string;
}

function telemetryDisabled(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const v = env?.[TELEMETRY_ENV_VAR];
  return v !== undefined && ["off", "0", "false", "no", "disabled"].includes(v.trim().toLowerCase());
}

function base64ToUtf8(b64: string): string {
  const v = b64.trim();
  if (typeof globalThis.atob === "function") {
    const bin = globalThis.atob(v);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(v, "base64").toString("utf8");
  throw new Error("no base64 decoder available");
}

/** Decode PAYMENT-RESPONSE (v2) or X-PAYMENT-RESPONSE (v1). Returns undefined if absent or unparseable. */
export function decodeSettlement(headers: Headers): SettlementInfo | undefined {
  const raw = headers.get("payment-response") || headers.get("x-payment-response");
  if (!raw) return undefined;
  try {
    const j = JSON.parse(base64ToUtf8(raw)) as Record<string, unknown>;
    if (!j || typeof j !== "object" || typeof j.success !== "boolean") return undefined;
    const out: SettlementInfo = { success: j.success };
    if (typeof j.network === "string" && j.network) out.network = j.network;
    if (typeof j.payer === "string" && j.payer) out.payer = j.payer;
    if (typeof j.amount === "string" && /^\d+$/.test(j.amount)) out.amount = j.amount;
    return out;
  } catch {
    return undefined;
  }
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** sha256 hex via Web Crypto, falling back to node:crypto. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return toHex(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const nodeCrypto = (await import("node:crypto")) as typeof import("node:crypto");
  return nodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** The resource identity: METHOD + " " + URL without query string or fragment. */
export function resourceKey(method: string, url: string): string {
  const u = new URL(url);
  return `${method.toUpperCase()} ${u.origin}${u.pathname}`;
}

export async function resourceHash(method: string, url: string): Promise<string> {
  return sha256Hex(resourceKey(method, url));
}

interface OutgoingInfo {
  url: string;
  method: string;
  headers: Headers;
  bodyText?: string;
}

function describeRequest(input: string | URL | Request, init?: RequestInit): OutgoingInfo {
  const isReq = typeof Request !== "undefined" && input instanceof Request;
  const url = isReq ? input.url : input instanceof URL ? input.href : String(input);
  const method = (init?.method ?? (isReq ? input.method : "GET")).toUpperCase();
  const headers = new Headers(isReq ? input.headers : undefined);
  if (init?.headers) new Headers(init.headers).forEach((v, k) => headers.set(k, v));
  const out: OutgoingInfo = { url, method, headers };
  if (typeof init?.body === "string") out.bodyText = init.body;
  return out;
}

function requestParams(o: OutgoingInfo): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  try {
    new URL(o.url).searchParams.forEach((v, k) => {
      params[k] = v;
    });
  } catch {
    /* ignore */
  }
  if (o.bodyText) {
    try {
      const j = JSON.parse(o.bodyText) as unknown;
      if (j && typeof j === "object" && !Array.isArray(j)) Object.assign(params, j);
    } catch {
      /* not JSON */
    }
  }
  return params;
}

function headersRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function paymentHeaderSent(h: Headers): boolean {
  return Boolean(h.get("payment-signature") || h.get("x-payment"));
}

interface BuildArgs {
  opts: AuditOptions;
  out: OutgoingInfo;
  startedAt: number;
  latencyMs: number;
  res?: Response;
  /** The clone the validators read; undefined when no response. */
  clone?: Response;
}

/** Build the record for one call, or undefined when there is no evidence that a payment was sent. */
export async function buildRecord(a: BuildArgs): Promise<TelemetryRecord | undefined> {
  const { opts, out, res } = a;
  const settlement = res ? decodeSettlement(res.headers) : undefined;
  const paymentSent = paymentHeaderSent(out.headers) || settlement !== undefined;
  if (!paymentSent) {
    if (a.clone) a.clone.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const u = new URL(out.url);
  const host = u.hostname.toLowerCase();
  const service = opts.serviceConfigs?.[host];

  let validators: Partial<Record<ValidatorName, ValidatorResult>> | undefined;
  let truncatedByUs = false;
  if (res && a.clone) {
    const read = await readBodyCapped(a.clone, MAX_BODY_BYTES);
    truncatedByUs = read.truncatedByUs;
    const request: RequestRecord = {
      url: out.url,
      method: out.method,
      headers: headersRecord(out.headers),
      params: requestParams(out),
      sentAt: a.startedAt,
    };
    if (out.bodyText !== undefined) request.body = out.bodyText;
    const response: ResponseRecord = {
      status: res.status,
      headers: headersRecord(res.headers),
      body: read.body,
      truncatedByUs: read.truncatedByUs,
      incomplete: read.incomplete,
      receivedAt: Date.now(),
      latencyMs: a.latencyMs,
    };
    if (read.declaredLength !== undefined) response.declaredLength = read.declaredLength;
    const ctx: ValidationContext = { request, response, requirements: {}, now: Date.now() };
    if (service) ctx.service = service;
    validators = await runAllValidators(ctx);
  }

  const c = classify({
    paymentSent: true,
    settlementCount: settlement?.success ? 1 : 0,
    responseReceived: res !== undefined,
    ...(res ? { responseStatus: res.status } : {}),
    elapsedSinceSignMs: Date.now() - a.startedAt,
    quoteAmountAtomic: settlement?.amount ?? "0",
    paid: true,
    ...(validators ? { validators } : {}),
    latencyMs: a.latencyMs,
    defaultMaxTimeoutSeconds: opts.defaultMaxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    serviceConfigPresent: service !== undefined,
    truncatedByUs,
  });

  const statuses: Partial<Record<ValidatorName, ValidatorStatus>> = {};
  for (const [name, r] of Object.entries(validators ?? {}) as Array<[ValidatorName, ValidatorResult]>) {
    statuses[name] = r.status;
  }

  const record: TelemetryRecord = {
    v: 1,
    source_id: opts.sourceId,
    client_version: CLIENT_VERSION,
    ts: a.startedAt,
    resource_hash: await resourceHash(out.method, out.url),
    seller_domain: host,
    outcome: c.outcome,
    flags: c.flags,
    latency_ms: Math.max(0, Math.round(a.latencyMs)),
    status: res?.status ?? 0,
    validators: statuses,
  };
  if (settlement?.network) record.network = settlement.network;
  if (settlement?.amount) record.amount_atomic = settlement.amount;
  if (opts.includeWallet === true && settlement?.payer) record.wallet = settlement.payer;
  return record;
}

/** Fire-and-forget POST with a hard timeout. Never throws. */
export async function sendRecord(opts: AuditOptions, record: TelemetryRecord): Promise<boolean> {
  try {
    const f = opts.sendFetch ?? globalThis.fetch;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await f(opts.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(record),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    res.body?.cancel().catch(() => undefined);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Wrap a (payment-enabled) fetch so that each paid call is validated, classified and reported.
 * The returned function resolves to exactly the Response the inner fetch produced.
 */
export function withAudit(fetchImpl: FetchLike, opts: AuditOptions): FetchLike & { flush(): Promise<void> } {
  const pending = new Set<Promise<void>>();
  const track = (p: Promise<void>): void => {
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  const report = async (args: BuildArgs): Promise<void> => {
    try {
      const record = await buildRecord(args);
      if (!record) return;
      try {
        opts.onRecord?.(record);
      } catch {
        /* caller hook must never break us */
      }
      if (telemetryDisabled()) return;
      await sendRecord(opts, record);
    } catch {
      /* never surface */
    }
  };

  const audited = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (telemetryDisabled() && !opts.onRecord) return fetchImpl(input, init);
    let out: OutgoingInfo | undefined;
    try {
      out = describeRequest(input, init);
    } catch {
      out = undefined;
    }
    const startedAt = Date.now();
    const t0 = typeof performance !== "undefined" ? performance.now() : startedAt;
    const elapsed = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
    let res: Response;
    try {
      res = await fetchImpl(input, init);
    } catch (e) {
      if (out) track(report({ opts, out, startedAt, latencyMs: elapsed() }));
      throw e;
    }
    const latencyMs = elapsed();
    if (out) {
      let clone: Response | undefined;
      try {
        clone = res.bodyUsed ? undefined : res.clone();
      } catch {
        clone = undefined;
      }
      const args: BuildArgs = { opts, out, startedAt, latencyMs, res };
      if (clone) args.clone = clone;
      track(report(args));
    }
    return res;
  };

  return Object.assign(audited, {
    /** Resolves once all in-flight reports have been sent or given up (useful before process exit, and in tests). */
    async flush(): Promise<void> {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
  });
}

export type { ServiceConfig } from "x402-audit/validators/types";
