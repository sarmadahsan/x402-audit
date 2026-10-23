/** Small HTTP helpers shared by quote.ts and pay.ts. */
import type { ResponseRecord } from "../validators/types.js";

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

export interface BodyReadResult {
  body: Uint8Array;
  truncatedByUs: boolean;
  incomplete: boolean;
  declaredLength?: number;
  /** Set if the stream errored. */
  streamError?: unknown;
}

/**
 * Read a response body as a stream, keeping at most `maxBytes`.
 * - truncatedByUs: more than maxBytes were available and we stopped reading.
 * - incomplete: the stream errored, or ended short of the declared Content-Length
 *   (only compared when there is no Content-Encoding, since fetch decodes compressed bodies).
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<BodyReadResult> {
  const cl = res.headers.get("content-length");
  const declared = cl !== null && /^\d+$/.test(cl.trim()) ? Number(cl.trim()) : undefined;
  const encoding = (res.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncatedByUs = false;
  let incomplete = false;
  let streamError: unknown;

  if (res.body) {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        if (total + value.byteLength > maxBytes) {
          const keep = maxBytes - total;
          if (keep > 0) chunks.push(value.subarray(0, keep));
          total += keep;
          truncatedByUs = true;
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } catch (e) {
      incomplete = true;
      streamError = e;
    }
    if (truncatedByUs || incomplete) {
      reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }

  if (!truncatedByUs && !incomplete && declared !== undefined && (encoding === "identity" || encoding === "") && total < declared) {
    incomplete = true;
  }

  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.byteLength;
  }
  const out: BodyReadResult = { body, truncatedByUs, incomplete };
  if (declared !== undefined) out.declaredLength = declared;
  if (streamError !== undefined) out.streamError = streamError;
  return out;
}

export function buildResponseRecord(
  res: Response,
  read: BodyReadResult,
  startedAt: number,
  headersAt: number,
  receivedAt: number,
): ResponseRecord {
  const rec: ResponseRecord = {
    status: res.status,
    headers: headersToRecord(res.headers),
    body: read.body,
    truncatedByUs: read.truncatedByUs,
    incomplete: read.incomplete,
    receivedAt,
    latencyMs: headersAt - startedAt,
  };
  if (read.declaredLength !== undefined) rec.declaredLength = read.declaredLength;
  return rec;
}
