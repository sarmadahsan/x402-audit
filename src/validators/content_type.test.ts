import { describe, expect, it } from "vitest";
import { contentType, isFormatWarning } from "./content_type.js";
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
  it("passes with a missing_content_type warning when the header is missing and the body is usable", async () => {
    const r = await contentType.run(makeCtx({ response: { headers: {} } }));
    expect(r).toMatchObject({ status: "pass", reason: "missing_content_type", evidence: { header: null, actual: null, warning: true } });
    expect(isFormatWarning(r)).toBe(true);
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

/** Issue 40: usable content in another format than declared is a warning, not a failure. */
describe("content_type: the format rule", () => {
  const run = (o: { declared?: string; header?: string | null; body: string }) =>
    contentType.run(
      makeCtx({
        ...(o.declared !== undefined ? { requirements: { mimeType: o.declared } } : {}),
        response: { headers: o.header === null || o.header === undefined ? {} : { "content-type": o.header }, body: o.body },
      }),
    );

  it("warns, and does not fail, on the aiact-api.com case: declared application/json, sent the article as text/markdown", async () => {
    const r = await run({ declared: "application/json", header: "text/markdown; charset=utf-8", body: "# EU AI Act, Article 5\n\nProhibited practices..." });
    expect(r).toMatchObject({ status: "pass", reason: "content_type_mismatch", evidence: { expected: "application/json", actual: "text/markdown", expected_source: "requirements", warning: true } });
    expect(isFormatWarning(r)).toBe(true);
  });

  it("warns on JSON sent as text/plain", async () => {
    const r = await run({ declared: "application/json", header: "text/plain", body: '{"price": 1}' });
    expect(r).toMatchObject({ status: "pass", reason: "content_type_mismatch", evidence: { warning: true } });
  });

  it("fails broken JSON sent as text/plain where JSON was declared", async () => {
    const r = await run({ declared: "application/json", header: "text/plain", body: '{"price": ' });
    expect(r).toMatchObject({ status: "fail", reason: "body_not_json" });
  });

  it("treats the JSON family as one format: parameters and +json suffixes match without a warning", async () => {
    for (const [declared, header] of [
      ["application/json; charset=utf-8", "application/json"],
      ["application/vnd.api+json", "application/json; charset=utf-8"],
      ["application/json", "application/ld+json"],
      ["application/json", "text/json"],
    ] as const) {
      const r = await run({ declared, header, body: '{"a":1}' });
      expect(r.status, `${declared} vs ${header}`).toBe("pass");
      expect(r.reason, `${declared} vs ${header}`).toBeUndefined();
    }
  });

  it("fails an HTML page served where HTML was not declared, by header or by its first bytes", async () => {
    expect(await run({ declared: "application/json", header: "text/html", body: "<html><body>Sign in</body></html>" })).toMatchObject({ status: "fail", reason: "content_type_mismatch" });
    expect(await run({ declared: "text/markdown", header: "application/xhtml+xml", body: "<html/>" })).toMatchObject({ status: "fail", reason: "content_type_mismatch" });
    expect(await run({ declared: "application/json", header: "text/plain", body: "\n  <!DOCTYPE html><html>502</html>" })).toMatchObject({ status: "fail", reason: "html_body" });
    expect(await run({ declared: "application/json", header: null, body: "<html>error</html>" })).toMatchObject({ status: "fail", reason: "html_body" });
  });

  it("passes HTML where HTML or a wildcard covering it was declared", async () => {
    expect(await run({ declared: "text/html", header: "text/html", body: "<html></html>" })).toMatchObject({ status: "pass" });
    expect((await run({ declared: "text/*", header: "text/html", body: "<html></html>" })).reason).toBeUndefined();
  });

  it("fails an undeclared application/problem+json error document", async () => {
    expect(await run({ declared: "application/json", header: "application/problem+json", body: '{"title":"Upstream failed","status":502}' })).toMatchObject({ status: "fail", reason: "content_type_mismatch" });
  });

  it("warns when a JSON type was sent where another was declared, and fails it when that JSON does not parse", async () => {
    expect(await run({ declared: "text/csv", header: "application/json", body: '[["a",1]]' })).toMatchObject({ status: "pass", reason: "content_type_mismatch" });
    expect(await run({ declared: "text/csv", header: "application/json", body: "a,b" })).toMatchObject({ status: "fail", reason: "body_not_json" });
  });

  it("applies the same rule when the seller declared no type (application/json expected by default)", async () => {
    const r = await run({ header: "text/markdown", body: "# title" });
    expect(r).toMatchObject({ status: "pass", reason: "content_type_mismatch", evidence: { expected_source: "default", warning: true } });
    expect(await run({ header: "text/html", body: "<html></html>" })).toMatchObject({ status: "fail", reason: "content_type_mismatch" });
  });

  it("fails a missing header over broken JSON where JSON was expected", async () => {
    expect(await run({ declared: "application/json", header: null, body: '{"a":' })).toMatchObject({ status: "fail", reason: "body_not_json" });
  });

  it("looks past any amount of leading whitespace for an HTML page or broken JSON", async () => {
    const pad = " \n".repeat(300);
    expect(await run({ declared: "application/json", header: "text/plain", body: `${pad}<html>Bad gateway</html>` })).toMatchObject({ status: "fail", reason: "html_body" });
    expect(await run({ declared: "application/json", header: "text/plain", body: `${pad}{"a":` })).toMatchObject({ status: "fail", reason: "body_not_json" });
  });

  it("still fails a JSON-labelled body that does not parse", async () => {
    expect(await run({ declared: "application/json", header: "application/json", body: "plain words" })).toMatchObject({ status: "fail", reason: "body_not_json" });
  });
});

