/**
 * Redaction for log lines that leave the host (the health post's log_tail). Stricter than src/log.ts `redact`, which
 * only guards our own structured output: these lines are whatever the loop's children printed, so anything shaped
 * like a secret goes, and some public things that share the shape go with it.
 *
 * 0x + 64 hex is both a private key and a tx hash. It is redacted unless the text right before it says it is a tx hash
 * (`tx`, `tx_hash`, `txHash`, `settlement_tx_hash`, `transaction`, `basescan.org/tx/`): a key printed by mistake is never
 * labelled that way, and a tx hash is public and is what makes a log line useful. Longer hex runs (signatures, calldata)
 * and bare 64 hex (no 0x; sha256 digests included) are always redacted. 0x + 40 hex wallet addresses are public and stay.
 */

export const REDACTED = "[REDACTED]";
export const MAX_LINE_CHARS = 400;

/** Header-style names whose whole value goes, to the end of the quoted value or the line. */
const HEADER_VALUE = /\b((?:proxy-)?authorization|x-paidfor-audit-signature|x-api-key|set-cookie|cookie)(["']?\s*[:=]\s*["']?)[^"'\n]*/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const SECRET_WORDS = "[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|MNEMONIC)[A-Za-z0-9_]*";
/** NAME=value (env style): the value goes to the next space or `&`, commas included (X402_AUDIT_WALLET_KEYS=a,b). */
const SECRET_ENV = new RegExp(`(?<![A-Za-z0-9_])(${SECRET_WORDS})=(?:"[^"]*"|'[^']*'|[^\\s&]+)`, "gi");
/** "name": value or name: value (JSON, YAML, headers); a quoted value goes whole and keeps its quotes. */
const SECRET_FIELD = new RegExp(`(?<![A-Za-z0-9_])(["']?)(${SECRET_WORDS})\\1(\\s*:\\s*)("[^"]*"|'[^']*'|[^\\s"',;&}\\]]+)`, "gi");
const JWT = /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g;
const VENDOR_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|sb_secret_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|re_[A-Za-z0-9]{8,}_[A-Za-z0-9_]{8,})/g;
/** scheme://user:pass@ or scheme://token@ */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"'<>]+@/gi;
const QUERY_SECRET = /([?&][^=&\s#"']*(?:key|token|secret|signature|sig|password|auth)[^=&\s#"']*=)[^&\s#"']*/gi;
const PRIVATE_PATH = /(?:[^\s"'`=:]*\/)?(?:etc\/paidfor\/|data\/server-wallets|data\/server-audit)[^\s"'`,;)]*/g;
const HOME_PATH = /\/(?:home|Users)\/[^/\s"'`]+/g;
const HEX_0X = /0x[0-9a-fA-F]{64,}(?![0-9a-zA-Z])/g;
const HEX_BARE = /(?<![0-9a-zA-Z])[0-9a-fA-F]{64,}(?![0-9a-zA-Z])/g;
/** What may precede a 0x + 64 hex tx hash (up to 24 chars back) for it to stay. */
const TX_CONTEXT = /(?:(?:^|[^a-z])tx(?:_?hash)?|transaction(?:_?hash)?|basescan\.org\/tx\/)["'\s:=]*$/i;
const CONTROL = /\u001b\[[0-9;]*[A-Za-z]|[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** One line, redacted, then cut to MAX_LINE_CHARS (cut after redaction, so a cut can never split a secret out of a pattern). */
export function redactLine(line: string): string {
  let s = line.replace(CONTROL, "");
  s = s.replace(PRIVATE_PATH, "[private-path]").replace(HOME_PATH, "~");
  s = s.replace(HEADER_VALUE, `$1$2${REDACTED}`).replace(BEARER, `$1 ${REDACTED}`);
  s = s.replace(URL_CREDENTIALS, `$1${REDACTED}@`).replace(QUERY_SECRET, `$1${REDACTED}`);
  s = s.replace(SECRET_ENV, `$1=${REDACTED}`);
  s = s.replace(SECRET_FIELD, (_m, q: string, name: string, sep: string, v: string) => {
    const vq = v[0] === '"' || v[0] === "'" ? v[0] : "";
    return `${q}${name}${q}${sep}${vq}${REDACTED}${vq}`;
  });
  s = s.replace(JWT, REDACTED).replace(VENDOR_TOKEN, REDACTED);
  s = s.replace(HEX_0X, (m, off: number, all: string) => (m.length === 66 && TX_CONTEXT.test(all.slice(Math.max(0, off - 24), off)) ? m : REDACTED));
  s = s.replace(HEX_BARE, REDACTED);
  return s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS - 1) + "…" : s;
}

export function redactLines(lines: readonly string[]): string[] {
  return lines.map(redactLine);
}
