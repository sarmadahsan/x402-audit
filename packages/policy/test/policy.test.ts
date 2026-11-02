import type { PaymentRequirements } from "@x402/core/types";
import { describe, expect, it } from "vitest";
import { USDC_BASE, buildSnapshot, paidforPolicy, type PaidforRefusal } from "../src/index.js";
import { AVOID_HOST, AVOID_PAY_TO, OK_PAY_TO, fixture, freshState, mockFetch } from "./mock.js";

const req = (payTo: string, amount = "10000"): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: USDC_BASE,
  amount,
  payTo,
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the avoid set", () => {
  it("joins /v1/sellers verdicts with sellers.json pay-to addresses while the index rows carry none", () => {
    const snap = buildSnapshot(fixture("v1-sellers-api-xpay"), fixture("sellers-data-api-xpay"), new Set(["avoid"]));
    expect(snap.joinedFromData).toBe(true);
    expect(snap.matched).toBe(1);
    expect(snap.unmatched).toEqual([]);
    expect(snap.byPayTo.get(AVOID_PAY_TO)).toMatchObject({ domain: "api-xpay.com", verdict: "avoid", payTo: AVOID_PAY_TO });
    expect(snap.byPayTo.get(AVOID_PAY_TO)!.evidenceUrl).toContain("api-xpay.com.json");
  });

  it("uses pay_to_addresses on the index rows when present (the additive field), lowercased, and skips other verdicts", () => {
    const upper = AVOID_PAY_TO.toUpperCase().replace("0X", "0x");
    const snap = buildSnapshot(
      {
        sellers: [
          { domain: "Bad.Example", verdict: "avoid", pay_to_addresses: [upper, "not-an-address"], evidence_url: "https://e/x.json" },
          { domain: "fine.example", verdict: "ok", pay_to_addresses: [OK_PAY_TO] },
          { domain: "nowhere.example", verdict: "avoid", pay_to_addresses: [] },
        ],
      },
      undefined,
      new Set(["avoid"]),
    );
    expect(snap.joinedFromData).toBe(false);
    expect([...snap.byPayTo.keys()]).toEqual([AVOID_PAY_TO]);
    expect(snap.byPayTo.get(AVOID_PAY_TO)!.domain).toBe("bad.example");
    expect(snap.unmatched).toEqual(["nowhere.example"]);
    expect(snap.sellers).toBe(3);
  });
});

describe("paidforPolicy", () => {
  it("removes an avoid pay-to and keeps the others, before anything is signed", async () => {
    const st = freshState();
    const refusals: PaidforRefusal[] = [];
    const policy = paidforPolicy({ fetch: mockFetch(st), warn: false, onRefuse: (r) => refusals.push(r) });
    const status = await policy.ready();
    expect(status).toMatchObject({ current: true, addresses: 1, sellers: 1, joinedFromData: true, lastError: null });
    expect(st.sellersCalls).toBe(1);
    expect(st.dataCalls).toBe(1);

    const other = req(OK_PAY_TO);
    const kept = policy(2, [req(AVOID_PAY_TO.toUpperCase().replace("0X", "0x")), other]);
    expect(kept).toEqual([other]);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ kind: "avoid_pay_to", remaining: 1 });
    expect((refusals[0] as Extract<PaidforRefusal, { kind: "avoid_pay_to" }>).removed[0]!.seller.domain).toBe("api-xpay.com");
    expect(policy.lastRefusal).toBe(refusals[0]);
    expect(policy.lookup(AVOID_PAY_TO)?.domain).toBe("api-xpay.com");

    expect(policy(2, [req(AVOID_PAY_TO)])).toEqual([]);
    expect(policy(2, [other])).toEqual([other]);
    expect(refusals).toHaveLength(2);
    policy.stop();
  });

  it("fail-open (default): an unreachable index never blocks a payment", async () => {
    for (const sellers of [{ kind: "status", status: 503 }, { kind: "hang" }, { kind: "throw" }] as const) {
      const st = freshState();
      st.sellers = sellers;
      const policy = paidforPolicy({ fetch: mockFetch(st), warn: false, timeoutMs: 200 });
      const status = await policy.ready();
      expect(status.current).toBe(false);
      expect(status.lastError).toBeTruthy();
      const reqs = [req(AVOID_PAY_TO), req(OK_PAY_TO)];
      expect(policy(2, reqs)).toEqual(reqs);
      expect(policy.lastRefusal).toBeNull();
      policy.stop();
    }
  });

  it("fail-open: a missing sellers.json is a failed load (verdicts without addresses cannot filter anything)", async () => {
    const st = freshState();
    st.data = { kind: "status", status: 404 };
    const policy = paidforPolicy({ fetch: mockFetch(st), warn: false });
    const status = await policy.ready();
    expect(status.current).toBe(false);
    expect(status.lastError).toContain("pay-to addresses unavailable");
    expect(policy(2, [req(AVOID_PAY_TO)])).toHaveLength(1);
    policy.stop();
  });

  it("fail-closed: nothing passes until the set is loaded, then the filter applies as usual", async () => {
    const st = freshState();
    st.sellers = { kind: "status", status: 503 };
    const refusals: PaidforRefusal[] = [];
    const warnings: string[] = [];
    const policy = paidforPolicy({ fetch: mockFetch(st), failMode: "closed", warn: (m) => warnings.push(m), onRefuse: (r) => refusals.push(r) });
    await policy.ready();
    expect(policy(2, [req(AVOID_PAY_TO), req(OK_PAY_TO)])).toEqual([]);
    expect(refusals[0]).toMatchObject({ kind: "index_unavailable", reason: "not_loaded", remaining: 0 });
    expect(warnings[0]).toContain('failMode is "closed"');
    expect(policy(2, [])).toEqual([]);
    expect(refusals).toHaveLength(1);

    st.sellers = { kind: "json", body: fixture("v1-sellers-api-xpay") };
    const status = await policy.refresh();
    expect(status.current).toBe(true);
    expect(policy(2, [req(AVOID_PAY_TO), req(OK_PAY_TO)])).toEqual([req(OK_PAY_TO)]);
    policy.stop();
  });

  it("a set older than maxStaleMs is stale: fail-open passes everything, fail-closed refuses everything", async () => {
    const st = freshState();
    const open = paidforPolicy({ fetch: mockFetch(st), warn: false, maxStaleMs: 1 });
    const closed = paidforPolicy({ fetch: mockFetch(st), warn: false, maxStaleMs: 1, failMode: "closed" });
    await Promise.all([open.ready(), closed.ready()]);
    await sleep(10);
    expect(open.status().current).toBe(false);
    expect(open(2, [req(AVOID_PAY_TO)])).toHaveLength(1);
    expect(closed(2, [req(OK_PAY_TO)])).toEqual([]);
    expect(closed.lastRefusal).toMatchObject({ kind: "index_unavailable", reason: "stale" });
    open.stop();
    closed.stop();
  });

  it("refuseVerdicts can include caution", async () => {
    const st = freshState();
    st.sellers = { kind: "json", body: { sellers: [{ domain: "slow.example", verdict: "caution", pay_to_addresses: [OK_PAY_TO] }] } };
    const policy = paidforPolicy({ fetch: mockFetch(st), warn: false, refuseVerdicts: ["avoid", "caution"] });
    await policy.ready();
    expect(st.dataCalls).toBe(0);
    expect(policy(2, [req(OK_PAY_TO)])).toEqual([]);
    policy.stop();
  });

  it("autoStart false loads nothing until ready(); concurrent refreshes share one load; onRefresh fires per attempt", async () => {
    const st = freshState();
    const seen: boolean[] = [];
    const policy = paidforPolicy({ fetch: mockFetch(st), warn: false, autoStart: false, onRefresh: (s) => seen.push(s.current) });
    await sleep(5);
    expect(st.sellersCalls).toBe(0);
    expect(policy(2, [req(AVOID_PAY_TO)])).toHaveLength(1); // fail-open while not loaded
    await Promise.all([policy.ready(), policy.refresh(), policy.refresh()]);
    expect(st.sellersCalls).toBe(1);
    expect(seen).toEqual([true]);
    expect(policy(2, [req(AVOID_PAY_TO)])).toEqual([]);
    policy.stop();
  });

  it("sends the X-Paidfor-Client header and nothing else about the caller on index requests", async () => {
    const st = freshState();
    const seen: Array<Record<string, string>> = [];
    const spy: typeof globalThis.fetch = async (input, init) => {
      const h: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (h[k] = v));
      seen.push(h);
      return mockFetch(st)(input, init);
    };
    const policy = paidforPolicy({ fetch: spy, warn: false });
    await policy.ready();
    expect(seen).toHaveLength(2);
    for (const h of seen) expect(h).toEqual({ accept: "application/json", "x-paidfor-client": "x402-policy/0.1.0" });
    policy.stop();
  });

  it(`keys on pay-to, so a request to ${AVOID_HOST} is refused whatever URL the seller declares`, async () => {
    const st = freshState();
    const policy = paidforPolicy({ fetch: mockFetch(st), warn: false });
    await policy.ready();
    expect(policy(1, [{ ...req(AVOID_PAY_TO), network: "base" as never }])).toEqual([]);
    policy.stop();
  });
});

describe("where pay-to addresses come from", () => {
  type Rows = { sellers: Array<Record<string, unknown>> };
  const indexRow = (): Record<string, unknown> => ({ ...(fixture<Rows>("v1-sellers-api-xpay").sellers[0] as Record<string, unknown>) });

  it("/v1/sellers rows that carry pay_to_addresses are used as they are: sellers.json is never requested", async () => {
    const st = freshState();
    st.sellers = { kind: "json", body: { sellers: [{ ...indexRow(), pay_to_addresses: [AVOID_PAY_TO] }] } };
    st.data = { kind: "status", status: 500 }; // would fail the load if it were ever read
    const policy = paidforPolicy({ fetch: mockFetch(st), warn: false });
    const status = await policy.ready();
    expect(status).toMatchObject({ current: true, addresses: 1, sellers: 1, joinedFromData: false, lastError: null });
    expect(st.sellersCalls).toBe(1);
    expect(st.dataCalls).toBe(0);
    expect(policy(2, [req(AVOID_PAY_TO)])).toEqual([]);
    policy.stop();
  });

  it("/v1/sellers rows without pay_to_addresses fall back to sellers.json, read once and joined on domain", async () => {
    const st = freshState();
    expect(indexRow()).not.toHaveProperty("pay_to_addresses");
    const policy = paidforPolicy({ fetch: mockFetch(st), warn: false });
    const status = await policy.ready();
    expect(status).toMatchObject({ current: true, addresses: 1, sellers: 1, joinedFromData: true, lastError: null });
    expect(st.sellersCalls).toBe(1);
    expect(st.dataCalls).toBe(1);
    expect(policy(2, [req(AVOID_PAY_TO)])).toEqual([]);
    policy.stop();
  });

  it("mixed rows: sellers.json is read once and fills in only the rows that lack the field", async () => {
    const st = freshState();
    st.sellers = { kind: "json", body: { sellers: [indexRow(), { domain: "other.example", verdict: "avoid", pay_to_addresses: [OK_PAY_TO] }] } };
    const policy = paidforPolicy({ fetch: mockFetch(st), warn: false });
    const status = await policy.ready();
    expect(status).toMatchObject({ current: true, addresses: 2, sellers: 2, joinedFromData: true, unmatched: [] });
    expect(st.dataCalls).toBe(1);
    expect(policy.lookup(AVOID_PAY_TO)?.domain).toBe("api-xpay.com");
    expect(policy.lookup(OK_PAY_TO)?.domain).toBe("other.example");
    policy.stop();
  });

  it("a row's own pay_to_addresses win over sellers.json for the same domain", async () => {
    const st = freshState();
    st.sellers = { kind: "json", body: { sellers: [{ ...indexRow(), pay_to_addresses: [OK_PAY_TO] }, { domain: "nowhere.example", verdict: "avoid" }] } };
    const policy = paidforPolicy({ fetch: mockFetch(st), warn: false });
    const status = await policy.ready();
    expect(st.dataCalls).toBe(1); // forced by nowhere.example
    expect(status).toMatchObject({ addresses: 1, sellers: 1, joinedFromData: true, unmatched: ["nowhere.example"] });
    expect(policy.lookup(OK_PAY_TO)?.domain).toBe("api-xpay.com");
    expect(policy.lookup(AVOID_PAY_TO)).toBeUndefined();
    policy.stop();
  });
});
