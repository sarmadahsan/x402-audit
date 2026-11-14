import { VALIDATORS } from "../taxonomy.js";
import type { Validator, ValidatorResult } from "./types.js";
import { decodeBody, getHeader, isJsonMediaType, mediaType, parseJsonBody } from "./util.js";

/**
 * The format rule (issue 40). A response in another format than the seller declared, whose body is usable, is a
 * warning: status `pass`, `reason` naming it (`content_type_mismatch`, or `missing_content_type` when the header is
 * absent) and `evidence.warning: true`. It stays a failure when the answer has the shape of an error rather than of
 * content: HTML (by header or by its first bytes) where HTML was not declared, an `application/problem+json` document
 * that was not declared, or a body that should be JSON and does not parse. Empty, truncated and non-2xx answers are
 * failed by the other validators.
 */
export const WARNING_REASONS = ["content_type_mismatch", "missing_content_type"] as const;
export type WarningReason = (typeof WARNING_REASONS)[number];

function matches(expected: string, actual: string): boolean {
  if (expected === actual || expected === "*/*") return true;
  if (expected.endsWith("/*")) return actual.startsWith(expected.slice(0, -1));
  return false;
}

const PROBLEM_JSON = "application/problem+json";
const isHtmlType = (mt: string) => mt === "text/html" || mt === "application/xhtml+xml";
/** The expected type admits HTML: HTML itself or a wildcard that covers it. */
const htmlExpected = (mt: string) => isHtmlType(mt) || mt === "*/*" || mt === "text/*" || mt === "application/*";
/** The JSON family as one format: application/json, text/json and +json types, except the error-document type. */
const jsonFamily = (mt: string) => isJsonMediaType(mt) && mt !== PROBLEM_JSON;

/**
 * The body's first 256 characters after the BOM, leading whitespace and any leading HTML comments, lower-cased. An
 * unterminated leading comment reads as HTML: it is markup either way.
 */
function head(body: Uint8Array): string {
  let t = decodeBody(body).replace(/^\uFEFF/, "").trimStart();
  while (t.startsWith("<!--")) {
    const end = t.indexOf("-->");
    if (end < 0) return "<html";
    t = t.slice(end + 3).trimStart();
  }
  return t.slice(0, 256).toLowerCase();
}
const looksHtml = (h: string) => h.startsWith("<!doctype html") || h.startsWith("<html");
const looksJson = (h: string) => h.startsWith("{") || h.startsWith("[");

export const contentType: Validator = {
  name: VALIDATORS.CONTENT_TYPE,
  run(ctx) {
    // Sellers may send mimeType "" (or whitespace); that is "undeclared", not an empty expectation.
    const declared = ctx.requirements.mimeType?.trim() || undefined;
    const expected_source = declared ? "requirements" : "default";
    const expectedRaw = declared ?? "application/json";
    const expected = mediaType(expectedRaw);
    const header = getHeader(ctx.response.headers, "content-type");
    const body = ctx.response.body;
    const h = head(body);
    const bytes = body.length;
    const notJson = (base: Record<string, unknown>): ValidatorResult | null => {
      const parsed = parseJsonBody(body);
      return parsed.ok ? null : { status: "fail", reason: "body_not_json", evidence: { ...base, parse_error: parsed.error, bytes } };
    };

    if (header === undefined || mediaType(header) === "") {
      const base = { header: header ?? null, actual: null, expected, expected_source };
      if (!htmlExpected(expected) && looksHtml(h)) return { status: "fail", reason: "html_body", evidence: { ...base, bytes } };
      if (jsonFamily(expected) && looksJson(h)) {
        const bad = notJson(base);
        if (bad) return bad;
      }
      return { status: "pass", reason: "missing_content_type", evidence: { ...base, warning: true, bytes } };
    }

    const actual = mediaType(header);
    const base = { header, actual, expected, expected_source };
    if (!matches(expected, actual) && !(jsonFamily(expected) && jsonFamily(actual))) {
      if (actual === PROBLEM_JSON) return { status: "fail", reason: "content_type_mismatch", evidence: base };
      // An HTML label over a body that parses as JSON is JSON mislabelled, so usable; anything else under it is a page.
      if (isHtmlType(actual) && !htmlExpected(expected) && !(looksJson(h) && parseJsonBody(body).ok)) {
        return { status: "fail", reason: "content_type_mismatch", evidence: base };
      }
      if (!htmlExpected(expected) && looksHtml(h)) return { status: "fail", reason: "html_body", evidence: { ...base, bytes } };
      if (isJsonMediaType(actual) || (jsonFamily(expected) && looksJson(h))) {
        const bad = notJson(base);
        if (bad) return bad;
      }
      return { status: "pass", reason: "content_type_mismatch", evidence: { ...base, warning: true, bytes } };
    }
    if (isJsonMediaType(actual)) {
      return notJson(base) ?? { status: "pass", evidence: { ...base, json_parsed: true } };
    }
    return { status: "pass", evidence: base };
  },
};

/** True for a validator result that passed with a format warning. */
export function isFormatWarning(r: Pick<ValidatorResult, "status" | "reason" | "evidence"> | undefined): r is ValidatorResult & { reason: WarningReason } {
  return !!r && r.status === "pass" && r.evidence?.warning === true && (WARNING_REASONS as readonly string[]).includes(r.reason ?? "");
}
