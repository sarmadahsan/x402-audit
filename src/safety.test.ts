import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { haltRequested, liveGateReason } from "./safety.js";

describe("live gate", () => {
  const ok = { liveFlag: true, envLive: "1", network: "eip155:8453" as const, dryRun: false };
  it("allows only when every condition holds", () => {
    expect(liveGateReason(ok)).toBeNull();
    expect(liveGateReason({ ...ok, dryRun: true })).toMatch(/dry-run/);
    expect(liveGateReason({ ...ok, liveFlag: false })).toMatch(/--live/);
    expect(liveGateReason({ ...ok, envLive: "true" })).toMatch(/X402_AUDIT_LIVE/);
    expect(liveGateReason({ ...ok, network: "eip155:84532" })).toMatch(/mainnet/);
  });
});

describe("halt file", () => {
  it("is detected in the given root", () => {
    const d = mkdtempSync(join(tmpdir(), "x402-halt-"));
    expect(haltRequested(d)).toBe(false);
    writeFileSync(join(d, "halt"), "");
    expect(haltRequested(d)).toBe(true);
    rmSync(d, { recursive: true });
  });
});
