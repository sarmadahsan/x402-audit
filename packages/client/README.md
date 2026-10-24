# @x402-audit/client

Opt-in, anonymised outcome telemetry for x402 paid API calls. It wraps your existing
`@x402/fetch` client, checks each paid response with the same validators the x402-audit
harness uses, and reports one small record per paid call to an ingest endpoint you choose.

> **Not published yet.** Publishing to npm needs explicit human approval, and
> `npm publish` is blocked until then. Install it from the git repo (below).

## 1. Install (from the repo, for now)

```sh
git clone <x402-audit repo> && cd x402-audit
pnpm install
pnpm --filter @x402-audit/client build
cd packages/client && npm pack            # -> x402-audit-client-0.1.0.tgz
# in your agent's project:
npm install /path/to/x402-audit/packages/client/x402-audit-client-0.1.0.tgz
```

The built package is self-contained (ESM + CJS + types). Its only runtime dependencies are
`ajv`, `ajv-formats` and `jsonpath-plus`. It runs on Node 20+ and edge runtimes that have
`fetch` and Web Crypto.

## 2. Integrate (two lines)

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { withAudit } from "@x402-audit/client";

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const audited = withAudit(fetchWithPayment, {
  endpoint: "https://ingest.example/v1/calls",
  sourceId: "my-agent",
  // token: "...",          // sent as Authorization: Bearer <token>
  // includeWallet: false,  // default
  // serviceConfigs: { "api.seller.com": { domain: "api.seller.com", json_schema: {...} } },
  // onRecord: (r) => console.log(r),
});

const res = await audited("https://api.seller.com/v1/quote?symbol=ETH");
```

Use `audited` wherever you used `fetchWithPayment`. You get back the same `Response` object,
with no extra delay. Checking and sending happen in the background: a 3 s timeout, and errors
are never thrown to you. Before a short-lived process exits, call `await audited.flush()` if you
want to wait for records still being sent.

## 3. Exactly what is sent

One JSON `POST` per paid call:

```json
{
  "v": 1,
  "source_id": "my-agent",
  "client_version": "0.1.0",
  "ts": 1761220800000,
  "resource_hash": "5326d434ec99d56b065d4165a26673196164eb0cd1b33f2aa1be588bd3ecdc4a",
  "seller_domain": "api.seller.com",
  "network": "eip155:8453",
  "outcome": "ok",
  "flags": ["schema_missing"],
  "amount_atomic": "10000",
  "latency_ms": 412,
  "status": 200,
  "validators": {
    "http_status": "pass",
    "non_empty": "pass",
    "content_type": "pass",
    "not_truncated": "pass",
    "json_schema": "skipped",
    "entity_matches": "skipped",
    "freshness": "skipped",
    "injection_scan": "pass"
  }
}
```

| Field | Meaning |
|---|---|
| `resource_hash` | sha256 (hex) of `METHOD + " " + origin + path`, e.g. `GET https://api.seller.com/v1/quote`. The query string and fragment are removed **before** hashing. |
| `seller_domain` | Hostname only. |
| `network`, `amount_atomic` | From the seller's `PAYMENT-RESPONSE` / `X-PAYMENT-RESPONSE` header, only if present. |
| `outcome`, `flags` | From the x402-audit taxonomy (`docs/taxonomy.md`). |
| `validators` | Status only (`pass` / `fail` / `skipped`). The evidence is never sent. |
| `status` | HTTP status, or `0` if no response came back. |
| `wallet` | Only if you set `includeWallet: true` (see section 5). |

**Never sent:** request or response bodies, any headers (yours or the seller's), query strings,
URL paths in clear text, validator evidence, payment signatures, transaction hashes, or your
wallet address (unless you opt in).

**Limits of client-side results.** The client cannot see the chain, so it counts a settlement
only when the seller's settlement header says `success: true`. It therefore never reports
`duplicate`. It has no reference price, so it never reports `overcharge`. It reports a call only
when there is evidence that a payment was made: a `PAYMENT-SIGNATURE`/`X-PAYMENT` header on your
request, or a settlement header on the response. Other calls are passed through and not reported.

## 4. Opt out

- Environment: `X402_AUDIT_TELEMETRY=off` (also `0`, `false`, `no`, `disabled`). Nothing is
  sent, and responses pass through untouched.
- Code: don't wrap, or call `fetchWithPayment` directly.

## 5. Include your wallet (off by default)

`withAudit(fetchWithPayment, { ..., includeWallet: true })` adds `"wallet": "<payer>"` to the
record, copied from the settlement header's `payer` field. If the header has no `payer`, no
wallet is sent.

## 6. See the records locally

From the x402-audit repo, start the ingest server. It stores records in the audit SQLite DB.
The bind address defaults to `TELEMETRY_BIND=127.0.0.1:8787`, and the optional bearer token
comes from `TELEMETRY_INGEST_TOKEN`:

```sh
pnpm cli telemetry serve        # see `pnpm cli telemetry serve --help` for flags
```

Then point the client at `http://127.0.0.1:8787/v1/calls`. Check the records with
`sqlite3 data/audit.sqlite 'select * from telemetry_calls'`. To print records without
running a server, use `onRecord: (r) => console.log(JSON.stringify(r))` with
`X402_AUDIT_TELEMETRY=off`.

Ingest rules: JSON body of 32 KB or less, strict schema (unknown fields are rejected with 400),
401 without the right bearer token when one is configured, and 60 requests per minute per
`source_id` (429 after that).
