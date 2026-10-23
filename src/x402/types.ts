/**
 * x402 wire types (v2, plus a tolerant v1 detector) and header encoding helpers.
 * Shapes follow docs/protocol-notes.md §1-§3 and §6 (SDK @x402/core 2.28.0 schemas).
 */
import { z } from "zod";

/** Header names. Source: docs/protocol-notes.md §1 (x402HTTPClient.ts, specs/transports-v{1,2}/http.md). */
export const HEADERS = {
  V2_REQUIRED: "PAYMENT-REQUIRED",
  V2_SIGNATURE: "PAYMENT-SIGNATURE",
  V2_RESPONSE: "PAYMENT-RESPONSE",
  V1_PAYMENT: "X-PAYMENT",
  V1_RESPONSE: "X-PAYMENT-RESPONSE",
} as const;

const NonEmptyString = z.string().min(1);
const AnyRecord = z.record(z.string(), z.unknown());
const OptionalAny = AnyRecord.optional().nullable();
const NetworkV2 = z
  .string()
  .min(3)
  .refine((v) => v.includes(":"), { message: "network must be CAIP-2 (namespace:reference)" });

export const ResourceInfoSchema = z.looseObject({
  url: NonEmptyString,
  description: z.string().nullish(),
  mimeType: z.string().nullish(),
  serviceName: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  iconUrl: z.string().nullish(),
});
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;

export const PaymentRequirementsSchema = z.looseObject({
  scheme: NonEmptyString,
  network: NetworkV2,
  amount: NonEmptyString,
  asset: NonEmptyString,
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  extra: OptionalAny,
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

/** v2 envelope carried (base64 JSON) in the PAYMENT-REQUIRED header. */
export const PaymentRequiredSchema = z.looseObject({
  x402Version: z.literal(2),
  error: z.string().nullish(),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsSchema).min(1),
  extensions: OptionalAny,
});
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

export const PaymentPayloadSchema = z.looseObject({
  x402Version: z.literal(2),
  resource: ResourceInfoSchema.nullish(),
  accepted: PaymentRequirementsSchema,
  payload: AnyRecord,
  extensions: OptionalAny,
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

/** Body of PAYMENT-RESPONSE / X-PAYMENT-RESPONSE (SettleResponse, notes §6). */
export const SettlementResponseSchema = z.looseObject({
  success: z.boolean(),
  transaction: z.string(),
  network: z.string(),
  payer: z.string().optional(),
  errorReason: z.string().optional(),
  errorMessage: z.string().optional(),
  amount: z.string().optional(),
});
export type SettlementResponse = z.infer<typeof SettlementResponseSchema>;

// ---- v1 (deprecated protocol; 402 JSON body) ----

export const PaymentRequirementsV1Schema = z.looseObject({
  scheme: NonEmptyString,
  network: NonEmptyString,
  maxAmountRequired: NonEmptyString,
  resource: NonEmptyString,
  description: z.string(),
  mimeType: z.string().optional(),
  outputSchema: AnyRecord.optional().nullable(),
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  asset: NonEmptyString,
  extra: OptionalAny,
});
export type PaymentRequirementsV1 = z.infer<typeof PaymentRequirementsV1Schema>;

/** v1 network names we care about -> CAIP-2 (notes §4). */
export const V1_NETWORK_TO_CAIP2: Readonly<Record<string, string>> = {
  base: "eip155:8453",
  "base-sepolia": "eip155:84532",
};
export const CAIP2_TO_V1_NETWORK: Readonly<Record<string, string>> = {
  "eip155:8453": "base",
  "eip155:84532": "base-sepolia",
};

/** Version-independent view of one payment option. */
export interface NormalizedRequirements {
  x402Version: 1 | 2;
  scheme: string;
  /** As sent by the seller (v1 name such as "base", or CAIP-2 for v2). */
  network: string;
  amountAtomic: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  resourceUrl?: string;
  description?: string;
  mimeType?: string;
  outputSchema?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  /** The requirement object exactly as received. */
  raw: unknown;
}

/** CAIP-2 network of a normalized requirement (maps v1 names; unknown v1 names pass through). */
export function caip2Network(r: Pick<NormalizedRequirements, "x402Version" | "network">): string {
  return r.x402Version === 1 ? (V1_NETWORK_TO_CAIP2[r.network] ?? r.network) : r.network;
}

export function normalizeV2(req: PaymentRequirements, envelope?: { resource?: ResourceInfo | undefined }): NormalizedRequirements {
  const out: NormalizedRequirements = {
    x402Version: 2,
    scheme: req.scheme,
    network: req.network,
    amountAtomic: req.amount,
    asset: req.asset,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    raw: req,
  };
  const res = envelope?.resource;
  if (res?.url) out.resourceUrl = res.url;
  if (res?.description != null) out.description = res.description;
  if (res?.mimeType != null) out.mimeType = res.mimeType;
  if (req.extra) out.extra = req.extra;
  return out;
}

export function normalizeV1(req: PaymentRequirementsV1): NormalizedRequirements {
  const out: NormalizedRequirements = {
    x402Version: 1,
    scheme: req.scheme,
    network: req.network,
    amountAtomic: req.maxAmountRequired,
    asset: req.asset,
    payTo: req.payTo,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    resourceUrl: req.resource,
    description: req.description,
    raw: req,
  };
  if (req.mimeType != null) out.mimeType = req.mimeType;
  if (req.outputSchema) out.outputSchema = req.outputSchema;
  if (req.extra) out.extra = req.extra;
  return out;
}

export interface Parsed402 {
  version: 1 | 2 | null;
  accepts: NormalizedRequirements[];
  envelope: unknown;
  parseError?: string;
}

function issuesToString(e: z.ZodError): string {
  return e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/**
 * Parse a 402. Mirrors x402HTTPClient.getPaymentRequiredResponse: PAYMENT-REQUIRED header => v2;
 * otherwise a JSON body with x402Version === 1 => v1. Tolerant: individual accepts that fail
 * validation are dropped and reported in parseError, valid ones are still returned.
 * @param headers lowercase-keyed response headers
 */
export function parse402(headers: Record<string, string>, bodyText: string | undefined): Parsed402 {
  const hdr = headers[HEADERS.V2_REQUIRED.toLowerCase()];
  if (hdr !== undefined && hdr !== "") {
    let envelope: unknown;
    try {
      envelope = decodeHeaderJson(hdr);
    } catch (e) {
      return { version: 2, accepts: [], envelope: hdr, parseError: `PAYMENT-REQUIRED decode failed: ${errMsg(e)}` };
    }
    const errors: string[] = [];
    const full = PaymentRequiredSchema.safeParse(envelope);
    if (!full.success) errors.push(`envelope: ${issuesToString(full.error)}`);
    const env = (envelope ?? {}) as { resource?: unknown; accepts?: unknown };
    const resParsed = ResourceInfoSchema.safeParse(env.resource);
    const resource = resParsed.success ? resParsed.data : undefined;
    const accepts: NormalizedRequirements[] = [];
    if (Array.isArray(env.accepts)) {
      env.accepts.forEach((a, i) => {
        const r = PaymentRequirementsSchema.safeParse(a);
        if (r.success) accepts.push({ ...normalizeV2(r.data, { resource }), raw: a });
        else errors.push(`accepts[${i}]: ${issuesToString(r.error)}`);
      });
    }
    const out: Parsed402 = { version: 2, accepts, envelope };
    if (errors.length) out.parseError = errors.join(" | ");
    return out;
  }

  if (bodyText === undefined || bodyText.trim() === "") {
    return { version: null, accepts: [], envelope: undefined, parseError: "no PAYMENT-REQUIRED header and empty body" };
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch (e) {
    return { version: null, accepts: [], envelope: undefined, parseError: `no PAYMENT-REQUIRED header and body is not JSON: ${errMsg(e)}` };
  }
  if (!body || typeof body !== "object" || (body as { x402Version?: unknown }).x402Version !== 1) {
    return { version: null, accepts: [], envelope: body, parseError: "no PAYMENT-REQUIRED header and body.x402Version !== 1" };
  }
  const errors: string[] = [];
  const accepts: NormalizedRequirements[] = [];
  const rawAccepts = (body as { accepts?: unknown }).accepts;
  if (!Array.isArray(rawAccepts) || rawAccepts.length === 0) errors.push("accepts: missing or empty");
  else
    rawAccepts.forEach((a, i) => {
      const r = PaymentRequirementsV1Schema.safeParse(a);
      if (r.success) accepts.push({ ...normalizeV1(r.data), raw: a });
      else errors.push(`accepts[${i}]: ${issuesToString(r.error)}`);
    });
  const out: Parsed402 = { version: 1, accepts, envelope: body };
  if (errors.length) out.parseError = errors.join(" | ");
  return out;
}

// ---- header encoding: base64(JSON.stringify(obj)), standard base64, UTF-8 (notes §1) ----

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function decodeHeaderJson(value: string): unknown {
  const v = value.trim();
  if (!BASE64_RE.test(v) || v.length % 4 === 1) throw new Error("header value is not standard base64");
  return JSON.parse(Buffer.from(v, "base64").toString("utf8"));
}

export function encodeHeaderJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64");
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
