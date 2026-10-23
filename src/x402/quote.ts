/** Unpaid request + 402 parsing. Never signs anything. */
import { buildResponseRecord, headersToRecord, readBodyCapped, type FetchImpl } from "./http.js";
import { caip2Network, errMsg, parse402, type NormalizedRequirements } from "./types.js";

export const QUOTE_BODY_MAX_BYTES = 64 * 1024;

export interface QuoteOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Request body for POST-style endpoints. */
  body?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

export interface QuoteParsed {
  version: 1 | 2 | null;
  accepts: NormalizedRequirements[];
  envelope: unknown;
  parseError?: string;
}

export interface QuoteResult {
  url: string;
  status?: number;
  /** All response headers, lowercase keys. */
  headers?: Record<string, string>;
  /** Body text, at most 64 KB (UTF-8 decoded). */
  bodyText?: string;
  bodyTruncated?: boolean;
  latencyMs: number;
  /** Present only when status === 402. */
  parsed?: QuoteParsed;
  /** Network-level failure (DNS, connect, reset, timeout). */
  error?: { kind: "network" | "timeout"; message: string };
}

/** Turn an already-received response into a QuoteResult (reads at most 64 KB of the body). */
export async function quoteFromResponse(url: string, res: Response, startedAt: number): Promise<QuoteResult> {
  const headersAt = Date.now();
  const read = await readBodyCapped(res, QUOTE_BODY_MAX_BYTES);
  const rec = buildResponseRecord(res, read, startedAt, headersAt, Date.now());
  const bodyText = new TextDecoder("utf-8", { fatal: false }).decode(rec.body);
  const out: QuoteResult = {
    url,
    status: res.status,
    headers: rec.headers,
    bodyText,
    bodyTruncated: read.truncatedByUs,
    latencyMs: rec.latencyMs,
  };
  if (res.status === 402) out.parsed = parse402(rec.headers, bodyText);
  return out;
}

/**
 * Perform the unpaid request and parse any 402. Never throws for HTTP-level problems;
 * network errors and timeouts come back as `error`.
 */
export async function fetchQuote(url: string, opts: QuoteOptions = {}): Promise<QuoteResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const ac = new AbortController();
  let timedOut = false;
  const timer =
    opts.timeoutMs !== undefined
      ? setTimeout(() => {
          timedOut = true;
          ac.abort(new Error(`quote timed out after ${opts.timeoutMs}ms`));
        }, opts.timeoutMs)
      : undefined;
  const startedAt = Date.now();
  try {
    const init: RequestInit = { method: opts.method ?? "GET", signal: ac.signal, redirect: "follow" };
    if (opts.headers) init.headers = opts.headers;
    if (opts.body !== undefined) init.body = opts.body;
    const res = await fetchImpl(url, init);
    return await quoteFromResponse(url, res, startedAt);
  } catch (e) {
    return {
      url,
      latencyMs: Date.now() - startedAt,
      error: { kind: timedOut ? "timeout" : "network", message: timedOut ? `timeout after ${opts.timeoutMs}ms` : errMsg(causeOf(e)) },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** fetch() wraps socket errors as TypeError("fetch failed") with the real error in `cause`. */
export function causeOf(e: unknown): unknown {
  if (e instanceof Error && e.cause !== undefined) return new Error(`${e.message}: ${errMsg(e.cause)}`);
  return e;
}

export interface SelectOptions {
  /** CAIP-2 network (v1 names in the 402 are mapped, e.g. "base" -> "eip155:8453"). */
  network: string;
  /** Asset contract address (case-insensitive). */
  asset?: string;
  scheme: "exact";
}

/** First `exact` requirement on the given network (and asset, if given). */
export function selectRequirements(accepts: NormalizedRequirements[], opts: SelectOptions): NormalizedRequirements | undefined {
  return accepts.find(
    (r) =>
      r.scheme === opts.scheme &&
      caip2Network(r) === opts.network &&
      (opts.asset === undefined || r.asset.toLowerCase() === opts.asset.toLowerCase()),
  );
}

export { headersToRecord };
