/**
 * Per-service validator configs: config/schemas/<domain>.json (see config/schemas/README.md).
 * A missing file means the validators that need it skip and the call is flagged schema_missing.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { ServiceConfig } from "../validators/types.js";

const ServiceSchema = z
  .object({
    domain: z.string().min(1),
    json_schema: z.record(z.string(), z.unknown()).optional(),
    entity: z
      .object({ request_param: z.string(), response_path: z.string(), case_insensitive: z.boolean().optional() })
      .optional(),
    freshness: z
      .object({ response_path: z.string(), max_age_seconds: z.number().positive(), format: z.enum(["iso", "unix_s", "unix_ms"]).optional() })
      .optional(),
    max_timeout_seconds: z.number().positive().optional(),
  })
  .passthrough();

export type ServiceLookup = (domain: string) => ServiceConfig | undefined;

/** Loads every config/schemas/*.json (keyed by its `domain`, lower-cased). Throws on an invalid file. */
export function loadServiceConfigs(dir = resolve(process.cwd(), "config", "schemas")): Map<string, ServiceConfig> {
  const out = new Map<string, ServiceConfig>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const raw: unknown = JSON.parse(readFileSync(resolve(dir, f), "utf8"));
    const parsed = ServiceSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`config/schemas/${f}: ${parsed.error.message}`);
    out.set(parsed.data.domain.toLowerCase(), parsed.data as unknown as ServiceConfig);
  }
  return out;
}

export function serviceLookup(configs: Map<string, ServiceConfig>): ServiceLookup {
  return (domain) => configs.get(domain.toLowerCase());
}
