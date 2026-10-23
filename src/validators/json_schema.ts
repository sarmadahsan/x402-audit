import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { VALIDATORS } from "../taxonomy.js";
import type { Validator } from "./types.js";
import { errorMessage, parseJsonBody } from "./util.js";

// CJS interop under NodeNext: the default import is module.exports; both packages also set exports.default.
const Ajv2020 = Ajv2020Import.default;
const addFormats = addFormatsImport.default;

export const MAX_SCHEMA_ERRORS = 20;

const compiled = new WeakMap<object, ValidateFunction>();

function compile(schema: Record<string, unknown>): ValidateFunction {
  const cached = compiled.get(schema);
  if (cached) return cached;
  // Fresh instance per schema object so two configs sharing a $id cannot collide in Ajv's registry.
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const fn = ajv.compile(schema);
  compiled.set(schema, fn);
  return fn;
}

export const jsonSchema: Validator = {
  name: VALIDATORS.JSON_SCHEMA,
  run(ctx) {
    const schema = ctx.service?.json_schema;
    if (!schema) {
      if (ctx.requirements.outputSchema) {
        return { status: "skipped", reason: "no_config_seller_schema_ignored", evidence: { seller_schema_present: true } };
      }
      return { status: "skipped", reason: "no_config", evidence: {} };
    }
    let validate: ValidateFunction;
    try {
      validate = compile(schema);
    } catch (e) {
      // Our config is broken; this says nothing about the seller.
      return { status: "skipped", reason: "schema_invalid", evidence: { error: errorMessage(e) } };
    }
    const parsed = parseJsonBody(ctx.response.body);
    if (!parsed.ok) {
      return { status: "fail", reason: "body_not_json", evidence: { parse_error: parsed.error, bytes: ctx.response.body.length } };
    }
    if (validate(parsed.value)) return { status: "pass", evidence: { errors: [], error_count: 0 } };
    const all = validate.errors ?? [];
    const errors = all.slice(0, MAX_SCHEMA_ERRORS).map((e) => ({ instancePath: e.instancePath, message: e.message ?? "", keyword: e.keyword }));
    return { status: "fail", reason: "schema_mismatch", evidence: { errors, error_count: all.length, errors_capped: all.length > MAX_SCHEMA_ERRORS } };
  },
};
