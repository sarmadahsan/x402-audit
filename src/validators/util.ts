/** Shared helpers for validators. Pure, no I/O. */
import type { ResponseRecord, ValidationContext } from "./types.js";

/** Case-insensitive header lookup. Returns undefined when absent. */
export function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

/** Media type only: parameters stripped, trimmed, lower-cased. */
export function mediaType(contentType: string): string {
  return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** application/json, text/json, or any +json structured suffix. */
export function isJsonMediaType(mt: string | undefined): boolean {
  if (!mt) return false;
  const m = mediaType(mt);
  return m === "application/json" || m === "text/json" || m.endsWith("+json");
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/** Lossy UTF-8 decode, optionally capped at maxBytes. */
export function decodeBody(body: Uint8Array, maxBytes?: number): string {
  const slice = maxBytes !== undefined && body.length > maxBytes ? body.subarray(0, maxBytes) : body;
  return decoder.decode(slice);
}

export type JsonParse = { ok: true; value: unknown } | { ok: false; error: string };

export function parseJsonBody(body: Uint8Array): JsonParse {
  const text = decodeBody(body).replace(/^﻿/, "");
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The response content-type if present, else the content-type the buyer expected. */
export function effectiveContentType(ctx: ValidationContext): string {
  return getHeader(ctx.response.headers, "content-type") ?? ctx.requirements.mimeType ?? "application/json";
}

export function bodyPreview(res: ResponseRecord, maxBytes = 1024): string {
  return decodeBody(res.body, maxBytes);
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
