/**
 * Paid request wrapper around the official SDK (@x402/core x402Client, @x402/evm ExactEvmScheme via
 * registerExactEvmScheme, @x402/fetch wrapFetchWithPayment). We never sign anything ourselves.
 *
 * Path taken for the pre-sign hook: the SDK has a true pre-sign hook. x402Client.createPaymentPayload
 * runs `onBeforePaymentCreation` hooks after requirement selection and BEFORE calling the scheme's
 * createPaymentPayload (which is what signs), and an `{ abort: true }` result throws before any
 * signature exists. So hooks.beforeSign is driven from onBeforePaymentCreation, and the 402
 * round-trip is the wrapper's own (we observe it through the injected inner fetch).
 *
 * No automatic retry: wrapFetchWithPayment re-signs and retries once only when an onPaymentResponse
 * hook returns { recovered: true }. We register no onPaymentResponse hooks, ExactEvmScheme(V1) define
 * no schemeHooks, and the inner fetch additionally refuses to send a second paid request.
 */
import { x402Client, type PaymentPolicy } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAX_BODY_BYTES } from "../taxonomy.js";
import type { RequestRecord, ResponseRecord } from "../validators/types.js";
import { buildResponseRecord, headersToRecord, readBodyCapped, type FetchImpl } from "./http.js";
import { causeOf, quoteFromResponse, type QuoteResult } from "./quote.js";
import { decodeSettlementHeader } from "./settlement.js";
import {
  HEADERS,
  PaymentRequirementsSchema,
  PaymentRequirementsV1Schema,
  ResourceInfoSchema,
  caip2Network,
  errMsg,
  normalizeV1,
  normalizeV2,
  type NormalizedRequirements,
  type SettlementResponse,
} from "./types.js";

export type PayNetwork = "eip155:8453" | "eip155:84532";

export class CapViolation extends Error {
  override readonly name = "CapViolation";
  constructor(
    message: string,
    readonly detail: { value?: string; maxAmountAtomic: string; to?: string; payTo?: string },
  ) {
    super(message);
  }
}

export interface SignedAuthorization {
  nonce: string;
  validAfter: string;
  validBefore: string;
  value: string;
  to: string;
  from: string;
}

export interface AfterSignInfo extends SignedAuthorization {
  signature: string;
  /** JSON.stringify of the full PaymentPayload that will be base64'd into the header. */
  payloadJson: string;
}

export interface PayHooks {
  /** Called with the selected requirements before any signature is produced. */
  beforeSign(requirements: NormalizedRequirements): Promise<"proceed" | { abort: string }>;
  /** Called after signing and BEFORE the paid request is sent. Make ledger writes durable before resolving. */
  afterSign(info: AfterSignInfo): Promise<void>;
}

export interface PayerOptions {
  privateKey: `0x${string}`;
  network: PayNetwork;
  rpcUrl?: string;
  maxAmountAtomic: bigint;
  fetchImpl?: FetchImpl;
  /** Default timeout, applied separately to the quote request and to the paid request (headers + body). */
  timeoutMs?: number;
}

export interface PayInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Overrides PayerOptions.timeoutMs for this call. */
  timeoutMs?: number;
  /** Stress test: abort (close the connection) this many ms after the paid request is sent. */
  abortAfterMs?: number;
}

export type PayErrorKind = "network" | "timeout" | "aborted" | "cap" | "no_quote" | "declined" | "sdk";

export interface PaidResult {
  request: RequestRecord;
  response?: ResponseRecord;
  settlement?: SettlementResponse;
  settlementHeaderRaw?: string;
  settlementParseError?: string;
  signed?: SignedAuthorization;
  quote: NormalizedRequirements | undefined;
  /** Raw unpaid-request result (status, headers, parsed 402). */
  quoteResult?: QuoteResult;
  error?: { kind: PayErrorKind; message: string };
  timing: { quoteMs?: number; signMs?: number; paidRequestMs?: number; totalMs: number };
}

export interface Payer {
  address: string;
  network: PayNetwork;
  payAndFetch(url: string, init: PayInit, hooks: PayHooks): Promise<PaidResult>;
}

type ErrState = { kind: PayErrorKind; message: string };

function sdkNetwork(x402Version: number, network: string): string {
  return caip2Network({ x402Version: x402Version === 1 ? 1 : 2, network });
}

function buildParams(url: string, body: string | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  try {
    new URL(url).searchParams.forEach((v, k) => {
      params[k] = v;
    });
  } catch {
    /* relative/invalid URL: no params */
  }
  if (body) {
    try {
      const j: unknown = JSON.parse(body);
      if (j && typeof j === "object" && !Array.isArray(j)) Object.assign(params, j);
    } catch {
      /* non-JSON body */
    }
  }
  return params;
}

function eqAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

export function createPayer(opts: PayerOptions): Payer {
  const account = privateKeyToAccount(opts.privateKey);
  const baseFetch: FetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const network = opts.network;
  const maxAtomic = opts.maxAmountAtomic;

  async function payAndFetch(url: string, init: PayInit, hooks: PayHooks): Promise<PaidResult> {
    const t0 = Date.now();
    const timeoutMs = init.timeoutMs ?? opts.timeoutMs;
    const method = (init.method ?? "GET").toUpperCase();

    // ---- per-call state, observed from SDK hooks and the inner fetch ----
    let request: RequestRecord = {
      url,
      method,
      headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      params: buildParams(url, init.body),
      sentAt: t0,
    };
    if (init.body !== undefined) request.body = init.body;
    let quoteResult: QuoteResult | undefined;
    let quoteMs: number | undefined;
    let quote: NormalizedRequirements | undefined;
    let signStart: number | undefined;
    let signMs: number | undefined;
    let signed: SignedAuthorization | undefined;
    let failure: ErrState | undefined; // set by hooks; takes precedence over the SDK's wrapped error
    let quoteTimedOut = false;
    let quoteTimer: NodeJS.Timeout | undefined;
    let paidCount = 0;
    let paidStart: number | undefined;
    let paidHeadersAt: number | undefined;
    let paidAbort: "timeout" | "aborted" | undefined;
    const paidTimers: NodeJS.Timeout[] = [];

    // ---- SDK client, fresh per call so hook closures are per-call ----
    const client = new x402Client();
    client.setSpendControls(false); // harness enforces its own caps (disables "$1" + default-asset allow-list)
    const policy: PaymentPolicy = (version, reqs) =>
      reqs.filter(
        (r) =>
          r.scheme === "exact" &&
          sdkNetwork(version, r.network) === network &&
          ((r.extra?.assetTransferMethod as string | undefined) ?? "eip3009") === "eip3009",
      );
    const schemeOptions = opts.rpcUrl ? { rpcUrl: opts.rpcUrl } : undefined;
    registerExactEvmScheme(client, {
      signer: account,
      networks: [network],
      policies: [policy],
      ...(schemeOptions ? { schemeOptions } : {}),
    });

    client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
      signStart = Date.now();
      // Normalise what the SDK selected, validating it with our own schemas.
      let norm: NormalizedRequirements | undefined;
      if (paymentRequired.x402Version === 2) {
        const r = PaymentRequirementsSchema.safeParse(selectedRequirements);
        const res = ResourceInfoSchema.safeParse(paymentRequired.resource);
        if (r.success) norm = { ...normalizeV2(r.data, { resource: res.success ? res.data : undefined }), raw: selectedRequirements };
      } else if (paymentRequired.x402Version === 1) {
        const r = PaymentRequirementsV1Schema.safeParse(selectedRequirements);
        if (r.success) norm = { ...normalizeV1(r.data), raw: selectedRequirements };
      }
      if (!norm) {
        failure = { kind: "no_quote", message: "selected requirements failed schema validation" };
        return { abort: true, reason: failure.message };
      }
      quote = norm;
      if (norm.scheme !== "exact" || caip2Network(norm) !== network) {
        failure = { kind: "sdk", message: `SDK selected ${norm.scheme}/${norm.network}, expected exact/${network}` };
        return { abort: true, reason: failure.message };
      }
      if (!/^\d+$/.test(norm.amountAtomic) || BigInt(norm.amountAtomic) > maxAtomic) {
        failure = { kind: "cap", message: `requirement amount ${norm.amountAtomic} exceeds maxAmountAtomic ${maxAtomic}` };
        return { abort: true, reason: failure.message };
      }
      let decision: Awaited<ReturnType<PayHooks["beforeSign"]>>;
      try {
        decision = await hooks.beforeSign(norm);
      } catch (e) {
        failure = { kind: "sdk", message: `beforeSign hook threw: ${errMsg(e)}` };
        return { abort: true, reason: failure.message };
      }
      if (decision !== "proceed") {
        failure = { kind: "declined", message: decision.abort };
        return { abort: true, reason: decision.abort };
      }
      return undefined;
    });

    client.onAfterPaymentCreation(async ({ paymentPayload }) => {
      const signedAt = Date.now();
      if (signStart !== undefined) signMs = signedAt - signStart;
      const p = paymentPayload.payload as {
        signature?: unknown;
        authorization?: Record<string, unknown>;
      };
      const a = p.authorization;
      if (!a || typeof p.signature !== "string") {
        failure = { kind: "sdk", message: "signed payload has no EIP-3009 authorization/signature" };
        throw new Error(failure.message);
      }
      const s: SignedAuthorization = {
        nonce: String(a.nonce),
        validAfter: String(a.validAfter),
        validBefore: String(a.validBefore),
        value: String(a.value),
        to: String(a.to),
        from: String(a.from),
      };
      signed = s;
      // Hard assertions before anything leaves the process.
      const payTo = quote?.payTo ?? "";
      if (!/^\d+$/.test(s.value) || BigInt(s.value) > maxAtomic) {
        const err = new CapViolation(`signed value ${s.value} exceeds maxAmountAtomic ${maxAtomic}`, {
          value: s.value,
          maxAmountAtomic: maxAtomic.toString(),
        });
        failure = { kind: "cap", message: err.message };
        throw err;
      }
      if (!eqAddress(s.to, payTo)) {
        const err = new CapViolation(`signed to ${s.to} does not match requirements.payTo ${payTo}`, {
          to: s.to,
          payTo,
          maxAmountAtomic: maxAtomic.toString(),
        });
        failure = { kind: "cap", message: err.message };
        throw err;
      }
      try {
        await hooks.afterSign({ ...s, signature: p.signature, payloadJson: JSON.stringify(paymentPayload) });
      } catch (e) {
        failure = { kind: "sdk", message: `afterSign hook threw: ${errMsg(e)}` };
        throw e;
      }
    });

    // ---- inner fetch: sees the unpaid request and the single paid request ----
    const innerFetch = async (input: string | URL | Request, rinit?: RequestInit): Promise<Response> => {
      const req = input instanceof Request ? input : new Request(input, rinit);
      const isPaid = req.headers.has(HEADERS.V2_SIGNATURE) || req.headers.has(HEADERS.V1_PAYMENT);
      const headers = headersToRecord(req.headers);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
      const ac = new AbortController();
      const fInit: RequestInit = { method: req.method, headers, signal: ac.signal };
      if (body !== undefined && body !== "") fInit.body = body;

      if (!isPaid) {
        if (timeoutMs !== undefined)
          quoteTimer = setTimeout(() => {
            quoteTimedOut = true;
            ac.abort(new Error("quote timeout"));
          }, timeoutMs);
        fInit.redirect = "follow";
        const start = Date.now();
        const res = await baseFetch(req.url, fInit);
        if (res.status !== 402) return res; // body read later by payAndFetch, timer still armed
        try {
          quoteResult = await quoteFromResponse(req.url, res, start);
        } finally {
          clearTimeout(quoteTimer);
        }
        quoteMs = Date.now() - start;
        // Hand the wrapper an equivalent 402 (we consumed the original body).
        return new Response(quoteResult.bodyText ?? "", { status: 402, headers: res.headers });
      }

      paidCount++;
      if (paidCount > 1) throw new Error("x402-audit: refusing a second paid request (automatic retry is disabled)");
      paidStart = Date.now();
      request = { url: req.url, method: req.method, headers, params: buildParams(req.url, body), sentAt: paidStart };
      if (body !== undefined && body !== "") request.body = body;
      if (timeoutMs !== undefined)
        paidTimers.push(
          setTimeout(() => {
            paidAbort ??= "timeout";
            ac.abort(new Error("paid request timeout"));
          }, timeoutMs),
        );
      if (init.abortAfterMs !== undefined)
        paidTimers.push(
          setTimeout(() => {
            paidAbort ??= "aborted";
            ac.abort(new Error("aborted by abortAfterMs"));
          }, init.abortAfterMs),
        );
      // Do not follow redirects: a redirect would re-send PAYMENT-SIGNATURE to another URL.
      fInit.redirect = "manual";
      const res = await baseFetch(req.url, fInit);
      paidHeadersAt = Date.now();
      return res;
    };

    const fetchWithPay = wrapFetchWithPayment(innerFetch as typeof globalThis.fetch, client);
    const reqInit: RequestInit = { method };
    if (init.headers) reqInit.headers = init.headers;
    if (init.body !== undefined) reqInit.body = init.body;

    const finish = (extra: Partial<PaidResult>): PaidResult => {
      for (const t of paidTimers) clearTimeout(t);
      if (quoteTimer) clearTimeout(quoteTimer);
      const timing: PaidResult["timing"] = { totalMs: Date.now() - t0 };
      if (quoteMs !== undefined) timing.quoteMs = quoteMs;
      if (signMs !== undefined) timing.signMs = signMs;
      if (paidStart !== undefined) timing.paidRequestMs = Date.now() - paidStart;
      const out: PaidResult = { request, quote, timing, ...extra };
      if (signed) out.signed = signed;
      if (quoteResult) out.quoteResult = quoteResult;
      return out;
    };

    const classify = (e: unknown): ErrState => {
      if (failure) return failure;
      if (paidCount > 0 && paidAbort === "timeout") return { kind: "timeout", message: `paid request timed out after ${timeoutMs}ms` };
      if (paidCount > 0 && paidAbort === "aborted") return { kind: "aborted", message: `paid request aborted after ${init.abortAfterMs}ms` };
      if (quoteTimedOut) return { kind: "timeout", message: `quote timed out after ${timeoutMs}ms` };
      if (e instanceof TypeError && /fetch failed|terminated|network/i.test(e.message)) return { kind: "network", message: errMsg(causeOf(e)) };
      if (quoteResult && signStart === undefined)
        return { kind: "no_quote", message: quoteResult.parsed?.parseError ?? errMsg(e) };
      return { kind: "sdk", message: errMsg(causeOf(e)) };
    };

    let res: Response;
    try {
      res = await fetchWithPay(url, reqInit);
    } catch (e) {
      return finish({ error: classify(e) });
    }

    // Read the final body (paid response, or the unpaid non-402 response).
    const startedAt = paidCount > 0 ? (paidStart ?? t0) : t0;
    const headersAt = paidCount > 0 ? (paidHeadersAt ?? Date.now()) : Date.now();
    const read = await readBodyCapped(res, MAX_BODY_BYTES);
    const response = buildResponseRecord(res, read, startedAt, headersAt, Date.now());
    const extra: Partial<PaidResult> = { response };

    if (paidCount === 0) {
      extra.error = {
        kind: "no_quote",
        message: quoteResult ? "402 received but no payment was attempted" : `expected 402 on unpaid request, got ${res.status}`,
      };
      return finish(extra);
    }

    const st = decodeSettlementHeader(response.headers);
    if (st.parsed) extra.settlement = st.parsed;
    if (st.raw !== undefined) extra.settlementHeaderRaw = st.raw;
    if (st.parseError !== undefined) extra.settlementParseError = st.parseError;
    if (read.incomplete && paidAbort === "timeout") extra.error = { kind: "timeout", message: `paid response body timed out after ${timeoutMs}ms` };
    else if (read.incomplete && paidAbort === "aborted") extra.error = { kind: "aborted", message: `paid response aborted after ${init.abortAfterMs}ms` };
    return finish(extra);
  }

  return { address: account.address, network, payAndFetch };
}
