# Plan

One question, one number: **what share of paid x402 API calls on Base mainnet
fail the buyer, by count and by dollars, and why.** Everything below exists to
make that number correct and auditable.

## Milestones

| # | Milestone | Done when | Money moves? |
|---|---|---|---|
| 1 | Repo, protocol notes, taxonomy, SQLite schema, mock seller, validators + unit tests | `pnpm test` passes against the mock; every outcome and validator has a test | no |
| 2 | `discover` and `probe` against real indexes and real 402 endpoints on mainnet | Sellers/resources tables populated; hourly probes running; first `probe report` after 24 h | no (probing is free) |
| 3 | `buy` and `stress` passing integration tests against the mock seller on a local chain (anvil) or Base Sepolia | Integration suite green; `buy plan` prints planned spend per stratum; **wait for approval** | testnet only |
| 4 | Mainnet `buy` to the approved budget, settlement confirmation, first `report` | `reports/YYYY-MM-DD.md` + JSON with Wilson intervals | yes, capped |
| 5 | `chain` module and market-wide proxy floors | `chain report` for top 60 pay-to addresses over 30 days | no |
| 6 | `@x402-audit/client` wrapper and `telemetry serve` | An operator can follow the README in five minutes; **wait for approval before `npm publish`** | no |

Each milestone ends in a commit whose message names it, and a short summary
here: what runs, numbers so far, exact commands to reproduce.

2026-10-23: the operator approved the plan and the taxonomy decisions as
written, and then asked for all milestones to be built without waiting for
per-milestone approval. The hard stops below are unchanged: no mainnet wallet
is funded or used, and nothing is published to npm, without an explicit yes.

## Hard stops (ask before)

- Creating the repo under an org (it is under `sarmadahsan`).
- Funding or using any mainnet wallet.
- Exceeding any cap.
- Publishing the npm package.
- Adding any dependency that touches keys.

## Architecture

Six small modules behind one CLI (`x402-audit <subcommand>`), all writing to
one SQLite file (`data/audit.sqlite`). Every subcommand defaults to
`--dry-run`. Real money requires `--live` **and** `X402_AUDIT_LIVE=1` **and**
`--network eip155:8453`.

```
src/
  cli.ts                 one entry point, one subcommand per module
  taxonomy.ts            outcome + flag constants (mirrors docs/taxonomy.md)
  config/                env + yaml loading, caps, config hash
  db/                    schema.sql, open(), typed row helpers
  x402/                  thin wrapper over the official client: parse 402, sign, send, expose nonce
  validators/            one file per validator, shared interface
  classify.ts            validator results + settlement facts -> primary outcome + flags
  discover/  probe/  buy/  stress/  chain/  telemetry/
  report/                queries.ts (every reported number has a named query), wilson.ts, render
tools/mock-seller/       local x402 seller + in-memory facilitator, failure modes on demand
config/                  sample.yaml, exclude.yaml, manual-sellers.yaml, schemas/<service>.json
```

### Storage

Single SQLite file, WAL mode, foreign keys on. Key tables (full DDL in
`src/db/schema.sql`):

- `sellers`, `resources`: the universe from Bazaar, x402scan and the manual list.
- `probes`: every unpaid 402 capture, both client identities.
- `attempts`: **append-only** (triggers forbid UPDATE/DELETE). A row is written
  *before* signing, so a crash can never lose track of money that may have moved.
- `calls`: one row per paid or attempted call with the full request, response
  (body up to 2 MB plus SHA-256), settlement header, tx hash, latency, outcome,
  flags, `source` (`buy` | `stress_duplicate` | `stress_timeout`).
- `validator_results`: one row per validator per call, with evidence JSON.
- `settlements`: every on-chain settlement matched to an intent (more than one
  row per intent is how `duplicate` is detected).
- `halts`: why a run stopped.
- `chain_transfers`, `telemetry_calls`: modules 5 and 6.
- `runs`: subcommand, args, config hash, network, dry-run flag.

### Sampling design (module 3)

Strata: seller tier (top 20 by 30-day volume, random 40 from the tail) by
category (inference, data, scraping, compute, other). Target about 3,000 paid
calls, weighted toward cheap resources.

Why 3,000. With a 95% Wilson interval:

| true failure rate | half-width at n = 3,000 | half-width at n = 300 (one stratum) | half-width at n = 30 (one seller) |
|---|---|---|---|
| 2% | ±0.50 pp | ±1.69 pp | ±7.2 pp |
| 5% | ±0.78 pp | ±2.52 pp | ±9.0 pp |
| 10% | ±1.07 pp | ±3.41 pp | ±11.1 pp |
| 20% | ±1.43 pp | ±4.51 pp | ±13.9 pp |

Calls needed for a given half-width (reproduce with `x402-audit samplesize --rate p --halfwidth h`):

| rate | ±1 pp | ±1.5 pp | ±2 pp | ±3 pp | ±5 pp |
|---|---|---|---|---|---|
| 2% | 800 | 380 | 230 | 120 | 60 |
| 5% | 1,840 | 830 | 470 | 220 | 90 |
| 10% | 3,470 | 1,540 | 870 | 390 | 150 |
| 20% | 6,150 | 2,740 | 1,540 | 690 | 250 |

So 3,000 calls gives about ±1 pp on the headline at any plausible rate, about
±3 pp per stratum if the ten strata are roughly equal, and the "at least 30
calls" rule for the per-seller table gives ±10 pp per seller, which is enough
to separate a 5% seller from a 40% seller but not a 5% from a 10%. The report
says so.

Spend. At a mean price of $0.05 per call, 3,000 calls is $150; at $0.10 it is
$300. The sampler weights toward resources priced at or under $0.05 and refuses
to start if the planned spend exceeds `MAX_TOTAL_USD` (default 300). Per-call
cap `MAX_PER_CALL_USD` default 0.50.

### Caps (enforced in code before any signature)

`MAX_PER_CALL_USD`, `MAX_PER_SELLER_PER_DAY_USD`, `MAX_PER_DAY_USD`,
`MAX_TOTAL_USD`. Any breach halts the run and writes a `halts` row. The `halt`
file in the repo root stops every loop within one iteration.

### Settlement confirmation

After every call: look for the USDC `Transfer` from our wallet to the pay-to
address in the block range since signing, matched on amount and on the
EIP-3009 nonce via the `AuthorizationUsed` event (see
`docs/protocol-notes.md`). Not found within 10 minutes: `indeterminate`, keep
polling in the background for 24 h.

## Order of work inside milestone 1

1. Protocol notes from source (done by reading `coinbase/x402` at a pinned commit).
2. Taxonomy doc and constants, with a test that they agree.
3. SQLite schema.
4. Validator interface and the eight validators, each with unit tests.
5. Classifier (validator results + settlement facts -> outcome + flags), with a test per outcome.
6. Mock seller with every failure mode on demand, and an in-memory facilitator.
7. End-to-end local test: mock seller -> harness client -> validators -> classifier -> DB row.

## Milestone 1 status (2026-10-23)

Done. Everything runs locally against the mock seller; no network, no keys, no money.

- `pnpm test`: 176 tests in 18 files. Taxonomy constants are checked against
  `docs/taxonomy.md`; every validator has pass/fail/skipped tests; every
  outcome and flag has a classifier test; the official client wrapper is tested
  against a throwaway HTTP seller; the mock seller is paid by a real
  `@x402/fetch` client; and `test/e2e-mock.test.ts` drives each mock failure
  route through client, ledger, validators, settlement lookup, classifier and
  SQLite, asserting the designed outcome.
- Protocol facts were read from `coinbase/x402` at `0e6e8c5` (2026-10-15) and
  index facts from live docs and probes on 2026-10-23; see `docs/protocol-notes.md`.
- Findings that shape milestone 2+:
  - CDP Bazaar discovery is public, keyless, ~37.9k resources, all v2; it gives
    30-day call counts per resource but not USDC volume.
  - x402scan's per-merchant volume endpoint is paid ($0.01 per 100 rows, via
    x402 on Base mainnet), so even the cross-check is a mainnet purchase.
  - Per-payTo 30-day volume therefore comes from chain logs (USDC `Transfer`
    joined to `AuthorizationUsed` in the same tx; publicnode RPC allows
    50k-block log queries; `mainnet.base.org` returns 429 for `eth_getLogs`).
  - The reference express middleware settles only after a successful handler,
    so "500 after settlement" needs a seller using the `upfront` flow or a
    non-reference implementation; the mock settles upfront.
  - Permit2 and non-`exact` requirements are excluded from buying; the client
    wrapper signs only EIP-3009 authorizations.

## Milestone 2 to 6 build status (2026-10-24)

All module code exists and is tested locally (306 tests, including an anvil
integration suite for `buy`, `stress`, settlement confirmation and the
indeterminate resolver). Live status per milestone:

- M2 `discover`: run live against CDP Bazaar (37,903 resources, 2,649 sellers).
  `chain scan-volume` over 30 days ranks sellers by real USDC volume; `probe`
  runs hourly once the ranking exists.
- M3 `buy`/`stress`: integration-tested on anvil with a real EIP-3009 token and
  real settlement confirmation; **no mainnet wallet has been funded or used**.
- M4: waits for the operator's approval of `buy plan` output and wallet funding.
- M5 `chain`: volume scan live; verification sampling and proxy report wired.
- M6 `@x402-audit/client` + `telemetry serve`: built and tested; **unpublished**
  (a `prepublishOnly` guard refuses without `X402_AUDIT_PUBLISH_APPROVED=1`).

## Milestone 2 numbers (2026-10-24, first hours)

- `discover run`: 37,903 unique resources (38 index pages, 2 duplicates, 0 parse
  rejects), 2,649 seller domains, 37,563 Base-exact resources, 0 permit2,
  340 with no Base-exact option. Categories: data 23,089, other 8,457,
  inference 2,645, scraping 2,023, compute 1,689.
- `chain scan-volume --days 30`: blocks 51,712,495 to 53,008,495, 1,707
  pay-to addresses, 1,292,210 USDC transfers stored, 460 RPC calls, 71 min on
  publicnode. 1,617 canonical sellers ranked; 1,032 domains are shadows that
  share a pay-to with a higher-traffic domain (staging hosts, mirrors, and a
  domain literally named `jev-x402-evil.vercel.app` sharing a pay-to with
  `jev-x402.vercel.app`). Top seller by volume: api.bitrefill.com at about
  $607k over 30 days; the Bazaar call-count ranking and the dollar ranking
  disagree sharply (ax1.vc has 443k transfers but $8.9k).
- `probe plan`: 60 top sellers + 40 seeded tail resources (seed 20261023).
- First two probe rounds: 200 requests each from identities A and B;
  183 then 192 returned a 402; 2 then 6 quotes exceeded the Bazaar-listed
  price (three resources, 1.6x to 2.5x, identical for both identities, so not
  discrimination: either stale listings or real overcharge, which the 7-day
  modal reference will separate); no pay-to changes, no price discrimination,
  no 429s. The hourly loop is running (`data/probe-loop.log`).
- `buy plan` (dry-run): 2,904 of 3,000 target calls across 57 sellers and
  374 resources for about $42 USDC. Two single-seller strata (top/compute and
  tail/scraping) carry $36 of it because their prices are $0.05 to $0.06.

Reproduce:

```bash
pnpm cli --db data/audit.sqlite --network eip155:8453 discover report --top 100
pnpm cli --db data/audit.sqlite --network eip155:8453 chain top --n 60
pnpm cli --db data/audit.sqlite --network eip155:8453 probe report
pnpm cli --db data/audit.sqlite --network eip155:8453 buy plan
```

## Approval record

- 2026-10-24: operator approved the mainnet buy plan as printed by `buy plan`
  (about 2,904 calls, about $42 USDC, seed 20261023, caps as in `.env.example`:
  per call 0.50, per seller per day 20, per day 100, total 300). Wallet funding
  is manual by the operator. The live run starts only on the operator's
  explicit go, with `--live`, `X402_AUDIT_LIVE=1`, `--network eip155:8453`,
  and a passing integration suite recorded by `pnpm gate` for the current commit.

## Open decisions for the operator

- Precedence of `overcharge` versus delivery failures (currently severity order; see taxonomy).
- The added `not_paid` outcome (see taxonomy #9).
- Whether to pay overcharged quotes within cap (currently yes, as a naive agent would).
