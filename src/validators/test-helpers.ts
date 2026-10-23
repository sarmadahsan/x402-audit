import type { RequestRecord, ResponseRecord, ServiceConfig, ValidationContext } from "./types.js";

export const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

export interface CtxOverrides {
  request?: Partial<RequestRecord>;
  response?: Partial<Omit<ResponseRecord, "body">> & { body?: string | Uint8Array };
  requirements?: ValidationContext["requirements"];
  service?: ServiceConfig;
  now?: number;
}

const enc = new TextEncoder();
export const bytes = (s: string): Uint8Array => enc.encode(s);

/** Builds a fully explicit ValidationContext: a 200 application/json `{"ok":true}` response unless overridden. */
export function makeCtx(o: CtxOverrides = {}): ValidationContext {
  const request: RequestRecord = {
    url: "https://api.example.com/v1/quote?symbol=ETH",
    method: "GET",
    headers: {},
    params: { symbol: "ETH" },
    sentAt: NOW - 500,
    ...o.request,
  };
  const { body: rawBody, ...resRest } = o.response ?? {};
  const body = rawBody === undefined ? bytes('{"ok":true}') : typeof rawBody === "string" ? bytes(rawBody) : rawBody;
  const response: ResponseRecord = {
    status: 200,
    headers: { "content-type": "application/json" },
    truncatedByUs: false,
    incomplete: false,
    receivedAt: NOW - 100,
    latencyMs: 400,
    ...resRest,
    body,
  };
  const ctx: ValidationContext = { request, response, requirements: o.requirements ?? {}, now: o.now ?? NOW };
  if (o.service) ctx.service = o.service;
  return ctx;
}
