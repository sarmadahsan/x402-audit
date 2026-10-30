# Index handoff: sample-growth fields (harness Prompt 0e, 2026-10-29)

For the next `~/paidfor` session. The harness export (`sarmadahsan/paidfor-data`, hourly) gained the fields below.
All are additive: no existing field changed name, type or meaning. The index change happens in `~/paidfor`, not here.

## summary.json (new top-level fields)

| field | type | meaning |
|---|---|---|
| `sellers_below_30` | integer | Sellers with at least one resource at or under the scheduled per-call cap (0.10 USDC) and fewer than 30 denominator calls: the coverage pool the next scheduled run draws from (zero-call sellers included). |
| `sellers_new_7d` | integer | Sellers first seen in the last 7 days, any route (Bazaar recrawl, seed list, user candidates), not counting the initial universe (first Bazaar crawl, 2026-10-24). |
| `sellers_measured_trend` | array of `{ date: "YYYY-MM-DD", sellers_with_min_calls: integer }` | Last seven daily values of `sellers_with_min_calls`, oldest first; each is the count at the end of that UTC day, the last is now and equals `sellers_with_min_calls`. |
| `discovery_last_run` | object or null | Last `discover refresh`: `finished_at` (ISO), `new_sellers`, `probe_set_added`, `bazaar_resources`, `seed_sellers_added`, `new_unmapped_payees`, `facilitators`, `receipts_sampled`, `errors` (array of strings). Null before the first refresh. |
| `breadth_purchases` | `{ paid_calls, sellers }` | Paid calls and sellers from the weekly breadth run (source `breadth`). These count in the headline. |
| `unmapped_payees` | integer | Base addresses that received facilitator settlements and match no known seller's pay-to. |
| `unmapped_payees_with_inflow` | integer | How many of those have a measured 30-day inflow so far (at most 20 measured per day). |
| `unmapped_payee_inflow_30d_usdc` | decimal string | Sum of their 30-day non-dust USDC inflow: money flowing to x402 sellers nobody can name. Covers only `unmapped_payees_with_inflow`. |

## sellers.json (new fields on every row in `sellers` and `low_sample`)

| field | type | meaning |
|---|---|---|
| `discovered_at` | ISO string or null | When the seller entered our database (the discovery run that found it, else the first listing or import that named it). |
| `first_buy_at` | ISO string or null | Our first paid call to the seller, any measured source. |
| `breadth_purchases` | integer | Paid breadth calls included in the seller's figures. |
| `purchases_by_source` | object | Paid calls per source: `buy`, `breadth`, `audit_disagreement`, `audit_demand`. |
| `source` | string | Now one of `discovery`, `seed` (new), `user`. |

## too_expensive.json (new field on every resource)

| field | type | meaning |
|---|---|---|
| `breadth_eligible` | boolean | The quote is at or under the breadth cap (0.50 USDC), so the weekly breadth run can buy it once enabled. |

Also: `too_expensive.json` now lists only sellers with no endpoint at or under 0.10 USDC; a seller with one affordable
endpoint is bought on it and leaves the file. Evidence samples can carry `source: "breadth"`.

## The two lines the index should show

1. Home page, near the seller count: **"N sellers added this week"**, with N = `summary.sellers_new_7d` (hide the line when 0).
2. Seller page, next to the sample size: **"measured since <first_buy_at>"**, the date part of `sellers.json` `first_buy_at` for that seller (hide when null).

## Wording the index should keep

The headline is a rolling figure over the current sample and moves as the sample widens. If the index shows the report's
study-window figure (6.6%, 2026-10-24 to 2026-10-26), it is a separate, frozen line with its dates, never recomputed.

## Run status (changed meaning, same field)

`summary.json` `last_buy_run.status` can now be `cap_reached`: the run ended on its own budget (per-run or daily
scheduled budget), which is routine and should not alarm. `halted` now means only the halt file, an error, or a
backstop cap (`MAX_PER_DAY_USD`, `MAX_TOTAL_USD`). `ok`/`completed` as before.

Since 2026-10-30, `skipped` (also in the health post's `runs.buy.status`): the loop reached a scheduled slot but one of
its gates stopped the run before any purchase (its test gate failed, a halt file was present, the working tree was
dirty, or the wallet pool was below the run cap). The row has no calls and no spend; the reason is in the harness's
`runs.notes`. The buy tile should show it as a missed run (red or amber), not as a fresh run and not as "ok": the next
slot is at most six hours away, and a second `skipped` in a row is the signal that the harness needs an operator.

## Needed from the index: per-host demand by channel

The harness ranks admit-lane sellers by **external** demand: checks from the `skill`, `mcp`, `x402-safe-fetch` and
`paidfor-client` channels only. Our own harness (`x402-audit`), bare API calls (`api`, which includes our own curl
checks) and `other` must never rank a seller. `/v1/demand` today gives one `checks` number per host, so the harness
cannot tell these apart and **does not use demand at all** until the index serves the split.

Wanted, additive: on every `/v1/demand` host row, `checks_by_channel`, an object from channel name (the same strings
`channelOf` produces in `lib/channels.ts`, version suffix included or not) to checks over the requested window, summing
to `checks`. That means recording the channel with each `recordCheck(host)` (per host, per UTC day, per channel).
The harness reads the field as soon as it appears (`fetchDemand` in `src/audit/triggers.ts`, `demandMap` in
`src/cli/buy.ts`) and needs no change.
