import { HEADERS, SettlementResponseSchema, decodeHeaderJson, errMsg, type SettlementResponse } from "./types.js";

export interface DecodedSettlement {
  raw?: string;
  parsed?: SettlementResponse;
  version?: 1 | 2;
  parseError?: string;
}

/**
 * Decode the seller's settlement header. Like x402HTTPClient.getPaymentSettleResponse, tries
 * PAYMENT-RESPONSE (v2) first, then X-PAYMENT-RESPONSE (v1). Header lookup is case-insensitive.
 */
export function decodeSettlementHeader(headers: Record<string, string>): DecodedSettlement {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const candidates: Array<[string, 1 | 2]> = [
    [HEADERS.V2_RESPONSE.toLowerCase(), 2],
    [HEADERS.V1_RESPONSE.toLowerCase(), 1],
  ];
  for (const [name, version] of candidates) {
    const raw = lower[name];
    if (raw === undefined || raw === "") continue;
    let json: unknown;
    try {
      json = decodeHeaderJson(raw);
    } catch (e) {
      return { raw, version, parseError: `decode failed: ${errMsg(e)}` };
    }
    const r = SettlementResponseSchema.safeParse(json);
    if (!r.success) {
      return {
        raw,
        version,
        parseError: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      };
    }
    return { raw, version, parsed: r.data };
  }
  return {};
}
