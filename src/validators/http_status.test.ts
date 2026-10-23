import { describe, expect, it } from "vitest";
import { httpStatus } from "./http_status.js";
import { makeCtx } from "./test-helpers.js";

describe("http_status", () => {
  it("passes on 2xx", async () => {
    for (const status of [200, 204, 299]) {
      const r = await httpStatus.run(makeCtx({ response: { status } }));
      expect(r).toEqual({ status: "pass", evidence: { status } });
    }
  });
  it("fails on non-2xx", async () => {
    for (const status of [199, 300, 404, 500, 503]) {
      const r = await httpStatus.run(makeCtx({ response: { status } }));
      expect(r.status).toBe("fail");
      expect(r.reason).toBe("non_2xx_status");
      expect(r.evidence.status).toBe(status);
    }
  });
  it("402 after paying is payment_rejected with a body preview capped at 1 KB", async () => {
    const r = await httpStatus.run(makeCtx({ response: { status: 402, body: '{"error":"insufficient"}' } }));
    expect(r.status).toBe("fail");
    expect(r.reason).toBe("payment_rejected");
    expect(r.evidence.body_preview).toBe('{"error":"insufficient"}');
    const big = await httpStatus.run(makeCtx({ response: { status: 402, body: "x".repeat(5000) } }));
    expect((big.evidence.body_preview as string).length).toBe(1024);
    expect(big.evidence.body_bytes).toBe(5000);
  });
});
