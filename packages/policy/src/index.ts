/**
 * @paidfor/x402-policy: one line on an existing @x402 client (v2.28) and the developer's own wallet.
 *
 *   usePaidfor(client)   registers paidforPolicy() (pay-to filter, synchronous, before anything is signed) and
 *                        paidforExtension() (resource check before, outcome report after) on the client.
 *
 * No custody, no key handling, no new wallet: the signer and the process stay exactly as they are.
 */
import type { x402Client } from "@x402/core/client";
import { paidforExtension, type PaidforExtension, type PaidforExtensionOptions } from "./extension.js";
import { paidforPolicy, type PaidforPolicy, type PaidforPolicyOptions, type PolicyStatus } from "./policy.js";
import type { FetchLike } from "./constants.js";

export type PaidforOptions = PaidforPolicyOptions & PaidforExtensionOptions;

export interface Paidfor {
  readonly client: x402Client;
  readonly policy: PaidforPolicy;
  readonly extension: PaidforExtension;
  /**
   * globalThis.fetch with the extension's view of each paid response. Pass it to wrapFetchWithPayment in place of
   * `fetch` so delivered / not delivered is reported; use wrapFetch() for a custom fetch.
   */
  readonly fetch: FetchLike;
  wrapFetch(inner: FetchLike): FetchLike;
  /** Resolves once the avoid set has been loaded (or the first load has failed). Never rejects. */
  ready(): Promise<PolicyStatus>;
  /** Wait for in-flight reports. */
  flush(): Promise<void>;
  /** Stop the background refresh. */
  stop(): void;
}

/** Register the policy and the extension on a client. The client is changed in place and also returned in the handle. */
export function usePaidfor(client: x402Client, options: PaidforOptions = {}): Paidfor {
  const policy = paidforPolicy(options);
  const extension = paidforExtension(options);
  client.registerPolicy(policy);
  extension.install(client);
  return {
    client,
    policy,
    extension,
    fetch: extension.wrapFetch(),
    wrapFetch: (inner) => extension.wrapFetch(inner),
    ready: () => policy.ready(),
    flush: () => extension.flush(),
    stop: () => policy.stop(),
  };
}

export { paidforPolicy, DEFAULT_REFRESH_MS, DEFAULT_MAX_STALE_MS, DEFAULT_LOAD_TIMEOUT_MS } from "./policy.js";
export type { PaidforPolicy, PaidforPolicyOptions, PaidforRefusal, PolicyStatus } from "./policy.js";
export { paidforExtension, DEFAULT_CHECK_TIMEOUT_MS, DEFAULT_CHECK_CACHE_MS } from "./extension.js";
export type { PaidforExtension, PaidforExtensionOptions, CheckEvent, ReportEvent, ExtensionStatus } from "./extension.js";
export { buildProof, buildRow, atomicToUsdc, REPORT_TIMEOUT_MS } from "./report.js";
export type { TelemetryRow, TelemetryProof, ReportOutcome, SendResult } from "./report.js";
export { buildSnapshot, payToByDomain, loadAvoidSet } from "./avoid-set.js";
export type { AvoidEntry, AvoidSnapshot } from "./avoid-set.js";
export { VERSION, CLIENT_ID, CLIENT_HEADER, DEFAULT_INDEX_URL, DEFAULT_SELLERS_DATA_URL, BASE_MAINNET, USDC_BASE } from "./constants.js";
export type { Verdict, FailMode, FetchLike } from "./constants.js";
