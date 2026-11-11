# Commands and operation

A measurement harness that answers one question with a defensible number:
**what share of paid x402 API calls on Base mainnet fail the buyer, by count and
by dollars, and why.**

This is a research instrument, not a product. It runs for a few weeks, spends at
most a few hundred dollars of USDC, and produces a report. Every design choice
favours correctness and auditability of the number over scale or reuse.

See `docs/PLAN.md` for milestones, `docs/taxonomy.md` for the failure taxonomy,
`docs/protocol-notes.md` for the protocol facts this code relies on (with the
files and commits they were read from), and `docs/NOT-BUILT.md` for what was
deliberately left out.

## Safety defaults

- Default network is Base Sepolia (`eip155:84532`).
- Real money moves only with `--live`, `X402_AUDIT_LIVE=1`, and `--network eip155:8453`, all three.
- Every subcommand defaults to `--dry-run`.
- A file named `halt` in the repo root stops every running job within one loop iteration.
- Keys come from `.env` only. `.env` is gitignored; `.env.example` documents every variable.
- Wallets are never funded by the harness. Funding is manual (see "Wallets" below once milestone 3 lands).

## Commands

Every subcommand is dry-run by default and writes to the one SQLite file in `X402_AUDIT_DB`.

| Command | Moves money? | What it does |
|---|---|---|
| `pnpm cli status` | no | effective config, caps, live gate, row counts |
| `pnpm cli discover run` / `discover report` | no | pull the CDP Bazaar index and `config/manual-sellers.yaml`; top sellers by 30-day volume |
| `pnpm cli chain scan-volume --days 30` | no | USDC transfers to every known pay-to over 30 days; ranks sellers (`chain top`) |
| `pnpm cli chain verify-sample` / `verify-all` / `report` | no | EIP-3009 verification by receipt sampling; market-wide overcharge and duplicate-loop floors |
| `pnpm cli probe plan` / `probe run --once` / `probe run` / `probe report` | no | select the probe set; one round or an hourly loop from two client identities; quote drift and pay-to changes |
| `pnpm cli buy plan` | no | stratified plan with planned spend per stratum; refuses above `MAX_TOTAL_USD` |
| `pnpm cli buy balances` | no | pool wallet USDC balances |
| `pnpm cli buy run` | **only with `--live`, `X402_AUDIT_LIVE=1`, `--network eip155:8453`** | execute the plan under the caps; writes the `attempts` ledger before every signature |
| `pnpm cli buy resolve` | no | re-check `indeterminate` calls against the chain (run periodically for 24 h) |
| `pnpm cli stress duplicate` / `stress timeout` / `stress report` | same gate as buy | the two deliberate tests on about 10 sellers, own caps |
| `pnpm cli telemetry serve` / `telemetry report` | no | ingest for `@x402-audit/client` records |
| `pnpm cli report` | no | `reports/YYYY-MM-DD.md` + `.json`, every number from a named query |
| `pnpm cli samplesize --rate 0.1 --halfwidth 0.01` | no | calls needed for a Wilson half-width |
| `pnpm cli audit-host --host h --calls n --max-usd x --reason t [--measured-only]` | same gate as buy, plus `AUDIT_TRIGGERS_ENABLED=1` | operator-requested audit of named hosts (source `audit_operator`: the seller's own series, never the headline); posts each result to the index (docs/audit-callback.md) |
| `pnpm cli audit-post --id n` / `--host h --latest` | no | re-send a stored audit result to the index with the same signing as the original post, from `AUDIT_SECRET` in the environment; prints the HTTP status; idempotent; `--force` re-sends one already posted |
| `pnpm cli export [--out dir]` | no | write the public data (summary, sellers with the rolling `window` block, resources, evidence, stress, probe, candidates, too_expensive); the public-data README documents every field |
| `pnpm cli health [--trigger t] [--dry-run]` | no | machine and loop health (unit, disk, memory, halt files by existence only, runs, caps and spend, pool balances, the last run's redacted log lines) posted to `{PAIDFOR_INDEX_URL}/v1/admin/health`, signed like the audit callback; `--dry-run` prints the body; a failed post is a one-line warning, exit 0. `scripts/loop.sh` posts after every probe round, buy and export, and a systemd timer every 15 minutes |

Stopping: create a file named `halt` in the repo root; every loop checks it. To stop
one job without the others, use `halt-buy`, `halt-stress` or `halt-probe`. The probe
loop runs under launchd (`scripts/install-probe-agent.sh`) and restarts itself after a
crash, logout or reboot; it stays stopped only while `halt` or `halt-probe` exists.

## Running locally (milestone 1)

Requirements: Node 22+ (developed on 23.11), pnpm 10.

```bash
pnpm install
pnpm test          # 176 tests: taxonomy/doc agreement, schema, validators, classifier, Wilson stats, x402 client wrapper, mock seller, end-to-end
pnpm typecheck
pnpm mock-seller   # local x402 v2 seller on :4402 with every failure mode on demand (see tools/mock-seller/README.md)
pnpm cli status    # effective config, caps, live gate, row counts
pnpm cli samplesize --rate 0.10 --halfwidth 0.01
```

Layout: `src/taxonomy.ts` (outcome constants, mirrored by `docs/taxonomy.md`),
`src/validators/` (eight pluggable validators), `src/classify.ts` (validator
results + settlement facts to one primary outcome and flags), `src/x402/`
(thin wrapper over the official `@x402/*` client that exposes the nonce before
sending and enforces the per-call cap before signing), `src/pipeline/paidCall.ts`
(the one paid-call path: ledger row before signing, validators, settlement
lookup, classifier, DB row), `src/db/schema.sql`, `tools/mock-seller/`.

## Wallets (manual funding only)

The harness never funds a wallet and never moves funds between wallets. It
only signs EIP-3009 `transferWithAuthorization` payments from the pool you
give it, and only under the caps in `.env`.

1. Generate N fresh keys locally (N is the pool size; 3 to 5 is enough for
   round-robin per seller). For example with the installed foundry tools:

   ```bash
   cast wallet new
   ```

   Keep the private keys in a password manager. Never paste them anywhere but `.env`.
2. Put them in `.env` as `X402_AUDIT_WALLET_KEYS=0x...,0x...,0x...` (comma
   separated). `.env` is gitignored; `pnpm cli status` prints only the count.
3. Fund each address with USDC on the target network from a wallet you
   control. No ETH is needed: the seller's facilitator pays gas for EIP-3009
   settlement (see `docs/protocol-notes.md`).
   - Base Sepolia: Circle faucet, https://faucet.circle.com (20 USDC per 2 h).
   - Base mainnet: send USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`)
     from an exchange or your own wallet. Fund only what the approved plan
     needs: `pnpm cli buy plan` prints the planned spend per stratum and the
     total; `MAX_TOTAL_USD` caps it in code regardless of balances.
4. Check balances before a run: `pnpm cli buy balances` (reads on-chain USDC
   balances for every pool wallet; moves nothing).
5. After the study, sweep the remaining USDC out manually. The harness has
   no sweep command on purpose.

Mainnet spending additionally requires `--live`, `X402_AUDIT_LIVE=1`, and
`--network eip155:8453` on every invocation, and a gate marker:
`pnpm gate` runs every test (including the anvil integration suite) and writes
`data/.gate.json` for the current commit with the tests' outcome
(`tests: {status: passed|failed|error, passed, failed, files}`); a live mainnet
`buy run` or `stress` refuses unless that marker matches HEAD, the tree is
clean, and the marker is less than 24 hours old. Since 2026-11-03 the tests
are advisory: failing tests no longer refuse a run or skip a scheduled buy.
The loop passes the marker to `buy run --gate-file data/.gate.json` (and to
`buy skipped` when a later gate skips the slot), which records the outcome in
the run row's `notes.gate`; with `HEALTH_BUY_HISTORY=1` the health post
carries the last 28 scheduled runs with it as `buy_history` for the admin
dashboard. The public export does not carry test results. `pnpm gate` exits 1
for a dirty tree, 2 when it could not reach the tests, and 0 otherwise, so use
`pnpm test` to check the suite by hand. The money limit is the runtime caps,
checked before every signature.

## Archiving raw probe data

`probe archive-raw` moves `probes.headers_json` and `probes.body_text` older than `--keep-days` (7) to
`s3://$BACKUP_BUCKET/probe-raw/<yyyy-mm>/<day>-ids-<min>-<max>.ndjson.gz`, then clears them locally. Parsed fields
(status, quote, pay-to, outcome, flags) stay, and nothing the verdicts or reports read changes. Without `--apply` it
only prints the plan. `--upload-only` uploads and records without clearing, so a first file can be inspected; the next
run without it clears those ranges. Every file is recorded in `probe_archives`. A row is cleared only after the file
was read back and S3 accepted it against its SHA-256.

One-time setup, before `PROBE_ARCHIVE_ENABLED=1`:

1. Let the server's role write the archive (add to the `paidfor-audit-backup-role` policy):
   `s3:PutObject` on `arn:aws:s3:::<bucket>/probe-raw/*`.
2. Limit the bucket's 30-day expiry rule to `audit/`, or the archive would expire with the backups.
3. Run once with `--apply --upload-only --max-days 1`, inspect the file, then run `--apply` without `--upload-only`
   and with a larger `--max-days` for the backlog.
4. Reclaim the space with `--apply --vacuum` between loop cycles. It blocks writers and refuses without about twice the
   live data free.

`scripts/loop.sh` changed, so the first deploy needs a service restart outside the buy windows.
