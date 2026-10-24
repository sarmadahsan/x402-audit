# Deliberately not built

If a feature is not needed to compute or audit the failure rate, it is left
out. This file records those decisions so nobody mistakes an omission for an
oversight.

| Not built | Why |
|---|---|
| Payments product, wallet product, escrow | Non-goal. The harness only spends from a manually funded pool. |
| Reputation scoring of sellers | Non-goal. The report lists failure rates with confidence intervals; it does not rank "trust". |
| Dashboard / web UI | Non-goal. Output is a markdown report with a JSON twin and SQL queries. |
| Multi-tenant anything | Non-goal. One SQLite file, one operator. Telemetry sources are a column, not tenants. |
| Automatic retries in `buy` | Retries are the thing under test in `stress`; retrying in `buy` would hide `indeterminate` and `duplicate`. |
| Automatic wallet funding | Money movement into wallets is manual and documented, so the harness can never be the thing that drains an account. |
| Migrations framework | The schema is created once from `src/db/schema.sql`; a schema change means a new database file and a note in the report's reproducibility section. |
| Generic HTTP client abstraction | We wrap the official x402 fetch client once and log around it. |
| Non-EVM schemes (Solana `exact`, etc.) | The question is about Base mainnet USDC. Other networks are recorded by `discover` but never probed or bought. |
| Non-`exact` schemes (`upto`, deferred, etc.) | Same reason. Resources whose only accepted scheme is not `exact` on `eip155:8453` are stored and excluded from sampling, with a count in the report. |
| Package publishing automation | `@x402-audit/client` is published by hand after explicit approval. |
| Clever concurrency | One paid call per resource per minute, sequential within a seller. Slow is fine; a few thousand calls over weeks is the budget. |
| x402scan as a discovery or volume source | Every x402scan API endpoint is itself a paid x402 call ($0.01 per 100 rows on Base mainnet), and its terms forbid scraping the free frontend. Using it would be a mainnet purchase. The universe comes from the keyless CDP Bazaar index; 30-day volume is computed from chain logs. A paid cross-check can be added later with explicit approval. |
| Full AuthorizationUsed join for every transfer | Verifying every USDC transfer to 1,700 pay-tos needs one receipt fetch per transaction (hundreds of thousands of RPC calls). The chain module verifies a seeded random sample per top pay-to (with a Wilson interval on the EIP-3009 share) and fully verifies the subsets that drive the duplicate and overcharge proxies. |
| Per-resource exclusion column | `config/exclude.yaml` resource prefixes are applied at selection time by `probe` and `buy` through `isExcluded()`; a seller is marked excluded only when every resource matches. A column on `resources` would duplicate the YAML. |
| Buyer-identity header on unpaid probes | The protocol exposes no buyer wallet on the unpaid request, so price discrimination is probed with two User-Agents only, and the report says so. |
| Telemetry for unpaid calls | `@x402-audit/client` wraps outside the payment client and reports only calls that carried a payment header or a settlement response header; it cannot see the inner 402. |
| Mock seller as a real facilitator | The mock facilitator settles in memory (milestone 1) and against anvil (milestone 3). It never talks to a real chain. |
