/**
 * The outcome report: one v2 telemetry row with proof of payment, exactly the contract @paidfor/x402-safe-fetch
 * documents in docs/telemetry.md ("Version 2") and the index validates in lib/telemetry.ts. The field rules here
 * mirror x402-safe-fetch's proof.ts; a row that does not fit the contract is never sent.
 */
import { ADDRESS_RE, BASE_MAINNET, BYTES32_RE, CLIENT_HEADER, CLIENT_ID, errMsg, trimSlash, type FetchLike } from "./constants.js";
import { pathHash } from "./hash.js";

export const REPORT_TIMEOUT_MS = 10_000;
/** Longest plain path sent; a longer one is left out rather than risk the row. */
export const MAX_PATH_LENGTH = 512;

export type ReportOutcome = "ok" | "non_delivery" | "paid_no_response" | "error";

export interface TelemetryProof {
  network: string;
  scheme: string;
  asset: string;
  pay_to: string;
  payer: string;
  nonce: string;
  tx_hash: string | null;
  settled_at: string;
  response_sha256: string | null;
  declared_timeout_s: number;
}

/** The exact object POSTed to {indexUrl}/telemetry. Nothing else is ever sent. */
export interface TelemetryRow {
  v: 2;
  host: string;
  path_hash: string;
  outcome: ReportOutcome;
  amount_usdc: string;
  latency_ms: number;
  validator_failures: string[];
  client: typeof CLIENT_ID;
  proof: TelemetryProof;
  /** The plain URL path, only when the pre-pay check answered `unknown` for this seller. */
  path?: string;
}

export interface ProofInput {
  network: string;
  scheme: string;
  asset: string;
  payTo: string;
  payer: string;
  nonce: string;
  txHash: string | null | undefined;
  settledAt: number;
  declaredTimeoutS: number;
}

/** Returns null when a signed field is not in the contract's form, so a malformed row is never sent. */
export function buildProof(i: ProofInput): TelemetryProof | null {
  const asset = i.asset.toLowerCase();
  const payTo = i.payTo.toLowerCase();
  const payer = i.payer.toLowerCase();
  const nonce = i.nonce.toLowerCase();
  if (!ADDRESS_RE.test(asset) || !ADDRESS_RE.test(payTo) || !ADDRESS_RE.test(payer) || !BYTES32_RE.test(nonce)) return null;
  if (!/^eip155:\d+$/.test(i.network) || !Number.isInteger(i.declaredTimeoutS) || i.declaredTimeoutS < 0) return null;
  const tx = i.txHash?.toLowerCase();
  return {
    network: i.network,
    scheme: i.scheme,
    asset,
    pay_to: payTo,
    payer,
    nonce,
    tx_hash: tx !== undefined && BYTES32_RE.test(tx) ? tx : null,
    settled_at: new Date(i.settledAt).toISOString(),
    response_sha256: null,
    declared_timeout_s: i.declaredTimeoutS,
  };
}

/** Atomic USDC (6 decimals) to the contract's "0.010000" form. */
export function atomicToUsdc(value: bigint): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

export function plainPath(url: string): string | null {
  const p = new URL(url).pathname || "/";
  return p.length <= MAX_PATH_LENGTH ? p : null;
}

export interface RowInput {
  url: string;
  outcome: ReportOutcome;
  amountAtomic: bigint;
  latencyMs: number;
  /** HTTP status of the paid response when one came back and was not 2xx. */
  failedStatus?: number;
  proof: TelemetryProof;
  /** The pre-pay check answered `unknown`: send the plain path so the index can buy this seller itself. */
  unknownSeller?: boolean;
}

export async function buildRow(i: RowInput): Promise<TelemetryRow> {
  const row: TelemetryRow = {
    v: 2,
    host: new URL(i.url).hostname.toLowerCase(),
    path_hash: await pathHash(i.url),
    outcome: i.outcome,
    amount_usdc: atomicToUsdc(i.amountAtomic),
    latency_ms: Math.max(0, Math.round(i.latencyMs)),
    validator_failures: i.failedStatus !== undefined ? [`http_status:${i.failedStatus}`] : [],
    client: CLIENT_ID,
    proof: { ...i.proof },
  };
  if (i.unknownSeller) {
    const path = plainPath(i.url);
    if (path) row.path = path;
  }
  return row;
}

/** v1 names Base "base"; v2 uses CAIP-2. The index counts Base mainnet only. */
export function toCaip2(network: string): string {
  if (network === "base") return BASE_MAINNET;
  if (network === "base-sepolia") return "eip155:84532";
  return network;
}

export interface SendResult {
  status: number | null;
  body: unknown;
  error?: string;
}

/** POST one row. Never throws. */
export async function sendRow(indexUrl: string, row: TelemetryRow, fetchImpl: FetchLike, timeoutMs = REPORT_TIMEOUT_MS): Promise<SendResult> {
  try {
    const res = await fetchImpl(`${trimSlash(indexUrl)}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json", [CLIENT_HEADER]: CLIENT_ID },
      body: JSON.stringify(row),
      signal: AbortSignal.timeout(timeoutMs),
      // The route answers directly; never let a redirect carry the row somewhere else.
      redirect: "error",
    });
    const body: unknown = await res.json().catch(() => null);
    return { status: res.status, body };
  } catch (e) {
    return { status: null, body: null, error: errMsg(e) };
  }
}
