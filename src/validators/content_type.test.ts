import { describe, expect, it } from "vitest";
import { contentType } from "./content_type.js";
import { makeCtx } from "./test-helpers.js";

describe("content_type", () => {
  it("passes with default expectation and parameters/case ignored", async () => {
    const r = await contentType.run(makeCtx({ response: { headers: { "Content-Type": "Application/JSON; charset=utf-8" } } }));
    expect(r.status).toBe("pass");
    expect(r.evidence).toMatchObject({ expected: "application/json", expected_source: "default", actual: "application/json" });
  });
  it("uses requirements.mimeType when present", async () => {
    const r = await contentType.run(
      makeCtx({ requirements: { mimeType: "text/csv" }, response: { headers: { "content-type": "text/csv" }, body: "a,b\n1,2" } }),
    );
    expect(r).toMatchObject({ status: "pass", evidence: { expected: "text/csv", expected_source: "requirements" } });
  });
  it("fails on mismatch", async () => {
    const r = await contentType.run(makeCtx({ response: { headers: { "content-type": "text/html" }, body: "<html></html>" } }));
    expect(r).toMatchObject({ status: "fail", reason: "content_type_mismatch", evidence: { actual: "text/html", expected: "application/json" } });
  });
  it("fails when header is missing", async () => {
    const r = await contentType.run(makeCtx({ response: { headers: {} } }));
    expect(r).toMatchObject({ status: "fail", reason: "missing_content_type" });
  });
  it("fails with body_not_json when JSON type but body does not parse", async () => {
    const r = await contentType.run(makeCtx({ response: { body: "<html>error</html>" } }));
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("body_not_json");
    expect(r.evidence.parse_error).toBeTypeOf("string");
  });
  it("treats an empty declared mimeType as undeclared and falls back to application/json", async () => {
    const r = await contentType.run(makeCtx({ requirements: { mimeType: "" }, response: { headers: { "content-type": "application/json" }, body: "{}" } }));
    expect(r.status).toBe("pass");
    expect(r.evidence.expected_source).toBe("default");
    expect(r.evidence.expected).toBe("application/json");
  });
});
