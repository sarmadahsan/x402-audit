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

### Caps for continuous running (2026-10-29)

The mechanism is unchanged (every cap is read from the database and checked
before every signature); values and granularity change:

- Scheduled runs pass `--per-call-usd 0.10`. A run may lower
  `MAX_PER_CALL_USD` (0.50 on the audit host), never raise it.
- `config/expensive-sellers.yaml` lists five high-volume sellers whose modal
  quote is above 0.10 (top five by 30-day inflow), each with its own per-call
  cap and at most three purchases a week. A run adds at most one call per
  listed seller; its cap is clamped to `MAX_PER_CALL_USD`, so the list can
  never raise a cap.
- Any resource that quotes above the cap that applies to it is recorded
  `too_expensive` with the amount (`resource_states`, exported as
  `too_expensive.json`), whether seen in a listing, a probe or a live quote.
- Audits keep their own caps: 5 USDC and 10 sellers per UTC day over the audit
  sources, 10 calls per seller, per-call cap `MAX_PER_CALL_USD` unchanged.
- `MAX_TOTAL_USD` counts scheduled buys and audits together.

### Audits (2026-10-29)

`audit-triggers` runs after the 12:00 UTC scheduled run. It reads the index's
`/v1/reported` and `/v1/demand` and triggers a seller when (a) the reported
series is mature and the two 95% intervals do not overlap, (b) the reported
series is mature and we have under 30 measured calls, (c) operators report
above 10% failures on a seller we mark ok, or (d) the seller is in the top 20
of 7-day demand with under 30 measured calls or none in 14 days.
Disagreements go first, then demand, then the rest. Every decision is written
to `audit_triggers` with its inputs before any spend. A planned audit is up to
10 paid calls round-robin over the seller's known resources and wallets,
source `audit_disagreement` or `audit_demand`, no retries; the result is
posted to the index (`docs/audit-callback.md`). Nothing is bought unless
`AUDIT_TRIGGERS_ENABLED=1` as well as `--live` and `X402_AUDIT_LIVE=1`.

### Schedule (2026-10-29)

`scripts/loop.sh` under systemd (`paidfor-audit.service`, one long-running
unit; no timer): every hour a probe round, settlement re-checks and an export.
At 00:00, 06:00, 12:00 and 18:00 UTC a scheduled run replaces the old daily
buy: the free candidate import, then `buy run --live` with a seed per run
(date and hour), `--budget-usd 1.00 --run-usd 1.00 --per-call-usd 0.10
--runs-per-day 4 --day-budget-usd $LOOP_DAILY_USD --expensive --candidates`.
Per-seller caps are `MAX_PER_SELLER_PER_DAY_USD` divided by four per run;
`MAX_PER_DAY_USD` stays the all-sources backstop and `LOOP_DAILY_USD` the
scheduled-buy budget for the day. A fresh seed per run spreads each seller's
calls across runs. `audit-triggers` runs after the 12:00 run only. Every run
ends with an export and publish. On first start the loop waits for the next
boundary instead of buying at deploy time. `scripts/loop.sh dry-run-buy` and
`dry-run-audit` print what the next run would do without spending.

### Candidates (2026-10-29)

`discover import-candidates` reads the index's `/v1/candidates` (a logged
no-op while it answers 404), adds unknown resource URLs with `source = user`,
probes each once without paying and classifies `queued`, `too_expensive` or
`not_x402`. Queued candidates get one call per scheduled run in their own lane
(`buy run --candidates`), only when `CANDIDATE_BUYS_ENABLED=1`; they never
enter the stratified plan.

### Coverage-first allocation (2026-10-29): finish and admit lanes

The per-run random draw kept landing on sellers we already knew (after the
first day of six-hourly runs: 363 sellers reached, 95 at 30 or more
denominator calls, the top ten taking a third of all calls). Scheduled runs
now pass `--allocation coverage` (`src/buy/allocate.ts`). First deployed the
same day as fewest-first; replaced within hours (operator's decision,
2026-10-29) because with 646 sellers below 30, 401 of them never bought,
fewest-first spread one call each over sellers nobody asks about and raised
the measured count for nobody.

- Budget: the run budget (`--budget-usd`, 1.00) with 5% headroom, less the
  expensive and candidate lanes. `COVERAGE_SHARE` (0.7) of it is coverage.
- Finish lane (70% of coverage): sellers with 1 or more calls below their
  target, closest to the target first, at most 4 calls per seller per run.
  This is what makes `sellers_with_min_calls` rise within a day.
- Admit lane (30% of coverage, plus whatever finish leaves): zero-call
  sellers, ranked by external demand this week (checks from the skill, MCP
  and client-library channels only, so our own harness and bare API calls
  never rank a seller), then price ascending, then 30-day on-chain inflow,
  then a seeded random key. A fifth of the lane's budget is reserved for the
  highest-inflow sellers not yet admitted (one call each, in inflow order,
  skipping any that do not fit), so volume sellers are not starved by the
  cheap breadth; what the reserve leaves goes to the price queue. (Reserved by
  calls, one in five, the volume sellers' quotes took 88% of the lane.) Each admitted seller takes at most 2 calls a run. Until
  `/v1/demand` splits each host's checks by channel, demand is not used.
- Targets: 30 calls for sellers first bought before 18:00 UTC on 2026-10-29
  (`COVERAGE_TIERS_SINCE`), sellers in the top 50 by 30-day inflow, sellers
  in demand this week, sellers on `config/expensive-sellers.yaml` and user
  candidates (demand here is external demand too); 5 calls for every other newly admitted seller, enough to
  appear as `low_sample` with an honest interval.
- Maintenance (the rest): sellers at or past their target, a weighted draw
  without replacement by 30-day inflow with a floor
  (`MAINTENANCE_INFLOW_FLOOR_USD`, 100), at most 2 calls per seller per run.
- Plan sizing: every call is priced at its quote, the modal paid quote of the
  last 7 days or else the latest 402 probe, and budgeted at that quote x1.2.
  The listing price is never used: sellers quoting above their listing is the
  overcharge behaviour we measure, and trusting listings is what ended the
  12:17 UTC run of 2026-10-29 on its cap. A seller with no quote at all is
  not planned. No seller plans more than 15% of the run, and the per-seller
  per-run limit checked before every signature is the lower of
  `MAX_PER_SELLER_PER_DAY_USD`/4 and 15% of `LOOP_RUN_USD`.
- A seller is eligible while one resource quotes at or under the scheduled
  cap; calls rotate over its cheapest resources (within twice the cheapest
  quote). Only sellers with no such resource keep `too_expensive` rows.
- A resource whose last three attempts were `not_paid` or `our_error` sits
  out 48 hours (logged, a `backoff` row, never deleted).
- Every planned call and back-off is a `run_allocations` row (run, seller,
  resource, pool `finish|admit|maintenance|expensive|candidate|breadth|backoff`,
  planned calls, reason, planned USDC) written before the first signature,
  dry runs included. Calls go out in plan order: finish, admit, maintenance.
- A run ended by its own budget (`cap_per_run`, `cap_buy_day_budget`,
  `cap_audit_per_day`) finishes with status `cap_reached`; `halted` keeps
  meaning the halt file, an error, or a backstop cap (`MAX_PER_DAY_USD`,
  `MAX_TOTAL_USD`).

`buy projection` costs the tiered targets and simulates the lanes run by run
at today's caps and at a second daily budget (`--alt-day-budget-usd`).
`buy plan` and `buy run` without `--allocation` keep the stratified study
design.

### Breadth run (2026-10-29)

`buy run --breadth` (`scripts/loop.sh` after the 12:00 run on
`LOOP_BREADTH_WEEKDAY_UTC`, Monday by default): one call per seller with no
resource at or under the scheduled cap, on its cheapest resource at or under
`BREADTH_MAX_PER_CALL_USD` (0.50, clamped to `MAX_PER_CALL_USD`), ordered by
30-day inflow then fewest calls, under `BREADTH_WEEKLY_USD` (10) over any 7
days (source `breadth`; the per-run limit is what is left of the week). Sellers
on `config/expensive-sellers.yaml` keep their own lane. Buys only with
`BREADTH_RUN_ENABLED=1` on top of every live gate; otherwise it records a dry
run with its plan. Breadth rows count in the headline (docs/taxonomy.md).

### Discovery (2026-10-29)

`discover refresh` runs after the 00:00 run (docs/discovery.md): Bazaar
recrawl, `config/seed-sellers.yaml`, and Base payees of facilitator
settlements in the last 24 hours that no known seller claims
(`unmapped_payees`, with 30-day inflow). New sellers get tier NULL, one
resource in the probe set, and the coverage pool of the next run. No purchase
happens in refresh. `discover import-candidates` now runs after every
scheduled run.

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

## Milestone 4 phase 1 (2026-10-24 20:25 to 2026-10-25 08:19 UTC)

Report: `reports/phase1-2026-10-25.md` (+ `.json`), probes `reports/probe-2026-10-25.md`,
stress `reports/stress-2026-10-25.md`, chain `reports/chain-proxy-2026-10-24.md`.

- 2,305 buy calls to 48 sellers; 2,018 settlements; 18.31 USDC in the dollar
  denominator; wallets funded 58 USDC, 39.6 left before phase 2.
- Headline (buy only): **6.7% of paid calls failed the buyer, 95% CI 5.7% to
  7.9%, n = 1,997; 3.4% dollar-weighted (CI 2.1% to 5.4%)**. Failures are
  almost all `non_delivery` (paid, then 4xx or no response within the seller's
  own declared window); 3 `overcharge`; 0 `wrong_goods` (no per-service schemas
  yet, so every row is `schema_missing`); 0 `duplicate` in the main sample.
- Reported separately: 198 `our_error` (listings we could not form a valid
  request from: empty body examples), 71 `not_paid` (seller never produced a
  payable 402, or rejected before settling), 0 `indeterminate`.
- Stress: 5 of 10 sellers settled a second fresh signature for the same intent;
  2 of 10 settled despite the connection being dropped after 2 s, and the naive
  retry then double-charged on 5 of 10.
- Operational fixes applied during the run (all audited in `reclassifications`,
  30 rows): empty `mimeType` false `non_delivery`, bodiless POSTs, 402-wrapped
  validation errors, injection pattern false positive, never-paid rows.

## Phase 2 (started 2026-10-25 08:19 UTC)

Operator asked to use the remaining funds for a wider, more diverse sample.
`config/sample.yaml` now targets 6,000 calls (about 31 USDC) across the top 20
sellers and 300 random tail sellers (317 sellers, 2,378 resources), with at
most 150 calls per seller and tier-level redistribution. Phase 1's config is
kept as `config/sample-phase1.yaml`. The probe set was widened to 60 + 300.
`buy run --resume-since 2026-10-25T08:19:27Z` keeps phase-1 calls out of the
phase-2 allocations; the report can be cut at that boundary with `--since`.

## Phase 2 results (2026-10-25 08:19 to 20:33 UTC)

Report: `reports/phase2-2026-10-25.md` (+ `.json`). 7,428 paid calls in the
denominator across about 300 sellers (the probe set was widened mid-phase to
660 resources, so the plan absorbed more sellers than the 317 it started with).
**Headline: 6.3% of paid calls failed the buyer, 95% CI 5.7% to 6.8%; 8.8%
dollar-weighted (CI 7.4% to 10.3%) on 31.00 USDC.** Reported separately:
677 `not_paid`, 281 `our_error`, 15 `indeterminate`. The dollar-weighted rate
is higher than phase 1 because the wider tail quotes above its listing more
often (`overcharge` rows are paid in full and count as failures).

Operational fixes during phase 2 (all gated and tested): concurrency-safe
settlement wait, receipt-first confirmation from the seller's tx hash, a
2-minute inline cap on no-response waits (resolver owns the rest), exception
guards so a paid call can never be lost, parked sellers on their daily cap,
balance-aware wallet rotation, and the index fix that took throughput from
1.5 to 18 calls per minute.

## Phase 3 (operator instruction, 2026-10-25 17:40 UTC)

"Just continue running and gathering data until all the wallets run out."
After phase 2 exhausts its plan, further plans are sized to the remaining
pool balance (minus a few cents per wallet so the last calls do not fail on
balance), with the probe set widened again (top 60 + 600 tail) so each plan
reaches more sellers. Each phase has its own boundary timestamp and report.

## Final results (pool exhausted 2026-10-26 00:19 UTC)

Reports: `reports/combined-2026-10-26.md` (+ `.json`, every number from a
named query), per-phase reports `phase1-2026-10-25.md`, `phase2-2026-10-25.md`,
`phases3to6-2026-10-26.md`, plus probe, stress and chain-proxy reports.

- 14,580 paid-call attempts to 362 sellers over 2026-10-24 20:25 to
  2026-10-26 00:19 UTC; 57.96 USDC of the 58 funded settled on-chain (the rest
  is dust below the per-wallet safety margin).
- **Headline (all phases): 6.6% of paid x402 calls on Base failed the buyer,
  95% CI 6.2% to 7.1%, n = 12,805 calls in the denominator; 7.8%
  dollar-weighted (CI 6.7% to 9.0%) on 57.65 USDC.** Phase 1 (top-volume
  heavy sample) 6.7%; phase 2 (wide tail) 6.3%; phases 3 to 6 (same wide set,
  later in the day) 7.3%, with a higher dollar-weighted rate (13.7%) because
  overcharges concentrate in a few pricier tail sellers.
- Reported separately: `not_paid`, `our_error` and 16 `indeterminate` rows
  (no settlement ever appeared; they become `not_paid` after 24 h).
- Stress: 5 of 10 sellers double-settled one intent; 2 of 10 settled after a
  dropped connection, and a naive retry then double-charged on 5 of 10.
- Chain proxy floors (top 60 pay-tos, 30 days, share-adjusted): overcharge
  proxy 14.7% of transfers, isolated duplicate pairs 0.15%.

Reproduce the headline:

```bash
pnpm cli --db data/audit.sqlite --network eip155:8453 report --stdout
```

## Open decisions for the operator

- Precedence of `overcharge` versus delivery failures (currently severity order; see taxonomy).
- The added `not_paid` outcome (see taxonomy #9).
- Whether to pay overcharged quotes within cap (currently yes, as a naive agent would).
