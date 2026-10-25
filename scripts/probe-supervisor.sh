#!/usr/bin/env bash
# Keeps the hourly probe loop running for the life of this shell session (no system persistence):
# restarts it whenever it exits, waits while `halt-probe` exists, and stops for good when `halt` exists.
# For restart-on-reboot use scripts/install-probe-agent.sh (launchd), which must be run by the operator.
cd "$(dirname "$0")/.."
echo "$(date -u +%FT%TZ) supervisor: start (pid $$)"
while true; do
  if [ -e halt ]; then echo "$(date -u +%FT%TZ) supervisor: halt file present, exiting"; exit 0; fi
  if [ -e halt-probe ]; then sleep 30; continue; fi
  echo "$(date -u +%FT%TZ) supervisor: starting probe loop"
  pnpm tsx src/cli.ts --db data/audit.sqlite --network eip155:8453 probe run --every-minutes 60
  echo "$(date -u +%FT%TZ) supervisor: probe loop exited ($?); restarting in 30 s"
  sleep 30
done
