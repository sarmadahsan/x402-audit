import { describe, expect, it } from "vitest";
import { freshness } from "./freshness.js";
import { makeCtx, NOW } from "./test-helpers.js";

const svc = (format?: "iso" | "unix_s" | "unix_ms") => ({
  domain: "x",
  freshness: { response_path: "$.ts", max_age_seconds: 3600, ...(format ? { format } : {}) },
});
const body = (ts: unknown) => JSON.stringify({ ts });

describe("freshness", () => {
  it("skips with no_config", async () => {
    expect(await freshness.run(makeCtx())).toMatchObject({ status: "skipped", reason: "no_config" });
  });
  it("passes a fresh ISO timestamp", async () => {
    const r = await freshness.run(makeCtx({ service: svc(), response: { body: body(new Date(NOW - 60_000).toISOString()) } }));
    expect(r).toMatchObject({ status: "pass", evidence: { ts_ms: NOW - 60_000, age_s: 60, max_age_s: 3600 } });
  });
  it("parses unix_s and unix_ms", async () => {
    const s = await freshness.run(makeCtx({ service: svc("unix_s"), response: { body: body((NOW - 10_000) / 1000) } }));
    expect(s).toMatchObject({ status: "pass", evidence: { age_s: 10 } });
    const ms = await freshness.run(makeCtx({ service: svc("unix_ms"), response: { body: body(String(NOW - 20_000)) } }));
    expect(ms).toMatchObject({ status: "pass", evidence: { age_s: 20 } });
  });
  it("fails stale", async () => {
    const r = await freshness.run(makeCtx({ service: svc("unix_ms"), response: { body: body(NOW - 3601_000) } }));
    expect(r).toMatchObject({ status: "fail", reason: "stale", evidence: { age_s: 3601 } });
  });
  it("fails future timestamps beyond 5 minutes but tolerates small skew", async () => {
    const far = await freshness.run(makeCtx({ service: svc("unix_ms"), response: { body: body(NOW + 301_000) } }));
    expect(far).toMatchObject({ status: "fail", reason: "future_timestamp" });
    const near = await freshness.run(makeCtx({ service: svc("unix_ms"), response: { body: body(NOW + 60_000) } }));
    expect(near.status).toBe("pass");
  });
  it("fails unparseable timestamps", async () => {
    const r = await freshness.run(makeCtx({ service: svc(), response: { body: body("not a date") } }));
    expect(r).toMatchObject({ status: "fail", reason: "timestamp_unparseable", evidence: { ts_raw: "not a date" } });
    const n = await freshness.run(makeCtx({ service: svc("unix_s"), response: { body: body("abc") } }));
    expect(n.reason).toBe("timestamp_unparseable");
  });
  it("fails when the timestamp is missing", async () => {
    const r = await freshness.run(makeCtx({ service: svc(), response: { body: "{}" } }));
    expect(r).toMatchObject({ status: "fail", reason: "timestamp_missing_in_response" });
  });
});
