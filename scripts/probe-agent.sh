#!/usr/bin/env bash
# Run by launchd. Waits while a job-specific halt-probe file exists, then runs the hourly probe loop.
cd "/Users/sarmad/billing/x402-audit"
while [ -e halt-probe ]; do sleep 30; done
exec "/opt/homebrew/bin/pnpm" tsx src/cli.ts --db data/audit.sqlite --network eip155:8453 probe run --every-minutes 60
