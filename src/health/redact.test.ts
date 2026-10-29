import { describe, expect, it } from "vitest";
import { MAX_LINE_CHARS, REDACTED, redactLine } from "./redact.js";

const KEY = "0x" + "ab12".repeat(16); // 32-byte hex: the shape of a private key and of a tx hash
const BARE = "cd34".repeat(16);
const WALLET = "0x1111111111111111111111111111111111111111";

describe("health log redaction", () => {
  it("removes 0x + 64 hex (private key shape) and bare 64 hex", () => {
    expect(redactLine(`loaded ${KEY} ok`)).toBe(`loaded ${REDACTED} ok`);
    expect(redactLine(`digest ${BARE}`)).toBe(`digest ${REDACTED}`);
    expect(redactLine(`sig 0x${"ef".repeat(65)}`)).toBe(`sig ${REDACTED}`); // longer runs (signatures) too
  });

  it("keeps 0x + 64 hex when it is labelled a tx hash", () => {
    for (const l of [`tx ${KEY}`, `tx_hash=${KEY}`, `"settlement_tx_hash":"${KEY}"`, `txHash: ${KEY}`, `https://basescan.org/tx/${KEY}`, `transaction ${KEY}`])
      expect(redactLine(l)).toBe(l);
    // The label must sit right before it; a tx word earlier in the line does not save a key.
    expect(redactLine(`tx failed, key ${KEY}`)).toBe(`tx failed, key ${REDACTED}`);
    expect(redactLine(`nonce=${KEY}`)).toBe(`nonce=${REDACTED}`);
  });

  it("keeps wallet addresses and 40-hex commit shas", () => {
    const l = `wallet=${WALLET} commit 6c0e4e78366f7afe7255849da3eb16402cbf775d`;
    expect(redactLine(l)).toBe(l);
  });

  it("removes authorization headers, bearer tokens and the audit signature", () => {
    expect(redactLine("Authorization: Bearer abc.def.ghi")).toBe(`Authorization: ${REDACTED}`);
    expect(redactLine(`{"authorization":"Basic dXNlcjpwYXNz","x":1}`)).toBe(`{"authorization":"${REDACTED}","x":1}`);
    expect(redactLine("curl -H 'Bearer s3cr3tT0ken'")).toBe(`curl -H 'Bearer ${REDACTED}'`);
    expect(redactLine("x-paidfor-audit-signature: sha256=" + "a1".repeat(32))).toBe(`x-paidfor-audit-signature: ${REDACTED}`);
  });

  it("removes values of env-style and JSON assignments whose name says key, secret, token, password, private or mnemonic", () => {
    expect(redactLine(`X402_AUDIT_WALLET_KEYS=${KEY},${KEY}`)).toBe(`X402_AUDIT_WALLET_KEYS=${REDACTED}`);
    expect(redactLine("AUDIT_SECRET=hunter2 LOOP_RUN_USD=2.00")).toBe(`AUDIT_SECRET=${REDACTED} LOOP_RUN_USD=2.00`);
    expect(redactLine(`{"privateKey":"abc def","mnemonic":"word word word","calls":3}`)).toBe(`{"privateKey":"${REDACTED}","mnemonic":"${REDACTED}","calls":3}`);
    expect(redactLine("db_password: p@ss TELEMETRY_INGEST_TOKEN='t0k'")).toBe(`db_password: ${REDACTED} TELEMETRY_INGEST_TOKEN=${REDACTED}`);
    // A seller domain that happens to contain "key" is not an assignment name.
    const l = "seller keyring-agent.blockchhub.link: 7 calls";
    expect(redactLine(l)).toBe(l);
  });

  it("removes JWTs and vendor tokens", () => {
    expect(redactLine("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl end")).toBe(`jwt ${REDACTED} end`);
    for (const t of ["sk-ant-api03-abcdefghijklmnopqrstu", "sb_secret_abcdefghij123", "ghp_abcdefghijklmnopqrstuvwxyz0123", "github_pat_11ABCDEFG0abcdefghijklmnop", "sk_live_abcdefghijk1"])
      expect(redactLine(`token ${t} here`)).toBe(`token ${REDACTED} here`);
  });

  it("removes URL credentials and secret query values, keeps the rest of the URL", () => {
    expect(redactLine("fetch https://user:pa55@rpc.example.com/v1")).toBe(`fetch https://${REDACTED}@rpc.example.com/v1`);
    expect(redactLine("https://ghp_x@github.com/a/b.git")).toBe(`https://${REDACTED}@github.com/a/b.git`);
    expect(redactLine("GET https://api.example.com/q?city=x&apikey=abc123&n=1")).toBe(`GET https://api.example.com/q?city=x&apikey=${REDACTED}&n=1`);
    expect(redactLine("https://x.example/?access_token=zzz")).toBe(`https://x.example/?access_token=${REDACTED}`);
    const pub = "push git@github-data:sarmadahsan/paidfor-data.git https://paidfor.dev/v1/seller/a.example";
    expect(redactLine(pub)).toBe(pub);
  });

  it("hides private paths and home directories", () => {
    expect(redactLine("EnvironmentFile=/etc/paidfor/audit.env")).toBe("EnvironmentFile=[private-path]");
    expect(redactLine("cat data/server-wallets.env")).toBe("cat [private-path]");
    expect(redactLine("scp /home/audit/x402-audit/data/server-wallets.env x")).toBe("scp [private-path] x");
    expect(redactLine("out /home/audit/x402-audit/data/paidfor-data")).toBe("out ~/x402-audit/data/paidfor-data");
    expect(redactLine("cwd /Users/someone/billing/x402-audit")).toBe("cwd ~/billing/x402-audit");
  });

  it("strips terminal escapes and caps the length after redacting", () => {
    expect(redactLine("\u001b[31mred\u001b[0m")).toBe("red");
    const long = "z".repeat(380) + " " + KEY + " " + "y".repeat(100);
    const out = redactLine(long);
    expect(out.length).toBe(MAX_LINE_CHARS);
    expect(out).not.toContain(KEY.slice(0, 20));
  });
});
