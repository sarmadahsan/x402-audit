# @paidfor/x402-policy

One line on your existing `@x402` client (v2.28) makes it refuse sellers the [paidfor](https://paidfor.dev) index rates
`avoid` before anything is signed, and report the outcome of each payment to the index afterwards. Your signer, your
wallet and your process stay exactly as they are: this package holds no key, signs nothing and moves no money. The
verdicts come from paid calls the index made itself with its own USDC, each settlement on Base and each delivered
or undelivered response on record.

## Install

```sh
npm install @paidfor/x402-policy
```

`@x402/core` `^2.28.0` is a peer dependency; you already have it. Node 20 or newer.

## Add it

```ts
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { usePaidfor } from "@paidfor/x402-policy";

export function createFetchWithPayment(signer: ClientEvmSigner) {
  const client = new x402Client();
  registerExactEvmScheme(client, { signer }); // your existing setup, unchanged
  const paidfor = usePaidfor(client); // the one added line
  return wrapFetchWithPayment(paidfor.fetch, client); // paidfor.fetch where you passed fetch
}
```

`usePaidfor(client)` registers two things on the client you already have:

- **`paidforPolicy()`**, a synchronous `PaymentPolicy`. It keeps the pay-to addresses of every seller rated `avoid`
  in memory, refreshed from the index in the background about once an hour, and removes each payment option that
  pays one of them. When nothing acceptable is left the client throws
  `Failed to create payment payload: All payment requirements were filtered out by policies for x402 version: 2`
  and no authorization is signed. The policy hook receives only the payment options, not the resource URL, so it
  keys on pay-to addresses; the resource is checked by the extension.
- **`paidforExtension()`**, on the client's `onBeforePaymentCreation`, `onAfterPaymentCreation` and
  `onPaymentResponse` hooks. Before a payment it asks `GET https://paidfor.dev/v1/check?url=` about the resource
  (origin and path only) and, on `avoid`, aborts with the index's reason, for example
  `Payment creation aborted: paidfor: www.api-xpay.com is rated avoid by the paidfor index; nothing was signed. Avoid: 53.5% of 546 paid calls to api-xpay.com failed the buyer ...`.
  After the paid response it reports what happened (below).

`paidfor.fetch` is `globalThis.fetch` with one addition: for a request that carries a payment header it reads the
response status and the seller's settlement header, which is how the report knows delivered from not delivered.
The client's response hook does not receive the HTTP status, so without `paidfor.fetch` only payments the seller
rejected are reported. Use `paidfor.wrapFetch(myFetch)` for a custom fetch.

If you only want one of the two pieces:

```ts
registerExactEvmScheme(client, { signer, policies: [paidforPolicy()] }); // pay-to filter only
paidforExtension().install(client); // resource check and report only
```

`ClientExtension.hooks` in `@x402/core` 2.28 run only for extension keys the seller declared in its 402, so
`paidforExtension()` is not passed to `client.registerExtension`; `install(client)` uses the client's own hooks,
which run for every payment.

## Fail-open by default, and why

While the avoid set has not loaded yet, or the index cannot be reached, every payment option passes and every check
proceeds. An index outage must never stop your agent from paying sellers that are fine; the index is one more input
to your client, not a dependency of it. A loaded set is used for up to 24 hours (`maxStaleMs`) if refreshes fail.

- `await paidfor.ready()` waits for the first load, so the very first payment is covered too. It never rejects;
  it resolves with the load status (`current`, `addresses`, `sellers`, `lastError`).
- `usePaidfor(client, { failMode: "closed" })` turns it around: with no current set, or a check the index did not
  answer within `checkTimeoutMs`, nothing is signed. Use it where an unchecked payment is worse than a delayed one.

Every refusal is one `console.warn` line (set `warn: false` for silence, or pass your own logger) and an `onRefuse`
or `onCheck` callback. Callbacks that throw never affect a payment.

## What is sent to the index, and nothing else

Three requests, all without an account or a key, all carrying the header `X-Paidfor-Client: x402-policy/0.1.0`
(the package name and version, so the index can count calls per client):

| Request | When | What it carries |
| --- | --- | --- |
| `GET /v1/sellers`, then the public `sellers.json` of `sarmadahsan/paidfor-data` while the index rows carry no `pay_to_addresses` | At start and about every hour | Nothing but the header. |
| `GET /v1/check?url=` | Before a payment, once per resource per 5 minutes | The resource URL with the query string and fragment removed (origin and path). |
| `POST /v1/telemetry` | After the paid response | The row below. |

One report per payment, exactly this object, the "Version 2" contract of `@paidfor/x402-safe-fetch`:

```json
{
  "v": 2,
  "host": "api.example.com",
  "path_hash": "<sha256 hex of the URL path, trailing slash removed>",
  "outcome": "ok",
  "amount_usdc": "0.010000",
  "latency_ms": 412,
  "validator_failures": [],
  "client": "x402-policy/0.1.0",
  "proof": {
    "network": "eip155:8453",
    "scheme": "exact",
    "asset": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    "pay_to": "0x<seller pay-to, lowercase>",
    "payer": "0x<your signer address, lowercase>",
    "nonce": "0x<32-byte EIP-3009 authorization nonce>",
    "tx_hash": "0x<settlement transaction from the seller's PAYMENT-RESPONSE header, or null>",
    "settled_at": "2026-11-01T10:12:03.000Z",
    "response_sha256": null,
    "declared_timeout_s": 60
  }
}
```

| Field | Source |
| --- | --- |
| `host`, `path_hash` | The resource URL: hostname lowercased, sha256 of the path. The query string never enters either. |
| `outcome` | `ok` for a 2xx after settlement; `non_delivery` for any other status (then `validator_failures` is `["http_status:<status>"]`); `error` when the seller rejected the payment (402 again, or a settlement header with `success: false`); `paid_no_response` when the paid request got no response. |
| `amount_usdc` | The signed authorization's value, 6 decimals. |
| `proof.payer`, `proof.nonce` | `from` and `nonce` of the EIP-3009 authorization your signer produced. Both are public on Base once the payment settles; the row links them to the host, path hash and outcome so the index can verify the payment on chain before counting it. |
| `proof.pay_to`, `network`, `asset`, `declared_timeout_s` | The payment option that was signed. |
| `path` | Only when the check answered `unknown` (a seller the index has never measured): the plain path, so the index can buy that seller itself. |

**Never sent:** request or response bodies, any header of yours or the seller's, query strings, API keys, the
signature, private keys (the package never sees one). Payments on networks other than Base mainnet, or in assets
other than USDC, are not reported at all. `report: false` turns reporting off; the checks still run.

Sellers cannot pay to change a verdict: verdicts come from the index's own paid calls and from verified reports
like these, there is no listing fee, and no account or key exists anywhere in this flow.

## Options

`usePaidfor(client, options)`, `paidforPolicy(options)` and `paidforExtension(options)` take the same object;
each reads the keys it uses.

| Option | Default | Meaning |
| --- | --- | --- |
| `indexUrl` | `https://paidfor.dev/v1` | The index. |
| `failMode` | `"open"` | `"closed"`: refuse when the set is not current or a check gets no answer. |
| `refuseVerdicts` | `["avoid"]` | Add `"caution"` to refuse those sellers too. |
| `refreshMs` | 1 hour | How often the avoid set is reloaded. |
| `maxStaleMs` | 24 hours | Age after which a loaded set is no longer used. |
| `timeoutMs` | 10 s | One load of the set. |
| `sellersDataUrl` | the public `sellers.json` | Where pay-to addresses come from until `/v1/sellers` carries them; `false` disables the join. |
| `checkTimeoutMs` | 1.5 s | The pre-pay check. |
| `checkCacheMs` | 5 min | How long one check answer is reused for the same resource. |
| `report` | `true` | Send outcome reports. |
| `reportTimeoutMs` | 10 s | One report (the index checks the chain before answering). |
| `fetch` | `globalThis.fetch` | Used for index requests only. |
| `warn` | `console.warn` | One line per refusal; `false` for silence. |
| `onRefuse`, `onCheck`, `onReport`, `onRefresh` | | Callbacks; errors in them are swallowed. |
| `autoStart` | `true` | `false`: no load until `ready()` or `refresh()`. |

The handle returned by `usePaidfor` has `ready()`, `flush()` (wait for in-flight reports, before a short-lived
process exits), `stop()` (end the background refresh; it is `unref`'d and never keeps a process alive), `policy`
(`status()`, `lookup(payTo)`, `lastRefusal`) and `extension` (`status()`: checks, refusals, reported, unreported).

## Limits

- A seller rated `avoid` whose pay-to address the index does not know cannot be filtered by the policy; the
  extension's resource check still refuses it. `policy.status().unmatched` lists such sellers.
- The resource check uses the URL the seller declares in its 402 (`resource.url`). The pay-to filter does not depend
  on anything the seller says.
- Without `paidfor.fetch` (hooks only, for example a transport this package has not wrapped), settled payments are
  not reported because delivery is unknown; `extension.status().unreported` counts them.
- x402 v1 sellers are filtered and checked; their reports carry the same proof when the payment is on Base.

## Index-side change this package is built for

`/v1/sellers` rows carry `verdict`; the index is adding `pay_to_addresses: string[]` to each row. The loader uses
that field whenever a row carries it and reads the public data repo's `sellers.json` only for rows that do not, so
the second request disappears on its own once the field is live. `policy.status().joinedFromData` says whether
`sellers.json` was needed on the last load.

## Demo

```sh
pnpm demo
```

Runs both cases in process with a throwaway signer that has no funds and the index played back from fixtures
captured on 2026-11-01: `www.api-xpay.com` (rated avoid) is refused with nothing signed, and a seller rated ok is paid
once against a mocked settlement, with the exact report printed. No request leaves the process.

### Live smoke test (one real payment, operator only)

```sh
PAIDFOR_POLICY_LIVE=1 PAIDFOR_SMOKE_KEY_FILE=/path/to/key pnpm -C packages/policy demo:live
```

`demo/live.ts` pays one resource for real with the key in `PAIDFOR_SMOKE_KEY_FILE` (read into memory, never printed;
only the derived address is shown) and then requests `https://www.api-xpay.com/x402/time`, rated avoid, with the
same client. It refuses to run without `PAIDFOR_POLICY_LIVE=1`; before paying it asks `/v1/check` about the target
(default `https://blockrun.ai/api/v1/defillama/prices/coingecko:bitcoin`, 0.002 USDC; override with
`PAIDFOR_SMOKE_URL`) and stops unless the verdict is `ok` and the quote is at or below 0.002 USDC; a payment policy
caps the signed authorization at 0.01 USDC before the scheme signs; a marker file in the OS temp directory stops a
second run against the same URL within a minute. It prints the HTTP status, the settlement transaction, the exact
row sent to `/v1/telemetry`, the index's answer with its `verification_url`, and for the second step the refusal
together with the number of calls into the signer, which must be zero or the run fails.

## Development

```sh
pnpm -C packages/policy test
pnpm -C packages/policy typecheck
pnpm -C packages/policy build
```

MIT.
