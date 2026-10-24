import { describe, expect, it } from "vitest";
import { gateReason, GATE_MAX_AGE_MS } from "./gate.js";

const m = { commit: "a".repeat(40), dirty: false, passedAt: 1_000_000 };
describe("integration-suite gate", () => {
  it("passes only for a fresh, clean marker on the same commit", () => {
    expect(gateReason(m, m.commit, false, m.passedAt + 1000)).toBeNull();
    expect(gateReason(undefined, m.commit, false)).toMatch(/no passing/);
    expect(gateReason(m, "b".repeat(40), false, m.passedAt)).toMatch(/HEAD is/);
    expect(gateReason({ ...m, dirty: true }, m.commit, false, m.passedAt)).toMatch(/dirty/);
    expect(gateReason(m, m.commit, true, m.passedAt)).toMatch(/dirty/);
    expect(gateReason(m, m.commit, false, m.passedAt + GATE_MAX_AGE_MS + 1)).toMatch(/older than 24 h/);
  });
});
