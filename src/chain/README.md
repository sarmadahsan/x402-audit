# `chain`: passive on-chain measurement

Read-only. Nothing in this module signs or sends a transaction. Everything lands in the one SQLite file.

## Pipeline

| step | code | writes | RPC cost |
|---|---|---|---|
| 1. volume scan | `scanPayToVolume` (volume.ts), CLI `chain scan-volume` | `chain_transfers` (every USDC `Transfer` to a known pay-to, `via_authorization = NULL`), `chain_scan_progress`, `payto_volume`, meta `volume_window_<network>` | `eth_getLogs`: about ceil(blocks / 50,000) windows x ceil(pay-tos / 200) address batches, plus splits when a window has too many results, plus 2 `eth_getBlockByNumber` per query that returned logs. 30 days on Base (about 1.3M blocks) for 1,707 pay-tos is about 26 x 9 = 234 `getLogs` before splits. |
| 2. ranking | `assignSellerVolumes`, `topPayTos` (rank.ts), CLI `chain top` | `sellers.volume_30d_*`, `rank_30d` | none |
| 3a. sampled verification | `verifySample` (verify.ts) | `chain_transfers.via_authorization` / `nonce` for sampled txs, meta `eip3009_share_<network>_<payTo>` | one `eth_getTransactionReceipt` per sampled tx: at most `perPayTo` x pay-tos (100 x 60 = 6,000 for the top 60), plus retries on 429 |
| 3b. full verification | `verifyAll` (verify.ts) | same, for every unverified non-dust tx of the listed pay-tos | one receipt per distinct unverified non-dust tx of those pay-tos (their `payto_volume.transfer_count` is the upper bound) |
| 4. proxy report | `computeChainProxies`, `renderChainReport` (report.ts) | nothing | none (SQLite only) |

### Why verification is sampled

A `Transfer` to a pay-to is an x402 EIP-3009 settlement only if the same tx has an `AuthorizationUsed`
from the USDC contract with `authorizer == Transfer.from` (docs/protocol-notes.md Part 2 C). Checking
that needs a receipt per tx. A full join for 30 days of the whole market is hundreds of thousands of
receipts, so:

- `verifySample(db, { client, network, payTos, perPayTo = 100, seed })` takes, per pay-to, a seeded
  uniform sample (mulberry32 + Fisher-Yates, sub-seed per pay-to from `seed`) of `perPayTo` distinct tx
  hashes among the pay-to's non-dust, still unverified (`via_authorization IS NULL`) transfers in its latest
  `payto_volume` window, verifies them, and stores the EIP-3009 share of sampled txs with a Wilson 95%
  interval in meta `eip3009_share_<network>_<payTo>` as JSON
  (`{ payTo, sampled, viaAuthorization, share, lo, hi, population, errors, network, seed, perPayTo, fromBlock, toBlock, computedAt }`).
  The sample unit is the tx. Each run samples among txs still unverified; the meta row holds the latest run.
- `verifyAll(db, { client, network, payTos })` verifies every unverified non-dust tx of a short list of
  pay-tos (the ones that drive the headline), so the "verified" view of the report is complete for them.
- Both call `verifyTransfers(db, { client, network, txHashes, concurrency = 4 })`: fetch the receipt
  (up to 3 retries on rate-limit errors, backoff `[2 s, 8 s, 30 s]`, injectable `backoffMs` / `sleep`),
  then, in one DB transaction per batch of 50 txs, one `UPDATE` per row: `via_authorization = 1` and
  `nonce = topic2` for rows whose `from_addr` is an authorizer (several authorizations by one sender in
  one tx are paired in log order), `0` for the tx's other rows. A failed receipt leaves rows `NULL` and is
  counted in `errors`. Returns `{ checked (txs), viaAuthorization (rows), plain (rows), errors (txs), rpcCalls, retries }`.

`via_authorization = 0` means "not EIP-3009", not "not x402": Permit2 (`assetTransferMethod: permit2`),
`upto` and batch-settlement payments emit no `AuthorizationUsed`.

## Proxy report (report.ts)

Universe: `topPayTos(db, { network, n: topN = 60 })`, each pay-to restricted to its own latest
`payto_volume` block window and to `value >= dustFloorAtomic` (default 100 atomic units). Three views,
printed in this order:

1. **verified**: `via_authorization = 1` rows only (EIP-3009 settlements). Small while only samples are verified.
2. **share-adjusted** (`shareAdjusted`): one rule per pay-to, chosen in JS from the all-view totals and the
   `eip3009_share_<network>_<payTo>` meta row, and listed per pay-to in the report (`shareRules`):
   - (a) `fully-verified`: every non-dust row in the window is checked (no `via_authorization IS NULL`) ->
     its `via_authorization = 1` rows;
   - (b) `high-share`: otherwise, if the sampled EIP-3009 share's Wilson 95% lower bound is
     `>= SHARE_ADJUST_MIN_LO` (0.95; option `shareAdjustMinLo`) -> **all** its non-dust rows, under the
     stated assumption that they are x402 settlements (at most a few percent may be unrelated USDC flows);
   - `partial`: otherwise -> only its verified rows, and the pay-to is flagged "partially verified";
   - `empty`: no non-dust rows.
   The rule is passed to SQL as a per-entry `verified_only` (0 for `high-share`, 1 otherwise) in `@universe`,
   which overrides `@verified_only` for that pay-to. This removes pay-tos that mostly receive non-x402 USDC
   (for example a 15% sampled share) from the full-volume numbers while keeping high-share pay-tos at full
   volume instead of only their sampled rows. It always contains at least the verified rows.
3. **all non-dust** (verified or not): not x402-filtered; shown last for transparency only, never a floor.

The "adjusted" line uses the share-adjusted view when it has rows, else the verified view
(`adjustedBasis`), else it is not available.

SQL (exported in `CHAIN_PROXY_QUERIES`, shared CTE `CHAIN_PROXY_UNIVERSE_CTE`; parameters `@network`,
`@universe` JSON array of `{pay_to, from_block, to_block, verified_only?}`, `@dust_floor`, `@verified_only`,
`@window_ms`, `@isolation_ms`):

| name | returns | used for |
|---|---|---|
| `chain_proxy_totals` | per pay-to: n, distinct payers, verified / plain / unchecked rows, block and ts range | transfers, unique payers, verification coverage |
| `chain_proxy_overcharge` | per (pay-to, value): n | sum, mode (most frequent value, ties -> lower; bigint in JS), > mode and > 2 x mode counts and dollars |
| `chain_proxy_duplicate_runs` | per (pay-to, value): followers, runs | duplicate-loop proxy: `LAG(block_ts)` over `PARTITION BY from_addr, to_addr, value_atomic ORDER BY block_ts, block_number, log_index, id`; follower = predecessor at most `@window_ms` earlier (`DUPLICATE_RUN_WINDOW_S` = 120 s); run = follower whose own predecessor is not a follower |
| `chain_proxy_isolated_pairs` | per (pay-to, value): pairs | stricter duplicate proxy (lone retry): a (from, to, value) run of exactly 2 transfers at most `@window_ms` apart (`LAG`/`LEAD` over `PARTITION BY from_addr, to_addr, value_atomic`) where the payer made no other transfer of any value to that payee within `@isolation_ms` (`ISOLATION_S` = 1 h) before the first or after the second (`LAG(block_ts, 2)` / `LEAD(block_ts)` over `PARTITION BY from_addr, to_addr`, and the pair must be adjacent there). One row per pair, so pairs = followers in pairs; dollars = value of the second transfer |

Followers vs isolated pairs: a high-frequency consumer (one payer paying the same price every few seconds)
makes almost every transfer a "follower" but produces no isolated pair, so followers measure repeat
traffic and isolated pairs approximate lone retries (a duplicate charge pattern).

Market-wide: count-weighted rates with `wilsonInterval`, dollar-weighted with `dollarWeightedWilson`
(Kish effective n, approximate), for > mode, > 2 x mode, duplicate followers and isolated pairs, in all three
views. Each view's column is followed by the number of pay-tos contributing (pay-tos with at least one
flagged transfer; the header gives the pay-tos with any row in that view).

`src/report/queries.ts` already has `chain_proxy_overcharge` and `chain_proxy_duplicate_runs`, over the
time window only (no top-N universe, no dust floor in SQL, no verified restriction, row-level followers).
They do not match this report, so these keep the same names for a later merge rather than importing them.

Caveats (printed verbatim in every report, `CHAIN_CAVEATS`): delivery is invisible on-chain; these are
floors; a payment above the mode may be a legitimately different product or a dynamic price; a repeated
identical transfer within 120 s may be a legitimate second purchase; isolated pairs can still be deliberate
repeat purchases; dust and unrelated transfers are excluded by the floor and (where verified) by the
AuthorizationUsed join; the share-adjusted view's rule (b) assumes high-share pay-tos' unverified rows are x402.
