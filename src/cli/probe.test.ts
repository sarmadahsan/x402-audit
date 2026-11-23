import { describe, expect, it } from "vitest";
import { parseWhole } from "./probe.js";

describe("probe run numeric flags", () => {
  it("accepts whole numbers only; empty, blank, fractional and non-numeric values are NaN, never 0", () => {
    expect([parseWhole("0"), parseWhole("8"), parseWhole(" 45 "), parseWhole("+3")]).toEqual([0, 8, 45, 3]);
    for (const bad of ["", " ", "0.5", "2.5", "abc", "1e3", "0x10", "-", "Infinity"]) expect(parseWhole(bad), bad).toBeNaN();
    // Negative numbers parse; the command's range check is what rejects them.
    expect(parseWhole("-1")).toBe(-1);
  });
});
