import { VALIDATORS } from "../taxonomy.js";
import type { Validator } from "./types.js";
import { queryJsonPath, stringifyScalar } from "./jsonpath.js";
import { errorMessage, parseJsonBody } from "./util.js";

export const entityMatches: Validator = {
  name: VALIDATORS.ENTITY_MATCHES,
  run(ctx) {
    const entity = ctx.service?.entity;
    if (!entity) return { status: "skipped", reason: "no_config", evidence: {} };
    const path = entity.response_path;
    const param = entity.request_param;
    const rawExpected = ctx.request.params[param];
    if (rawExpected === undefined) {
      return { status: "skipped", reason: "request_param_absent", evidence: { request_param: param, path } };
    }
    const expected = stringifyScalar(rawExpected);
    const case_insensitive = entity.case_insensitive !== false;
    const parsed = parseJsonBody(ctx.response.body);
    if (!parsed.ok) {
      return { status: "fail", reason: "body_not_json", evidence: { expected, actual: null, path, request_param: param, parse_error: parsed.error } };
    }
    let matches: unknown[];
    try {
      matches = queryJsonPath(parsed.value, path);
    } catch (e) {
      return { status: "skipped", reason: "path_invalid", evidence: { path, error: errorMessage(e) } };
    }
    const first = matches.find((m) => m !== undefined && m !== null);
    if (first === undefined) {
      return { status: "fail", reason: "entity_missing_in_response", evidence: { expected, actual: null, path, request_param: param } };
    }
    const actual = stringifyScalar(first);
    const norm = (s: string) => (case_insensitive ? s.trim().toLowerCase() : s.trim());
    const evidence = { expected, actual, path, request_param: param, case_insensitive, match_count: matches.length };
    if (norm(expected) === norm(actual)) return { status: "pass", evidence };
    return { status: "fail", reason: "entity_mismatch", evidence };
  },
};
