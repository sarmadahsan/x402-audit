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

## Wallets

Not yet. Milestone 3 documents the manual funding procedure. The harness
never funds wallets.
