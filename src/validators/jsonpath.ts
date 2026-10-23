import { JSONPath } from "jsonpath-plus";

/** Evaluate a JSONPath against parsed JSON; returns all matches (empty array if none). Never evaluates script expressions. */
export function queryJsonPath(json: unknown, path: string): unknown[] {
  if (json === null || typeof json !== "object") return [];
  const out = JSONPath({ path, json: json as object, wrap: true, eval: false });
  return Array.isArray(out) ? out : [];
}

export function stringifyScalar(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
