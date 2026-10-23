# x402 protocol notes (read from source) and index API notes

Part 1 covers the protocol, read from the coinbase/x402 repo at a pinned commit. Part 2 (below) covers the CDP Bazaar discovery API, x402scan, and on-chain volume sources, from live docs and probes.

Source repo: `https://github.com/coinbase/x402` cloned to
`/private/tmp/claude-501/-Users-sarmad-billing/63e6dccc-57bc-4dfe-8287-0398e0e7edb1/scratchpad/x402-src`
(shallow clone, `--depth 1`).

- HEAD: `0e6e8c55d86b4f14234fb6e49a4052074fb93e57` (short `0e6e8c5`)
- Commit date: `2026-10-15T10:26:05-07:00`, subject `chore: sync upstream main (#413)`
- Every "Source:" line below is `<repo-relative path>@0e6e8c5`.

Note: in-repo links and Go module paths point to `github.com/x402-foundation/x402`
(e.g. `go/legacy/pkg/coinbasefacilitator/facilitator.go@0e6e8c5` imports
`github.com/x402-foundation/x402/go/pkg/types`). `coinbase/x402` looks like a synced mirror
of the foundation repo (see the commit subject above). We did not clone the foundation repo.

Nothing from inside the clone was executed. Everything here comes from reading files only.

---

## 1. Protocol versions and HTTP headers

Two versions exist: `x402Version: 1` and `x402Version: 2`. The v1 npm packages are marked deprecated:
"This npm package implements x402 **v1**. It is **deprecated**" (Source: `typescript/packages/legacy/x402/README.md@0e6e8c5`).

| Direction | v1 | v2 |
|---|---|---|
| 402 payment-required | **JSON body** of the 402 (`{x402Version:1, error, accepts}`) | **`PAYMENT-REQUIRED` header** (base64 JSON). Body is up to the server (`{}` by default) |
| Client payment payload | `X-PAYMENT` header | `PAYMENT-SIGNATURE` header |
| Seller settlement response | `X-PAYMENT-RESPONSE` header | `PAYMENT-RESPONSE` header |

Encoding for all header values is base64 of `JSON.stringify(obj)`, UTF-8 safe:
```ts
export function encodePaymentSignatureHeader(paymentPayload: PaymentPayload): string {
  return safeBase64Encode(JSON.stringify(paymentPayload));
}
```
Source: `typescript/packages/core/src/http/index.ts@0e6e8c5`. `safeBase64Encode` uses `btoa` over UTF-8 bytes or `Buffer...toString("base64")`, which is standard base64 and not base64url (Source: `typescript/packages/core/src/utils/index.ts@0e6e8c5`, L193-200). Decoders check the input against `Base64EncodedRegex` first.

Client header selection (Source: `typescript/packages/core/src/http/x402HTTPClient.ts@0e6e8c5`):
```ts
switch (paymentPayload.x402Version) {
  case 2: return { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload) };
  case 1: return { "X-PAYMENT": encodePaymentSignatureHeader(paymentPayload) };
```
**Version detection** (same file, `getPaymentRequiredResponse`):
```ts
// v2
const paymentRequired = getHeader("PAYMENT-REQUIRED");
if (paymentRequired) { return decodePaymentRequiredHeader(paymentRequired); }
// v1
if (body && body instanceof Object && "x402Version" in body && (body as PaymentRequired).x402Version === 1) {
  return body as PaymentRequired;
}
```
In short: if the 402 has a `PAYMENT-REQUIRED` header, the seller speaks v2. If not, parse the body JSON and check `x402Version === 1`.
Settlement lookup tries `PAYMENT-RESPONSE` first and then `X-PAYMENT-RESPONSE` (`getPaymentSettleResponse`).

The v2 seller (`x402HTTPResourceServer.extractPayment`) reads only `payment-signature`/`PAYMENT-SIGNATURE`. It does **not** decode `X-PAYMENT` (Source: `typescript/packages/core/src/http/x402HTTPResourceServer.ts@0e6e8c5`, ~L1279). The 402 headers it emits:
```ts
"PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired),
"Cache-Control": PAYMENT_REQUIRED_CACHE_CONTROL,   // = "no-store"
```
Spec tables: `specs/transports-v2/http.md@0e6e8c5` ("Header Summary": `PAYMENT-REQUIRED` Server→Client, `PAYMENT-SIGNATURE` Client→Server, `PAYMENT-RESPONSE` Server→Client, all "Base64-encoded"). `specs/transports-v1/http.md@0e6e8c5` says "HTTP 402 status code with JSON response body", `X-PAYMENT` and `X-PAYMENT-RESPONSE`.
The fetch wrapper also sets `Access-Control-Expose-Headers: PAYMENT-RESPONSE,X-PAYMENT-RESPONSE` on the paid request (Source: `typescript/packages/http/fetch/src/index.ts@0e6e8c5`).

A failed settle produces **HTTP 402** with the `PAYMENT-RESPONSE` header carrying `success:false` and `Cache-Control: no-store`. The body is `{}` unless `settlementFailedResponseBody` is configured (Source: `x402HTTPResourceServer.ts@0e6e8c5` `buildSettlementFailureResponse`, ~L1043-1073). Spec example: `specs/transports-v2/http.md@0e6e8c5` L145-147.

The facilitator-to-server side channel is the `EXTENSION-RESPONSES` header (base64 JSON keyed by extension). It is never forwarded to buyers. `encodePaymentResponseHeader` deletes `extensionResponses` (Source: `specs/x402-specification-v2.md@0e6e8c5` §7.2.1; `core/src/http/index.ts@0e6e8c5`).

## 2. PaymentRequirements and the 402 envelope (zod)

Source: `typescript/packages/core/src/schemas/index.ts@0e6e8c5`

```ts
const NonEmptyString = z.string().min(1);
const Any = z.record(z.unknown());
const OptionalAny = z.record(z.unknown()).optional().nullable();
const NetworkSchemaV1 = NonEmptyString;
const NetworkSchemaV2 = z.string().min(3).refine(val => val.includes(":"), ...); // CAIP-2

export const PaymentRequirementsV1Schema = z.object({
  scheme: NonEmptyString,
  network: NetworkSchemaV1,
  maxAmountRequired: NonEmptyString,
  resource: NonEmptyString, // URL string in V1
  description: z.string(),
  mimeType: z.string().optional(),
  outputSchema: Any.optional().nullable(),
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  asset: NonEmptyString,
  extra: OptionalAny,
});
export const PaymentRequiredV1Schema = z.object({
  x402Version: z.literal(1),
  error: z.string().optional(),
  accepts: z.array(PaymentRequirementsV1Schema).min(1),
});

export const PaymentRequirementsV2Schema = z.object({
  scheme: NonEmptyString,
  network: NetworkSchemaV2,
  amount: NonEmptyString,
  asset: NonEmptyString,
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  extra: OptionalAny,
});
export const PaymentRequiredV2Schema = z.object({
  x402Version: z.literal(2),
  error: z.string().nullish().transform(v => v ?? undefined),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsV2Schema).min(1),
  extensions: OptionalAny,
});
export const ResourceInfoSchema = z.object({
  url: NonEmptyString,
  description: z.string().nullish()...,  mimeType: z.string().nullish()...,
  serviceName: z.string().min(1).max(32).regex(PRINTABLE_ASCII_REGEX).nullish()...,
  tags: z.array(z.string().min(1).max(32).regex(PRINTABLE_ASCII_REGEX)).max(5).nullish()...,
  iconUrl: z.string().max(2048).nullish()...,
});
```
Optionality:
- **v1:** `mimeType`, `outputSchema` and `extra` are optional. `description` is required but may be empty. Everything else is required.
- **v2 requirements:** only `extra` is optional.
- **v2 renames:** `maxAmountRequired` became `amount`.
- **v2 moves:** `resource`, `description` and `mimeType` moved off each requirement into the top-level `resource` object (`ResourceInfo`). `outputSchema` is gone from v2 requirements; discovery I/O lives in the `bazaar` extension instead.

Amounts are **strings of atomic units** (e.g. `"10000"` = 0.01 USDC with 6 decimals; spec examples).

`extra` for EIP-3009 USDC holds the EIP-712 domain `{ "name": ..., "version": "2" }`. Spec says "`extra.name` (required): The EIP-712 domain name of the token contract" (Source: `specs/schemes/exact/scheme_exact_evm.md@0e6e8c5` L72-73). The client throws if they are missing: `"EIP-712 domain parameters (name, version) are required in payment requirements..."` (Source: `typescript/packages/mechanisms/evm/src/exact/client/eip3009.ts@0e6e8c5`).
Reserved `extra` keys: `extra.assetTransferMethod` (`"eip3009"` default | `"permit2"`) and `extra.paymentFlow` (`authorization` default | `upfront` | `escrow`) (Source: `specs/x402-specification-v2.md@0e6e8c5` §6.1).

Example v1 402 body (Source: `specs/transports-v1/http.md@0e6e8c5`):
`{"x402Version":1,"error":"Payment required to access this resource","accepts":[{"scheme":"exact","network":"base-sepolia","maxAmountRequired":"10000","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","payTo":"0x2096...","resource":"https://api.example.com/premium-data","description":"...","mimeType":"application/json","outputSchema":null,"maxTimeoutSeconds":60,"extra":{"name":"USDC","version":"2"}}]}`

## 3. PaymentPayload (what the client sends)

Source: `typescript/packages/core/src/schemas/index.ts@0e6e8c5`
```ts
export const PaymentPayloadV1Schema = z.object({
  x402Version: z.literal(1), scheme: NonEmptyString, network: NetworkSchemaV1, payload: Any,
});
export const PaymentPayloadV2Schema = z.object({
  x402Version: z.literal(2),
  resource: ResourceInfoSchema.nullish().transform(v => v ?? undefined),
  accepted: PaymentRequirementsV2Schema,
  payload: Any,
  extensions: OptionalAny,
});
```
v2 has no top-level `scheme`/`network`. Those live in `accepted`, which is the full chosen requirement echoed back.
The scheme-specific `payload` for exact/EVM/EIP-3009 is defined in `typescript/packages/mechanisms/evm/src/types.ts@0e6e8c5`:
```ts
export type ExactEIP3009Payload = {
  signature?: `0x${string}`;
  authorization: { from: `0x${string}`; to: `0x${string}`; value: string;
                   validAfter: string; validBefore: string; nonce: `0x${string}`; };
};
export type ExactEvmPayloadV2 = ExactEIP3009Payload | ExactPermit2Payload;
```
The Permit2 variant is `{ signature, permit2Authorization: { permitted:{token,amount}, spender, nonce, deadline, witness:{to,validAfter}, from } }`, and its nonce is a uint256 decimal string, not bytes32.
The v2 client wraps the payload as `{ x402Version, payload, extensions, resource: paymentRequired.resource, accepted: requirements }` (Source: `typescript/packages/core/src/client/x402Client.ts@0e6e8c5` `createPaymentPayload`).

## 4. Networks, USDC addresses, EIP-712 domains

v1 name → chain id (Source: `typescript/packages/mechanisms/evm/src/constants.ts@0e6e8c5`):
```ts
export const EVM_NETWORK_CHAIN_ID_MAP = {
  ethereum: 1, sepolia: 11155111, abstract: 2741, "abstract-testnet": 11124,
  "base-sepolia": 84532, base: 8453, "avalanche-fuji": 43113, avalanche: 43114,
  iotex: 4689, sei: 1329, "sei-testnet": 1328, polygon: 137, "polygon-amoy": 80002,
  peaq: 3338, story: 1514, educhain: 41923, "skale-base-sepolia": 324705682,
  megaeth: 4326, monad: 143, "monad-testnet": 10143, stable: 988, "stable-testnet": 2201,
  celo: 42220, flare: 14,
} as const;
```
v2 uses CAIP-2 `eip155:<chainId>`, parsed by `/^eip155:(\d+)$/` (Source: `mechanisms/evm/src/utils.ts@0e6e8c5`). So `base` ↔ `eip155:8453` and `base-sepolia` ↔ `eip155:84532`. The hosted x402.org facilitator registers v1 `"base-sepolia"` and v2 `"eip155:84532"` side by side (Source: `typescript/site/app/facilitator/index.ts@0e6e8c5`). Solana: v1 `solana-devnet`, v2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (same file).

Hard-coded default USDC (Source: `typescript/packages/mechanisms/evm/src/defaultAssets.ts@0e6e8c5`):
```ts
"eip155:8453":  [{ asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "USD Coin", version: "2", decimals: 6, symbol: "USDC" }], // Base mainnet USDC
"eip155:84532": [{ asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", name: "USDC",     version: "2", decimals: 6, symbol: "USDC" }], // Base Sepolia USDC
```
**The EIP-712 `name` differs by chain:** `"USD Coin"` on Base mainnet and `"USDC"` on Base Sepolia. The version is `"2"` on both. The same table appears in `docs/core-concepts/network-and-token-support.mdx@0e6e8c5` L114-115.
The seller's `ExactEvmScheme` (server) fills `extra.name/version` from this table when the price is a `"$0.001"`-style Money value (Source: `mechanisms/evm/src/exact/server/scheme.ts@0e6e8c5` `defaultMoneyConversion`).

## 5. EIP-3009 `exact` flow on EVM

**EIP-712 types** (Source: `mechanisms/evm/src/constants.ts@0e6e8c5`):
```ts
export const authorizationTypes = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" },
  { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" } ] } as const;
```
Domain = `{ name: extra.name, version: extra.version, chainId, verifyingContract: getAddress(requirements.asset) }`, primaryType `"TransferWithAuthorization"` (Source: `mechanisms/evm/src/exact/client/eip3009.ts@0e6e8c5`).

**Nonce:** 32 random bytes, hex-encoded (Source: `mechanisms/evm/src/utils.ts@0e6e8c5`):
```ts
export function createNonce(): `0x${string}` {
  return toHex(getCrypto().getRandomValues(new Uint8Array(32)));
}
```
**Time window. v1 and v2 differ:**
- v2 (`exact/client/eip3009.ts@0e6e8c5`): `validAfter: "0"`, `validBefore: (now + paymentRequirements.maxTimeoutSeconds).toString()`, `value: paymentRequirements.amount`.
- v1 (`exact/v1/client/scheme.ts@0e6e8c5`): `validAfter: (now - 600).toString(), // 10 minutes before`, `validBefore: (now + selectedV1.maxTimeoutSeconds)`, `value: selectedV1.maxAmountRequired`.

**Facilitator verify checks** (Source: `mechanisms/evm/src/exact/facilitator/eip3009.ts@0e6e8c5`), in order:
1. Signature (ecrecover or strict EIP-1271).
2. `to == payTo`.
3. `validBefore >= now + 6` ("6 second buffer for block time").
4. `validAfter <= now`.
5. `value == amount` exactly.
6. The asset is a contract.
7. An `eth_call` simulation of `transferWithAuthorization`.

If the simulation fails, a diagnostic multicall reads `balanceOf`, `name`, `version` and `authorizationState(from, nonce)`. A used nonce maps to `invalid_exact_evm_nonce_already_used` (Source: `exact/facilitator/eip3009-utils.ts@0e6e8c5`).

**Settle calls `transferWithAuthorization`** (not `receiveWithAuthorization`) (Source: `exact/facilitator/eip3009-utils.ts@0e6e8c5` `executeTransferWithAuthorization`):
```ts
return signer.writeContract({ address: erc20Address, abi: eip3009ABI,
  functionName: "transferWithAuthorization", args: [...baseArgs, ...signatureArgs], dataSuffix });
```
There are two ABI overloads:
- `(from,to,value,validAfter,validBefore,nonce,v,r,s)` when the signature is 65-byte ECDSA.
- `(...,nonce, bytes signature)` otherwise, for smart wallets.

`dataSuffix` means extra calldata may be appended (builder-code extension), so calldata length is not fixed. Settle re-runs verify (simulation off by default: `simulateInSettle ?? false`), waits for the receipt, and requires a matching ERC-20 `Transfer(from,to,value)` log from the asset; otherwise it returns `invalid_exact_evm_transfer_event_mismatch`.
(`receiveWithAuthorization` is used only by the separate `batch-settlement` scheme's deposit path: `mechanisms/evm/src/batch-settlement/client/eip3009.ts@0e6e8c5`.)

**On-chain events for chain scanning:**
- The v2 SDK only decodes `event Transfer(address indexed from, address indexed to, uint256 value)` (Source: `exact/facilitator/eip3009-utils.ts@0e6e8c5` `erc20TransferEventAbi`).
- `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)` appears in the repo only in the legacy USDC ABI (Source: `typescript/packages/legacy/x402/src/types/shared/evm/erc20PermitABI.ts@0e6e8c5` ~L45-63). Since `nonce` is an indexed topic, **the nonce is recoverable from the AuthorizationUsed log** (topic[2]) and also from tx calldata.
- `Transfer` does not carry the nonce. To join a settlement to a logged nonce, use AuthorizationUsed (`authorizer`=payer, `nonce`) or decode the calldata.
- Topic hashes were not computed here; see Open questions.
- The settle `transaction` field is the tx hash, and the facilitator's signer is `msg.sender`. The facilitator's own addresses are published in `/supported` → `signers` (e.g. `"eip155:*": [...]`).

## 6. Facilitator HTTP contract

Client (Source: `typescript/packages/core/src/http/httpFacilitatorClient.ts@0e6e8c5`):
- `DEFAULT_FACILITATOR_URL = "https://x402.org/facilitator"` and `DEFAULT_TIMEOUT_MS = 90_000`.
- `POST ${url}/verify` and `POST ${url}/settle` take the body `{ x402Version: paymentPayload.x402Version, paymentPayload, paymentRequirements }` with `Content-Type: application/json`.
- `GET ${url}/supported`.
- Optional auth headers are keyed per path: `{ verify:{...}, settle:{...}, supported:{...}, bazaar:{...} }`.

Types (Source: `typescript/packages/core/src/types/facilitator.ts@0e6e8c5`):
```ts
export type VerifyRequest = { x402Version: number; paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements; };
export type VerifyResponse = { isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: string;
  extensions?: Record<string, unknown>; extensionResponses?: Record<string, unknown>; extra?: Record<string, unknown>; };
export type SettleResponse = { success: boolean; errorReason?: string; errorMessage?: string; payer?: string;
  transaction: string; network: Network;
  /** Actual amount settled in atomic token units. Present for schemes like `upto` ... */ amount?: string;
  extensions?: ...; extensionResponses?: ...; extra?: ...; };
export type SupportedKind = { x402Version: number; scheme: string; network: Network; extra?: Record<string, unknown>; };
export type SupportedResponse = { kinds: SupportedKind[]; extensions: string[]; signers: Record<string, string[]>; };
```
The settle response field is **`transaction`** (not `txHash`). It is `""` on failure. v1 `SettleResponseV1` has the same shape minus `amount`/extensions (Source: `core/src/types/v1/index.ts@0e6e8c5`). The client-side zod for `/supported` defaults `extensions` to `[]` and `signers` to `{}` (`httpFacilitatorClient.ts` L208-212).
Non-2xx handling:
- A JSON body containing `isValid`/`success` throws `VerifyError`/`SettleError` with the status code.
- Anything else throws a generic Error.
- A timeout throws `FacilitatorTimeoutError`, documented as indeterminate for settle: "Callers must not treat this error as proof that settlement did not occur" (`types/facilitator.ts`).

Spec success/error examples (Source: `specs/x402-specification-v2.md@0e6e8c5` §7.1-7.3):
`{"isValid": false, "invalidReason": "insufficient_funds", "payer": "0x857b..."}`
`{"success": false, "errorReason": "insufficient_funds", "payer": "0x857b...", "transaction": "", "network": "eip155:84532"}`

**Spec error codes** (§9): `insufficient_funds`, `invalid_exact_evm_payload_authorization_valid_after`, `invalid_exact_evm_payload_authorization_valid_before`, `invalid_exact_evm_payload_authorization_value_mismatch`, `invalid_exact_evm_payload_signature`, `invalid_exact_evm_payload_recipient_mismatch`, `invalid_network`, `invalid_payload`, `invalid_payment_requirements`, `invalid_scheme`, `unsupported_scheme`, `invalid_x402_version`, `invalid_transaction_state`, `unexpected_verify_error`, `unexpected_settle_error`, `settlement_pending` (non-terminal: "MUST carry a non-empty `transaction`").

**SDK error codes** (Source: `typescript/packages/mechanisms/evm/src/exact/facilitator/errors.ts@0e6e8c5`, which says it is "character-for-character identical" to the Go constants):
- `invalid_exact_evm_scheme`, `invalid_exact_evm_network_mismatch`, `invalid_exact_evm_missing_eip712_domain`
- `invalid_exact_evm_recipient_mismatch`, `invalid_exact_evm_signature`
- `invalid_exact_evm_payload_authorization_valid_before`, `invalid_exact_evm_payload_authorization_valid_after`
- `invalid_exact_evm_authorization_value`, `invalid_exact_evm_payload_authorization_value_mismatch`
- `invalid_exact_evm_payload_undeployed_smart_wallet`, `invalid_exact_evm_transaction_failed`, `invalid_exact_evm_transfer_event_mismatch`
- `invalid_exact_evm_token_name_mismatch`, `invalid_exact_evm_token_version_mismatch`
- `invalid_exact_evm_eip3009_not_supported`, `invalid_exact_evm_nonce_already_used`
- `invalid_exact_evm_insufficient_balance`, `invalid_exact_evm_transaction_simulation_failed`
- `asset_not_deployed_contract`
- `invalid_exact_evm_failed_to_parse_signature`, `unsupported_payload_type`, `invalid_transaction_state`
- `eip6492_factory_not_allowed`, `smart_wallet_deployment_failed`
- `settlement_pending`
- Permit2/2612/erc20-approval families: `permit2_*`, `invalid_permit2_*`, `erc20_approval_*`, `eip2612_*`

**Mismatch to note:** the spec says `invalid_exact_evm_payload_signature` / `invalid_exact_evm_payload_recipient_mismatch`, but the SDK emits `invalid_exact_evm_signature` / `invalid_exact_evm_recipient_mismatch`. Insufficient balance is `invalid_exact_evm_insufficient_balance` in the SDK, not the spec's `insufficient_funds`. The harness should treat reason strings as open-ended.
The hosted site facilitator also emits `invalid_json` and `missing_parameters` with HTTP 400 (Source: `typescript/site/app/facilitator/settle/route.ts@0e6e8c5`).

**Facilitator URLs and networks:**
- `https://x402.org/facilitator` is the default in the v2 SDK and the legacy `x402` package (`legacy/x402/src/verify/useFacilitator.ts@0e6e8c5`). It is testnet only. Its supported list: "`eip155:84532` (Base Sepolia), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (Solana Devnet), `stellar:testnet` (Stellar Testnet), `aptos:2` (Aptos Testnet), `hedera:testnet` (Hedera Testnet), `xrpl:1` (XRPL Testnet)" (Source: `docs/core-concepts/network-and-token-support.mdx@0e6e8c5` L324). The FAQ says it "does not support Base mainnet (`eip155:8453`)" (Source: `docs/faq.md@0e6e8c5` L131). Its implementation lives in `typescript/site/app/facilitator/` and registers exact/upto/batch-settlement on `eip155:84532` plus v1 `base-sepolia`.
- CDP appears in code only in the Go legacy package: `CoinbaseFacilitatorBaseURL = "https://api.cdp.coinbase.com"`, `CoinbaseFacilitatorV2Route = "/platform/v2/x402"` (Source: `go/legacy/pkg/coinbasefacilitator/facilitator.go@0e6e8c5`). It needs CDP key id/secret JWT auth headers per path. The TS CDP client is the external npm package `@coinbase/x402` (`facilitator` export, referenced in `typescript/packages/legacy/x402-next/README.md@0e6e8c5` L142-157) and is not in this repo. `docs/dev-tools/facilitators.md@0e6e8c5` lists "CDP Facilitator ... Coinbase-hosted facilitator with KYT/OFAC checks" without stating its networks. Many third-party facilitators are listed there too (PayAI, Dexter, Corbits, etc.).

## 7. Discovery / Bazaar

- **Spec:** `specs/extensions/bazaar.md@0e6e8c5` and `specs/x402-specification-v2.md@0e6e8c5` §8. The seller advertises with `PaymentRequired.extensions.bazaar = { info: { input: {type:"http", method, queryParams|body...} | {type:"mcp",...}, output: {type, example} }, schema: <JSON Schema> }`.
- **Endpoints are optional for facilitators** ("Facilitators that implement Bazaar discovery may expose discovery APIs"):
  - `GET /discovery/resources` takes `type`, `payTo`, `scheme`, `network`, `extensions`, `limit`, `offset`.
  - `GET /discovery/search` takes `query` (required), `type`, `payTo`, `scheme`, `network`, `extensions`, `limit`, `cursor`. `limit` and `cursor` are advisory.
- **Client:** `withBazaar(facilitatorClient).extensions.bazaar.listResources(params)` / `.search(params)` (Source: `typescript/packages/extensions/src/bazaar/facilitatorClient.ts@0e6e8c5`). Response types:
```ts
export interface DiscoveryResource { resource: string; type: string; x402Version: number;
  accepts: PaymentRequirements[]; lastUpdated: string; description?: string; mimeType?: string;
  serviceName?: string; tags?: string[]; iconUrl?: string; extensions?: Record<string, unknown>; }
export interface DiscoveryResourcesResponse { x402Version: number; items: DiscoveryResource[];
  pagination: { limit: number; offset: number; total: number }; }
export interface SearchDiscoveryResourcesResponse { x402Version: number; resources: DiscoveryResource[];
  partialResults?: boolean; pagination?: { limit: number; cursor: string | null } | null; }
```
Note that list returns `items` while search returns `resources`. The legacy v1 client also calls `${url}/discovery/resources?...` (Source: `typescript/packages/legacy/x402/src/verify/useFacilitator.ts@0e6e8c5` L172). Docs reference `https://x402.org/facilitator/discovery/resources`, but `typescript/site/app/facilitator/` has **no** discovery route at this commit, only verify/settle/supported.
Catalog status comes back to the seller through `EXTENSION-RESPONSES: base64({"bazaar":{"status":"success"|"processing"|"rejected","rejectedReason"?}})`.

## 8. TypeScript packages (all `package.json` under `typescript/packages`)

| Package | Version | Path |
|---|---|---|
| `@x402/core` | 2.28.0 | packages/core |
| `@x402/evm` | 2.28.0 | packages/mechanisms/evm |
| `@x402/fetch` | 2.28.0 | packages/http/fetch |
| `@x402/axios` | 2.28.0 | packages/http/axios |
| `@x402/express` / `@x402/hono` / `@x402/next` / `@x402/fastify` | 2.28.0 | packages/http/* |
| `@x402/paywall`, `@x402/mcp`, `@x402/extensions` | 2.28.0 | |
| `@x402/svm`, `@x402/avm`, `@x402/aptos`, `@x402/stellar`, `@x402/near`, `@x402/xrpl`, `@x402/tvm`, `@x402/cardano`, `@x402/casper`, `@x402/concordium`, `@x402/keeta`, `@x402/hedera` | 2.28.0 | packages/mechanisms/* |
| legacy v1 (deprecated): `x402` 1.2.1, `x402-fetch` 1.2.0, `x402-axios` 1.2.1, `x402-express` 1.2.0, `x402-hono` 1.2.0, `x402-next` 1.2.0 | | packages/legacy/* |

Packages a buyer needs:
- **(a) Parse a 402:** `@x402/core`. Use `x402HTTPClient.getPaymentRequiredResponse(getHeader, body)` or the decoders `decodePaymentRequiredHeader` / zod `parsePaymentRequired` / `isPaymentRequiredV1|V2` (`@x402/core/http`, `@x402/core/schemas`). `@x402/fetch` re-exports `x402Client`, `x402HTTPClient` and `decodePaymentResponseHeader`.
- **(b) Sign exact EVM with a viem account:** `@x402/evm`. Use `new ExactEvmScheme(signer, options?)` from `@x402/evm/exact/client`, where `signer: ClientEvmSigner = { address, signTypedData(...) , readContract? }`. A viem `privateKeyToAccount(pk)` is passed directly in the example (Source: `examples/typescript/clients/fetch/index.ts@0e6e8c5`: `client.register("eip155:*", new ExactEvmScheme(evmSigner, rpcOptions))`). The helper `registerExactEvmScheme(client, { signer, networks?, policies?, ... })` registers v2 `eip155:*` **and** all v1 names (Source: `mechanisms/evm/src/exact/client/register.ts@0e6e8c5`). `toClientEvmSigner(signer, publicClient?)` lives in `mechanisms/evm/src/signer.ts`.
- **(c) Wrap fetch:** `@x402/fetch`:
```ts
export function wrapFetchWithPayment(fetch: typeof globalThis.fetch, client: x402Client | x402HTTPClient)
export function wrapFetchWithPaymentFromConfig(fetch: typeof globalThis.fetch, config: x402ClientConfig)
```
`x402Client` API (Source: `core/src/client/x402Client.ts@0e6e8c5`):
- `new x402Client(paymentRequirementsSelector?)`. The default selector is `accepts[0]` after filtering.
- `register(network, schemeClient)` and `registerV1(...)`.
- `registerPolicy(policy)`.
- `setSpendControls(controls | false)`.
- `onBeforePaymentCreation`, `onAfterPaymentCreation`, `onPaymentCreationFailure`, `onPaymentResponse`.
- `createPaymentPayload(paymentRequired)`.
- `type SelectPaymentRequirements = (x402Version: number, paymentRequirements: PaymentRequirements[]) => PaymentRequirements`.

**Spend controls are on by default:** `DEFAULT_MAX_AMOUNT_PER_PAYMENT: Money = "$1"`. Only "default assets" (the table in §4) are allowed unless `allowedAssets` is set. `setSpendControls(false)` disables both.

**Hook to see the nonce before sending:** yes. `onAfterPaymentCreation(hook)` gets `{ paymentRequired, selectedRequirements, paymentPayload }` after signing and before return. In `wrapFetchWithPayment`, the order is `createPaymentPayload` → `encodePaymentSignatureHeader` → `fetch(clonedRequest)`, so the hook runs before the paid request goes out. The nonce is `paymentPayload.payload.authorization.nonce`.
- The hook returns `Promise<void>`. Make the log write durable before resolving.
- `onBeforePaymentCreation` can abort: `{ abort: true, reason }`.
- **Caveat:** on `onPaymentResponse` → `{recovered:true}`, the wrapper signs a **fresh payload** (new nonce) and retries once, so the hook fires again.
- The wrapper throws `"Payment already attempted"` if the original request already carried `PAYMENT-SIGNATURE`/`X-PAYMENT`.
- To control logging fully, the harness can skip the wrapper: call `x402HTTPClient.createPaymentPayload`, log, then `encodePaymentSignatureHeader`, and send.

Legacy v1 client API, for reference: `wrapFetchWithPayment(fetch, walletClient, maxValue = BigInt(0.1 * 10 ** 6), paymentRequirementsSelector = selectPaymentRequirements, config?)` (Source: `typescript/packages/legacy/x402-fetch/src/index.ts@0e6e8c5`) and `createPaymentHeader(client, x402Version, paymentRequirements)` (Source: `typescript/packages/legacy/x402/src/client/createPaymentHeader.ts@0e6e8c5`).

## 9. Seller middleware

Packages: `@x402/express`, `@x402/hono`, `@x402/next`, `@x402/fastify` (v2) plus the legacy `x402-express|hono|next`.
Configuration (Source: `examples/typescript/servers/express/index.ts@0e6e8c5`):
```ts
const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
app.use(paymentMiddleware(
  { "GET /weather": { accepts: [{ scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: evmAddress }],
                      description: "Weather data", mimeType: "application/json" } },
  new x402ResourceServer(facilitatorClient).register("eip155:84532", new ExactEvmScheme()),
));
```
Types (Source: `core/src/http/x402HTTPResourceServer.ts@0e6e8c5`):
- `PaymentOption { scheme; payTo: string|DynamicPayTo; price: Price|DynamicPrice; network; maxTimeoutSeconds?; extra? }`
- `RouteConfig { accepts: PaymentOption|PaymentOption[]; resource?; description?; mimeType?; serviceName?; tags?; iconUrl?; ...; unpaidResponseBody?; settlementFailedResponseBody?; extensions? }`
- Route keys look like `"GET /path"`, with `*`, `:param` and `[param]` supported.

Express signatures (Source: `typescript/packages/http/express/src/index.ts@0e6e8c5`):
- `paymentMiddleware(routes, server, paywallConfig?, paywall?, syncFacilitatorOnStart = true)`
- `paymentMiddlewareFromConfig(routes, facilitatorClients?, schemes?, ...)`
- `paymentMiddlewareFromHTTPServer(httpServer, ...)`

On startup it calls `/supported` (`httpServer.initialize()`).

**Verify/settle ordering (default `authorization` flow)** in the express middleware:
1. `processHTTPRequest`. With no header it returns a 402 with `PAYMENT-REQUIRED`. With a header it calls `verifyPayment` (facilitator `/verify`) and gives a 402 on invalid.
2. On `payment-verified` it **buffers** `writeHead`/`write`/`end`/`flushHeaders`, then runs `next()` (the handler).
3. If the handler throws, or `res.statusCode >= 400`, it does **not settle** ("If the response from the protected route is >= 400, do not settle payment") and replays the buffered error response.
4. Otherwise it calls `processSettlement`, which runs `settlePayment` (facilitator `/settle`). On success it adds `PAYMENT-RESPONSE` and `Cache-Control` private, then flushes the buffered body. On settle failure it **drops the handler body** and returns 402 + `PAYMENT-RESPONSE`(success:false).
5. A facilitator boundary error gives **502** `{error}`. An unexpected error during settle gives 402 `{}`. Init errors give 500 `{"error":"Internal Server Error"}`.

So with the reference middleware and the default flow, **a 5xx after a successful settlement cannot happen**: settlement happens only after the handler has produced a <400 response. Ways it can still happen:
- (i) `extra.paymentFlow: "upfront"` or `"escrow"`, which settles **before** the handler. Upfront README: "If the handler fails after settlement, the client has already paid; the middleware still echoes the settlement receipt in `PAYMENT-RESPONSE`" (Source: `examples/typescript/servers/upfront/README.md@0e6e8c5`). The spec ordering table says `upfront`: settle → resource → respond (Source: `specs/x402-specification-v2.md@0e6e8c5` §6.1). Spec: "When a resource offers both `authorization` ... and a pre-handler-settlement flow ... clients SHOULD prefer `authorization`."
- (ii) Non-reference sellers.
- (iii) Failure after settle while writing/streaming the buffered response, or an on-chain tx that lands after a `settlement_pending` / timeout response.

## 10. Rate limits, retries, idempotency

- **`/supported`:** the client retries on HTTP 429 and honors `Retry-After` (`GET_SUPPORTED_RETRIES`, `computeRetryDelay`). `/verify` and `/settle` are **not** retried on 429 (Source: `httpFacilitatorClient.ts@0e6e8c5` ~L520-575).
- **Settle retry:** the resource server retries settle **exactly once**, and only for `settlement_pending` with a non-empty `transaction` (`settleWithPendingRetry`, `const SETTLEMENT_PENDING_REASON = "settlement_pending"`) (Source: `core/src/server/x402ResourceServer.ts@0e6e8c5` ~L156-158, L1562-1600, L2040-2062).
- **Facilitator-side idempotency:** the EVM exact facilitator keeps a `PendingSettlementStore` keyed by the **signature**. If a prior attempt broadcast a tx but the receipt wait failed, a retry with the identical payload reconciles against the cached tx instead of re-broadcasting. The default is `new InMemoryPendingSettlementStore()`, which is per-process with "no cross-call sharing" unless injected (Source: `mechanisms/evm/src/exact/facilitator/eip3009.ts@0e6e8c5` `settleEIP3009`; `core/src/facilitator/pendingSettlementStore.ts@0e6e8c5`).
- **Reused nonce:** there is no off-chain nonce registry. Replay is blocked on chain by EIP-3009 (`authorizationState`). Verify simulation fails, and the diagnostic maps it to `invalid_exact_evm_nonce_already_used`. A settle revert matching `/authorization.*used|AuthorizationAlreadyUsed|AuthorizationUsedOrCanceled/` maps to the same code (`eip3009-utils.ts@0e6e8c5` `parseEip3009TransferError`). Spec §10.1: "EIP-3009 contracts inherently prevent nonce reuse at the smart contract level".
- **Optional idempotency extension:** `payment-identifier`. The client adds `extensions["payment-identifier"].id` (16-128 chars) as an "idempotency key" for servers and facilitators (Source: `specs/extensions/payment_identifier.md@0e6e8c5`).
- **Timeouts:** the default facilitator call timeout is 90s. A settle timeout is indeterminate.
- **Hosted x402.org facilitator:** no rate-limit logic found in `typescript/site/app/facilitator/*`. Comments in the routes mention verify→settle tracking hooks ("Validate payment was verified (onBeforeSettle - will abort if not)"), but no such hook registration was found in `app/facilitator/index.ts` at this commit.

---

## Open questions / things not found in source

1. **Event topic hashes** for `Transfer(address,address,uint256)` and `AuthorizationUsed(address,bytes32)` are not written in the repo. Compute them with keccak in the harness rather than from memory. USDC's on-chain ABI is external. The repo only has the legacy ABI copy showing both `authorizer` and `nonce` indexed.
2. **CDP facilitator for TS:** the `@coinbase/x402` package is not in this repo. Its exact TS URL, the networks it supports and its rate limits cannot be confirmed here. The only in-repo CDP URL is the Go legacy `https://api.cdp.coinbase.com` + `/platform/v2/x402`.
3. **x402.org rate limits / quotas:** not in source.
4. **Spec vs SDK error strings disagree** (`invalid_exact_evm_payload_signature` vs `invalid_exact_evm_signature`, etc.). Which one third-party facilitators emit is unknown. Log raw strings.
5. **Discovery on x402.org:** docs mention `https://x402.org/facilitator/discovery/resources`, but the site code at this commit has no discovery route. Probe it live.
6. Whether v2 SDK sellers accept v1 `X-PAYMENT` at all. `extractPayment` reads only `PAYMENT-SIGNATURE`, but the express context also reads `x-payment` into `paymentHeader`. Not fully traced; v1-only buyers likely fail against v2 sellers.
7. `validAfter: "0"` in v2 means on-chain `validAfter` gives no signing-time hint. The harness must log signing time itself; `validBefore - maxTimeoutSeconds` approximates it.
8. Mainnet Base support of the x402.org facilitator: docs say no. Not verified live.
9. The x402.org website spec was not fetched. The repo `specs/` (v1 and v2) was used as primary, per instructions.


---

# Part 2: indexes, discovery APIs and on-chain volume sources


Research date: 2026-10-23. Every live probe below was a plain GET (or a read-only JSON-RPC POST) with no
credentials, run on 2026-10-23 between about 22:00 and 22:20 UTC. Anything not confirmed by a doc or a
live probe is marked **UNVERIFIED**.

## TL;DR

| Need | Best source | Auth | Cost |
|---|---|---|---|
| Universe of sellers/resources (Base) | CDP Bazaar `GET /platform/v2/x402/discovery/resources` | none | free |
| Resources per payTo | CDP Bazaar `GET /platform/v2/x402/discovery/merchant?payTo=` | none | free |
| 30-day activity per resource (call count, unique payers) | CDP Bazaar `quality` field | none | free |
| 30-day **USDC volume** per payTo, ranked | x402scan `GET /api/x402/merchants?chain=base&timeframe=30&sort_by=volume` | x402 payment | $0.01 per page (max 100 rows per page) |
| 30-day volume per payTo, self-computed | `eth_getLogs` on USDC `Transfer` filtered by `to=payTo`, joined to `AuthorizationUsed` in the same tx | free public RPC or a provider key | free (publicnode) |

No **free** API returns per-payTo 30-day USD settlement volume. CDP gives call counts only. x402scan
gives volume, but each call costs $0.01 in x402 USDC on Base. Otherwise you compute it from chain logs.

---

## A. Coinbase CDP x402 Bazaar (discovery API)

Docs:
- https://docs.cdp.coinbase.com/x402/bazaar (and its `.md` twin)
- https://docs.cdp.coinbase.com/x402/buyer/discover-services
- API reference (OpenAPI-rendered):
  - https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/list-x402-resources
  - https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/list-merchant-discovery-info
  - https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/search-x402-resources
- Generic extension spec: https://docs.x402.org/extensions/bazaar

### Auth
Public. The docs say: "Bazaar discovery is public. You do not need a CDP API key to use the discovery APIs."
The OpenAPI sets `security: - unauthenticated: []` on all three operations, overriding the global
`apiKeyAuth`. Confirmed live: all calls below returned HTTP 200 with no headers set.

### Rate limits
Not documented. The spec defines a `rate_limit_exceeded` error type but gives no thresholds. Live: 15
back-to-back requests and three `limit=1000` pages all returned 200. The responses carry no
`X-RateLimit-*` headers. Treat the limit as **UNVERIFIED** and throttle to about 1 request/s.

### 1. List resources
`GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` (operationId `listX402DiscoveryResources`)

| param | type | default | notes |
|---|---|---|---|
| `type` | string | none | Docs say "Currently, the only supported protocol type is "http"" (the item enum also has `mcp`) |
| `limit` | int | 100 (doc) | **Live behaviour:** clamped to the range [20, 1000]. `limit=1,2,5,10,19` each returned 20 items. `limit=5000` returned 1000. Omitting `limit` returned 20, not the documented 100. |
| `offset` | int | 0 | Offset pagination. An offset past the end returns `items: []` (and the echoed offset was rounded down). |

Response (`x402DiscoveryResourcesResponse`): `{ x402Version, items[], pagination: { limit, offset, total } }`

Item (`x402DiscoveryResource`). Required: `resource`, `type`, `x402Version`. Optional fields:
- `description`, `lastUpdated` (date-time)
- `accepts[]`: x402 PaymentRequirements; see the v2 note below
- `extensions` (object keyed by extension name, e.g. `bazaar` holds input/output schema and examples, `builder-code`)
- `quality`: `{ l30DaysTotalCalls, l30DaysUniquePayers, lastCalledAt }` (field names seen in the doc example and live; the schema object itself is not expanded in the docs)
- `serviceName` (free-form, "not a stable identifier"), `tags[]`, `bundleSlugs[]` (curated only),
  `iconUrl`, `curated` (bool; omitted means false), `skillUrl`

**v2 note:** every item sampled was `x402Version: 2` (pages at offsets 0 and 30000, 1000 items each; zero v1
items). In v2, `accepts[]` entries have
`{ scheme, network (CAIP-2, e.g. "eip155:8453"), amount (atomic units), asset, payTo, maxTimeoutSeconds, extra{name,version,...} }`.
There is **no `maxAmountRequired`**, which is v1 only. There is no per-accept `description` or
`outputSchema`: the description is on the item, and the output schema lives in `extensions.bazaar`. Some
accepts carry `extra.assetTransferMethod: "permit2"`, and those settlements will **not** emit EIP-3009
`AuthorizationUsed` (see C).

Live totals (2026-10-23 ~22:05 UTC): `pagination.total = 37889` with no filter, and `37763` with `type=http`.
The first 1000 items include 298 distinct Base (`eip155:8453`) payTo addresses. Network counts across
accepts in the first 1000 items: eip155:8453 1118, Solana mainnet 422, Polygon 215, Arbitrum 187, BSC 57, and others.
Ordering is roughly by activity but **not strictly sorted** by `l30DaysTotalCalls`. Deep pages show
`l30DaysTotalCalls: 1`, so the full list includes long-tail and dead resources. Because the order is not
stable, page through to the end and de-duplicate on `resource`.

Trimmed real example (`curl 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1000'`, items 0 and 10):
```json
{"x402Version":2,"pagination":{"limit":1000,"offset":0,"total":37889},"items":[
 {"resource":"https://www.ax1.vc/api/dashboard/q-verdict/resource","type":"http","x402Version":2,
  "serviceName":"AX1 Console","description":"Send a Base token contract address, get an AI-written verdict...",
  "lastUpdated":"2026-10-11T14:48:09.674Z","tags":["agents","token","verdict"],
  "quality":{"l30DaysTotalCalls":238665,"l30DaysUniquePayers":2608,"lastCalledAt":"2026-10-21T09:39:38.381Z"},
  "accepts":[{"scheme":"exact","network":"eip155:8453","amount":"20000",
    "asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payTo":"0x7284D41b5b852F2bd4c99bDf95043D84452d299C",
    "maxTimeoutSeconds":300,"extra":{"name":"USD Coin","version":"2"}}],
  "extensions":{"bazaar":"(trimmed)","builder-code":"(trimmed)"}},
 {"resource":"https://blockrun.ai/api/v1/chat/completions","type":"http","x402Version":2,"curated":true,
  "serviceName":"BlockRun.AI","description":"AI chat completions API - pay per request with USDC on Base",
  "lastUpdated":"2026-10-23T21:58:43.669Z","tags":["ai","inference","llm","gateway"],
  "quality":{"l30DaysTotalCalls":84716,"l30DaysUniquePayers":291,"lastCalledAt":"2026-10-23T18:23:18.114Z"},
  "accepts":[{"scheme":"exact","network":"eip155:8453","amount":"2000",
    "asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payTo":"0xe9030014F5DAe217d0A152f02A043567b16c1aBf",
    "maxTimeoutSeconds":300,"extra":{"name":"USD Coin","version":"2"}}],
  "extensions":{"bazaar":"(trimmed)"}}]}
```

### 2. Resources by payTo (merchant)
`GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/merchant?payTo=<addr>&limit=20&offset=0`
(operationId `listX402DiscoveryMerchant`). `payTo` is required (1 to 128 chars), and `limit` defaults to 20.
Response: `{ x402Version, payTo, resources[], pagination{limit,offset,total} }`. `resources` is empty for an
unknown address. Live: `payTo=0x589a2314a2E05F45e40C4823Da3Ba58D421dB3d8` returned 200 with `total: 14`.

### 3. Search
`GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/search`. Params: `query` (max length 400), `network`
(CAIP-2 or legacy names such as `base`), `asset`, `scheme`, `payTo`, `urlSubstring`, `maxUsdPrice`,
`extensions[]`, `tags[]` (max 5), `bundleSlugs[]` (max 5), `curatedOnly`, and `limit` (1 to 20, default 20).
Response: `{ resources[], partialResults, searchMethod (text|vector|hybrid), x402Version }`. Live, it also
returned `meta.searchToken`. Search is not useful for enumeration because it is capped at 20 results.

### What CDP gives for ranking
`quality.l30DaysTotalCalls` and `l30DaysUniquePayers` count activity per **resource**, not USD volume. A
rough proxy is calls × `amount`, but this assumes a fixed price (no `upto` scheme) and that every call
settled. **UNVERIFIED:** whether `quality` counts only settlements through the CDP facilitator or across all
facilitators. The docs describe it only as call count and unique payers over the last 30 days.

### Open-source / x402.org facilitator discovery
- `https://x402.org/facilitator/discovery/resources` returned **404** (Next.js 404 page), and so did
  `https://www.x402.org/facilitator/discovery/resources`.
- `facilitator.x402.org` has **no DNS record** (curl: could not resolve host).
- `https://x402.org/facilitator/supported` returned **200** (see D).
- docs.x402.org/extensions/bazaar says facilitators that support the Bazaar extension "may provide" a
  `/discovery/resources` endpoint. The x402.org testnet facilitator does not.

### CDP API keys (only needed for the CDP facilitator verify/settle, not for discovery)
The CDP facilitator "authenticates with your CDP API key ID and secret"
(https://docs.cdp.coinbase.com/x402/network-support). Pricing: the first 1,000 on-chain transactions per month
are free, then $0.001 each. The env var names `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` used by
`@coinbase/cdp-sdk` were not confirmed on the pages fetched: **UNVERIFIED**. The audit's discovery crawl does
not need them.

---

## B. x402scan (https://www.x402scan.com)

`x402scan.com` redirects (307) to `www.x402scan.com`. It is operated by Merit Systems. Source:
https://github.com/Merit-Systems/x402scan (399 stars, last push 2026-10-14, no license detected by GitHub).

Machine-readable entry points (all fetched live, HTTP 200):
- https://www.x402scan.com/llms.txt: says it "exposes that data through a public API", and "most read endpoints
  require a small x402 micropayment (~$0.01–$0.02, sent via an `X-Payment` header)".
- https://www.x402scan.com/openapi.json (OpenAPI 3.1, server `https://www.x402scan.com`)
- https://www.x402scan.com/.well-known/api-catalog (RFC 9727 linkset)
- https://www.x402scan.com/api/health returned `{"status":"ok","service":"x402scan","time":"2026-10-23T22:06:20.294Z"}`
- `/docs`, `/api`, `/terms`, `/api/openapi.json` all return 404.

### Public API (`/api/x402/*`): paid per call via x402 (USDC on Base)
Pagination for all list endpoints: `page` (0-based), `page_size` (1 to 100, default 10).
`chain` ∈ {`base`,`solana`}. `timeframe` ∈ {1,7,14,30} days.

| Endpoint | Price | Extra params |
|---|---|---|
| `GET /api/x402/merchants` (top recipients by volume) | $0.01 | `sort_by` ∈ volume, tx_count, unique_buyers (default volume) |
| `GET /api/x402/merchants/{address}/stats` | $0.01 | chain, timeframe |
| `GET /api/x402/merchants/{address}/transactions` | $0.01 | `sort_by` ∈ time, amount; `sort_order` |
| `GET /api/x402/buyers` | $0.01 | per the guidance text (not in `paths` dump) |
| `GET /api/x402/wallets/{address}/stats` and `/transactions` | $0.01 | as above |
| `GET /api/x402/facilitators`, `/facilitators/stats` | $0.01 | chain, timeframe |
| `GET /api/x402/resources` | $0.01 | chain |
| `GET /api/x402/resources/search?q=` | $0.02 | tags, chains |
| `GET /api/x402/origins/{id}/resources` | $0.01 | chain |
| `GET /api/x402/registry/origin?url=` | $0.01 | chain |
| `POST /api/x402/registry/register`, `/register-origin` | free | SIWX wallet auth |
| `POST /api/x402/send` | dynamic | sends USDC |

**Per-payTo 30-day volume exists here:** `GET /api/x402/merchants?chain=base&timeframe=30&sort_by=volume&page_size=100`.
Live probe returned `HTTP 402`, empty body, with a base64 `payment-required` header that decodes to:
```json
{"x402Version":2,"resource":{"url":"https://www.x402scan.com/api/x402/merchants?chain=base&timeframe=30&sort_by=volume&page_size=100",
 "method":"GET","description":"Paginated list of merchants (top recipients by volume)","mimeType":"application/json","serviceName":"x402scan"},
 "accepts":[{"scheme":"exact","network":"eip155:8453","amount":"10000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "payTo":"0x2EC4545f96A24876764bF2B04D54E66A1351bE71","maxTimeoutSeconds":300,"extra":{"name":"USD Coin","version":"2"}}]}
```
The response also sets the header `x-agent-identity`, a SIWX-style challenge. The OpenAPI defines no 200
response schema. The schema below comes from the repo source (`apps/scan/src/app/api/x402/_handlers/merchants.ts`,
`_lib/utils.ts`, `services/transfers/sellers/list-mv.ts`):
```
{ data: [ { recipient, facilitator_ids[], tx_count, total_amount (float), latest_block_timestamp,
            unique_buyers, chains[] } ],
  pagination: { page, page_size, has_next_page } }
```
The data is read from materialized views `recipient_stats_aggregated_<timeframe>`. The units of `total_amount`
(USDC atomic units or decimal USD) are **UNVERIFIED** and need a paid sample. How x402scan attributes a
transfer to x402 (by known facilitator sender addresses) is **UNVERIFIED**. The ToS (A.5) says the data comes
from CDP, BitQuery, BigQuery and public RPCs, and that it is "best-effort and may be inaccurate or delayed".
Cost to rank the Base top 1000 merchants: 10 pages × $0.01 = $0.10, plus one $0.01 `/stats` call per
merchant for spot checks. This needs an x402 buyer wallet funded with mainnet USDC on Base. No API key is needed.

### Internal tRPC (frontend)
`/api/trpc/[trpc]` is reachable. One GET to `/api/trpc/public.sellers.all.list` returned a tRPC
`400 BAD_REQUEST` zod error ("expected object" at path `pagination`), which shows the router is live and
unauthenticated. Its `public.sellers.all.list` serves the same data as `/api/x402/merchants`. **Do not use
it.** The ToS §7 forbids attempts to "**circumvent x402 payments or platform fees**" and to "scrape, harvest,
or copy the Services (except for public, revocable search-engine indexing)" (https://www.x402scan.com/tos.md).
robots.txt allows `/` with `Content-Signal: search=yes, ai-train=no, ai-input=yes`. Rate limits are not
documented anywhere: **UNVERIFIED**.

---

## C. Computing per-payTo volume from chain logs

### Contract addresses
Source: https://developers.circle.com/stablecoins/usdc-contract-addresses (fetched 2026-10-23). Confirmed on-chain with `eth_call name()`.
- Base mainnet (chainId 8453): **`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`**. `name()` returns `"USD Coin"`.
- Base Sepolia (chainId 84532, `eth_chainId` = 0x14a34): **`0x036CbD53842c5426634e7929541eC2318f3dCF7e`**. `name()` returns `"USDC"`.
  This matters for the EIP-712 domain `extra.name`.

### Events and selectors
From Circle's source, https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol line 50:
`event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);`. **Both parameters are indexed.**
The data field is empty.

Topic hashes were computed locally with a verified keccak256 (it reproduces the well-known Transfer topic) and
confirmed against a live receipt:
- `Transfer(address,address,uint256)`: `0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef`
- `AuthorizationUsed(address,bytes32)`: `0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5`
- Selector `transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)`: `0xe3ee160e`
- Selector `transferWithAuthorization(...,bytes signature)`: `0xcf092995`. Selector `receiveWithAuthorization(v,r,s)`: `0xef55bec6`.

Live x402 settlement example: tx `0xf9a46d6d894ba554d614476288fece3b557b97002549708300b5100bb0a75d90`.
The sender is `0x93f6601151ccb08f333ab4b1cccfb1e188c0be44` and `to` is the USDC contract. The selector is
`0xe3ee160e`. The tx emits `AuthorizationUsed(authorizer=0xe8505a…7eaf, nonce)` and then
`Transfer(0xe8505a… → payTo 0x589a23…b3d8, 0x1388 = 5000 = $0.005)`. That amount matches the Bazaar price for
that payTo. Whether the sender is the CDP facilitator is **UNVERIFIED**.

### Pitfall: dust/spam transfers pollute naive `Transfer to payTo` sums
For payTo `0x589a2314…b3d8`, the last 50,000 blocks had 1471 incoming USDC Transfer logs:
- 1346 of exactly 5000 (real x402 settlements)
- 85 of 20 atomic units, sent via a batch contract (`0x75161f…eb96`, plain `transfer` `0xa9059cbb`), which is address-poisoning/dust spam
- 40 of 10 to 20 USDC (unrelated transfers)

Counting rule: count a Transfer only if the same tx has an `AuthorizationUsed` log from USDC with
`authorizer == Transfer.from`. Optionally also require that tx.from is a known facilitator signer. Note that
Permit2-based x402 (`assetTransferMethod: permit2`) and the `upto` and `batch-settlement` schemes do not emit
`AuthorizationUsed` and would need separate handling. Volume is about 17.8 `AuthorizationUsed` logs per block
on Base (1784 in 100 blocks). Scanning all of them for 30 days (about 1.3M blocks at 2 s each, roughly 23M logs)
is impractical on free tiers. Instead, query **per payTo** with
`topics: [Transfer, null, pad32(payTo)]`, then fetch receipts or filter AuthorizationUsed by tx hash.

### RPC providers (eth_getLogs over 30 days)
| Provider | Endpoint | Free-tier getLogs limit | Source |
|---|---|---|---|
| Base public | `https://mainnet.base.org` / `https://sepolia.base.org` | Live: `eth_blockNumber` and `eth_call` worked, but **every `eth_getLogs` returned HTTP 429** `{"code":-32011,"message":"request limit reached"}`, even for a 10-block range. `web3_sha3` is filtered (-32611). Unusable for logs. | https://docs.base.org/network-information (no rate-limit caveat found on the current page, so the "not for production" claim is UNVERIFIED there; search snippets of older docs.base.org pages say it is rate limited) |
| PublicNode | `https://base-rpc.publicnode.com` (no key) | Live: max **50,000 block range** (`-32701 exceed maximum block range: 50000`) and max **20,000 results** (`-32602 query exceeds max results 20000, retry with the range …`). A per-payTo 50k-block query took about 4 s. 30 days takes about 26 calls per payTo. | live probe |
| Alchemy | `https://base-mainnet.g.alchemy.com/v2/<KEY>` | Free: **10-block** range. PAYG/Enterprise: unlimited for Base. 150 MB response cap. | https://www.alchemy.com/docs/reference/eth-getlogs |
| QuickNode | per-account endpoint | Free Trial: **5 blocks**. Paid: 10,000 blocks. | https://www.quicknode.com/docs/base/eth_getLogs |
| llamarpc | `https://base.llamarpc.com` | Live: HTTP 525 (down) | live probe |

Recommendation: use PublicNode for free, keyless 30-day per-payTo scans, with Alchemy PAYG as a paid fallback.
The free tiers of Alchemy and QuickNode are useless for 30-day log scans.

### Aggregator fallbacks
- **Blockscout** (`https://base.blockscout.com/api/v2/...`, Etherscan-compatible `/api?module=account&action=tokentx`):
  live from this host, every call returned **HTTP 403 Cloudflare "Just a moment..." challenge**, so it is
  unusable without a browser, which we must not bypass. The PRO API needs a key from dev.blockscout.com
  (prefix `proapi_`). Free tier: 5 RPS, 100K credits/day, about 20 credits per call, one key for all chains
  selected via `chain_id=8453`, no credit card. Sources: https://docs.blockscout.com/rate-limits,
  https://docs.blockscout.com/devs/pro-api, https://docs.blockscout.com/make-your-first-call. Base-specific
  coverage on the PRO API is **UNVERIFIED**.
- **Dune API** (`DUNE_API_KEY`): Free plan has 2,500 credits/month. Rate limits are 15 req/min on low-limit
  (execute) endpoints and 40 req/min on high-limit endpoints. Failed executions are charged, and export is 20
  credits/MB. Sources: https://docs.dune.com/api-reference/overview/rate-limits,
  https://docs.dune.com/api-reference/overview/billing, https://docs.dune.com/learning/how-tos/pricing-faqs.
  A single SQL query over `base.logs` joining Transfer and AuthorizationUsed could compute volume for all
  payTos at once. Credit cost per run is **UNVERIFIED**.
- **Etherscan API V2** (`chainid=8453`): whether a free key covers Base is **UNVERIFIED**. The official
  supported-chains page rendered an empty table (https://docs.etherscan.io/supported-chains).

---

## D. Base Sepolia test plumbing

- **Facilitator:** `https://x402.org/facilitator` (also reachable on `www.`). Live `GET /facilitator/supported`
  lists `{"x402Version":2,"scheme":"exact","network":"eip155:84532"}`, `upto` and `batch-settlement` on
  eip155:84532, and v1 `{"x402Version":1,"scheme":"exact","network":"base-sepolia"}`. It also lists Solana
  devnet, Algorand, Aptos, Stellar, Hedera and XRPL testnets. Its EVM signer is
  `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf`. Extensions: `builder-code`, `eip2612GasSponsoring`,
  `erc20ApprovalGasSponsoring`. It exposes no discovery endpoint (404, see A). The docs say it needs no auth or
  setup, that it is the default facilitator in the x402 packages, and that it is "not intended for mainnet
  routes" (https://docs.x402.org/core-concepts/network-and-token-support,
  https://docs.x402.org/dev-tools/facilitators.md).
- **USDC faucet:** https://faucet.circle.com/ (Base Sepolia listed). "Developers can request 20 USDC on testnet
  every 2 hours, per address, and per blockchain." The CDP faucet https://portal.cdp.coinbase.com/products/faucet
  also dispenses USDC (needs a CDP login).
- **ETH faucets** (https://docs.base.org/base-chain/tools/network-faucets):
  - CDP portal faucet gives up to 0.1 ETH per 24 h.
  - Others: https://thirdweb.com/base-sepolia-testnet, https://www.alchemy.com/faucets/base-sepolia (account
    required), https://faucet.quicknode.com/base/sepolia, https://faucet.chainstack.com/ (API key),
    https://ethfaucet.com/networks/base. These are usually limited to one claim per 24 h.
- **Buyer needs no ETH with EIP-3009:** the spec says "The `exact` scheme on EVM executes a transfer where the
  Facilitator (server) pays the gas" and calls EIP-3009 "Recommended (Simplest, truly gasless)"
  (https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md). The docs also say
  "Both methods provide gasless transfers (facilitator sponsors gas)"
  (https://docs.x402.org/core-concepts/network-and-token-support). Exception: Permit2 needs a one-time
  `approve`, which the user pays for unless one of the gas-sponsoring extensions is used. The buyer wallet
  therefore needs only Sepolia USDC. The seller (payTo) needs nothing.

## Keys and accounts the user would need
- None for CDP Bazaar discovery, the x402.org facilitator, or PublicNode RPC.
- A Base-mainnet wallet funded with a few USDC to pay x402scan's $0.01 endpoints (optional, to cross-check volume).
- Optional: `ALCHEMY_API_KEY` (PAYG, needed for wide getLogs), a Blockscout `proapi_…` key, `DUNE_API_KEY`.
- CDP API key ID/secret only if the harness settles through the CDP mainnet facilitator (not needed for measurement).
