/** Minimal logger. Redacts anything that looks like a private key, mnemonic-ish, or API secret. */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;
type Level = keyof typeof LEVELS;
const current: Level = ((process.env.LOG_LEVEL as Level) ?? "info") in LEVELS ? ((process.env.LOG_LEVEL as Level) ?? "info") : "info";

const HEX64 = /0x[0-9a-fA-F]{64}/g; // 32-byte hex: private keys. Tx hashes also match; we only redact at debug-free call sites where keys could appear.
const SECRET_KEYS = /("?(?:private_?key|mnemonic|secret|api_?key|token|authorization)"?\s*[:=]\s*)("?)([^",\s]+)/gi;

export function redact(s: string): string {
  return s.replace(SECRET_KEYS, "$1$2[REDACTED]").replace(HEX64, (m) => `${m.slice(0, 6)}…[64hex]`);
}

/** JSON with bigint (as decimal string) and Error (message) support; never throws. */
export function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Error ? { error: x.message } : x));
  } catch (e) {
    return `[unserializable: ${(e as Error).message}]`;
  }
}

function emit(level: Level, msg: string, data?: unknown): void {
  if (LEVELS[level] > LEVELS[current]) return;
  const line = data === undefined ? msg : `${msg} ${redact(typeof data === "string" ? data : safeJson(data))}`;
  const out = level === "error" || level === "warn" ? process.stderr : process.stdout;
  out.write(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${line}\n`);
}

export const log = {
  error: (m: string, d?: unknown) => emit("error", m, d),
  warn: (m: string, d?: unknown) => emit("warn", m, d),
  info: (m: string, d?: unknown) => emit("info", m, d),
  debug: (m: string, d?: unknown) => emit("debug", m, d),
};
