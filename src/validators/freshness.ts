import { VALIDATORS } from "../taxonomy.js";
import type { Validator } from "./types.js";
import { queryJsonPath } from "./jsonpath.js";
import { errorMessage, parseJsonBody } from "./util.js";

export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

type Format = "iso" | "unix_s" | "unix_ms";

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return undefined;
}

export function parseTimestamp(raw: unknown, format: Format): number | undefined {
  if (format === "unix_s") {
    const n = toNumber(raw);
    return n === undefined ? undefined : Math.round(n * 1000);
  }
  if (format === "unix_ms") return toNumber(raw);
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

export const freshness: Validator = {
  name: VALIDATORS.FRESHNESS,
  run(ctx) {
    const cfg = ctx.service?.freshness;
    if (!cfg) return { status: "skipped", reason: "no_config", evidence: {} };
    const format: Format = cfg.format ?? "iso";
    const path = cfg.response_path;
    const max_age_s = cfg.max_age_seconds;
    const parsed = parseJsonBody(ctx.response.body);
    if (!parsed.ok) return { status: "fail", reason: "body_not_json", evidence: { path, format, parse_error: parsed.error } };
    let matches: unknown[];
    try {
      matches = queryJsonPath(parsed.value, path);
    } catch (e) {
      return { status: "skipped", reason: "path_invalid", evidence: { path, error: errorMessage(e) } };
    }
    const ts_raw = matches.find((m) => m !== undefined && m !== null);
    if (ts_raw === undefined) {
      return { status: "fail", reason: "timestamp_missing_in_response", evidence: { path, format, ts_raw: null, max_age_s } };
    }
    const ts_ms = parseTimestamp(ts_raw, format);
    if (ts_ms === undefined) {
      return { status: "fail", reason: "timestamp_unparseable", evidence: { path, format, ts_raw, ts_ms: null, max_age_s } };
    }
    const ageMs = ctx.now - ts_ms;
    const evidence = { path, format, ts_raw, ts_ms, ts_iso: new Date(ts_ms).toISOString(), now_ms: ctx.now, age_s: ageMs / 1000, max_age_s };
    if (-ageMs > MAX_FUTURE_SKEW_MS) return { status: "fail", reason: "future_timestamp", evidence: { ...evidence, max_future_skew_s: MAX_FUTURE_SKEW_MS / 1000 } };
    if (ageMs > max_age_s * 1000) return { status: "fail", reason: "stale", evidence };
    return { status: "pass", evidence };
  },
};
