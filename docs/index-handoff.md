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
`runs.notes` and, since 2026-10-31, in `last_buy_run.reason` (section below). The buy tile should show it as a missed run (red or amber), not as a fresh run and not as "ok": the next
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

## 2026-10-31: the skip reason, and how the buy tile must grade a skipped run

Background (harness `HANDOFF.md`, 2026-10-31): the 06:00 UTC scheduled runs of 2026-10-30 and 2026-10-31 were skipped by
the harness's test gate (a timing-fragile assertion, fixed), and `/admin` stayed green through both. Three index changes
follow, all in `~/paidfor`; nothing here edits that repo.

### New export field (live from the first export after the harness deploy on 2026-10-31)

| file | field | type | meaning |
|---|---|---|---|
| `summary.json` | `last_buy_run.reason`, `last_probe_run.reason` | string or null | For status `skipped`: which gate stopped the run, as the loop recorded it, e.g. `pnpm gate failed: 1 of 389 tests failed (src/cli/skipped.test.ts)`, `working tree is dirty:  M f;?? g (...)`, `halt or halt-buy file present`, `X402_AUDIT_LIVE is not 1`, `wallet pool holds 0.50 USDC, less than the run cap 2.00`. Null for every other status. At most 500 characters. |

Additive. `lib/types.ts` `RunInfo` can gain `reason?: string | null`; nothing breaks if it does not.

### Health post: `runs.buy.reason` needs the index first

`lib/admin-health.ts` validates `runs.<kind>` with `exactKeys([status, started_at, finished_at, planned_calls, spent_usdc,
failures, errors])`, so a post with one more key is refused ("runs.buy: unknown fields reason") and the "Last health post"
tile would go red for the wrong reason. The harness therefore does **not** send `reason` in the health post yet. Index
change, then harness: accept an optional `reason` (string of at most 500 characters, or null) on every `runs.<kind>` object
(add it to the key list as optional, or drop the extra-key check for that one name), keep it on the stored post and the
`Run` type, and the harness adds it in its next deploy (`src/health/body.ts` `buyRun`/`probeRun`, one line each: the same
`reason` the export carries). Until then the skip reason is in the export and in the post's `log_tail` lines
(`scheduled buy <date> <HH>:00: skipped, <reason>`).

### `runTile` (`lib/admin.ts`): why nothing went red, and the change

As written, `runTile("buy", run, fallback, now)`:

- `failed = /fail|error/i.test(r.status)`: `skipped` matches neither, so a skipped run counts as a success;
- age is `now - (finished_at ?? started_at)` of the **latest row**, and the skip row is dated at the skip (06:28 and
  06:35 UTC), so the tile read "0 min ago", green, and stayed green until 6.5 h later, by which time the 12:00 run had
  finished and reset the age;
- the health post after a skip carries the skip row as `runs.buy` (status `skipped`, `planned_calls: null`,
  `spent_usdc: "0.000000"`, failures 0, errors 0), so yes, it refreshes the tile's timestamp and makes it look fresh;
- `admin-alarm.ts` mails only on red, so no mail went out.

The change (one function, no new data needed):

1. A last run whose status is `skipped`, `failed`, `error` or `halted` grades **red at once**, whatever its age:
   `const failed = /fail|error|skipped|halted/i.test(r.status)`. Keep `cap_reached` and `ok` green.
2. Freshness comes from the last **completed** run, not the latest row: use the export's `last_buy_run.last_activity`
   (the time of the last paid call; already in `summary.json`, dropped by the fallback mapping today) or, from the health
   post, the latest run with status in `ok`/`cap_reached`. A run whose `last_activity` is older than the previous
   completed run must not count as fresh: `at = Date.parse(fallback?.last_activity ?? r.finished_at ?? r.started_at)`,
   and for the buy tile `ageH` is measured from that. With this, a skipped 06:00 run shows "skipped · last purchases
   6.5 h ago" and turns amber at 6.5 h and red at 7 h on its own even if the status rule above were missing.
3. Show the reason: append `r.reason` (health post, once accepted) or `fallback.reason` (export) to the tile's note, so
   the mail says "skipped: pnpm gate failed: 1 of 389 tests failed (src/cli/skipped.test.ts)" and not just "skipped".
4. Threshold text: `red when the last run was skipped or failed, or no purchase for over 7 h; amber over 6.5 h`.

`lib/admin.test.ts` cases to add: a `runs.buy` with status `skipped` 5 minutes old is red; an `ok` run 5 minutes old whose
`last_activity` is 7 h old is red; a `cap_reached` run 1 h old is green.

### What "calls went down" was on the dashboard

The harness's exported counts never fell: `denominator_paid_calls` and every seller's call count only grew between
2026-10-30 and 2026-10-31. Two tiles did drop after each skip, because both read the **last run** and the skip row has
no plan and no spend:

- `Last buy run` note: before the skip `ok · started 10-31 00:28 · finished 10-31 00:43 · 603 planned · 1.55 USDC ·
  N failures · N errors`; after it `skipped · started 10-31 06:35 · finished 10-31 06:35 · 0.000000 USDC · 0 failures ·
  0 errors`, with the "planned" part gone (`planned_calls` is null for a skip, so the part is omitted rather than shown
  as 0). That is the "calls went down" reading.
- `Spent, last run vs per-run cap`: `caps.spent_run_usdc` is the last run's spend, so it went from about 1.55 of 2.00
  to 0.00 of 2.00 (status "none", information only, so no colour change).

The home page footer and `HomeHuman` ("last purchases N h ago" from `last_buy_run.finished_at`) also showed the skip time
as if purchases had happened then.

What the tile should show instead: the status word and reason of the last scheduled slot, and the figures of the last
**completed** run with its own time, e.g. `skipped at 06:35 (pnpm gate failed: ...) · last completed 00:28 to 00:43 ·
603 planned · 1.553211 USDC`. The "last purchases" line on the home page should use `last_buy_run.last_activity`, not
`finished_at`.
