#!/usr/bin/env bash
# End-of-run sequence after a live buy run exhausts its plan. Idempotent; safe to re-run.
# Usage: scripts/end-of-run.sh <phase-boundary-iso> <report-date YYYY-MM-DD>
set -euo pipefail
cd "$(dirname "$0")/.."
B="${1:?phase boundary ISO}"; D="${2:?report date}"
CLI="pnpm tsx src/cli.ts --db data/audit.sqlite --network eip155:8453"
echo "== reclassify (final code)"; $CLI buy reclassify --reason "end-of-run pass $D with final validator/classifier code" | tail -1
$CLI buy reclassify --apply --reason "end-of-run pass $D with final validator/classifier code" | tail -1
echo "== resolve + reconcile"; $CLI buy resolve | tail -1; $CLI buy reconcile --apply | tail -1
echo "== reports"
$CLI report --since "$B" --out reports | tail -1 && mv "reports/$D.md" "reports/phase2-$D.md" && mv "reports/$D.json" "reports/phase2-$D.json"
$CLI report --out reports | tail -1 && mv "reports/$D.md" "reports/combined-$D.md" && mv "reports/$D.json" "reports/combined-$D.json"
$CLI probe report > "reports/probe-$D.md"
$CLI stress report > "reports/stress-$D.md"
$CLI chain report --top 60 > "reports/chain-proxy-$D.md"
echo "== headline (phase 2)"; sed -n '/## 2\. Headline/,/Denominator:/p' "reports/phase2-$D.md" | head -8
echo "== headline (combined)"; sed -n '/## 2\. Headline/,/Denominator:/p' "reports/combined-$D.md" | head -8
git add -A && git commit -qm "reports: phase 2 and combined ($D)" && git push -q origin main && echo pushed
