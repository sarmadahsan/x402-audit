# Audit callback: `POST /v1/audits` on the index

Spec for the index session (`sarmadahsan/paidfor-index`). The harness side is built: `audit-triggers` posts one
request per completed audit (`src/audit/run.ts` `postAuditResult`) and stores the outcome in `audit_results.post_status`
(`posted`, `skipped_no_secret`, `failed:<status>`). Until the route exists every post answers 404 and is recorded as
`failed:404`; nothing else depends on it.

## Request

```
POST https://paidfor.dev/v1/audits
content-type: application/json
x-paidfor-audit-timestamp: 1761739200            (unix seconds, as a decimal string)
x-paidfor-audit-signature: sha256=<hex>           (HMAC-SHA256 with AUDIT_SECRET over `${timestamp}.${raw body}`)

{
  "host": "api.example.com",
  "triggered_at": "2026-10-29T12:41:07.000Z",
  "reason": "disagreement",            // disagreement | demand | thin_measured | reported_above_ok
  "calls": 10,                         // paid-denominator calls in this audit
  "failures": 4,
  "rate": 0.4,                         // null when calls is 0
  "wilson_low": 0.168,                 // 95% Wilson; null when calls is 0
  "wilson_high": 0.687,
  "evidence_url": "https://raw.githubusercontent.com/sarmadahsan/paidfor-data/main/evidence/api.example.com.json"
}
```

## Verification (index)

1. Read the raw body as text before parsing.
2. Reject with 401 unless `x-paidfor-audit-signature` equals `sha256=` + hex HMAC-SHA256(`AUDIT_SECRET`, `${timestamp}.${body}`),
   compared in constant time, and `|now - timestamp| <= 300` seconds.
3. Reject with 400 unless the body has exactly the nine fields above with these types: `host` a bare lowercase hostname,
   `triggered_at` ISO 8601, `reason` one of the four values, `calls` and `failures` integers with `0 <= failures <= calls <= 50`,
   `rate`/`wilson_low`/`wilson_high` numbers in [0, 1] or null, `evidence_url` starting with
   `https://raw.githubusercontent.com/sarmadahsan/paidfor-data/main/evidence/`. Strip nothing silently; refuse unknown fields.
4. Store in KV: `audit:<host>` list, newest first, capped at 20 entries, each the body plus `received_at`.
   Answer `201 {"ok": true}`. A replay of the same `(host, triggered_at)` answers 200 and stores nothing.

`AUDIT_SECRET` is the same value in `/etc/paidfor/audit.env` on the audit host and in the Vercel project's production env.
Generate it once with `openssl rand -hex 32`. When it is unset on either side, nothing is posted or accepted.

## Display (seller page, both views, and `/v1/seller/{domain}` additively)

The newest entry renders one line under the verdict:

- `reason` is `disagreement`, `thin_measured` or `reported_above_ok`: "Audited N hours ago after a disagreement: X% (C calls)."
- `reason` is `demand`: "Audited after N checks this week: X% (C calls)." N is the host's `checks_7d` at render time.

X is `rate` as a percentage with no decimals; the line links `evidence_url`. `/v1/seller/{domain}` gains an optional
`last_audit` object with the stored fields; no existing field changes. The audit's calls are already inside the seller's
measured figures from the next export (sellers.json `audit_purchases`), so the line is context, not a second number to add.

## Events

The changes feed already lists `audit_completed`; emit it from this route (host, reason, rate, calls).
