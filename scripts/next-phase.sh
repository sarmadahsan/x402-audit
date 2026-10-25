#!/usr/bin/env bash
# Waits for any running buy process to exit, writes a new phase boundary, gates the current commit, and launches a
# live buy run from that boundary with 8 workers. Usage: scripts/next-phase.sh <phase-number>
set -uo pipefail
cd "$(dirname "$0")/.."
N="${1:?phase number}"
while pgrep -f "tsx src/cli.ts .* buy run" >/dev/null; do sleep 10; done
B=$(date -u +%Y-%m-%dT%H:%M:%SZ); echo "$B" > "data/phase${N}-boundary.txt"; echo "phase $N boundary $B"
if git status --porcelain | grep -q .; then echo "tree dirty; refusing to gate"; exit 1; fi
pnpm gate > "/tmp/x402-gate-phase${N}.log" 2>&1
grep -E "Tests |gate:" "/tmp/x402-gate-phase${N}.log"
if grep -q "gate: passed on [0-9a-f]*;" "/tmp/x402-gate-phase${N}.log"; then
  (nohup pnpm tsx src/cli.ts --db data/audit.sqlite --network eip155:8453 --live buy run --resume-since "$B" --concurrency 8 >> data/buy-live.log 2>&1 &)
  sleep 3; echo "phase $N started"; git push -q origin main 2>/dev/null && echo pushed
else
  echo "GATE_FAILED"; exit 1
fi
