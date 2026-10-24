/**
 * "Our malformed request" detection shared by the live path (paidCall) and `buy reclassify`.
 * docs/taxonomy.md #8: a request the seller rejected as malformed, with nothing settled, is our_error.
 */
export const BAD_REQUEST_STATUSES = new Set([400, 405, 415, 422]);

/** Error text patterns that mean the seller rejected the request itself (not the payment). Conservative on purpose. */
const WRAPPED_4XX_PATTERNS = [/"status"\s*:\s*(400|405|415|422)\b/, /validation error/i, /missing (required )?(param|field|argument|prompt|query)/i, /invalid (query|param|parameter|argument|category|body|input)/i];

export function malformedRequestReason(status: number | null | undefined, bodyText: string | null | undefined, settlementCount: number): string | null {
  if (settlementCount > 0 || status == null) return null;
  if (BAD_REQUEST_STATUSES.has(status)) return `malformed_request:http_${status}`;
  if (status === 402 && bodyText) {
    // A 402 re-issued after payment whose `error` is a 4xx validation message: the seller never evaluated the payment.
    let errText = "";
    try {
      const j = JSON.parse(bodyText) as { error?: unknown };
      errText = typeof j.error === "string" ? j.error : j.error ? JSON.stringify(j.error) : "";
    } catch {
      errText = "";
    }
    if (errText && WRAPPED_4XX_PATTERNS.some((re) => re.test(errText))) return "malformed_request:402_wrapping_4xx_validation";
  }
  return null;
}
