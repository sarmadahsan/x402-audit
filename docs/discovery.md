# Discovery

How sellers enter the database after the initial universe (the 2026-10-24 Bazaar crawl and 30-day chain scan), and
how the unmapped-payee figure is computed. Code: `src/discover/refresh.ts` (`discover refresh`),
`src/discover/candidates.ts` (`discover import-candidates`). Neither ever signs or pays.

## Schedule

- `discover refresh`: daily, after the 00:00 UTC scheduled run (`scripts/loop.sh`, `LOOP_REFRESH_HOUR_UTC`).
- `discover import-candidates`: after every scheduled run (00, 06, 12, 18 UTC).

## Sources

1. **Bazaar.** The CDP discovery API is re-crawled in full (`runDiscover`, the same crawler as `discover run`).
   A seller that was not in the database gets a `seller_discovery` row (`source = discovery`, `discovered_at`).
2. **Seed list.** `config/seed-sellers.yaml` is a hand-kept list of hosts from ecosystem pages, directories and
   partner catalogs, one source line each. A host we do not know is probed once per refresh at its root; a 402 with a
   Base `exact` option makes it a seller (`source = seed`) with that root as its resource. A host that does not answer
   a 402 is not added and is tried again the next day.
3. **User candidates.** Resources people checked or paid through the index (`GET /v1/candidates`); see
   docs/taxonomy.md "Candidate sellers". They keep their own buying lane.
4. **Chain.** Base payees of facilitator settlements in the last 24 hours that no known seller claims (below).

Every new seller from 1 and 2 has tier NULL (as in the widened phases), gets one resource in the probe set
(`probe_set.stratum = discovery`, busiest listing first, at most 300 per refresh) so the next hourly probe quotes it
for free, and enters the coverage pool of the next scheduled run because it has zero calls (docs/PLAN.md
"Coverage-first allocation").

## Facilitators

The harness has no configured list of facilitator addresses, so they are learned, not typed in: each refresh reads
the 200 most recent settlement transactions we matched for our own purchases (`settlements.tx_hash`) and records
each transaction's sender (`tx.from`) in the `facilitators` table with the number of those 200 it sent. A facilitator
we have never been settled through is therefore not on the list, and its settlements are not counted below.

Facilitator addresses seen on 2026-10-29 (from the audit database, 200 most recent matched settlements):

| address | of our 200 most recent settlements |
|---|---:|
| `0x59b7ebc67a3d627fabaf06768c818638452ae704` | 14 |
| `0x8f5cb67b49555e614892b7233cfddebfb746e531` | 13 |
| `0x68efafe862d89ce66dd3d7b07d5a3747a0871164` | 12 |
| `0x93f6601151ccb08f333ab4b1cccfb1e188c0be44` | 12 |
| `0x625d8a65134079f8faaac39a7947c73d93c6ac39` | 11 |
| `0x67b9ce703d9ce658d7c4ac3c289cea112fe662af` | 11 |
| `0x97acce27d5069544480bde0f04d9f47d7422a016` | 11 |
| `0xa32ccda98ba7529705a059bd2d213da8de10d101` | 11 |
| `0x14fda13953fc30428938e6bf950d036e77214e52` | 10 |
| `0x2a89407a98a0732b7fd578c4e156b7166540eb5a` | 10 |
| `0x68a96f41ff1e9f2e7b591a931a4ad224e7c07863` | 10 |
| `0x8cda367232d78c067116e3260da881d2da8ffa39` | 10 |
| `0xe72f0af4cf41356d433723547f1412ca27fbb1b8` | 10 |
| `0x42dd53906b49c202e8e934b059dc019e04634b00` | 9 |
| `0x64cc42b1ce598e3abcfbb64df4688521ddbf1f0a` | 9 |
| `0xb87e1a2cc2b4643f2892768e80e41167f17c5860` | 9 |
| `0xca5e87f82b3fa093800e6ad67d621a427d79c70d` | 8 |
| `0xe74817f4cdc15844314812b2271276e64e890fae` | 8 |
| `0x4c934c63c786157fefd990945b25ea60a0fb0205` | 6 |
| `0x772003a2e9c2ccc8af956870a37a66f64f8cec38` | 5 |
| `0x61fb0c8def27627c45c0e0d7f3b55d13b645a5fd` | 1 |

They are the signer addresses of the facilitators that settled our purchases (one facilitator usually signs from many addresses). The table in the database is refreshed daily; this list is the first day's.

## Unmapped payees

1. Every USDC `AuthorizationUsed` log on Base in the last 24 hours is read (about 400,000 a day, in 2,000-block
   windows), and a seeded uniform sample of 1,500 of their transactions is kept (reservoir sampling).
2. Each sampled transaction's receipt is read. If its sender is a known facilitator, every USDC `Transfer` in it from
   the authorizer of the `AuthorizationUsed` is a facilitator settlement, and its recipient is a payee.
3. A payee whose address is the pay-to of any resource we know (listing or probe-filled) or was quoted to us in a
   call is mapped. The rest go to `unmapped_payees` with the first transaction seen, its facilitator and how many
   sampled settlements went to it so far. When a later refresh finds the address in a listing, the row is marked
   matched (`matched_seller_id`) and leaves the figure.
4. For up to 20 unmapped payees per refresh (most-sampled first, figures older than 6 days refreshed), the 30-day
   inflow is computed with the chain module's own scan (`scanPayToVolume`: Transfer logs to the address over 30 days,
   dust floor 100 atomic units excluded), the same method that ranks sellers.

`summary.json` publishes `unmapped_payees`, `unmapped_payees_with_inflow` and `unmapped_payee_inflow_30d_usdc` (the sum
over unmatched payees with a measured inflow): USDC flowing to x402 sellers nobody can name.

Limits, stated plainly:

- Detection is sampled. A payee receiving a share p of the day's facilitator settlements is seen in a day's sample
  with probability about 1 - (1 - p)^1500; a payee with 0.1% of settlements is seen within a day about 78% of the
  time, one with 0.01% about 14%, so the smallest payees surface over weeks, not days.
- The inflow is all non-dust USDC the address received in 30 days, not only x402 settlements (the same caveat as the
  seller ranking, docs/FINAL-REPORT.md section 4.6).
- Settlements through a facilitator we have never used (step "Facilitators") are invisible here.
- `upto` and batch-settlement payments emit no `AuthorizationUsed` and are not seen.
