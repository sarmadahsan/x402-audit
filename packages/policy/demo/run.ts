/**
 * End-to-end demo with no network and no payment: a throwaway in-memory signer with no funds, the paidfor index
 * played back from fixtures captured on 2026-11-01 (www.api-xpay.com rated avoid), and two mocked sellers.
 *
 *   pnpm demo
 *
 * 1. www.api-xpay.com answers 402; the policy removes its pay-to, the client throws, nothing is signed.
 * 2. good-seller.example answers 402, the payment is signed and the mocked seller settles it; the report sent to
 *    the index is printed in full.
 */
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { usePaidfor } from "../src/index.js";
import { AVOID_HOST, OK_HOST, freshState, mockFetch, throwawaySigner } from "../test/mock.js";

const line = (s = "") => console.log(s);
const head = (s: string) => line(`\n== ${s} ==`);

const st = freshState();
const indexAndSellers = mockFetch(st);
const signer = throwawaySigner();
line(`throwaway signer ${signer.address} (random key held in memory only, no funds, never printed)`);

// The developer's existing setup, plus the one paidfor line.
const client = new x402Client();
registerExactEvmScheme(client, { signer });
const paidfor = usePaidfor(client, {
  fetch: indexAndSellers, // index requests go to the fixtures; the default is https://paidfor.dev/v1
  warn: (m) => line(`  [warn] ${m}`),
  onCheck: (c) => line(`  [check] ${c.url} -> ${c.verdict ?? `error: ${c.error}`}${c.refused ? " (refused)" : ""}`),
  onReport: (r) => line(r.kind === "sent" ? `  [report] sent, index answered ${r.result.status ?? r.result.error}` : `  [report] skipped: ${r.reason}`),
});
const fetchWithPayment = wrapFetchWithPayment(paidfor.wrapFetch(indexAndSellers), client);

head("avoid set");
const status = await paidfor.ready();
line(`  loaded ${status.addresses} pay-to address(es) for ${status.sellers} seller(s) rated avoid; joined from sellers.json: ${status.joinedFromData}`);
line(`  index requests so far: /v1/sellers x${st.sellersCalls}, sellers.json x${st.dataCalls}`);

head(`1. ${AVOID_HOST} (rated avoid on 2026-11-01)`);
try {
  await fetchWithPayment(`https://${AVOID_HOST}/v1/thing?q=1`);
  line("  unexpected: the call went through");
} catch (e) {
  line(`  refused: ${(e as Error).message}`);
}
line(`  402s received: ${st.unpaidCalls}, signatures produced: ${st.signatures.length}, paid requests sent: ${st.paidCalls}`);

head(`2. ${OK_HOST} (rated ok, mocked to settle)`);
const res = await fetchWithPayment(`https://${OK_HOST}/v1/data?q=1`);
line(`  status ${res.status}, body ${await res.text()}`);
line(`  signatures produced: ${st.signatures.length} (valid EIP-3009 authorization from ${st.signatures[0]?.payer}, verified by the mocked seller)`);
await paidfor.flush();
line("  report POSTed to /v1/telemetry:");
line(JSON.stringify(st.telemetryPosts[0]?.body, null, 2).replace(/^/gm, "    "));
line(`  with headers ${JSON.stringify(st.telemetryPosts[0]?.headers)}`);

head("index requests made in total");
line(`  GET /v1/sellers x${st.sellersCalls}, GET sellers.json x${st.dataCalls}, GET ${st.checkCalls.join(", ")}, POST /v1/telemetry x${st.telemetryPosts.length}`);
paidfor.stop();
