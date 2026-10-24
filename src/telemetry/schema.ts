/** Wire schema for records posted by @x402-audit/client (v: 1). Mirrors packages/client/src/index.ts TelemetryRecord. */
import { z } from "zod";
import { ALL_FLAGS, ALL_OUTCOMES, ALL_VALIDATORS, type Flag, type Outcome, type ValidatorName } from "../taxonomy.js";

const ValidatorStatus = z.enum(["pass", "fail", "skipped"]);

export const TelemetryRecordSchema = z.strictObject({
  v: z.literal(1),
  source_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9._:@-]+$/, "source_id must be [A-Za-z0-9._:@-]"),
  client_version: z.string().min(1).max(32),
  ts: z.number().int().nonnegative(),
  resource_hash: z.string().regex(/^[0-9a-f]{64}$/, "resource_hash must be lowercase sha256 hex"),
  seller_domain: z.string().min(1).max(253),
  network: z.string().min(1).max(64).optional(),
  outcome: z.enum(ALL_OUTCOMES as [Outcome, ...Outcome[]]),
  flags: z.array(z.enum(ALL_FLAGS as [Flag, ...Flag[]])).max(ALL_FLAGS.length),
  amount_atomic: z.string().regex(/^\d{1,78}$/).optional(),
  latency_ms: z.number().int().nonnegative(),
  status: z.number().int().min(0).max(999),
  validators: z.partialRecord(z.enum(ALL_VALIDATORS as [ValidatorName, ...ValidatorName[]]), ValidatorStatus),
  wallet: z.string().min(1).max(128).optional(),
});
export type IngestRecord = z.infer<typeof TelemetryRecordSchema>;
