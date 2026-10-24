import { describe, expect, it } from "vitest";
import { malformedRequestReason } from "./badRequest.js";

describe("malformedRequestReason", () => {
  it("flags plain 4xx and 402-wrapped validation errors only when nothing settled", () => {
    expect(malformedRequestReason(400, "{}", 0)).toBe("malformed_request:http_400");
    expect(malformedRequestReason(422, "{}", 0)).toBe("malformed_request:http_422");
    expect(malformedRequestReason(400, "{}", 1)).toBeNull();
    const wrapped = JSON.stringify({ x402Version: 1, error: '{"title":"One or more validation errors occurred.","status":400,"errors":{"category":["Invalid category."]}}', accepts: [] });
    expect(malformedRequestReason(402, wrapped, 0)).toBe("malformed_request:402_wrapping_4xx_validation");
    expect(malformedRequestReason(402, JSON.stringify({ x402Version: 2, error: "invalid_exact_evm_signature" }), 0)).toBeNull();
    expect(malformedRequestReason(402, JSON.stringify({ x402Version: 2, error: "Payment required" }), 0)).toBeNull();
    expect(malformedRequestReason(500, "{}", 0)).toBeNull();
    expect(malformedRequestReason(200, "{}", 0)).toBeNull();
  });
});
