import { VALIDATORS } from "../taxonomy.js";
import type { Validator } from "./types.js";
import { getHeader, isJsonMediaType, mediaType, parseJsonBody } from "./util.js";

function matches(expected: string, actual: string): boolean {
  if (expected === actual || expected === "*/*") return true;
  if (expected.endsWith("/*")) return actual.startsWith(expected.slice(0, -1));
  return false;
}

export const contentType: Validator = {
  name: VALIDATORS.CONTENT_TYPE,
  run(ctx) {
    // Sellers may send mimeType "" (or whitespace); that is "undeclared", not an empty expectation.
    const declared = ctx.requirements.mimeType?.trim() || undefined;
    const expected_source = declared ? "requirements" : "default";
    const expectedRaw = declared ?? "application/json";
    const expected = mediaType(expectedRaw);
    const header = getHeader(ctx.response.headers, "content-type");
    if (header === undefined) {
      return { status: "fail", reason: "missing_content_type", evidence: { header: null, expected, expected_source } };
    }
    const actual = mediaType(header);
    const base = { header, actual, expected, expected_source };
    if (!matches(expected, actual)) {
      return { status: "fail", reason: "content_type_mismatch", evidence: base };
    }
    if (isJsonMediaType(actual)) {
      const parsed = parseJsonBody(ctx.response.body);
      if (!parsed.ok) {
        return { status: "fail", reason: "body_not_json", evidence: { ...base, parse_error: parsed.error, bytes: ctx.response.body.length } };
      }
      return { status: "pass", evidence: { ...base, json_parsed: true } };
    }
    return { status: "pass", evidence: base };
  },
};
