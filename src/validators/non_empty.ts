import { VALIDATORS } from "../taxonomy.js";
import type { Validator } from "./types.js";
import { decodeBody } from "./util.js";

export const nonEmpty: Validator = {
  name: VALIDATORS.NON_EMPTY,
  run(ctx) {
    const bytes = ctx.response.body.length;
    if (bytes === 0) return { status: "fail", reason: "empty_body", evidence: { bytes } };
    if (decodeBody(ctx.response.body).trim().length === 0) {
      return { status: "fail", reason: "whitespace_only", evidence: { bytes } };
    }
    return { status: "pass", evidence: { bytes } };
  },
};
