import { describe, expect, it } from "vitest";
import { jsonSchema } from "./json_schema.js";
import { makeCtx } from "./test-helpers.js";

const schema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["symbol", "price", "at"],
  properties: { symbol: { type: "string" }, price: { type: "number" }, at: { type: "string", format: "date-time" } },
};
const service = { domain: "api.example.com", json_schema: schema };

describe("json_schema", () => {
  it("skips with no_config", async () => {
    expect(await jsonSchema.run(makeCtx())).toMatchObject({ status: "skipped", reason: "no_config" });
  });
  it("ignores a seller-declared outputSchema", async () => {
    const r = await jsonSchema.run(makeCtx({ requirements: { outputSchema: { type: "object" } } }));
    expect(r).toMatchObject({ status: "skipped", reason: "no_config_seller_schema_ignored" });
  });
  it("passes a conforming body", async () => {
    const r = await jsonSchema.run(makeCtx({ service, response: { body: '{"symbol":"ETH","price":1.5,"at":"2026-10-23T12:00:00Z"}' } }));
    expect(r).toEqual({ status: "pass", evidence: { errors: [], error_count: 0 } });
  });
  it("fails with all errors listed (allErrors, formats)", async () => {
    const r = await jsonSchema.run(makeCtx({ service, response: { body: '{"symbol":5,"at":"yesterday"}' } }));
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("schema_mismatch");
    const kws = (r.evidence.errors as { keyword: string }[]).map((e) => e.keyword).sort();
    expect(kws).toEqual(["format", "required", "type"]);
    expect(r.evidence.errors).toContainEqual({ instancePath: "/symbol", message: "must be string", keyword: "type" });
  });
  it("caps errors at 20", async () => {
    const many = { domain: "x", json_schema: { type: "array", items: { type: "string" } } };
    const r = await jsonSchema.run(makeCtx({ service: many, response: { body: JSON.stringify(Array.from({ length: 30 }, (_, i) => i)) } }));
    expect((r.evidence.errors as unknown[]).length).toBe(20);
    expect(r.evidence).toMatchObject({ error_count: 30, errors_capped: true });
  });
  it("fails body_not_json", async () => {
    const r = await jsonSchema.run(makeCtx({ service, response: { body: "not json" } }));
    expect(r).toMatchObject({ status: "fail", reason: "body_not_json" });
  });
  it("skips (not fails) when our own schema is invalid", async () => {
    const r = await jsonSchema.run(makeCtx({ service: { domain: "x", json_schema: { type: 12 } }, response: { body: "{}" } }));
    expect(r).toMatchObject({ status: "skipped", reason: "schema_invalid" });
  });
});
