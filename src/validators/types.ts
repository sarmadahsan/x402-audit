import type { ValidatorName } from "../taxonomy.js";

export type ValidatorStatus = "pass" | "fail" | "skipped";

export interface ValidatorResult {
  status: ValidatorStatus;
  /** Machine-readable evidence; stored verbatim in validator_results.evidence_json. */
  evidence: Record<string, unknown>;
  /** Required when status is "fail" or "skipped". */
  reason?: string;
}

/** Per-service configuration loaded from config/schemas/<domain>.json. Any section may be absent. */
export interface ServiceConfig {
  domain: string;
  json_schema?: Record<string, unknown>;
  entity?: {
    /** Name of the request query/body parameter whose value must be echoed. */
    request_param: string;
    /** JSONPath into the response body where the echoed value lives. */
    response_path: string;
    /** Optional: compare case-insensitively (default true). */
    case_insensitive?: boolean;
  };
  freshness?: {
    response_path: string;
    max_age_seconds: number;
    /** "iso" (default) | "unix_s" | "unix_ms" */
    format?: "iso" | "unix_s" | "unix_ms";
  };
  /** Overrides the seller-declared maxTimeoutSeconds for the `slow` flag. */
  max_timeout_seconds?: number;
}

export interface RequestRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Query params merged with JSON body fields, for entity matching. */
  params: Record<string, unknown>;
  body?: string;
  sentAt: number;
}

export interface ResponseRecord {
  status: number;
  headers: Record<string, string>;
  /** Raw body bytes, at most MAX_BODY_BYTES. */
  body: Uint8Array;
  /** True if we stopped reading at MAX_BODY_BYTES. */
  truncatedByUs: boolean;
  /** True if the connection ended before the declared length / framing completed. */
  incomplete: boolean;
  /** Content-Length as declared by the server, if any. */
  declaredLength?: number;
  receivedAt: number;
  latencyMs: number;
}

export interface ValidationContext {
  request: RequestRecord;
  response: ResponseRecord;
  /** The 402 requirements the payment was made against. */
  requirements: {
    mimeType?: string;
    maxTimeoutSeconds?: number;
    outputSchema?: Record<string, unknown>;
  };
  service?: ServiceConfig;
  now: number;
}

export interface Validator {
  name: ValidatorName;
  run(ctx: ValidationContext): Promise<ValidatorResult> | ValidatorResult;
}
