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
