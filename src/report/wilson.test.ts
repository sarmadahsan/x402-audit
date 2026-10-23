import { describe, expect, it } from "vitest";
import { dollarWeightedRate, dollarWeightedWilson, sampleSizeForHalfWidth, wilsonInterval } from "./wilson.js";

describe("wilsonInterval", () => {
  it("n=0 is uninformative", () => {
    const w = wilsonInterval(0, 0);
    expect(w.p).toBe(0);
    expect(w.lo).toBe(0);
    expect(w.hi).toBe(1);
  });
  it("10/100 at 95%", () => {
    const w = wilsonInterval(10, 100);
    expect(w.p).toBe(0.1);
    expect(w.lo).toBeCloseTo(0.0552, 4);
    expect(w.hi).toBeCloseTo(0.1744, 4);
    expect(w.halfWidth).toBeCloseTo((w.hi - w.lo) / 2, 12);
  });
  it("0/n and n/n stay inside [0,1]", () => {
    const a = wilsonInterval(0, 50);
    expect(a.lo).toBe(0);
    expect(a.hi).toBeGreaterThan(0);
    const b = wilsonInterval(50, 50);
    expect(b.hi).toBe(1);
    expect(b.lo).toBeLessThan(1);
  });
  it("rejects successes > n", () => {
    expect(() => wilsonInterval(5, 4)).toThrow(RangeError);
  });
});

describe("sampleSizeForHalfWidth", () => {
  it("0.10 rate, 0.01 half-width ~ 3457", () => {
    const n = sampleSizeForHalfWidth(0.1, 0.01);
    expect(Math.abs(n - 3457)).toBeLessThanOrEqual(5);
  });
  it("is the smallest such n", () => {
    const n = sampleSizeForHalfWidth(0.1, 0.01);
    expect(wilsonInterval(0.1 * n, n).halfWidth).toBeLessThanOrEqual(0.01);
    expect(wilsonInterval(0.1 * (n - 1), n - 1).halfWidth).toBeGreaterThan(0.01);
  });
  it("rejects bad input", () => {
    expect(() => sampleSizeForHalfWidth(0.1, 0)).toThrow(RangeError);
    expect(() => sampleSizeForHalfWidth(1.5, 0.1)).toThrow(RangeError);
  });
});

describe("dollar-weighted", () => {
  it("empty rows", () => {
    expect(dollarWeightedRate([])).toEqual({ rate: 0, totalAtomic: 0n, failedAtomic: 0n });
    expect(dollarWeightedWilson([])).toEqual({ p: 0, lo: 0, hi: 1, halfWidth: 0.5, effectiveN: 0 });
  });
  it("all-zero weights are treated like empty", () => {
    expect(dollarWeightedWilson([{ weightAtomic: 0n, failed: true }]).effectiveN).toBe(0);
  });
  it("equal weights equal the count-weighted interval", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ weightAtomic: 10_000n, failed: i < 10 }));
    const dw = dollarWeightedWilson(rows);
    const cw = wilsonInterval(10, 100);
    expect(dw.effectiveN).toBeCloseTo(100, 9);
    expect(dw.p).toBeCloseTo(cw.p, 12);
    expect(dw.lo).toBeCloseTo(cw.lo, 9);
    expect(dw.hi).toBeCloseTo(cw.hi, 9);
    expect(dollarWeightedRate(rows).rate).toBeCloseTo(0.1, 12);
  });
  it("weights by amount and shrinks effective n when weights are unequal", () => {
    const rows = [
      { weightAtomic: 900n, failed: true },
      { weightAtomic: 100n, failed: false },
    ];
    const r = dollarWeightedRate(rows);
    expect(r.rate).toBeCloseTo(0.9, 12);
    expect(r.totalAtomic).toBe(1000n);
    expect(r.failedAtomic).toBe(900n);
    const w = dollarWeightedWilson(rows);
    // (1000^2) / (900^2 + 100^2) = 1e6 / 820000
    expect(w.effectiveN).toBeCloseTo(1e6 / 820000, 9);
    expect(w.lo).toBeLessThan(0.9);
    expect(w.hi).toBeGreaterThan(0.9);
  });
  it("handles large bigint weights without overflow", () => {
    const big = 10n ** 30n;
    const r = dollarWeightedRate([
      { weightAtomic: big, failed: true },
      { weightAtomic: big, failed: false },
    ]);
    expect(r.rate).toBe(0.5);
  });
  it("rejects negative weights", () => {
    expect(() => dollarWeightedRate([{ weightAtomic: -1n, failed: true }])).toThrow(RangeError);
  });
});
