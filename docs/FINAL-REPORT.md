# x402 Buyer Failure Rate on Base Mainnet: Final Report

> **Revision 2026-10-28.** The report's queries matched only the network id
> `eip155:8453`, so 188 purchase calls (and 4 stress calls) to sellers that
> quote the x402 v1 name `base` for the same chain (Base mainnet) were left out
> of every rate: api.slamai.dev
> (171 calls, a top-20 seller by volume), slamlink-ai-main-50fbb45.d2.zuplo.dev
> (10), uxus.finance (5) and x402factory.ai (2). The queries now treat `base`
> and `eip155:8453` as one network; no stored row was changed. The original
> limitations section predicted a shift under 0.1 point; the count rate moved
> 0.01 point.
>
> | measure | before | after |
> |---|---|---|
> | denominator | 12,805 | 12,992 |
> | count-weighted failures | 848 | 859 |
> | count-weighted rate | 6.62% [6.20%, 7.07%] | 6.61% [6.20%, 7.05%] |
> | dollar-weighted base, failed | 57.65, 4.48 USDC | 57.92, 4.51 USDC |
> | dollar-weighted rate | 7.76% [6.72%, 8.95%] | 7.79% [6.75%, 8.98%] |
> | Kish effective n | 2,217 | 2,237 |
> | non_delivery | 498 | 509 |
> | overcharge at 2x only | 6.2% [5.8%, 6.7%] | 6.2% [5.8%, 6.6%] |
> | charged_then_rejected | 140 | 143 |
> | client timeouts before declared window | 3 | 9 |
> | top tier | 3,837, 10.1% [9.2%, 11.1%] | 4,007, 9.8% [8.9%, 10.8%] |
> | tail tier | 3,861, 4.6% [3.9%, 5.3%] | 3,871, 4.5% [3.9%, 5.2%] |
> | unassigned tier | 5,107, 5.6% [5.0%, 6.2%] | 5,114, 5.7% [5.1%, 6.3%] |
> | data category | 3,237, 6.1% [5.3%, 6.9%] | 3,419, 6.0% [5.2%, 6.8%] |
> | inference category | 2,871, 5.0% [4.2%, 5.8%] | 2,876, 5.1% [4.3%, 5.9%] |
> | phases 1 / 2 / 3 to 6 (denominator) | 1,997 / 7,428 / 3,380 | 2,035 / 7,548 / 3,409 |
>
> Phase rates, the seller counts (362 reached, 93 with at least 30 calls, 69 of
> them with no failure) and the worst-ten table do not change; those counts in
> the original text already included the v1 rows. api.slamai.dev now qualifies
> for the 30-call seller set. The interval half-width in 2.5 is corrected to
> ±0.43 (it was 0.43 before this revision too).

Study window: 2026-10-24 20:25 UTC to 2026-10-26 00:19 UTC (purchases), with
discovery, on-chain measurement and probing from 2026-10-24 01:40 UTC to
2026-10-26 07:13 UTC. Repository: `sarmadahsan/x402-audit` (private), commit
range `cc2d284` to `12e26a3`, 68 commits, 329 automated tests in 38 files.
Database: `data/audit.sqlite` (one file; every number below is a query over it).

## 1. The question and the answer

**Question.** Of paid x402 API calls on Base mainnet, what share fail the
buyer, by count and by dollars, and why?

**Answer.** Across 12,992 paid calls that count in the denominator:

| measure | denominator | failures | rate [95% Wilson CI] |
|---|---|---|---|
| count-weighted | 12,992 paid calls | 859 | **6.6% [6.2%, 7.1%]** |
| dollar-weighted | 57.92 USDC | 4.51 USDC | **7.8% [6.8%, 9.0%]** (Kish effective n = 2,237) |

Failures split into two kinds. `non_delivery` (509 calls, 59% of failures):
the seller settled the payment on-chain and then returned a 4xx or 5xx, an
empty or wrong-typed body, or nothing at all within its own declared timeout.
`overcharge` (350 calls, 41%): the seller's 402 quote exceeded the price it
lists in the Coinbase Bazaar index, and the harness paid it as a naive agent
would. No `wrong_goods` could be assessed (no per-service response schemas
were configured) and no `duplicate` settlement occurred in the main sample.

The rate is robust to how strictly overcharge is defined: counting an
overcharge only at 1.1x the listed price gives 6.4% [6.0%, 6.8%]; only at 2x
gives 6.2% [5.8%, 6.6%]. Most overcharges were not marginal: of 350, 175 were
2x to 5x and 124 were 5x or more the listed price, concentrated in nine
sellers.

Reported separately and never in the denominator: 976 `not_paid` (the seller
never produced a payable 402, or rejected the payment before settling; no
money moved), 597 `our_error` (listings from which no valid request could be
formed; no money moved except 143 cases described below), and 15
`indeterminate` (payment signed, no response, no settlement visible within
24 hours).

## 2. Design

### 2.1 Failure taxonomy

Every paid or probed call receives exactly one primary outcome and zero or
more secondary flags (`docs/taxonomy.md`; a unit test fails if the code's
constants drift from the document). Primary outcomes, in precedence order
(first match wins; ties resolved toward the outcome that loses the buyer the
most money): `our_error`, `not_paid`, `indeterminate`, `duplicate`,
`non_delivery`, `wrong_goods`, `overcharge`, `injection`, `ok`.

The paid denominator is `ok`, `overcharge`, `non_delivery`, `wrong_goods`,
`injection`, `duplicate`. Headline failures are `overcharge`, `non_delivery`,
`wrong_goods`, `duplicate`. `injection` (text addressed to an agent in a
response body) is flagged for human review and reported separately; after
tightening the scanner to address forms only, zero rows carry it.

`not_paid` was added to the operator's eight original outcomes because "paid
nothing, got nothing" had no home and folding it into `non_delivery` would
have overstated dollar losses. The operator approved this on 2026-10-24.

### 2.2 Reference price for overcharge

In order of preference: the price listed in the Bazaar index for the
resource; else the modal quote seen by the probe module over the last 7 days;
else the first quote ever observed. All 350 overcharge rows used the Bazaar
listing. The quote-to-reference ratio is stored on every row.

### 2.3 Validators

Eight pluggable validators run on every delivered response and store
machine-readable evidence: `http_status`, `non_empty`, `content_type`,
`not_truncated`, `json_schema`, `entity_matches`, `freshness`,
`injection_scan`. A validator with no configuration returns `skipped`, never
`pass`; because no per-service schemas were written, every row carries the
`schema_missing` flag and `wrong_goods` is unmeasured (see Limitations).
Validator failures in the study: `http_status` 1,694, `content_type` 241,
`not_truncated` 16, `non_empty` 4.

### 2.4 Settlement confirmation

After every paid call the harness looked for the USDC `Transfer` from its
wallet to the pay-to address whose transaction also carries an
`AuthorizationUsed(authorizer, nonce)` log matching the nonce it signed
(EIP-3009 `transferWithAuthorization`). From phase 2 on, the seller-reported
transaction hash was verified first by receipt on the canonical RPC, falling
back to a log scan. 12,955 settlements were matched this way, 57.96 USDC.

### 2.5 Sampling and statistics

Stratified by seller tier (top 20 by 30-day on-chain volume versus a seeded
random tail) and category (inference, data, scraping, compute, other), with
calls weighted toward cheap resources, at most 10 resources and 150 calls per
seller per plan, and one call per resource per minute. Six plans ran in
sequence as the operator asked for more diverse data and then to spend the
pool down: phase 1 (top 20 + 40 tail sellers), phase 2 (top 20 + 300 tail,
widened mid-phase to 600 tail), phases 3 to 6 (same wide set, fresh seeds).

Intervals are 95% Wilson. The 3,000-call target was chosen so a 10% rate
would carry about ±1.1 points; the final 12,992 carries ±0.43. The
dollar-weighted interval uses Kish's effective sample size and is labelled an
approximation. The per-seller table requires at least 30 calls, where the
interval is about ±10 points: enough to separate a 5% seller from a 40% one.

### 2.6 Safety and auditability

Dry-run by default; real money required `--live`, `X402_AUDIT_LIVE=1`,
`--network eip155:8453`, and a passing 329-test suite recorded for the exact
commit (`pnpm gate`). Caps in code before any signature: per call 0.50 USD,
per seller per day 20, per day 100, total 300. Every payment attempt was
written to an append-only `attempts` ledger before signing; a reconcile pass
turned 7 ledger rows that lost their call row to a process stop into proper
rows after checking the chain. 63 rows were re-classified during the study as
validator bugs were fixed; each change is in the `reclassifications` table
with its reason and code commit. 22 halt rows record every stop (operator
halts for restarts, and one seller reaching its daily cap).

## 3. Data sources

| Source | What it provided | Access | Where used |
|---|---|---|---|
| `github.com/coinbase/x402` at commit `0e6e8c5` (2026-10-15) | Protocol facts: v2 headers (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`), v1 headers (`X-PAYMENT`, `X-PAYMENT-RESPONSE`), `PaymentRequirements` and `PaymentPayload` schemas, facilitator `/verify`, `/settle`, `/supported` contract, EIP-3009 flow, network ids, USDC addresses and EIP-712 domains | public repo, read from source (49 citations in `docs/protocol-notes.md`) | client wrapper, mock seller, settlement matching |
| npm `@x402/core`, `@x402/evm`, `@x402/fetch` 2.28.0 | Official client; all signing goes through it (`setSpendControls(false)`, `exact` scheme only, no retries) | public npm | `src/x402/` |
| Coinbase CDP Bazaar discovery API, `GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources` | The universe: 37,903 unique resources from 2,649 seller domains (38 pages of 1,000, 2 duplicates, 0 parse rejects), listed price, pay-to, network, input examples, 30-day call counts | public, no key, pulled 2026-10-24 01:40 UTC | discover, reference prices, request bodies |
| x402scan (`https://www.x402scan.com/openapi.json`) | Not used: every endpoint is itself a paid x402 call ($0.01 per 100 rows) and its terms forbid scraping the free frontend | documented only | none |
| Base mainnet JSON-RPC: `https://base-rpc.publicnode.com` (logs; 50k-block spans, 20k results), `https://mainnet.base.org` (receipts and balances; rejects log queries) | 30-day USDC `Transfer` history to every known pay-to: 1,336,834 transfers to 1,684 addresses, blocks 51,712,350 to 53,008,495 (2026-09-24 to 2026-10-24); receipts for 53,149 transactions (45,626 EIP-3009, 7,523 plain); settlement confirmation for every purchase | public, no key | seller ranking, chain proxies, settlement matching |
| USDC on Base `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Circle), events `Transfer` and `AuthorizationUsed` | On-chain settlements | public chain | all chain work |
| Sellers' own 402 endpoints (unpaid) | 33,320 quotes over 54 hourly rounds across 1,006 resources from two client identities | public HTTP | probe module |
| Sellers' own paid endpoints | 14,580 purchase attempts to 362 sellers and 2,064 resources | 4 wallets funded with 58 USDC by the operator | buy and stress modules |
| Local mock seller + anvil | Every failure mode on demand, a real EIP-3009 token, integration tests for buy, stress and confirmation | local | tests only |

Seller ranking: 30-day USDC inflow per pay-to, summed per seller domain. 1,032
of 2,649 domains share a pay-to with a higher-traffic domain (staging hosts,
mirrors, one domain literally named `jev-x402-evil.vercel.app` beside
`jev-x402.vercel.app`); they were treated as shadows and excluded from the top
tier so one operator could not occupy several slots. The dollar ranking
disagrees sharply with the index's call counts: the top seller by dollars
(api.bitrefill.com, about $607k in 30 days) ranks far below ax1.vc by calls
(443k transfers, $8.9k).

## 4. What was measured

### 4.1 Purchases

| | |
|---|---|
| attempts | 14,580 (plus 40 stress calls) |
| sellers reached | 362; 93 with at least 30 denominator calls |
| resources reached | 2,064 |
| wallets | 4, funded 58.00 USDC; 57.96 settled; 0.05 left as dust |
| settlements matched on-chain | 12,955 |
| outcomes | ok 12,133; not_paid 976; our_error 597; non_delivery 509; overcharge 350; indeterminate 15 |
| mean time to first byte on `ok` | 3.0 s (max 70 s) |

Per phase (count-weighted headline, 95% CI):

| phase | window (UTC) | denominator | rate |
|---|---|---|---|
| 1: top 20 + 40 tail sellers | 10-24 20:25 to 10-25 08:19 | 2,035 | 6.7% [5.7%, 7.9%] |
| 2: top 20 + 300 to 600 tail | 10-25 08:19 to 20:33 | 7,548 | 6.3% [5.7%, 6.8%] |
| 3 to 6: same wide set | 10-25 20:33 to 10-26 00:19 | 3,409 | 7.3% [6.5%, 8.3%] |

### 4.2 Breakdown

By seller tier (`unassigned` are sellers that entered through the widened
phases and have no tier label):

| tier | sellers | n | rate [CI] | dollar-weighted |
|---|---|---|---|---|
| top 20 by volume | 17 | 4,007 | 9.8% [8.9%, 10.8%] | 6.3% |
| random tail | 155 | 3,871 | 4.5% [3.9%, 5.2%] | 6.5% |
| unassigned (widened phases) | 190 | 5,114 | 5.7% [5.1%, 6.3%] | 12.3% |

By category:

| category | n | rate [CI] | dollar-weighted |
|---|---|---|---|
| other | 3,198 | 10.3% [9.3%, 11.4%] | 16.6% |
| compute | 1,974 | 7.6% [6.6%, 8.9%] | 4.0% |
| data | 3,419 | 6.0% [5.2%, 6.8%] | 11.6% |
| inference | 2,876 | 5.1% [4.3%, 5.9%] | 12.2% |
| scraping | 1,525 | 2.0% [1.4%, 2.8%] | 4.6% |

`non_delivery` by what came back after settlement: no response within the
seller's declared window 293 (18 sellers, 1.44 USDC); 4xx 145 (12 sellers);
5xx 27 (4 sellers); 2xx with an empty, truncated or wrong-typed body 44 (6
sellers). 143 rows carry `charged_then_rejected`: the seller settled and then
rejected the request as malformed, including requests built from the seller's
own listed example.

### 4.3 Sellers

Failure is concentrated. Of 93 sellers with at least 30 denominator calls, 69
had zero failures. The worst, by count rate:

| seller | tier | category | n | failures | rate [CI] |
|---|---|---|---|---|---|
| amanchain-relay.gitajhd.workers.dev | | compute | 150 | 150 | 100% [97.5%, 100%] |
| api.fadeandco.workers.dev | | data | 35 | 33 | 94.3% [81.4%, 98.4%] |
| palmyr.ai | tail | other | 43 | 27 | 62.8% [47.9%, 75.6%] |
| odds.rjhsignaltech.workers.dev | tail | inference | 107 | 65 | 60.7% [51.3%, 69.5%] |
| api.vapinetwork.ai | top | data | 116 | 67 | 57.8% [48.7%, 66.4%] |
| api-xpay.com | top | other | 500 | 270 | 54.0% [49.6%, 58.3%] |
| api.gondola-ai.com | top | inference | 174 | 48 | 27.6% [21.5%, 34.7%] |
| api.loyalspark.online | tail | data | 64 | 16 | 25.0% [16.0%, 36.8%] |
| api.sitecheck-api.workers.dev | | data | 87 | 18 | 20.7% [13.5%, 30.4%] |
| agent-tools-production-e6aa.up.railway.app | tail | scraping | 152 | 29 | 19.1% [13.6%, 26.1%] |

api.slamai.dev (top 20 by volume, data) joined this set in the 2026-10-28
revision: 170 calls, 6 failures, 3.5% [1.6%, 7.5%].

api-xpay.com alone contributes 270 of the 859 failures: it is a top-20 seller
by volume that took payment on hundreds of calls and did not answer within its
own declared 60 seconds. amanchain-relay took $0.05 per call 150 times and
never delivered.

### 4.4 Stress tests (10 sellers each, 0.20 USDC, never mixed into the headline)

- Duplicate: the same purchase intent sent twice back to back with fresh
  signatures. 5 of 10 sellers settled both. Nothing in the protocol or at
  these sellers deduplicates by intent; every signature is a payment.
- Timeout: sign, send, drop the connection after 2 seconds, then retry like a
  naive client. 2 of 10 sellers settled the aborted call anyway, and the retry
  produced a second settlement at 5 of 10.

### 4.5 Probes (unpaid quotes, hourly)

54 rounds, 33,320 quotes, 1,006 resources, two client identities differing
only in HTTP headers (the unpaid x402 request carries no buyer wallet).
95.8% of requests returned a 402. 447 quotes exceeded the listed price, the
same resources that produced the paid overcharges. 16 quote-drift events and 2
pay-to-address changes were observed. No price discrimination by identity was
detected.

### 4.6 On-chain proxies (market-wide floors, top 60 pay-tos, 30 days)

Delivery is invisible on-chain, so these are floors with caveats. On the
share-adjusted view (pay-tos fully verified by receipts, or with a sampled
EIP-3009 share whose lower bound is at least 95%; n = 988,081 transfers):

| proxy | count-weighted |
|---|---|
| payment above the pay-to's modal price | 14.7% [14.7%, 14.8%] |
| payment above 2x the modal price | 10.3% [10.2%, 10.3%] |
| isolated duplicate pair (one identical retry within 120 s, nothing else from that payer to that payee for an hour either side) | 0.15% [0.14%, 0.15%] (1,444 pairs, $1,252) |
| naive "any repeat within 120 s" | 76.6%, shown for transparency only; it mostly measures high-frequency legitimate consumers |

The above-mode proxy also inflates when one pay-to sells several products at
different prices, so it is an upper-ish signal of price heterogeneity rather
than a clean overcharge rate.

## 5. Conclusions

1. **About one paid x402 call in fifteen fails the buyer.** 6.6% by count
   (6.2% to 7.1%), 7.8% by dollars (6.8% to 9.0%), on 12,992 calls to 362
   sellers. The count interval is narrow enough that the true market rate is
   not below 6% or above 7.1% for this universe and period.
2. **Two mechanisms, roughly even by count.** Paying and getting nothing
   (`non_delivery`, 3.9% of calls) and paying more than the listed price
   (`overcharge`, 2.7% of calls). Overcharges are mostly large (2x to 10x+) and
   come from nine sellers; they look like stale listings or deliberate
   bait-and-switch rather than price jitter, because the 1.1x and 2x
   sensitivity cuts barely move the rate.
3. **Failure is a property of sellers, not of the protocol's median.** 69 of
   93 well-sampled sellers never failed; six sellers account for most
   failures, and one top-20 seller (api-xpay.com) for a third of them. A
   buyer with a short deny-list would see a rate well under 2%.
4. **Volume rank does not protect buyers.** The top-20-by-volume tier failed
   at 9.8% versus 4.5% for the random tail, driven by two high-volume sellers
   that charge first and answer late or never.
5. **Settlement precedes validation at many sellers.** 143 calls were charged
   and then rejected as malformed; 2 of 10 sellers settled a request whose
   connection was dropped after 2 seconds; 5 of 10 settled a duplicate intent.
   Nothing in the current `exact` scheme ties a payment to an idempotency key,
   so client retries are a direct double-charge risk.
6. **The on-chain picture is consistent but weaker.** Only 0.15% of transfers
   to the top 60 pay-tos look like lone retries, in line with the small
   duplicate signal in purchases; above-mode payments at 14.7% are compatible
   with the overcharge findings but cannot be separated from legitimate
   multi-product pricing without off-chain data.
7. **The index is noisy.** 1,179 listed URLs are path templates that cannot be
   called, 597 purchase attempts could not form a valid request from the
   listing, and roughly a third of the 2,649 domains are shadows of another.
   Agents that trust the index blindly will spend money on unfulfillable
   requests.

## 6. Limitations

- `wrong_goods` is unmeasured: no per-service schemas or entity extractors
  were configured, so every row is `schema_missing` and the headline is a
  lower bound on failures a careful buyer would count.
- Overcharge is relative to the Bazaar listing; a seller that lists a stale
  price and quotes its real one is counted as overcharging, which is the
  buyer's experience but not necessarily intent.
- 9 `non_delivery` rows (6 of them api.slamai.dev) timed out in our client
  (60 s) before the seller's declared 300 s window; they are an upper bound on those sellers' fault.
- Requests were built from each listing's example or typed field descriptors;
  597 attempts the sellers rejected as malformed are excluded as `our_error`,
  and the 143 `charged_then_rejected` rows include requests built the same way.
- Calls quoted under the x402 v1 network name `base` (the same chain as
  `eip155:8453`) are now included: the queries treat both names as one network
  (revision 2026-10-28).
- Phase 2's plan was rebuilt mid-phase when the probe set widened, so phase 2
  mixes two seller sets; the per-phase table is descriptive, the combined
  figure is the result.
- The probe-set tail and the buy tail were seeded samples of sellers that
  returned a 402 to an unpaid probe; sellers that never answer probes are not
  represented.
- Two client identities differed only by User-Agent and Accept headers.
- 15 `indeterminate` rows remain open at the time of writing and resolve to
  `not_paid` after 24 hours; they do not touch the denominator either way.
- Operational restarts (gated, with resume) and 63 audited re-classifications
  happened during the run; all are in the database and the git history.

## 7. Reproducibility

```bash
cd x402-audit && pnpm install && pnpm test
pnpm cli --db data/audit.sqlite --network eip155:8453 report --stdout
pnpm cli --db data/audit.sqlite --network eip155:8453 report --until 2026-10-25T08:19:27Z --stdout   # phase 1
pnpm cli --db data/audit.sqlite --network eip155:8453 chain report --top 60
pnpm cli --db data/audit.sqlite --network eip155:8453 probe report
pnpm cli --db data/audit.sqlite --network eip155:8453 stress report
```

Every reported number names the SQL query that produced it
(`src/report/queries.ts`); the report JSON carries the config hashes of every
run, the wallet count, the date range, the exact spend in USDC atomic units
and the git commit. Phase boundaries are in `data/phase{2..6}-boundary.txt`.
Reports: `reports/combined-2026-10-26.md`, `phase1-2026-10-25.md`,
`phase2-2026-10-25.md`, `phases3to6-2026-10-26.md`, `probe-2026-10-26.md`,
`stress-2026-10-26.md`, `chain-proxy-2026-10-26.md`.

## Appendix A. Taxonomy summary

| outcome | in denominator | counts as failure |
|---|---|---|
| ok | yes | no |
| overcharge | yes | yes |
| non_delivery | yes | yes |
| wrong_goods | yes (unmeasured here) | yes |
| injection | yes | no (human review) |
| duplicate | yes | yes |
| indeterminate | no (separate) | no |
| our_error | no | no (count shown) |
| not_paid | no | no (count shown) |

Flags: `payto_changed`, `price_discrimination`, `slow`, `schema_missing`,
`overcharged`, `unpaid_overcharge`, `injection_hit`, `resolved_late`,
`truncated_by_us`, `rate_limited`, `charged_then_rejected`.

## Appendix B. Discovery universe (2026-10-24)

37,903 resources; 37,563 accept `exact` on `eip155:8453`; 203 speak protocol
v1; 0 use permit2; 1,179 have templated paths. Categories (keyword rules in
`config/categories.yaml`): data 23,089, other 8,457, inference 2,645,
scraping 2,023, compute 1,689. Sellers: 2,649 domains, 1,617 canonical after
shadow removal.
