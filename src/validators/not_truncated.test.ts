import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES } from "../taxonomy.js";
import { notTruncated } from "./not_truncated.js";
import { makeCtx } from "./test-helpers.js";

describe("not_truncated", () => {
  it("passes on a complete JSON body matching declared length", async () => {
    const r = await notTruncated.run(makeCtx({ response: { body: '{"a":1}', declaredLength: 7 } }));
    expect(r.status).toBe("pass");
    expect(r.evidence).toMatchObject({ declared: 7, received: 7, truncatedByUs: false, incomplete: false });
  });
  it("fails when the connection ended early", async () => {
    const r = await notTruncated.run(makeCtx({ response: { incomplete: true } }));
    expect(r).toMatchObject({ status: "fail", reason: "connection_ended_early", evidence: { incomplete: true } });
  });
  it("fails when shorter than declared", async () => {
    const r = await notTruncated.run(makeCtx({ response: { body: '{"a":1}', declaredLength: 100 } }));
    expect(r).toMatchObject({ status: "fail", reason: "shorter_than_declared", evidence: { declared: 100, received: 7 } });
  });
  it("fails on unterminated JSON", async () => {
    const r = await notTruncated.run(makeCtx({ response: { body: '  {"a":[1,2,' } }));
    expect(r).toMatchObject({ status: "fail", reason: "json_unterminated" });
  });
  it("does not call non-JSON-looking garbage unterminated (content_type owns that)", async () => {
    const r = await notTruncated.run(makeCtx({ response: { body: "Internal Server Error" } }));
    expect(r.status).toBe("pass");
  });
  it("checks framing only when we truncated a large body", async () => {
    const r = await notTruncated.run(
      makeCtx({ response: { body: '{"a":"' + "x".repeat(100), truncatedByUs: true, declaredLength: MAX_BODY_BYTES + 10 } }),
    );
    expect(r).toMatchObject({ status: "pass", evidence: { checked: "framing_only", truncatedByUs: true } });
  });
  it("still fails when we truncated but the connection was incomplete", async () => {
    const r = await notTruncated.run(makeCtx({ response: { truncatedByUs: true, incomplete: true, declaredLength: MAX_BODY_BYTES + 10 } }));
    expect(r.reason).toBe("connection_ended_early");
  });
});
