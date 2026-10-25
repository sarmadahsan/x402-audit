#!/usr/bin/env bash
# Runs `buy resolve` every 15 minutes while a live buy run exists (and for 24 h after), so indeterminate rows and
# unconfirmed settlements are re-checked without an operator. Stops on the global `halt` file.
cd "$(dirname "$0")/.."
echo "$(date -u +%FT%TZ) resolve-loop: start (pid $$)"
while true; do
  [ -e halt ] && { echo "$(date -u +%FT%TZ) resolve-loop: halt file present, exiting"; exit 0; }
  pnpm tsx src/cli.ts --db data/audit.sqlite --network eip155:8453 buy resolve 2>&1 | tail -1
  pnpm tsx src/cli.ts --db data/audit.sqlite --network eip155:8453 buy reconcile --apply 2>&1 | tail -1
  sleep 900
done
