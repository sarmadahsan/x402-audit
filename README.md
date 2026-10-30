# x402-audit

The harness behind [paidfor.dev](https://paidfor.dev). It is published so that
anyone reading the study, including the sellers it names, can check how we
measured.

## The question

Of paid x402 API calls on Base mainnet, what share fail the buyer, by count and
by dollars, and why?

## The answer, for the study window

From 2026-10-24 20:25 UTC to 2026-10-26 00:19 UTC, across 12,992 paid calls to
362 sellers (95% Wilson intervals):

| measure | denominator | failures | rate |
|---|---|---|---|
| count-weighted | 12,992 paid calls | 859 | 6.6% [6.2%, 7.1%] |
| dollar-weighted | 57.92 USDC | 4.51 USDC | 7.8% [6.8%, 9.0%] (Kish effective n = 2,237) |

The full report is [docs/FINAL-REPORT.md](docs/FINAL-REPORT.md), including its
2026-10-28 revision and the 2026-10-29 corrections at the end. The figure on
paidfor.dev is a rolling one over a wider sample and is not this number.

## What is in this repository

- **probe** (`src/probe/`): unpaid 402 quotes, hourly, from two client identities.
- **buy** (`src/buy/`, `src/pipeline/paidCall.ts`, `src/x402/`): the one paid-call
  path. A ledger row is written before signing, caps are checked before
  signing, and all signing goes through the official `@x402/*` client.
- **validators** (`src/validators/`): eight checks on every response. A check
  with no configuration returns `skipped`, never `pass`.
- **taxonomy** (`src/taxonomy.ts`, [docs/taxonomy.md](docs/taxonomy.md)): one
  primary outcome per call, the precedence rule, the overcharge rule and its
  reference price. A test fails if the code and the document disagree.
- **chain matching** (`src/chain/`): each payment is matched to its USDC
  settlement on Base by the EIP-3009 nonce we signed.
- **stats** (`src/report/`): Wilson intervals, the Kish effective sample size
  for the dollar rate. Every reported number names its SQL query in
  `src/report/queries.ts`.
- **export** (`src/export/`): the files published to the public data repository.
- **mock seller** (`tools/mock-seller/`): a local x402 seller that produces
  every failure mode on demand, with an optional local chain.

Background documents: [docs/PLAN.md](docs/PLAN.md),
[docs/protocol-notes.md](docs/protocol-notes.md),
[docs/commands.md](docs/commands.md), [docs/NOT-BUILT.md](docs/NOT-BUILT.md).

What is not in this repository: no wallets or keys, no database, no logs, and
no server configuration. The per-call evidence that the study and the index
use is published separately in
[sarmadahsan/paidfor-data](https://github.com/sarmadahsan/paidfor-data).

## Reproducing against the mock seller

Requirements: Node 22 or later and pnpm 10. Foundry's `anvil` is optional; the
local-chain suite is skipped without it.

```bash
pnpm install
pnpm test                 # taxonomy and document agreement, validators, classifier, statistics, and an end-to-end run through every mock-seller route
pnpm mock-seller          # the mock seller on port 4402, to call by hand
pnpm cli status           # effective configuration, caps and the live gate
```

The report commands from the report's reproducibility section run against any
database the harness has written; on a database of your own they recompute the
same tables:

```bash
pnpm cli --db data/audit.sqlite --network eip155:8453 report --stdout
pnpm cli --db data/audit.sqlite --network eip155:8453 chain report --top 60
pnpm cli --db data/audit.sqlite --network eip155:8453 probe report
pnpm cli --db data/audit.sqlite --network eip155:8453 stress report
```

Every command is a dry run by default, and the default network is Base Sepolia.
Mainnet payments need all three gates on every invocation: the `--live` flag,
`X402_AUDIT_LIVE=1` in the environment, and `--network eip155:8453`. A live run
also needs a passing `pnpm gate` recorded for the current commit on a clean
tree. These caps are enforced in code before any signature (defaults, in USD):
0.50 per call, 20 per seller per day, 100 per day, 300 in total, and 30 for
the stress tests. [.env.example](.env.example) lists every setting.

## Responsible use

Running this against real sellers spends real money and produces claims about
named businesses. Run it against the mock seller first, keep the caps low, and
read [docs/taxonomy.md](docs/taxonomy.md) before publishing anything. A result
is a measurement of what a naive buyer experienced, not a finding of intent.
Sellers named on paidfor.dev have a right of reply: each seller page says how,
and replies sent to reply@paidfor.dev are published verbatim on that page.

## Status

This repository is published for review. It does not take support requests.
Issues are open only for factual errors in the method.

## Links

- [paidfor.dev](https://paidfor.dev)
- [Methodology](https://paidfor.dev/methodology)
- [Public data](https://github.com/sarmadahsan/paidfor-data)
