/**
 * The re-test lane (src/buy/retest.ts): the verdict mirror, the phases derived from the call history, the probe gate
 * and the budget.
 */
import { describe, expect, it } from "vitest";
import { openDb, type Db } from "../db/index.js";
import { usdToAtomic } from "../config/index.js";
import { sellerUniverse } from "./allocate.js";
import { rowsFromAllocations } from "./allocate.js";
import {
  AVOID_FLOOR_DAYS,
  AVOID_LOW_BOUND,
  CAUTION_RATE,
  MIN_CALLS,
  RAMP_MAX_PER_RUN,
  WINDOW_MIN_CALLS,
  WINDOW_SIZE,
  retestAllocations,
  retestBlock,
  retestRunBudget,
  retestStatuses,
  sellerVerdict,
  type WindowRow,
} from "./retest.js";

const NET = "eip155:8453";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

let n = 0;
/** A seller with one resource, its first 402 probe ten days old, and an optional later probe for the gate. */
function seller(d: Db, id: number, o: { price?: string; inflowUsd?: number; probe?: { status: number; outcome?: string; ts?: number } | false } = {}) {
  d.prepare("INSERT INTO sellers (id, domain, volume_30d_atomic, volume_30d_source, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'chain', 0, 0)").run(id, `s${id}.example`, usdToAtomic(o.inflowUsd ?? 0).toString());
  const rid = id * 10;
  const price = o.price ?? "1000";
  d.prepare("INSERT INTO resources (id, seller_id, url, source, network, scheme, declared_price_atomic, raw_json, first_seen_at, last_seen_at) VALUES (?, ?, ?, 'bazaar', ?, 'exact', ?, '{}', 0, 0)").run(rid, id, `https://s${id}.example/r`, NET, price);
  // sellerUniverse needs one 402 probe for the seller; the gate reads the latest one.
  d.prepare("INSERT INTO probes (resource_id, client_identity, ts, status, amount_atomic, network, outcome) VALUES (?, 'A', ?, 402, ?, ?, 'ok')").run(rid, NOW - 10 * DAY, price, NET);
  if (o.probe) d.prepare("INSERT INTO probes (resource_id, client_identity, ts, status, amount_atomic, network, outcome) VALUES (?, 'A', ?, ?, ?, ?, ?)").run(rid, o.probe.ts ?? NOW - 3_600_000, o.probe.status, price, NET, o.probe.outcome ?? "ok");
}
/** One paid call row for seller `id`'s resource. */
function call(d: Db, id: number, outcome: string, ts: number, source = "buy") {
  d.prepare("INSERT INTO calls (intent_id, source, resource_id, seller_id, ts, paid, amount_paid_atomic, request_json, outcome) VALUES (?, ?, ?, ?, ?, 1, '1000', '{}', ?)").run(`i${++n}`, source, id * 10, id, ts, outcome);
}
/** `fails` failures then `oks` clean calls, one a minute, the last at `lastTs`. */
function history(d: Db, id: number, o: { fails: number; oks: number; lastFailTs: number; source?: string }) {
  for (let k = 0; k < o.fails; k++) call(d, id, "non_delivery", o.lastFailTs - (o.fails - 1 - k) * 60_000);
  for (let k = 0; k < o.oks; k++) call(d, id, "ok", o.lastFailTs + (k + 1) * 60_000, o.source ?? "buy");
}
const rows = (fails: number, oks: number, lastFailTs: number): WindowRow[] => [
  ...Array.from({ length: fails }, (_, k) => ({ failed: 1, ts: lastFailTs - k })),
  ...Array.from({ length: oks }, (_, k) => ({ failed: 0, ts: lastFailTs + 1 + k })),
];
const lane = (d: Db, extra: Partial<Parameters<typeof retestAllocations>[1]> = {}) =>
  retestAllocations(d, {
    network: NET,
    now: NOW,
    budgetAtomic: usdToAtomic(0.15),
    weeklyBudgetAtomic: usdToAtomic(3),
    sellerCapAtomic: usdToAtomic(0.15),
    perCallCapAtomic: usdToAtomic(0.1),
    universe: sellerUniverse(d, { network: NET, capAtomic: usdToAtomic(0.1), now: NOW }),
    ...extra,
  });

describe("verdict mirror", () => {
  it("uses the index's constants (paidfor-index lib/verdict.ts)", () => {
    expect([AVOID_LOW_BOUND, CAUTION_RATE, MIN_CALLS, WINDOW_SIZE, WINDOW_MIN_CALLS, AVOID_FLOOR_DAYS]).toEqual([0.1, 0.02, 30, 50, 30, 7]);
  });

  it("matches the index's window and floor cases", () => {
    // 33 of 41 failed all-time: avoid.
    expect(sellerVerdict({ n: 41, failures: 33 }, rows(33, 8, NOW - 30 * DAY), NOW).verdict).toBe("avoid");
    // 50 clean after the failures, last failure 30 days ago: the window decides, ok.
    expect(sellerVerdict({ n: 91, failures: 33 }, rows(0, 50, NOW - 30 * DAY), NOW)).toMatchObject({ verdict: "ok", floor: false });
    // Window ok but a failure 3 days ago and all-time avoid: the floor holds it.
    const held = sellerVerdict({ n: 91, failures: 33 }, rows(1, 49, NOW - 3 * DAY), NOW);
    expect(held).toMatchObject({ verdict: "avoid", windowVerdict: "ok", floor: true });
    // Exactly 7 days: floor lifted.
    expect(sellerVerdict({ n: 91, failures: 33 }, rows(1, 49, NOW - 7 * DAY), NOW).verdict).toBe("ok");
    // A window under 30 calls: the all-time rule.
    expect(sellerVerdict({ n: 41, failures: 33 }, rows(0, 29, NOW - 30 * DAY), NOW)).toMatchObject({ verdict: "avoid", windowVerdict: null });
  });

  it("counts clean calls since the newest failure", () => {
    expect(sellerVerdict({ n: 40, failures: 30 }, rows(30, 7, NOW - 5 * DAY), NOW).cleanSinceFailure).toBe(7);
  });
});

describe("retestStatuses", () => {
  it("leaves sellers that are not avoid out", () => {
    const d = openDb(":memory:");
    seller(d, 1);
    history(d, 1, { fails: 0, oks: 40, lastFailTs: NOW - 20 * DAY });
    seller(d, 2);
    history(d, 2, { fails: 1, oks: 40, lastFailTs: NOW - 20 * DAY }); // caution, not avoid
    expect(retestStatuses(d, { network: NET, now: NOW })).toEqual([]);
  });

  it("waits 3 days after the last failure, then sends one sentinel", () => {
    const d = openDb(":memory:");
    seller(d, 1);
    history(d, 1, { fails: 30, oks: 0, lastFailTs: NOW - 2 * DAY });
    expect(retestStatuses(d, { network: NET, now: NOW })[0]).toMatchObject({ phase: "waiting", cycle: 0, nextDueTs: NOW + DAY });
    expect(lane(d).allocations).toEqual([]);
    const later = NOW + DAY;
    const st = retestStatuses(d, { network: NET, now: later })[0]!;
    expect(st).toMatchObject({ phase: "sentinel", nextDueTs: null });
    const l = lane(d, { now: later, universe: sellerUniverse(d, { network: NET, capAtomic: usdToAtomic(0.1), now: later }) });
    expect(l.allocations).toHaveLength(1);
    expect(l.allocations[0]).toMatchObject({ sellerId: 1, calls: 1, tier: "retest", source: "retest" });
    expect(rowsFromAllocations(l.allocations)[0]!.pool).toBe("retest");
  });

  it("one sentinel a day", () => {
    const d = openDb(":memory:");
    seller(d, 1);
    history(d, 1, { fails: 30, oks: 0, lastFailTs: NOW - 5 * DAY });
    call(d, 1, "ok", NOW - 3_600_000, "retest");
    const st = retestStatuses(d, { network: NET, now: NOW })[0]!;
    expect(st).toMatchObject({ phase: "sentinel", cleanStreak: 1, retestCalls: 1 });
    expect(st.nextDueTs).toBe(NOW - 3_600_000 + 20 * 3_600_000);
    expect(lane(d).allocations).toEqual([]);
  });

  it("ramps after 3 clean calls, up to 4 a run", () => {
    const d = openDb(":memory:");
    seller(d, 1);
    history(d, 1, { fails: 30, oks: 3, lastFailTs: NOW - 5 * DAY, source: "retest" });
    expect(retestStatuses(d, { network: NET, now: NOW })[0]).toMatchObject({ phase: "ramp", cleanStreak: 3 });
    expect(lane(d).allocations.reduce((s, a) => s + a.calls, 0)).toBe(RAMP_MAX_PER_RUN);
  });

  it("holds without buying when only the 7-day floor keeps it at avoid", () => {
    const d = openDb(":memory:");
    seller(d, 1);
    history(d, 1, { fails: 30, oks: 0, lastFailTs: NOW - 40 * DAY });
    // One more failure 4 days ago, then 49 clean: window 1/50 = ok, all-time 31/80 = avoid, floor holds.
    call(d, 1, "non_delivery", NOW - 4 * DAY);
    for (let k = 1; k <= 49; k++) call(d, 1, "ok", NOW - 4 * DAY + k * 60_000, "retest");
    const st = retestStatuses(d, { network: NET, now: NOW })[0]!;
    expect(st.phase).toBe("holding");
    expect(retestBlock(st).next_due_at).toBe(new Date(NOW - 4 * DAY + 7 * DAY).toISOString());
    expect(lane(d).allocations).toEqual([]);
  });

  it("a re-test that fails again doubles the cooldown, and four make it dormant", () => {
    const d = openDb(":memory:");
    seller(d, 1);
    history(d, 1, { fails: 30, oks: 0, lastFailTs: NOW - 60 * DAY });
    call(d, 1, "non_delivery", NOW - 4 * DAY, "retest");
    expect(retestStatuses(d, { network: NET, now: NOW })[0]).toMatchObject({ phase: "waiting", cycle: 1, nextDueTs: NOW + 3 * DAY });
    // Two failures on one day are one cycle.
    call(d, 1, "overcharge", NOW - 4 * DAY + 60_000, "retest");
    expect(retestStatuses(d, { network: NET, now: NOW })[0]!.cycle).toBe(1);
    for (const days of [50, 40, 30]) call(d, 1, "non_delivery", NOW - days * DAY, "retest");
    expect(retestStatuses(d, { network: NET, now: NOW })[0]).toMatchObject({ phase: "dormant", cycle: 4 });
    // our_error and not_paid are not failures.
    const e = openDb(":memory:");
    seller(e, 1);
    history(e, 1, { fails: 30, oks: 0, lastFailTs: NOW - 60 * DAY });
    call(e, 1, "our_error", NOW - 4 * DAY, "retest");
    expect(retestStatuses(e, { network: NET, now: NOW })[0]).toMatchObject({ phase: "sentinel", cycle: 0 });
  });
});

describe("retestAllocations", () => {
  it("the probe gate holds back a seller whose latest probe shows no 402 or an overcharge", () => {
    const d = openDb(":memory:");
    seller(d, 1, { probe: { status: 500 } });
    seller(d, 2, { probe: { status: 402, outcome: "overcharge" } });
    seller(d, 3, { probe: { status: 500, ts: NOW - 3 * DAY } }); // stale probe: the sentinel is the test
    for (const id of [1, 2, 3]) history(d, id, { fails: 30, oks: 0, lastFailTs: NOW - 5 * DAY });
    const l = lane(d);
    expect(l.allocations.map((a) => a.sellerId)).toEqual([3]);
    expect(l.skipped.filter((s) => s.reason.startsWith("probe gate")).map((s) => s.domain).sort()).toEqual(["s1.example", "s2.example"]);
  });

  it("ramp before sentinel, then demand, then inflow; stops at the budget", () => {
    const d = openDb(":memory:");
    seller(d, 1, { inflowUsd: 10 });
    seller(d, 2, { inflowUsd: 5000 });
    seller(d, 3);
    seller(d, 4);
    for (const id of [1, 2, 4]) history(d, id, { fails: 30, oks: 0, lastFailTs: NOW - 5 * DAY });
    history(d, 3, { fails: 30, oks: 3, lastFailTs: NOW - 5 * DAY }); // ramp
    const order = lane(d, { budgetAtomic: usdToAtomic(1), demand: new Map([["s4.example", 9]]) }).allocations.map((a) => a.sellerId);
    expect(order).toEqual([3, 4, 2, 1]);
    // 1000 atomic planned at 1200: a 0.006 budget fits 5 calls, the ramp's 4 and one sentinel.
    const tight = lane(d, { budgetAtomic: 6000n, demand: new Map([["s4.example", 9]]) });
    expect(tight.allocations.map((a) => [a.sellerId, a.calls])).toEqual([[3, 4], [4, 1]]);
    expect(tight.skipped.some((s) => s.reason === "re-test budget used up this run")).toBe(true);
  });

  it("the weekly budget caps the lane, and expensive-list sellers are left to their own lane", () => {
    const d = openDb(":memory:");
    seller(d, 1);
    seller(d, 2);
    for (const id of [1, 2]) history(d, id, { fails: 30, oks: 0, lastFailTs: NOW - 5 * DAY });
    expect(lane(d, { weeklyBudgetAtomic: 0n }).allocations).toEqual([]);
    const l = lane(d, { skipDomains: ["S2.example"] });
    expect(l.allocations.map((a) => a.sellerId)).toEqual([1]);
    expect(l.skipped.find((s) => s.domain === "s2.example")?.reason).toBe("bought by the expensive-sellers lane");
  });
});

describe("scheduled run limits count retest calls", () => {
  it("per run, per seller per run and the day budget sum buy and retest; a breadth run counts its own source", async () => {
    const { checkCaps } = await import("./guard.js");
    const d = openDb(":memory:");
    seller(d, 1);
    call(d, 1, "ok", NOW - 60_000, "buy");
    call(d, 1, "ok", NOW - 30_000, "retest");
    const caps = { perCallAtomic: usdToAtomic(0.1), perSellerPerDayAtomic: usdToAtomic(20), perDayAtomic: usdToAtomic(100), totalAtomic: usdToAtomic(300), stressTotalAtomic: usdToAtomic(30), auditPerDayAtomic: usdToAtomic(5) };
    const at = (run: Parameters<typeof checkCaps>[1]["run"]) => checkCaps(d, { caps, sellerId: 1, amountAtomic: 1000n, now: NOW, scope: "buy", run })?.reason ?? null;
    expect(at({ since: NOW - DAY, perRunAtomic: 2500n })).toBe("cap_per_run"); // 2000 spent across both sources
    expect(at({ since: NOW - DAY, perSellerPerRunAtomic: 2500n })).toBe("cap_per_seller_per_run");
    expect(at({ since: NOW - DAY, dayBudgetAtomic: 2500n })).toBe("cap_buy_day_budget");
    expect(at({ since: NOW - DAY, source: "breadth", perRunAtomic: 2500n })).toBeNull();
  });

  it("the weekly budget counts paid retest calls of the last 7 days", () => {
    const d = openDb(":memory:");
    seller(d, 1);
    history(d, 1, { fails: 30, oks: 0, lastFailTs: NOW - 5 * DAY });
    seller(d, 2);
    call(d, 2, "ok", NOW - DAY, "retest"); // 1000 spent this week
    call(d, 2, "ok", NOW - 8 * DAY, "retest"); // outside the week
    const l = lane(d, { weeklyBudgetAtomic: 2000n });
    expect(l.weeklyRemainingAtomic).toBe(1000n);
    expect(l.allocations).toEqual([]); // one sentinel plans 1200
  });
});

describe("re-test weekly budget at signing", () => {
  it("checkCaps refuses a retest call over RETEST_WEEKLY_USD and ignores it for other sources", async () => {
    const { checkCaps } = await import("./guard.js");
    const d = openDb(":memory:");
    seller(d, 1);
    call(d, 1, "ok", NOW - DAY, "retest"); // 1000 this week
    call(d, 1, "ok", NOW - 8 * DAY, "retest"); // last week
    const caps = { perCallAtomic: usdToAtomic(0.1), perSellerPerDayAtomic: usdToAtomic(20), perDayAtomic: usdToAtomic(100), totalAtomic: usdToAtomic(300), stressTotalAtomic: usdToAtomic(30), auditPerDayAtomic: usdToAtomic(5) };
    const run = { since: NOW - 60_000, retestWeeklyAtomic: 2500n };
    const at = (source: "retest" | "buy", amountAtomic: bigint) => checkCaps(d, { caps, sellerId: 1, amountAtomic, now: NOW, scope: "buy", run, source })?.reason ?? null;
    expect(at("retest", 1500n)).toBeNull();
    expect(at("retest", 1501n)).toBe("cap_retest_weekly");
    expect(at("buy", 5000n)).toBeNull();
  });
});

describe("retestRunBudget", () => {
  const usd = (x: number) => usdToAtomic(x);
  it("is RETEST_SHARE of the run when the other lanes leave room", () => {
    expect(retestRunBudget(usd(1), 0.15, [])).toBe(usd(0.15));
    expect(retestRunBudget(usd(1), 0.15, [{ priceAtomic: usd(0.1), calls: 2 }])).toBe(usd(0.15));
  });
  it("shrinks to what the earlier lanes leave of 95% of the run, at quote x1.2", () => {
    // Six $0.10 candidates plan $0.72; 95% of $1 leaves $0.23, more than the share.
    expect(retestRunBudget(usd(1), 0.15, [{ priceAtomic: usd(0.1), calls: 6 }])).toBe(usd(0.15));
    // Seven plan $0.84, leaving $0.11.
    expect(retestRunBudget(usd(1), 0.15, [{ priceAtomic: usd(0.1), calls: 7 }])).toBe(usd(0.11));
  });
  it("is zero when the earlier lanes already fill the run (the review case: eight $0.10 candidates)", () => {
    expect(retestRunBudget(usd(1), 0.15, Array.from({ length: 8 }, () => ({ priceAtomic: usd(0.1), calls: 1 })))).toBe(0n);
  });
  it("keeps the whole plan under the run budget with the lane at its allocation", () => {
    const prior = Array.from({ length: 7 }, () => ({ priceAtomic: usd(0.1), calls: 1 }));
    const b = retestRunBudget(usd(1), 0.15, prior);
    const priorPlan = prior.reduce((a, x) => a + ((x.priceAtomic * 120n + 99n) / 100n) * BigInt(x.calls), 0n);
    expect(priorPlan + b).toBeLessThanOrEqual(usd(1));
  });
});
