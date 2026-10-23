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

## Open decisions for the operator

- Precedence of `overcharge` versus delivery failures (currently severity order; see taxonomy).
- The added `not_paid` outcome (see taxonomy #9).
- Whether to pay overcharged quotes within cap (currently yes, as a naive agent would).
