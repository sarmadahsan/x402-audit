/**
 * Live smoke test: ONE real x402 payment through a client wrapped with usePaidfor(), so the index's verification of
 * a reported row from this package is exercised end to end, followed by a refused request to a seller rated avoid.
 * Run by the operator only, with their own demo wallet:
 *
 *   PAIDFOR_POLICY_LIVE=1 PAIDFOR_SMOKE_KEY_FILE=/path/to/key pnpm -C packages/policy demo:live
 *
 *   PAIDFOR_POLICY_LIVE     must be "1", otherwise nothing runs.
 *   PAIDFOR_SMOKE_KEY_FILE  file holding one 32-byte hex private key. Read into memory, never printed; only the
 *                           derived address is shown.
 *   PAIDFOR_SMOKE_URL       the resource to pay, default the blockrun.ai price lookup below (rated ok, 0.002 USDC
 *                           on 2026-11-01).
 *
 * Before paying: GET /v1/check on the target must answer `ok` with a quote at or below MAX_QUOTE_USDC. A hard cap of
 * MAX_SIGNED_USDC on the authorization value is enforced by a payment policy before the scheme signs. A marker file
 * in the OS temp dir stops a second run against the same URL within a minute from paying twice.
 *
 * Step 2 requests https://www.api-xpay.com/x402/time (rated avoid) with the same client and proves nothing was
 * signed: the signer is wrapped with a counter and the run fails loudly if it moved.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { x402Client } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { BASE_MAINNET, CLIENT_HEADER, CLIENT_ID, DEFAULT_INDEX_URL, USDC_BASE, usePaidfor, type CheckEvent, type ReportEvent } from "../src/index.js";

type Signer = Parameters<typeof registerExactEvmScheme>[1]["signer"];

const DEFAULT_TARGET = "https://blockrun.ai/api/v1/defillama/prices/coingecko:bitcoin";
const AVOID_TARGET = "https://www.api-xpay.com/x402/time";
/** The pre-pay quote from the index must be at or below this. */
const MAX_QUOTE_USDC = 0.002;
/** Hard cap on the signed authorization value, atomic USDC (6 decimals): 0.01 USDC. */
const MAX_SIGNED_ATOMIC = 10_000n;
const REPAY_GUARD_MS = 60_000;
const INDEX = DEFAULT_INDEX_URL;

const line = (s = "") => console.log(s);
const head = (s: string) => line(`\n== ${s} ==`);
const fail = (s: string, code = 1): never => {
  console.error(`\nFAIL: ${s}`);
  process.exit(code);
};

// ---- guards -----------------------------------------------------------------------------------------------------

if (process.env.PAIDFOR_POLICY_LIVE !== "1") {
  line("Not running: this script makes one real payment. Set PAIDFOR_POLICY_LIVE=1 and PAIDFOR_SMOKE_KEY_FILE=<path> to run it.");
  process.exit(2);
}
const keyFile = process.env.PAIDFOR_SMOKE_KEY_FILE;
if (!keyFile) fail("PAIDFOR_SMOKE_KEY_FILE is not set", 2);

let signCalls = 0;
const signer: Signer = (() => {
  let raw: string;
  try {
    raw = readFileSync(keyFile!, "utf8").trim();
  } catch (e) {
    return fail(`cannot read PAIDFOR_SMOKE_KEY_FILE: ${(e as Error).message}`, 2);
  }
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) fail("PAIDFOR_SMOKE_KEY_FILE does not hold one 32-byte hex key", 2);
  const account = privateKeyToAccount(hex as `0x${string}`);
  raw = "";
  // Count every call into the signer, so step 2 can prove nothing was signed.
  return {
    address: account.address,
    signTypedData: (message) => {
      signCalls++;
      return account.signTypedData(message as never);
    },
  };
})();
line(`signer address ${signer.address} (key read from PAIDFOR_SMOKE_KEY_FILE, held in memory only)`);

const target = process.env.PAIDFOR_SMOKE_URL ?? DEFAULT_TARGET;
const targetKey = (() => {
  const u = new URL(target);
  return `${u.origin}${u.pathname}`;
})();

// ---- pre-pay check against the index -----------------------------------------------------------------------------

head(`pre-pay check: ${targetKey}`);
interface CheckAnswer {
  verdict?: string;
  verdict_text?: string;
  resource?: { max_quote_usdc?: string; modal_quote_usdc?: string; listed_price_usdc?: string } | null;
  seller?: { median_quote_usdc?: string } | null;
}
const check = (await (async (): Promise<CheckAnswer> => {
  const res = await fetch(`${INDEX}/check?url=${encodeURIComponent(targetKey)}`, {
    headers: { accept: "application/json", [CLIENT_HEADER]: CLIENT_ID },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) fail(`index answered ${res.status} to /v1/check`);
  return (await res.json()) as CheckAnswer;
})());
line(`  verdict: ${check.verdict}`);
line(`  ${check.verdict_text ?? ""}`);
if (check.verdict !== "ok") fail(`verdict is "${check.verdict}", not "ok"; not paying`);
const quoteStr = check.resource?.max_quote_usdc ?? check.resource?.modal_quote_usdc ?? check.resource?.listed_price_usdc ?? check.seller?.median_quote_usdc;
if (!quoteStr) fail("the index knows no quote for this resource; not paying");
const quote = Number(quoteStr);
line(`  quote: ${quoteStr} USDC (limit ${MAX_QUOTE_USDC})`);
if (!Number.isFinite(quote) || quote > MAX_QUOTE_USDC) fail(`quote ${quoteStr} USDC is above the ${MAX_QUOTE_USDC} USDC limit; not paying`);

// ---- repay guard -------------------------------------------------------------------------------------------------

const marker = join(tmpdir(), `paidfor-x402-policy-live-${createHash("sha256").update(targetKey).digest("hex").slice(0, 16)}`);
if (existsSync(marker)) {
  const age = Date.now() - statSync(marker).mtimeMs;
  if (age < REPAY_GUARD_MS) fail(`${targetKey} was paid ${Math.round(age / 1000)} s ago by this script (marker ${marker}); not paying again within ${REPAY_GUARD_MS / 1000} s`, 3);
}

// ---- the client: the developer's setup plus the one paidfor line, plus this script's hard cap ----------------------

const client = new x402Client();
registerExactEvmScheme(client, { signer });
const checks: CheckEvent[] = [];
const reports: ReportEvent[] = [];
const paidfor = usePaidfor(client, {
  warn: (m) => line(`  [warn] ${m}`),
  onCheck: (c) => checks.push(c),
  onReport: (r) => reports.push(r),
});
const capRefused: string[] = [];
client.registerPolicy((_v: number, requirements: PaymentRequirements[]) =>
  requirements.filter((r) => {
    const ok =
      r.network === BASE_MAINNET && r.asset.toLowerCase() === USDC_BASE && r.scheme === "exact" && /^\d+$/.test(r.amount) && BigInt(r.amount) <= MAX_SIGNED_ATOMIC;
    if (!ok) capRefused.push(`${r.network} ${r.asset} ${r.scheme} amount ${r.amount}`);
    return ok;
  }),
);
client.onBeforePaymentCreation(async (ctx) => {
  const amount = BigInt(ctx.selectedRequirements.amount);
  if (amount > MAX_SIGNED_ATOMIC) return { abort: true, reason: `live smoke test: amount ${amount} is above the hard cap ${MAX_SIGNED_ATOMIC}` };
});
const fetchWithPayment = wrapFetchWithPayment(paidfor.fetch, client);

head("avoid set");
const status = await paidfor.ready();
line(`  loaded ${status.addresses} pay-to address(es) for ${status.sellers} seller(s) rated avoid; joined from sellers.json: ${status.joinedFromData}${status.lastError ? `; last error: ${status.lastError}` : ""}`);
if (!status.current) fail(`the avoid set did not load (${status.lastError}); not paying unchecked`);

// ---- step 1: one real payment ------------------------------------------------------------------------------------

head(`1. pay ${target}`);
writeFileSync(marker, new Date().toISOString());
let res: Response;
try {
  res = await fetchWithPayment(target);
} catch (e) {
  fail(`the paid request threw: ${(e as Error).message}${capRefused.length ? `; cap refused: ${capRefused.join("; ")}` : ""}`);
}
line(`  HTTP status: ${res!.status}`);
line(`  signer calls: ${signCalls}`);
const body = await res!.text();
line(`  body: ${body.length > 200 ? `${body.slice(0, 200)}...` : body}`);
const settlementRaw = res!.headers.get("PAYMENT-RESPONSE") ?? res!.headers.get("X-PAYMENT-RESPONSE");
let txHash: string | null = null;
if (settlementRaw) {
  try {
    const s = decodePaymentResponseHeader(settlementRaw);
    txHash = typeof s.transaction === "string" ? s.transaction : null;
    line(`  settlement: success=${s.success} network=${s.network} tx=${txHash ?? "(none)"}`);
  } catch (e) {
    line(`  settlement header could not be decoded: ${(e as Error).message}`);
  }
} else {
  line("  no settlement header on the response");
}
if (res!.status !== 200) fail(`expected 200 from the seller, got ${res!.status}`);
if (signCalls !== 1) fail(`expected exactly one signature for one payment, saw ${signCalls}`);

head("report sent to the index");
await paidfor.flush();
const sent = reports.filter((r) => r.kind === "sent");
if (sent.length !== 1) fail(`expected one report, saw ${reports.length}: ${JSON.stringify(reports)}`);
const { row, result } = sent[0] as Extract<ReportEvent, { kind: "sent" }>;
line("  row POSTed to /v1/telemetry:");
line(JSON.stringify(row, null, 2).replace(/^/gm, "    "));
line(`  index answered: HTTP ${result.status ?? `(no answer: ${result.error})`}`);
line(JSON.stringify(result.body, null, 2).replace(/^/gm, "    "));
const verification = (result.body as { verification_url?: unknown } | null)?.verification_url;
if (typeof verification === "string") line(`  verification URL: ${verification}`);
if (result.status !== 202 && result.status !== 200) fail(`the index did not accept the row (HTTP ${result.status})`);
if (row.outcome !== "ok") fail(`the row's outcome is "${row.outcome}", expected "ok"`);
if (txHash && row.proof.tx_hash !== txHash.toLowerCase()) fail(`the row's tx_hash ${row.proof.tx_hash} is not the settlement tx ${txHash}`);

// ---- step 2: a seller rated avoid is refused with nothing signed ---------------------------------------------------

head(`2. ${AVOID_TARGET} (rated avoid)`);
const before = signCalls;
let refused: string | null = null;
try {
  const r2 = await fetchWithPayment(AVOID_TARGET);
  line(`  unexpected: the call returned HTTP ${r2.status}`);
} catch (e) {
  refused = (e as Error).message;
  line(`  refused: ${refused}`);
}
line(`  signer calls during this step: ${signCalls - before}`);
line(`  policy refusal: ${paidfor.policy.lastRefusal ? paidfor.policy.lastRefusal.kind : "(none)"}; index checks made: ${checks.filter((c) => c.url.startsWith("https://www.api-xpay.com/")).map((c) => `${c.verdict}${c.refused ? " refused" : ""}`).join(", ") || "(none)"}`);
if (signCalls !== before) fail(`A SIGNATURE HAPPENED for a seller rated avoid (${signCalls - before} signer call(s))`);
if (!refused) fail("the request to the avoid seller was not refused");
if (!/filtered out by policies|Payment creation aborted: paidfor/.test(refused!)) fail(`the refusal did not come from paidfor: ${refused}`);

head("result");
line("  PASS: one payment made and reported, one seller rated avoid refused with nothing signed.");
paidfor.stop();
