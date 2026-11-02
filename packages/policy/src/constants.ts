/** Shared constants. The version here must match package.json; test/package.test.ts checks it. */
export const VERSION = "0.1.0";
/** Sent as the X-Paidfor-Client header and the `client` field of every report, so the index can count calls per client. */
export const CLIENT_ID = `x402-policy/${VERSION}`;
export const CLIENT_HEADER = "X-Paidfor-Client";
export const DEFAULT_INDEX_URL = "https://paidfor.dev/v1";
/**
 * The public data repo's sellers file carries `pay_to_addresses` per seller. It is read only while `/v1/sellers`
 * rows have no `pay_to_addresses` of their own (see README, "Index-side change").
 */
export const DEFAULT_SELLERS_DATA_URL = "https://raw.githubusercontent.com/sarmadahsan/paidfor-data/main/sellers.json";
export const BASE_MAINNET = "eip155:8453";
/** USDC on Base, lowercase. The index counts Base mainnet USDC only. */
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

export type Verdict = "avoid" | "caution" | "ok" | "unknown";
export type FailMode = "open" | "closed";
export type FetchLike = typeof globalThis.fetch;
export type FetchInput = Parameters<FetchLike>[0];

export const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
export const BYTES32_RE = /^0x[0-9a-f]{64}$/;

export function indexHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { [CLIENT_HEADER]: CLIENT_ID, ...extra };
}

export function trimSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/** origin + pathname: the query string and fragment never leave the process. */
export function resourceKey(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
