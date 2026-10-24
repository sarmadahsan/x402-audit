# x402-audit

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
`--network eip155:8453` on every invocation, and a passing integration suite
(`pnpm test`).
