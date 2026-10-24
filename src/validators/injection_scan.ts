import { MAX_BODY_BYTES, VALIDATORS } from "../taxonomy.js";
import type { Validator } from "./types.js";
import { decodeBody } from "./util.js";

/**
 * Conservative injection scanner. Both lists are audited by hand; extend them deliberately.
 * Phrases are matched case-insensitively as literals. Patterns use their own flags.
 */
/**
 * Conservative literal phrase list. Deliberately excludes phrases that appear in
 * ordinary inference output or API data ("as an AI", "you are now", "assistant:",
 * "exfiltrate"): a hit here is "flagged for human review", so false positives
 * cost reviewer time and credibility. Extend only with docs/taxonomy.md updated.
 */
export const INJECTION_PHRASES: readonly string[] = [
  "ignore previous instructions",
  "ignore all previous instructions",
  "ignore the above",
  "disregard your instructions",
  "system prompt",
  "developer message",
  "<|im_start|>",
  "[INST]",
  "###instruction",
  "do not tell the user",
  "call the following tool",
  "run this command",
  "send your api key",
  "print your system prompt",
];

export const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bignore (all )?(previous|prior|above) (instructions|prompts?)\b/i,
  /\byou (are|must|should) (now )?(act|behave|respond|pretend) as\b/i,
  // Address form only ("To the AI agent:", "Dear assistant,"), at the start of the text or a sentence/line/quote.
  // Plain prose such as "changes to AI model prices" must not match (it did, and cost a human review).
  /(?:^|[.!?\n"'\]\}]\s*)(?:note |important |attention |hey |hello )?(to|dear) (the )?(ai|assistant|agent|model|llm)s?\s*[:,]/i,
  /<\/?(system|assistant|user|instructions?)>/i,
  /\bIMPORTANT( NOTE)?( TO| FOR)? (AI|AGENTS?|ASSISTANTS?)\b/,
];

export const SCAN_LIMIT_BYTES = MAX_BODY_BYTES;
export const CONTEXT_CHARS = 80;
/** Cap stored hits so a pathological body cannot bloat the evidence row; total_hits keeps the real count. */
export const MAX_RECORDED_HITS = 200;

export interface InjectionHit {
  kind: "phrase" | "pattern";
  /** The phrase or pattern source that fired. */
  rule: string;
  match: string;
  /** [start, end) in UTF-16 code units of the decoded text. */
  span: [number, number];
  context: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const PHRASE_RES = INJECTION_PHRASES.map((p) => ({ rule: p, re: new RegExp(escapeRe(p), "gi") }));

function contextAround(text: string, start: number, end: number): string {
  const pad = Math.max(0, Math.floor((CONTEXT_CHARS - (end - start)) / 2));
  return text.slice(Math.max(0, start - pad), Math.min(text.length, end + pad));
}

function collect(text: string, kind: InjectionHit["kind"], rule: string, re: RegExp, out: InjectionHit[]): void {
  const g = re.flags.includes("g") ? new RegExp(re.source, re.flags) : new RegExp(re.source, re.flags + "g");
  for (const m of text.matchAll(g)) {
    if (m[0].length === 0) continue;
    const start = m.index ?? 0;
    const end = start + m[0].length;
    out.push({ kind, rule, match: m[0], span: [start, end], context: contextAround(text, start, end) });
  }
}

export function scanText(text: string): InjectionHit[] {
  const hits: InjectionHit[] = [];
  for (const { rule, re } of PHRASE_RES) collect(text, "phrase", rule, re, hits);
  for (const re of INJECTION_PATTERNS) collect(text, "pattern", re.toString(), re, hits);
  return hits.sort((a, b) => a.span[0] - b.span[0] || a.span[1] - b.span[1]);
}

export const injectionScan: Validator = {
  name: VALIDATORS.INJECTION_SCAN,
  run(ctx) {
    const body = ctx.response.body;
    const scanned_bytes = Math.min(body.length, SCAN_LIMIT_BYTES);
    const text = decodeBody(body, SCAN_LIMIT_BYTES);
    const all = scanText(text);
    if (all.length === 0) return { status: "pass", evidence: { hits: [], scanned_bytes } };
    return {
      status: "fail",
      reason: "injection_text_found",
      evidence: { hits: all.slice(0, MAX_RECORDED_HITS), total_hits: all.length, scanned_bytes, span_unit: "utf16_code_units" },
    };
  },
};
