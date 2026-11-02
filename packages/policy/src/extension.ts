/**
 * paidforExtension(): the resource-level check before a payment and the outcome report after it, on the
 * x402 core client's hooks.
 *
 *   onBeforePaymentCreation  GET {indexUrl}/check?url=<resource>; on a refused verdict returns { abort: true }
 *                            so the client throws before the scheme signs anything.
 *   onAfterPaymentCreation   Records what was signed (payer, nonce, pay-to, amount, network, asset, timeout).
 *   onPaymentResponse        Attaches the settlement result (tx hash, success) from the seller's header.
 *
 * `ClientExtension.hooks` in @x402/core 2.28 run only for extension keys the seller declared in its 402
 * (`getLabeledHooks` scopes them to `extensionKeysInUse`), so this object is not registered with
 * `client.registerExtension`: `install(client)` adds the three hooks with the client's own
 * onBeforePaymentCreation / onAfterPaymentCreation / onPaymentResponse, which run for every payment.
 *
 * The response hook never sees the HTTP status of the paid response (x402HTTPClient.processPaymentResult receives
 * it and does not forward it), and whether the seller delivered is exactly that status. `wrapFetch(fetch)` gives
 * the extension that view: pass the returned fetch to wrapFetchWithPayment and each paid call is reported as `ok`
 * (2xx) or `non_delivery`. Without it, only payments the seller rejected (`error`) are reported.
 */
import type { PaymentCreatedContext, PaymentCreationContext, PaymentResponseContext, x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import { BASE_MAINNET, CLIENT_HEADER, CLIENT_ID, DEFAULT_INDEX_URL, USDC_BASE, errMsg, resourceKey, trimSlash, type FailMode, type FetchInput, type FetchLike, type Verdict } from "./constants.js";
import { REPORT_TIMEOUT_MS, buildProof, buildRow, sendRow, toCaip2, type ReportOutcome, type SendResult, type TelemetryRow } from "./report.js";

export const DEFAULT_CHECK_TIMEOUT_MS = 1500;
export const DEFAULT_CHECK_CACHE_MS = 5 * 60 * 1000;
const MAX_PENDING = 1000;
const MAX_CACHE = 1000;
const VERDICTS: ReadonlySet<string> = new Set<Verdict>(["avoid", "caution", "ok", "unknown"]);

export interface PaidforExtensionOptions {
  /** Default https://paidfor.dev/v1. */
  indexUrl?: string;
  /** fetch used for index requests (check and report). Default globalThis.fetch. */
  fetch?: FetchLike;
  /** Timeout for the pre-pay check. Default 1.5 s. */
  checkTimeoutMs?: number;
  /** How long one check answer is reused for the same resource. Default 5 min. */
  checkCacheMs?: number;
  /**
   * "open" (default): a check that fails or times out lets the payment proceed. "closed": it aborts the payment.
   */
  failMode?: FailMode;
  /** Verdicts that abort the payment. Default ["avoid"]. */
  refuseVerdicts?: Verdict[];
  /** Send outcome reports. Default true. */
  report?: boolean;
  /** Timeout for one report. Default 10 s (the index checks the chain before answering). */
  reportTimeoutMs?: number;
  /** Called after each pre-pay check. Errors are swallowed. */
  onCheck?: (c: CheckEvent) => void;
  /** Called with each row sent and the index's answer, or why a payment was not reported. Errors are swallowed. */
  onReport?: (r: ReportEvent) => void;
  /** One line per refusal. Default console.warn; pass false for silence. */
  warn?: ((message: string) => void) | false;
}

export interface CheckEvent {
  /** origin + path of the resource, exactly what was sent to the index. */
  url: string;
  verdict: Verdict | null;
  /** True when the payment was aborted because of this check. */
  refused: boolean;
  fromCache: boolean;
  seller: { domain: string; evidenceUrl: string | null; failureRate: number | null; calls: number | null } | null;
  verdictText: string | null;
  error: string | null;
}

export type ReportEvent =
  | { kind: "sent"; row: TelemetryRow; result: SendResult }
  | { kind: "skipped"; reason: "network" | "asset" | "malformed" | "status_unknown" | "disabled"; nonce: string | null; url: string | null };

export interface ExtensionStatus {
  checks: number;
  refusals: number;
  reported: number;
  /** Settled payments whose HTTP status the extension never saw (install wrapFetch to report them). */
  unreported: number;
  pending: number;
}

export interface PaidforExtension {
  readonly key: "paidfor";
  /** The three hook functions, for callers who register them themselves. */
  readonly hooks: {
    onBeforePaymentCreation(ctx: PaymentCreationContext): Promise<void | { abort: true; reason: string }>;
    onAfterPaymentCreation(ctx: PaymentCreatedContext): Promise<void>;
    onPaymentResponse(ctx: PaymentResponseContext): Promise<void>;
  };
  /** Register the hooks on a client. Returns the client. */
  install(client: x402Client): x402Client;
  /**
   * Wrap the fetch you pass to wrapFetchWithPayment. Requests without a payment header pass straight through;
   * for a paid request the status and settlement header of the response complete the report.
   */
  wrapFetch(inner?: FetchLike): FetchLike;
  /** Resolves once every in-flight report has been sent or given up (before process exit, and in tests). */
  flush(): Promise<void>;
  status(): ExtensionStatus;
}

interface CheckAnswer {
  verdict: Verdict;
  seller: CheckEvent["seller"];
  verdictText: string | null;
  at: number;
}

interface Pending {
  nonce: string;
  payer: string;
  payTo: string;
  value: bigint;
  network: string;
  scheme: string;
  asset: string;
  timeoutS: number;
  url: string | null;
  signedAt: number;
  unknownSeller: boolean;
  // From the response hook.
  hookDone: boolean;
  settleSuccess: boolean | null;
  txHash: string | null;
  reverify: boolean;
  // From the transport view.
  status: number | undefined;
  respondedAt: number | undefined;
  transportError: string | undefined;
  sent: boolean;
}

interface AuthorizationLike {
  from?: unknown;
  to?: unknown;
  value?: unknown;
  nonce?: unknown;
}

/** payer, nonce, pay-to, value out of an exact-EVM payment payload (v2 or v1); null for other schemes. */
function authorizationOf(paymentPayload: unknown): { from: string; to: string; value: bigint; nonce: string } | null {
  const p = paymentPayload as { payload?: { authorization?: AuthorizationLike } } | null;
  const a = p?.payload?.authorization;
  if (!a || typeof a.from !== "string" || typeof a.to !== "string" || typeof a.nonce !== "string") return null;
  const value = typeof a.value === "string" || typeof a.value === "number" || typeof a.value === "bigint" ? String(a.value) : "";
  if (!/^\d+$/.test(value)) return null;
  return { from: a.from, to: a.to, value: BigInt(value), nonce: a.nonce.toLowerCase() };
}

function nonceOf(paymentPayload: unknown): string | null {
  return authorizationOf(paymentPayload)?.nonce ?? null;
}

/** The resource URL a payment is for: the v2 envelope's resource, or the v1 requirement's `resource`. */
function resourceUrlOf(ctx: PaymentCreationContext): string | null {
  const pr = ctx.paymentRequired as { resource?: { url?: unknown } } | null;
  const v2 = pr?.resource?.url;
  if (typeof v2 === "string" && v2) return v2;
  const v1 = (ctx.selectedRequirements as { resource?: unknown }).resource;
  return typeof v1 === "string" && v1 ? v1 : null;
}

function decodeSignature(header: string): unknown {
  try {
    return decodePaymentSignatureHeader(header);
  } catch {
    return null;
  }
}

function headersOf(input: FetchInput, init?: RequestInit): Headers {
  if (typeof Request !== "undefined" && input instanceof Request) return input.headers;
  return new Headers(init?.headers);
}

function urlOf(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function paidforExtension(options: PaidforExtensionOptions = {}): PaidforExtension {
  const indexUrl = trimSlash(options.indexUrl ?? DEFAULT_INDEX_URL);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const checkTimeoutMs = options.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const checkCacheMs = options.checkCacheMs ?? DEFAULT_CHECK_CACHE_MS;
  const failMode: FailMode = options.failMode ?? "open";
  const refuse: ReadonlySet<Verdict> = new Set(options.refuseVerdicts ?? ["avoid"]);
  const report = options.report !== false;
  const reportTimeoutMs = options.reportTimeoutMs ?? REPORT_TIMEOUT_MS;
  const warn = options.warn === undefined ? (m: string) => console.warn(m) : options.warn;

  const cache = new Map<string, CheckAnswer>();
  const pending = new Map<string, Pending>();
  /** Nonces already reported or given up on, so a late hook never reopens them. */
  const done = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const counts: ExtensionStatus = { checks: 0, refusals: 0, reported: 0, unreported: 0, pending: 0 };
  /** Resources whose last check answered `unknown`, so the report may carry the plain path. */
  const unknownResources = new Set<string>();

  const safe = (fn: (() => void) | undefined): void => {
    try {
      fn?.();
    } catch {
      /* caller hooks never break a payment */
    }
  };
  const track = (p: Promise<void>): void => {
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  async function fetchCheck(key: string): Promise<CheckAnswer> {
    const res = await fetchImpl(`${indexUrl}/check?url=${encodeURIComponent(key)}`, {
      method: "GET",
      headers: { accept: "application/json", [CLIENT_HEADER]: CLIENT_ID },
      signal: AbortSignal.timeout(checkTimeoutMs),
      redirect: "error",
    });
    if (!res.ok) {
      res.body?.cancel().catch(() => undefined);
      throw new Error(`index answered ${res.status}`);
    }
    const j = (await res.json()) as { verdict?: unknown; verdict_text?: unknown; seller?: Record<string, unknown> | null } | null;
    if (!j || typeof j.verdict !== "string" || !VERDICTS.has(j.verdict)) throw new Error("index answer has no verdict");
    const s = j.seller ?? null;
    return {
      verdict: j.verdict as Verdict,
      verdictText: typeof j.verdict_text === "string" ? j.verdict_text : null,
      seller: s
        ? {
            domain: typeof s.domain === "string" ? s.domain : new URL(key).hostname,
            evidenceUrl: typeof s.evidence_url === "string" ? s.evidence_url : null,
            failureRate: typeof s.failure_rate === "number" ? s.failure_rate : null,
            calls: typeof s.calls === "number" ? s.calls : null,
          }
        : null,
      at: Date.now(),
    };
  }

  async function onBeforePaymentCreation(ctx: PaymentCreationContext): Promise<void | { abort: true; reason: string }> {
    const url = resourceUrlOf(ctx);
    if (!url) return;
    let key: string;
    try {
      key = resourceKey(url);
    } catch {
      return;
    }
    counts.checks++;
    const cached = cache.get(key);
    let answer: CheckAnswer | undefined = cached && Date.now() - cached.at <= checkCacheMs ? cached : undefined;
    const fromCache = answer !== undefined;
    let error: string | null = null;
    if (!answer) {
      try {
        answer = await fetchCheck(key);
        if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
        cache.set(key, answer);
      } catch (e) {
        error = errMsg(e);
      }
    }
    if (answer) {
      if (answer.verdict === "unknown" && !answer.seller) unknownResources.add(key);
      else unknownResources.delete(key);
    }
    const refused = answer ? refuse.has(answer.verdict) : failMode === "closed";
    if (refused) counts.refusals++;
    safe(() =>
      options.onCheck?.({
        url: key,
        verdict: answer?.verdict ?? null,
        refused,
        fromCache,
        seller: answer?.seller ?? null,
        verdictText: answer?.verdictText ?? null,
        error,
      }),
    );
    if (!refused) return;
    const reason = answer
      ? `paidfor: ${new URL(key).hostname} is rated ${answer.verdict} by the paidfor index; nothing was signed. ${answer.verdictText ?? ""}`.trim()
      : `paidfor: the index could not be reached (${error}) and failMode is "closed"; nothing was signed`;
    if (warn) safe(() => warn(reason));
    return { abort: true, reason };
  }

  function record(nonce: string, init: () => Pending | null): Pending | null {
    if (done.has(nonce)) return null;
    let rec = pending.get(nonce);
    if (!rec) {
      const made = init();
      if (!made) return null;
      rec = made;
      if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value!);
      pending.set(nonce, rec);
      counts.pending = pending.size;
    }
    return rec;
  }

  function fromPayload(paymentPayload: unknown, url: string | null, now: number): Pending | null {
    const a = authorizationOf(paymentPayload);
    if (!a) return null;
    const accepted = (paymentPayload as { accepted?: Record<string, unknown> }).accepted ?? {};
    const v1 = paymentPayload as { x402Version?: unknown; network?: unknown; scheme?: unknown };
    const network = typeof accepted.network === "string" ? accepted.network : typeof v1.network === "string" ? v1.network : "";
    const scheme = typeof accepted.scheme === "string" ? accepted.scheme : typeof v1.scheme === "string" ? v1.scheme : "exact";
    const asset = typeof accepted.asset === "string" ? accepted.asset : "";
    const timeoutS = typeof accepted.maxTimeoutSeconds === "number" ? accepted.maxTimeoutSeconds : 0;
    const resource = (paymentPayload as { resource?: { url?: unknown } }).resource?.url;
    return {
      nonce: a.nonce,
      payer: a.from,
      payTo: typeof accepted.payTo === "string" ? accepted.payTo : a.to,
      value: a.value,
      network: toCaip2(network),
      scheme,
      asset,
      timeoutS,
      url: url ?? (typeof resource === "string" ? resource : null),
      signedAt: now,
      unknownSeller: false,
      hookDone: false,
      settleSuccess: null,
      txHash: null,
      reverify: false,
      status: undefined,
      respondedAt: undefined,
      transportError: undefined,
      sent: false,
    };
  }

  async function onAfterPaymentCreation(ctx: PaymentCreatedContext): Promise<void> {
    const url = resourceUrlOf(ctx);
    const now = Date.now();
    const nonce = nonceOf(ctx.paymentPayload);
    if (!nonce) return;
    const rec = record(nonce, () => fromPayload(ctx.paymentPayload, url, now));
    if (!rec) return;
    if (url && !rec.url) rec.url = url;
    // v1 requirements carry asset and timeout on the requirement, not in the payload.
    const req = ctx.selectedRequirements as { asset?: unknown; maxTimeoutSeconds?: unknown; payTo?: unknown };
    if (!rec.asset && typeof req.asset === "string") rec.asset = req.asset;
    if (!rec.timeoutS && typeof req.maxTimeoutSeconds === "number") rec.timeoutS = req.maxTimeoutSeconds;
    try {
      rec.unknownSeller = rec.url !== null && unknownResources.has(resourceKey(rec.url));
    } catch {
      rec.unknownSeller = false;
    }
  }

  async function onPaymentResponse(ctx: PaymentResponseContext): Promise<void> {
    const nonce = nonceOf(ctx.paymentPayload);
    if (!nonce) return;
    const rec = record(nonce, () => fromPayload(ctx.paymentPayload, null, Date.now()));
    if (!rec) return;
    rec.hookDone = true;
    if (ctx.settleResponse) {
      rec.settleSuccess = ctx.settleResponse.success !== false;
      const tx = ctx.settleResponse.transaction;
      if (typeof tx === "string" && tx) rec.txHash = tx;
    }
    rec.reverify = ctx.paymentRequired !== undefined && !ctx.settleResponse;
    if (ctx.error && !rec.transportError) rec.transportError = errMsg(ctx.error);
    maybeSend(rec);
  }

  /** Decide the outcome once enough is known; undefined means wait for the other side (hook or transport). */
  function outcomeOf(rec: Pending): { outcome: ReportOutcome; failedStatus?: number } | undefined {
    if (rec.transportError !== undefined && rec.status === undefined) return { outcome: "paid_no_response" };
    if (rec.status !== undefined) {
      if (rec.settleSuccess === false) return { outcome: "error" };
      if (rec.settleSuccess === null && rec.status === 402) return { outcome: "error" };
      // A settlement header saying success, or none at all (the index checks the chain by payer and nonce).
      if (rec.status >= 200 && rec.status < 300) return { outcome: "ok" };
      return { outcome: "non_delivery", failedStatus: rec.status };
    }
    if (rec.hookDone) {
      if (rec.settleSuccess === false || rec.reverify) return { outcome: "error" };
      // Settled, but the HTTP status was never seen: delivery is unknown, so nothing is claimed.
      return undefined;
    }
    return undefined;
  }

  function finish(rec: Pending): void {
    rec.sent = true;
    pending.delete(rec.nonce);
    done.add(rec.nonce);
    if (done.size > MAX_PENDING) done.delete(done.values().next().value!);
    counts.pending = pending.size;
  }

  function maybeSend(rec: Pending): void {
    if (rec.sent) return;
    const decided = outcomeOf(rec);
    if (!decided) {
      if (rec.hookDone && rec.status === undefined && rec.transportError === undefined) {
        // Hooks-only install: give the transport view a moment, then count it as unreported.
        setTimeout(() => {
          if (rec.sent || rec.status !== undefined) return;
          finish(rec);
          counts.unreported++;
          safe(() => options.onReport?.({ kind: "skipped", reason: "status_unknown", nonce: rec.nonce, url: rec.url }));
        }, 50).unref?.();
      }
      return;
    }
    finish(rec);
    if (!report) {
      safe(() => options.onReport?.({ kind: "skipped", reason: "disabled", nonce: rec.nonce, url: rec.url }));
      return;
    }
    if (rec.network !== BASE_MAINNET) {
      safe(() => options.onReport?.({ kind: "skipped", reason: "network", nonce: rec.nonce, url: rec.url }));
      return;
    }
    if (rec.asset.toLowerCase() !== USDC_BASE || rec.scheme !== "exact") {
      safe(() => options.onReport?.({ kind: "skipped", reason: "asset", nonce: rec.nonce, url: rec.url }));
      return;
    }
    const proof = buildProof({
      network: rec.network,
      scheme: rec.scheme,
      asset: rec.asset,
      payTo: rec.payTo,
      payer: rec.payer,
      nonce: rec.nonce,
      txHash: rec.txHash,
      settledAt: rec.respondedAt ?? Date.now(),
      declaredTimeoutS: rec.timeoutS,
    });
    if (!proof || !rec.url) {
      safe(() => options.onReport?.({ kind: "skipped", reason: "malformed", nonce: rec.nonce, url: rec.url }));
      return;
    }
    const url = rec.url;
    track(
      (async () => {
        try {
          const row = await buildRow({
            url,
            outcome: decided.outcome,
            amountAtomic: rec.value,
            latencyMs: (rec.respondedAt ?? Date.now()) - rec.signedAt,
            ...(decided.failedStatus !== undefined ? { failedStatus: decided.failedStatus } : {}),
            proof,
            unknownSeller: rec.unknownSeller,
          });
          const result = await sendRow(indexUrl, row, fetchImpl, reportTimeoutMs);
          counts.reported++;
          safe(() => options.onReport?.({ kind: "sent", row, result }));
        } catch {
          /* never surfaces */
        }
      })(),
    );
  }

  function wrapFetch(inner: FetchLike = globalThis.fetch): FetchLike {
    return async (input: FetchInput, init?: RequestInit): Promise<Response> => {
      const headers = headersOf(input, init);
      const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
      if (!sig) return inner(input, init);
      const payload = decodeSignature(sig);
      const nonce = nonceOf(payload);
      const now = Date.now();
      const rec = nonce ? record(nonce, () => fromPayload(payload, urlOf(input), now)) : null;
      if (rec && !rec.url) rec.url = urlOf(input);
      let res: Response;
      try {
        res = await inner(input, init);
      } catch (e) {
        if (rec) {
          rec.transportError = errMsg(e);
          rec.respondedAt = Date.now();
          maybeSend(rec);
        }
        throw e;
      }
      if (rec) {
        rec.status = res.status;
        rec.respondedAt = Date.now();
        const raw = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
        if (raw) {
          try {
            const s = decodePaymentResponseHeader(raw);
            rec.settleSuccess = s.success !== false;
            if (typeof s.transaction === "string" && s.transaction) rec.txHash = s.transaction;
          } catch {
            /* unparseable header: the index checks the chain */
          }
        }
        maybeSend(rec);
      }
      return res;
    };
  }

  const hooks = { onBeforePaymentCreation, onAfterPaymentCreation, onPaymentResponse };
  return {
    key: "paidfor",
    hooks,
    install(client) {
      client.onBeforePaymentCreation(onBeforePaymentCreation);
      client.onAfterPaymentCreation(onAfterPaymentCreation);
      client.onPaymentResponse(onPaymentResponse);
      return client;
    },
    wrapFetch,
    async flush() {
      // Let a hooks-only settlement's grace timer run, then wait for every send.
      await new Promise((r) => setTimeout(r, 60));
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
    status: () => ({ ...counts, pending: pending.size }),
  };
}
