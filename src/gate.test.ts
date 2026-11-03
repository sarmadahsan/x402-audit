import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gateNote, gateReason, gateTests, GATE_MAX_AGE_MS, type GateMarker } from "./gate.js";
// @ts-expect-error plain ESM script without types
import { testsFromReport } from "../scripts/gate.mjs";

const passed = { status: "passed" as const, passed: 412, failed: 0, files: [] };
const m: GateMarker = { commit: "a".repeat(40), dirty: false, ranAt: 1_000_000, tests: passed };
const failed: GateMarker = { ...m, tests: { status: "failed", passed: 411, failed: 1, files: ["test/e2e-mock.test.ts"] } };

describe("gate marker", () => {
  it("passes only for a fresh, clean marker on the same commit", () => {
    expect(gateReason(m, m.commit, false, m.ranAt! + 1000)).toBeNull();
    expect(gateReason(undefined, m.commit, false)).toMatch(/no gate run recorded/);
    expect(gateReason({ ...m, dirty: true }, m.commit, false, m.ranAt)).toMatch(/dirty/);
    expect(gateReason(m, m.commit, true, m.ranAt)).toMatch(/dirty/);
  });

  it("failed or errored tests no longer refuse: they are advisory and recorded on the run", () => {
    expect(gateReason(failed, m.commit, false, m.ranAt! + 1000)).toBeNull();
    expect(gateReason({ ...m, tests: { status: "error", passed: null, failed: null, files: [] } }, m.commit, false, m.ranAt! + 1000)).toBeNull();
  });

  it("a stale or mismatched marker still refuses, whatever its tests found", () => {
    for (const marker of [m, failed]) {
      expect(gateReason(marker, "b".repeat(40), false, marker.ranAt)).toMatch(/HEAD is bbbbbbbbbb/);
      expect(gateReason(marker, marker.commit, false, marker.ranAt! + GATE_MAX_AGE_MS + 1)).toMatch(/older than 24 h/);
    }
    expect(gateReason({ commit: m.commit, dirty: false }, m.commit, false, 0)).toMatch(/no run time/);
  });

  it("accepts the marker shape from before 2026-11-03 (passedAt, written only on a pass) for one deploy", () => {
    const old: GateMarker = { commit: m.commit, dirty: false, passedAt: 1_000_000, node: "v22" };
    expect(gateReason(old, m.commit, false, old.passedAt! + 1000)).toBeNull();
    expect(gateReason(old, m.commit, false, old.passedAt! + GATE_MAX_AGE_MS + 1)).toMatch(/older than 24 h/);
    expect(gateTests(old)).toEqual({ status: "passed", passed: null, failed: null, files: [] });
  });

  it("gateNote reads what a run records; a missing or unreadable file is status error", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-note-"));
    writeFileSync(join(dir, "ok.json"), JSON.stringify(failed));
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(gateNote(join(dir, "ok.json"))).toEqual({ ...failed.tests, commit: m.commit });
    expect(gateNote(join(dir, "bad.json"))).toEqual({ status: "error", passed: null, failed: null, files: [], commit: null });
    expect(gateNote(join(dir, "missing.json")).status).toBe("error");
  });
});

describe("scripts/gate.mjs: tests block from vitest's JSON report", () => {
  const root = "/repo";
  it("passed, failed (files relative and from each file's own status), error without a report", () => {
    const ok = { success: true, numPassedTests: 3, numFailedTests: 0, testResults: [{ name: "/repo/src/a.test.ts", status: "passed" }] };
    expect(testsFromReport(ok, 0, root)).toEqual({ status: "passed", passed: 3, failed: 0, files: [] });
    const bad = {
      success: false, numPassedTests: 410, numFailedTests: 1,
      testResults: [{ name: "/repo/test/e2e-mock.test.ts", status: "failed" }, { name: "/repo/src/b.test.ts", status: "failed" }, { name: "/repo/src/a.test.ts", status: "passed" }],
    };
    expect(testsFromReport(bad, 1, root)).toEqual({ status: "failed", passed: 410, failed: 1, files: ["src/b.test.ts", "test/e2e-mock.test.ts"] });
    expect(testsFromReport(null, 1, root)).toEqual({ status: "error", passed: null, failed: null, files: [] });
    // vitest exited non-zero with a report that shows no failure (an unhandled error): not a pass.
    expect(testsFromReport(ok, 1, root).status).toBe("failed");
    const many = { success: false, numPassedTests: 0, numFailedTests: 20, testResults: Array.from({ length: 20 }, (_, i) => ({ name: `/repo/t${String(i).padStart(2, "0")}.test.ts`, status: "failed" })) };
    expect(testsFromReport(many, 1, root).files).toHaveLength(10);
  });
});
