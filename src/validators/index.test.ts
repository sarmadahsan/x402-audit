import { describe, expect, it } from "vitest";
import { ALL_VALIDATORS } from "../taxonomy.js";
import { ALL, runAllValidators } from "./index.js";
import { makeCtx } from "./test-helpers.js";
import type { Validator } from "./types.js";

describe("runAllValidators", () => {
  it("ALL is in the contract order", () => {
    expect(ALL.map((v) => v.name)).toEqual([
      "http_status", "non_empty", "content_type", "not_truncated", "json_schema", "entity_matches", "freshness", "injection_scan",
    ]);
    expect([...ALL.map((v) => v.name)].sort()).toEqual([...ALL_VALIDATORS].sort());
  });
  it("runs every validator on a default context", async () => {
    const out = await runAllValidators(makeCtx());
    expect(Object.keys(out)).toEqual(ALL.map((v) => v.name));
    expect(out.http_status.status).toBe("pass");
    expect(out.json_schema.status).toBe("skipped");
  });
  it("keeps going when a validator throws or an early one fails", async () => {
    const vs: Validator[] = [...ALL];
    vs[1] = { name: "non_empty", run: () => { throw new Error("boom"); } };
    vs[4] = { name: "json_schema", run: async () => { throw new Error("async boom"); } };
    const out = await runAllValidators(makeCtx({ response: { status: 500 } }), vs);
    expect(out.http_status).toMatchObject({ status: "fail", reason: "non_2xx_status" });
    expect(out.non_empty).toEqual({ status: "fail", reason: "validator_threw", evidence: { error: "Error: boom" } });
    expect(out.json_schema).toMatchObject({ status: "fail", reason: "validator_threw" });
    expect(Object.keys(out)).toHaveLength(8);
    expect(out.injection_scan.status).toBe("pass");
  });
});
