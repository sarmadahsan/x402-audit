import { MAX_BODY_BYTES, VALIDATORS } from "../taxonomy.js";
import type { Validator } from "./types.js";
import { decodeBody, effectiveContentType, isJsonMediaType, parseJsonBody } from "./util.js";

export const notTruncated: Validator = {
  name: VALIDATORS.NOT_TRUNCATED,
  run(ctx) {
    const r = ctx.response;
    const evidence: Record<string, unknown> = {
      declared: r.declaredLength ?? null,
      received: r.body.length,
      truncatedByUs: r.truncatedByUs,
      incomplete: r.incomplete,
    };
    if (r.incomplete) return { status: "fail", reason: "connection_ended_early", evidence };
    if (r.truncatedByUs) {
      // We stopped reading at MAX_BODY_BYTES, so length and JSON checks are meaningless; only framing can be checked.
      return { status: "pass", evidence: { ...evidence, checked: "framing_only", max_body_bytes: MAX_BODY_BYTES } };
    }
    if (r.declaredLength !== undefined && r.body.length < r.declaredLength) {
      return { status: "fail", reason: "shorter_than_declared", evidence };
    }
    const ct = effectiveContentType(ctx);
    if (isJsonMediaType(ct)) {
      const parsed = parseJsonBody(r.body);
      if (!parsed.ok) {
        const head = decodeBody(r.body, 64).replace(/^﻿/, "").trimStart();
        if (head.startsWith("{") || head.startsWith("[")) {
          return { status: "fail", reason: "json_unterminated", evidence: { ...evidence, content_type: ct, parse_error: parsed.error } };
        }
      }
      return { status: "pass", evidence: { ...evidence, checked: "framing_length_json", content_type: ct } };
    }
    return { status: "pass", evidence: { ...evidence, checked: "framing_length", content_type: ct } };
  },
};
