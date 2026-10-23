import { VALIDATORS } from "../taxonomy.js";
import type { Validator } from "./types.js";
import { bodyPreview } from "./util.js";

/** Pass iff 200 <= status < 300. A 402 after paying means the payment was rejected. */
export const httpStatus: Validator = {
  name: VALIDATORS.HTTP_STATUS,
  run(ctx) {
    const status = ctx.response.status;
    if (status >= 200 && status < 300) return { status: "pass", evidence: { status } };
    if (status === 402) {
      return {
        status: "fail",
        reason: "payment_rejected",
        evidence: { status, body_preview: bodyPreview(ctx.response, 1024), body_bytes: ctx.response.body.length },
      };
    }
    return { status: "fail", reason: "non_2xx_status", evidence: { status } };
  },
};
