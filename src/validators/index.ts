import type { ValidatorName } from "../taxonomy.js";
import { contentType } from "./content_type.js";
import { entityMatches } from "./entity_matches.js";
import { freshness } from "./freshness.js";
import { httpStatus } from "./http_status.js";
import { injectionScan } from "./injection_scan.js";
import { jsonSchema } from "./json_schema.js";
import { nonEmpty } from "./non_empty.js";
import { notTruncated } from "./not_truncated.js";
import type { ValidationContext, Validator, ValidatorResult } from "./types.js";
import { errorMessage } from "./util.js";

export const ALL: readonly Validator[] = [
  httpStatus,
  nonEmpty,
  contentType,
  notTruncated,
  jsonSchema,
  entityMatches,
  freshness,
  injectionScan,
];

/**
 * Run every validator against ctx. Never throws: an exception inside a validator
 * becomes a `fail` with reason `validator_threw`. Later validators always run.
 */
export async function runAllValidators(
  ctx: ValidationContext,
  validators: readonly Validator[] = ALL,
): Promise<Record<ValidatorName, ValidatorResult>> {
  const out = {} as Record<ValidatorName, ValidatorResult>;
  for (const v of validators) {
    try {
      out[v.name] = await v.run(ctx);
    } catch (e) {
      out[v.name] = { status: "fail", reason: "validator_threw", evidence: { error: errorMessage(e) } };
    }
  }
  return out;
}

export type { ValidationContext, Validator, ValidatorResult } from "./types.js";
