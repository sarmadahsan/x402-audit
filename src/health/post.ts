import { signAuditBody } from "../audit/run.js";

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export const HEALTH_POST_TIMEOUT_MS = 15_000;

/**
 * POST {index}/v1/admin/health, signed exactly like the audit callback (docs/audit-callback.md): the same two headers,
 * HMAC-SHA256 with AUDIT_SECRET over `${timestamp}.${raw body}`. Never throws: the outcome is a word for the log line
 * (`posted <status>`, `skipped_no_secret`, `failed:<status or message>`).
 */
export async function postHealth(index: string, secret: string, body: string, fetchImpl: FetchImpl = fetch, now = Date.now()): Promise<string> {
  if (!secret) return "skipped_no_secret";
  const ts = String(Math.floor(now / 1000));
  try {
    const res = await fetchImpl(`${index.replace(/\/$/, "")}/v1/admin/health`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-paidfor-audit-timestamp": ts, "x-paidfor-audit-signature": signAuditBody(secret, ts, body) },
      body,
      signal: AbortSignal.timeout(HEALTH_POST_TIMEOUT_MS),
    });
    return res.ok ? `posted ${res.status}` : `failed:${res.status}`;
  } catch (e) {
    return `failed:${(e as Error).message}`;
  }
}
