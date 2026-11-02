import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { paidforExtension, paidforPolicy, usePaidfor, type CheckEvent, type PaidforOptions, type ReportEvent, type TelemetryRow } from "../src/index.js";
import { AVOID_HOST, AVOID_PAY_TO, OK_HOST, OK_PAY_TO, TX, UNKNOWN_HOST, freshState, mockFetch, throwawaySigner, type MockState } from "./mock.js";

const ROW_KEYS = ["amount_usdc", "client", "host", "latency_ms", "outcome", "path_hash", "proof", "v", "validator_failures"];
const PROOF_KEYS = ["asset", "declared_timeout_s", "network", "nonce", "pay_to", "payer", "response_sha256", "scheme", "settled_at", "tx_hash"];

function setup(st: MockState, opts: PaidforOptions = {}, transport = true) {
  const f = mockFetch(st);
  const client = new x402Client();
  const signer = throwawaySigner();
  registerExactEvmScheme(client, { signer });
  const checks: CheckEvent[] = [];
  const reports: ReportEvent[] = [];
  const paidfor = usePaidfor(client, { fetch: f, warn: false, onCheck: (c) => checks.push(c), onReport: (r) => reports.push(r), ...opts });
  const fetchWithPayment = wrapFetchWithPayment(transport ? paidfor.wrapFetch(f) : f, client);
  return { paidfor, fetchWithPayment, signer, checks, reports, st };
}

const onlyRow = (st: MockState): TelemetryRow => {
  expect(st.telemetryPosts).toHaveLength(1);
  return st.telemetryPosts[0]!.body as TelemetryRow;
};

describe("refusing before anything is signed", () => {
  it("the policy removes the avoid seller's pay-to: no signature, no paid request, no index check needed", async () => {
    const { paidfor, fetchWithPayment, st } = setup(freshState());
    await paidfor.ready();
    await expect(fetchWithPayment(`https://${AVOID_HOST}/v1/thing?x=1`)).rejects.toThrow(/filtered out by policies/);
    expect(st.unpaidCalls).toBe(1);
    expect(st.paidCalls).toBe(0);
    expect(st.signatures).toEqual([]);
    expect(st.checkCalls).toEqual([]);
    expect(paidfor.policy.lastRefusal).toMatchObject({ kind: "avoid_pay_to", remaining: 0 });
    paidfor.stop();
  });

  it("the extension's resource check refuses too, with the index's reason, when the pay-to set is not loaded", async () => {
    const st = freshState();
    st.sellers = { kind: "status", status: 503 };
    const { paidfor, fetchWithPayment, checks } = setup(st);
    await paidfor.ready();
    await expect(fetchWithPayment(`https://${AVOID_HOST}/v1/thing?secret=hunter2`)).rejects.toThrow(/Payment creation aborted: paidfor: www\.api-xpay\.com is rated avoid by the paidfor index; nothing was signed\. Avoid: 53\.5% of 546 paid calls/);
    expect(st.signatures).toEqual([]);
    expect(st.paidCalls).toBe(0);
    // Only origin + path reach the index: no query string.
    expect(st.checkCalls).toEqual([`/v1/check?url=${encodeURIComponent(`https://${AVOID_HOST}/v1/thing`)}`]);
    expect(checks[0]).toMatchObject({ url: `https://${AVOID_HOST}/v1/thing`, verdict: "avoid", refused: true, fromCache: false, seller: { domain: "api-xpay.com" } });
    expect(paidfor.extension.status()).toMatchObject({ checks: 1, refusals: 1, reported: 0 });
    paidfor.stop();
  });

  it("works as `policies: [paidforPolicy()]` on registerExactEvmScheme as well", async () => {
    const st = freshState();
    const f = mockFetch(st);
    const client = new x402Client();
    const policy = paidforPolicy({ fetch: f, warn: false });
    registerExactEvmScheme(client, { signer: throwawaySigner(), policies: [policy] });
    await policy.ready();
    const fetchWithPayment = wrapFetchWithPayment(f, client);
    await expect(fetchWithPayment(`https://${AVOID_HOST}/v1/thing`)).rejects.toThrow(/filtered out by policies/);
    expect(st.signatures).toEqual([]);
    policy.stop();
  });

  it("fail-closed: a check the index cannot answer aborts; fail-open: it proceeds and says why", async () => {
    for (const answer of [{ kind: "status", status: 503 }, { kind: "hang" }, { kind: "throw" }] as const) {
      const closed = freshState();
      closed.checks[OK_HOST] = answer;
      const c = setup(closed, { failMode: "closed", checkTimeoutMs: 200 });
      await c.paidfor.ready();
      await expect(c.fetchWithPayment(`https://${OK_HOST}/v1/data`)).rejects.toThrow(/could not be reached .* failMode is "closed"; nothing was signed/);
      expect(closed.signatures).toEqual([]);
      c.paidfor.stop();

      const open = freshState();
      open.checks[OK_HOST] = answer;
      const o = setup(open, { checkTimeoutMs: 200 });
      await o.paidfor.ready();
      const res = await o.fetchWithPayment(`https://${OK_HOST}/v1/data`);
      expect(res.status).toBe(200);
      expect(open.signatures).toHaveLength(1);
      expect(o.checks[0]).toMatchObject({ verdict: null, refused: false });
      expect(o.checks[0]!.error).toBeTruthy();
      o.paidfor.stop();
    }
  });

  it("one check answer is reused for the same resource", async () => {
    const { paidfor, fetchWithPayment, checks, st } = setup(freshState());
    await paidfor.ready();
    await (await fetchWithPayment(`https://${OK_HOST}/v1/data?a=1`)).text();
    await (await fetchWithPayment(`https://${OK_HOST}/v1/data?a=2`)).text();
    expect(st.checkCalls).toHaveLength(1);
    expect(checks.map((c) => c.fromCache)).toEqual([false, true]);
    await paidfor.flush();
    paidfor.stop();
  });
});

describe("reporting after settlement", () => {
  it("an ok seller: one payment signed by the developer's signer, one report with exactly the contract's fields", async () => {
    const { paidfor, fetchWithPayment, signer, reports, st } = setup(freshState());
    await paidfor.ready();
    const res = await fetchWithPayment(`https://${OK_HOST}/v1/data?q=1&token=hunter2`, { headers: { "x-api-key": "k-9" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, data: "the goods" });
    await paidfor.flush();

    expect(st.paidCalls).toBe(1);
    expect(st.signatures).toHaveLength(1);
    expect(st.signatures[0]).toMatchObject({ payer: signer.address.toLowerCase(), to: OK_PAY_TO, value: "10000", valid: true });

    const post = st.telemetryPosts[0]!;
    expect(post.headers["x-paidfor-client"]).toBe("x402-policy/0.1.0");
    const row = onlyRow(st);
    expect(Object.keys(row).sort()).toEqual(ROW_KEYS);
    expect(Object.keys(row.proof).sort()).toEqual(PROOF_KEYS);
    expect(row).toMatchObject({
      v: 2,
      host: OK_HOST,
      path_hash: createHash("sha256").update("/v1/data").digest("hex"),
      outcome: "ok",
      amount_usdc: "0.010000",
      validator_failures: [],
      client: "x402-policy/0.1.0",
      proof: {
        network: "eip155:8453",
        scheme: "exact",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        pay_to: OK_PAY_TO,
        payer: signer.address.toLowerCase(),
        nonce: st.signatures[0]!.nonce,
        tx_hash: TX,
        response_sha256: null,
        declared_timeout_s: 60,
      },
    });
    expect(Number.isInteger(row.latency_ms) && row.latency_ms >= 0).toBe(true);
    expect(new Date(row.proof.settled_at).toISOString()).toBe(row.proof.settled_at);
    const raw = JSON.stringify(post.body);
    for (const leak of ["q=1", "hunter2", "x-api-key", "k-9", "BODY-7731", "the goods", "signature", "/v1/data"]) expect(raw).not.toContain(leak);
    expect(reports).toEqual([{ kind: "sent", row, result: { status: 202, body: { status: "pending" } } }]);
    expect(paidfor.extension.status()).toMatchObject({ reported: 1, unreported: 0, pending: 0 });
    paidfor.stop();
  });

  it("settled, then a 500: non_delivery with the status in validator_failures", async () => {
    const st = freshState();
    st.sellerMode = "fail_500";
    const { paidfor, fetchWithPayment } = setup(st);
    await paidfor.ready();
    const res = await fetchWithPayment(`https://${OK_HOST}/v1/data`);
    expect(res.status).toBe(500);
    await paidfor.flush();
    expect(onlyRow(st)).toMatchObject({ outcome: "non_delivery", validator_failures: ["http_status:500"], proof: { tx_hash: TX } });
    paidfor.stop();
  });

  it("a seller the index has never measured: the row adds the plain path so the index can buy it itself", async () => {
    const { paidfor, fetchWithPayment, st } = setup(freshState());
    await paidfor.ready();
    await (await fetchWithPayment(`https://${UNKNOWN_HOST}/v1/data/?x=1`)).text();
    await paidfor.flush();
    const row = onlyRow(st);
    expect(row.path).toBe("/v1/data/");
    expect(row.path_hash).toBe(createHash("sha256").update("/v1/data").digest("hex"));
    expect(Object.keys(row).sort()).toEqual([...ROW_KEYS, "path"].sort());
    paidfor.stop();
  });

  it("the seller rejects the payment (402 again, nothing settled): error with tx_hash null", async () => {
    const st = freshState();
    st.sellerMode = "reject_402";
    const { paidfor, fetchWithPayment } = setup(st);
    await paidfor.ready();
    const res = await fetchWithPayment(`https://${OK_HOST}/v1/data`);
    expect(res.status).toBe(402);
    expect(st.paidCalls).toBe(1);
    await paidfor.flush();
    expect(onlyRow(st)).toMatchObject({ outcome: "error", proof: { tx_hash: null } });
    paidfor.stop();
  });

  it("the settlement header says success false: error", async () => {
    const st = freshState();
    st.sellerMode = "settle_fail";
    const { paidfor, fetchWithPayment } = setup(st);
    await paidfor.ready();
    await (await fetchWithPayment(`https://${OK_HOST}/v1/data`)).text();
    await paidfor.flush();
    expect(onlyRow(st)).toMatchObject({ outcome: "error", proof: { tx_hash: null } });
    paidfor.stop();
  });

  it("a 200 without a settlement header: ok with tx_hash null (the index checks the chain by payer and nonce)", async () => {
    const st = freshState();
    st.sellerMode = "no_header";
    const { paidfor, fetchWithPayment } = setup(st);
    await paidfor.ready();
    await (await fetchWithPayment(`https://${OK_HOST}/v1/data`)).text();
    await paidfor.flush();
    expect(onlyRow(st)).toMatchObject({ outcome: "ok", proof: { tx_hash: null } });
    paidfor.stop();
  });

  it("the paid request never gets a response: paid_no_response, and the caller still sees the transport error", async () => {
    const st = freshState();
    st.sellerMode = "throw";
    const { paidfor, fetchWithPayment } = setup(st);
    await paidfor.ready();
    await expect(fetchWithPayment(`https://${OK_HOST}/v1/data`)).rejects.toThrow(/socket hang up/);
    await paidfor.flush();
    expect(onlyRow(st)).toMatchObject({ outcome: "paid_no_response", proof: { tx_hash: null } });
    paidfor.stop();
  });

  it("hooks only (no paidfor.fetch): a settled payment is not reported, a rejected one is", async () => {
    const st = freshState();
    const { paidfor, fetchWithPayment, reports } = setup(st, {}, false);
    await paidfor.ready();
    await (await fetchWithPayment(`https://${OK_HOST}/v1/data`)).text();
    await paidfor.flush();
    expect(st.telemetryPosts).toEqual([]);
    expect(paidfor.extension.status()).toMatchObject({ reported: 0, unreported: 1, pending: 0 });
    expect(reports).toEqual([{ kind: "skipped", reason: "status_unknown", nonce: st.signatures[0]!.nonce, url: `https://${OK_HOST}/v1/data` }]);

    st.sellerMode = "reject_402";
    await (await fetchWithPayment(`https://${OK_HOST}/v1/other`)).text();
    await paidfor.flush();
    expect(onlyRow(st)).toMatchObject({ outcome: "error", host: OK_HOST, proof: { tx_hash: null } });
    paidfor.stop();
  });

  it("a payment on another network is never reported (the index counts Base mainnet USDC only)", async () => {
    const st = freshState();
    st.network = "eip155:84532";
    st.asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
    const { paidfor, fetchWithPayment, reports } = setup(st);
    await paidfor.ready();
    await (await fetchWithPayment(`https://${OK_HOST}/v1/data`)).text();
    await paidfor.flush();
    expect(st.signatures[0]?.valid).toBe(true);
    expect(st.telemetryPosts).toEqual([]);
    expect(reports).toEqual([{ kind: "skipped", reason: "network", nonce: st.signatures[0]!.nonce, url: `https://${OK_HOST}/v1/data` }]);
    paidfor.stop();
  });

  it("reporting never throws into the caller's request, whatever the index does", async () => {
    for (const telemetry of [{ kind: "throw" }, { kind: "hang" }, { kind: "status", status: 500 }] as const) {
      const st = freshState();
      st.telemetry = telemetry;
      const { paidfor, fetchWithPayment, reports } = setup(st, { reportTimeoutMs: 100 });
      await paidfor.ready();
      const res = await fetchWithPayment(`https://${OK_HOST}/v1/data`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true });
      await paidfor.flush();
      expect(reports).toHaveLength(1);
      expect(reports[0]!.kind).toBe("sent");
      const r = reports[0] as Extract<ReportEvent, { kind: "sent" }>;
      if (telemetry.kind === "status") expect(r.result.status).toBe(500);
      else expect(r.result.error).toBeTruthy();
      paidfor.stop();
    }
  });

  it("report: false sends nothing and says so", async () => {
    const st = freshState();
    const { paidfor, fetchWithPayment, reports } = setup(st, { report: false });
    await paidfor.ready();
    await (await fetchWithPayment(`https://${OK_HOST}/v1/data`)).text();
    await paidfor.flush();
    expect(st.telemetryPosts).toEqual([]);
    expect(reports).toEqual([{ kind: "skipped", reason: "disabled", nonce: st.signatures[0]!.nonce, url: `https://${OK_HOST}/v1/data` }]);
    paidfor.stop();
  });

  it("paidforExtension() alone, installed by hand, carries the same hooks", async () => {
    const st = freshState();
    const f = mockFetch(st);
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: throwawaySigner() });
    const ext = paidforExtension({ fetch: f, warn: false });
    expect(ext.key).toBe("paidfor");
    ext.install(client);
    const fetchWithPayment = wrapFetchWithPayment(ext.wrapFetch(f), client);
    await expect(fetchWithPayment(`https://${AVOID_HOST}/v1/thing`)).rejects.toThrow(/rated avoid/);
    await (await fetchWithPayment(`https://${OK_HOST}/v1/data`)).text();
    await ext.flush();
    expect(onlyRow(st).outcome).toBe("ok");
    expect(st.signatures.map((s) => s.to)).toEqual([OK_PAY_TO]);
    expect(st.signatures.some((s) => s.to === AVOID_PAY_TO)).toBe(false);
  });
});
