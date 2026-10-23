import { describe, expect, it } from "vitest";
import { entityMatches } from "./entity_matches.js";
import { makeCtx } from "./test-helpers.js";

const service = { domain: "api.example.com", entity: { request_param: "symbol", response_path: "$.data.symbol" } };

describe("entity_matches", () => {
  it("skips with no_config", async () => {
    expect(await entityMatches.run(makeCtx())).toMatchObject({ status: "skipped", reason: "no_config" });
  });
  it("skips when the request param is absent", async () => {
    const r = await entityMatches.run(makeCtx({ service, request: { params: {} } }));
    expect(r).toMatchObject({ status: "skipped", reason: "request_param_absent" });
  });
  it("passes case-insensitively and trimmed by default", async () => {
    const r = await entityMatches.run(makeCtx({ service, request: { params: { symbol: "eth" } }, response: { body: '{"data":{"symbol":" ETH "}}' } }));
    expect(r).toMatchObject({ status: "pass", evidence: { expected: "eth", actual: " ETH ", path: "$.data.symbol" } });
  });
  it("compares numbers as strings", async () => {
    const svc = { domain: "x", entity: { request_param: "id", response_path: "$.id" } };
    const r = await entityMatches.run(makeCtx({ service: svc, request: { params: { id: "42" } }, response: { body: '{"id":42}' } }));
    expect(r.status).toBe("pass");
  });
  it("fails case-sensitively when case_insensitive is false", async () => {
    const svc = { domain: "x", entity: { ...service.entity, case_insensitive: false } };
    const r = await entityMatches.run(makeCtx({ service: svc, request: { params: { symbol: "eth" } }, response: { body: '{"data":{"symbol":"ETH"}}' } }));
    expect(r).toMatchObject({ status: "fail", reason: "entity_mismatch", evidence: { expected: "eth", actual: "ETH" } });
  });
  it("fails on a different entity", async () => {
    const r = await entityMatches.run(makeCtx({ service, response: { body: '{"data":{"symbol":"BTC"}}' } }));
    expect(r).toMatchObject({ status: "fail", reason: "entity_mismatch", evidence: { expected: "ETH", actual: "BTC" } });
  });
  it("fails when the path yields nothing", async () => {
    const r = await entityMatches.run(makeCtx({ service, response: { body: '{"data":{}}' } }));
    expect(r).toMatchObject({ status: "fail", reason: "entity_missing_in_response", evidence: { actual: null } });
  });
  it("fails body_not_json", async () => {
    const r = await entityMatches.run(makeCtx({ service, response: { body: "ETH" } }));
    expect(r).toMatchObject({ status: "fail", reason: "body_not_json" });
  });
});
