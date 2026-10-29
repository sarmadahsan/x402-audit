import { describe, expect, it } from "vitest";
import { evaluateTriggers, measuredVerdict, type MeasuredSeller, type ReportedHost } from "./triggers.js";

const NOW = Date.UTC(2026, 9, 29, 12);
const DAY = 86_400_000;
const m = (sellerId: number, domain: string, n: number, failures: number, lo: number, hi: number, lastAgoDays = 1): MeasuredSeller => ({
  sellerId,
  domain,
  n,
  failures,
  rate: n ? failures / n : 0,
  lo,
  hi,
  lastCallTs: NOW - lastAgoDays * DAY,
});
const r = (host: string, o: Partial<ReportedHost>): ReportedHost => ({ host, calls: 40, rate: 0.5, wilson_low: 0.35, wilson_high: 0.65, mature: true, ...o });

describe("audit triggers", () => {
  const sellers = new Map([
    ["a.example", 1],
    ["b.example", 2],
    ["c.example", 3],
    ["d.example", 4],
    ["e.example", 5],
  ]);

  it("(a) disagreement: mature reported interval does not overlap the measured one", () => {
    const t = evaluateTriggers({ reported: [r("a.example", {})], demand: [], measured: [m(1, "a.example", 100, 2, 0.005, 0.07)], sellers, now: NOW });
    expect(t).toHaveLength(1);
    expect(t[0]!.reasons).toEqual(["disagreement", "reported_above_ok"]); // 2 of 100 is ok, and operators report 50%
    expect(t[0]!.source).toBe("audit_disagreement");
  });

  it("overlapping intervals or an immature reported series do not trigger (a)", () => {
    // 3 of 100 is caution, not ok, so (c) does not fire either.
    const overlap = evaluateTriggers({ reported: [r("a.example", { wilson_low: 0.05 })], demand: [], measured: [m(1, "a.example", 100, 3, 0.01, 0.085)], sellers, now: NOW });
    expect(overlap).toEqual([]);
    const young = evaluateTriggers({ reported: [r("a.example", { mature: false })], demand: [], measured: [m(1, "a.example", 100, 2, 0.005, 0.07)], sellers, now: NOW });
    expect(young.find((x) => x.reasons.includes("disagreement"))).toBeUndefined();
  });

  it("(b) thin measured with a mature reported series", () => {
    const t = evaluateTriggers({ reported: [r("b.example", {})], demand: [], measured: [m(2, "b.example", 12, 6, 0.25, 0.75)], sellers, now: NOW });
    expect(t[0]!.reasons).toEqual(["thin_measured"]);
  });

  it("(c) reported above 10% on a seller we mark ok, mature or not", () => {
    const ok = m(3, "c.example", 200, 0, 0, 0.019);
    expect(measuredVerdict(ok)).toBe("ok");
    const t = evaluateTriggers({ reported: [r("c.example", { mature: false, calls: 3, rate: 0.34, wilson_low: 0.06, wilson_high: 0.79 })], demand: [], measured: [ok], sellers, now: NOW });
    expect(t[0]!.reasons).toEqual(["reported_above_ok"]);
    const notOk = evaluateTriggers({ reported: [r("c.example", { mature: false, rate: 0.34 })], demand: [], measured: [m(3, "c.example", 200, 20, 0.06, 0.15)], sellers, now: NOW });
    expect(notOk).toEqual([]);
  });

  it("(d) demand: top 20 by checks and thin or stale measured data", () => {
    const demand = [
      { host: "d.example", checks: 9 },
      { host: "e.example", checks: 5 },
      { host: "a.example", checks: 4 },
    ];
    const measured = [m(4, "d.example", 10, 0, 0, 0.28), m(5, "e.example", 400, 4, 0.004, 0.025, 20), m(1, "a.example", 400, 4, 0.004, 0.025, 1)];
    const t = evaluateTriggers({ reported: [], demand, measured, sellers, now: NOW });
    expect(t.map((x) => x.host)).toEqual(["d.example", "e.example"]); // a.example is well measured and fresh
    expect(t.every((x) => x.source === "audit_demand")).toBe(true);
    expect(t[0]!.inputs.demand).toEqual({ rank: 1, checks: 9, days: 7 });
  });

  it("only the top 20 by checks count as demand", () => {
    const demand = Array.from({ length: 25 }, (_, k) => ({ host: `h${k}.example`, checks: 100 - k }));
    const t = evaluateTriggers({ reported: [], demand, measured: [], sellers: new Map(), now: NOW });
    expect(t).toHaveLength(20);
    expect(t.some((x) => x.host === "h20.example")).toBe(false);
    expect(t[0]!.sellerId).toBeNull();
  });

  it("orders disagreements first, then demand, then the rest", () => {
    const t = evaluateTriggers({
      reported: [r("a.example", {}), r("b.example", {}), r("c.example", { mature: false, rate: 0.5 })],
      demand: [{ host: "d.example", checks: 3 }],
      measured: [m(1, "a.example", 100, 2, 0.005, 0.07), m(2, "b.example", 12, 6, 0.25, 0.75), m(3, "c.example", 200, 0, 0, 0.019), m(4, "d.example", 3, 0, 0, 0.5)],
      sellers,
      now: NOW,
    });
    expect(t.map((x) => [x.host, x.reasons[0]])).toEqual([
      ["a.example", "disagreement"],
      ["d.example", "demand"],
      ["b.example", "thin_measured"],
      ["c.example", "reported_above_ok"],
    ]);
  });
});
