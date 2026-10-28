#!/usr/bin/env bash
# Keeps the public index alive without an operator.
#   hourly : one probe round over the current probe set, settlement re-check (moves no money), export, publish
#   daily  : at LOOP_BUY_HOUR_UTC, a gated live buy with a fresh seed over the wide seller set (config/sample.yaml),
#            budget LOOP_DAILY_USD, per-call cap LOOP_PER_CALL_USD; then settlement confirmation, export, publish
#   publish: git add public-data && git commit -m "data: <timestamp>" && git push, on branch public-data, from a
#            worktree at data/public-data-branch so the main checkout stays clean for the commit gate.
# Every existing gate stays: --live, X402_AUDIT_LIVE=1, --network eip155:8453, `pnpm gate` on a clean committed HEAD,
# the MAX_* caps, and the halt / halt-buy / halt-probe files. A skipped step is logged; the loop itself never stops.
#
# Usage: scripts/loop.sh            run the loop in the foreground (what launchd runs)
#        scripts/loop.sh once       one hourly cycle now, then exit
#        scripts/loop.sh install    macOS: write and load the launchd agent (com.x402audit.loop)
#                                   Linux: (sudo) write /etc/systemd/system/paidfor-audit.service and enable it
#        scripts/loop.sh uninstall  stop and remove the agent or service
#        scripts/loop.sh status     agent or service state and the last log lines
# On Linux every setting and secret comes from /etc/paidfor/audit.env (systemd EnvironmentFile); nothing logs them.
# backup : after the daily buy, a consistent snapshot of data/audit.sqlite is gzipped and copied to
#          s3://$BACKUP_BUCKET/audit/<date>.sqlite.gz (skipped and logged when BACKUP_BUCKET or the aws CLI is missing).
# Env:   LOOP_DAILY_USD (2.00)  LOOP_PER_CALL_USD (0.10)  LOOP_BUY_HOUR_UTC (14)  LOOP_BUY_CONCURRENCY (4)
#        LOOP_PUBLISH (1; 0 = export but do not commit or push)  BACKUP_BUCKET (unset = no backup)
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

LOOP_DAILY_USD="${LOOP_DAILY_USD:-2.00}"
LOOP_PER_CALL_USD="${LOOP_PER_CALL_USD:-0.10}"
LOOP_BUY_HOUR_UTC="${LOOP_BUY_HOUR_UTC:-14}"
LOOP_BUY_CONCURRENCY="${LOOP_BUY_CONCURRENCY:-4}"
LOOP_PUBLISH="${LOOP_PUBLISH:-1}"
NETWORK="eip155:8453"
LOG="$REPO/data/loop.log"
STATE="$REPO/data/loop-state"
WT="$REPO/data/public-data-branch"
BRANCH="public-data"
LABEL="com.x402audit.loop"
UNIT="paidfor-audit"
UNIT_FILE="/etc/systemd/system/$UNIT.service"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CLI=(pnpm -s tsx src/cli.ts --db data/audit.sqlite --network "$NETWORK")
mkdir -p "$STATE"

log() { echo "$(date -u +%FT%TZ) [$$] $*" >> "$LOG"; }
run() { log "run: $*"; "$@" >> "$LOG" 2>&1; local rc=$?; [ "$rc" -ne 0 ] && log "exit $rc: $*"; return "$rc"; }
lock() { until mkdir "$STATE/$1.lock" 2>/dev/null; do sleep 5; done; }
unlock() { rmdir "$STATE/$1.lock" 2>/dev/null || true; }

ensure_worktree() {
  if [ -e "$WT/.git" ]; then return 0; fi
  git fetch -q origin "$BRANCH" 2>/dev/null || true
  if git show-ref -q --verify "refs/heads/$BRANCH"; then git worktree add -q "$WT" "$BRANCH"
  elif git show-ref -q --verify "refs/remotes/origin/$BRANCH"; then git worktree add -q -b "$BRANCH" "$WT" "origin/$BRANCH"
  else git worktree add -q --orphan -b "$BRANCH" "$WT"; fi
}

export_publish() {
  lock publish
  if [ "$LOOP_PUBLISH" = 1 ]; then
    if ! ensure_worktree >> "$LOG" 2>&1; then log "publish skipped: could not set up worktree $WT"; unlock publish; return 1; fi
    out="$WT/public-data"
  else
    out="$REPO/public-data"
  fi
  if ! run "${CLI[@]}" export --out "$out"; then log "export failed; nothing published"; unlock publish; return 1; fi
  if [ "$LOOP_PUBLISH" = 1 ]; then
    ts="$(date -u +%FT%TZ)"
    (cd "$WT" && git add public-data) >> "$LOG" 2>&1
    if (cd "$WT" && git diff --cached --quiet); then
      log "publish: no change"
    elif (cd "$WT" && git commit -q -m "data: $ts" && git push -q origin "$BRANCH") >> "$LOG" 2>&1; then
      log "published data: $ts"
    else
      log "publish failed (commit or push); will retry next hour"
    fi
  fi
  unlock publish
}

hourly() {
  if [ -e halt ]; then
    log "halt file present: skipping probe and settlement re-check"
  else
    run "${CLI[@]}" probe run --once || log "probe round failed; continuing"
    # Indeterminate and unconfirmed rows are re-checked for 24 h after a buy; moves no money.
    run "${CLI[@]}" buy resolve || true
    run "${CLI[@]}" buy reconcile --apply || true
  fi
  export_publish || true
}

wallet_pool_usd() {
  "${CLI[@]}" buy balances 2>>"$LOG" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s.slice(s.indexOf("{")));console.log(j.wallets.reduce((a,w)=>a+Number(w.usdc),0).toFixed(6))}catch{}})'
}

backup() {
  local day="$1" snap
  if [ -z "${BACKUP_BUCKET:-}" ] || [ "${BACKUP_BUCKET}" = REPLACE_WITH_BUCKET_FROM_PROVISION ]; then log "backup $day: skipped, BACKUP_BUCKET not set"; return 0; fi
  if ! command -v aws >/dev/null 2>&1; then log "backup $day: skipped, aws CLI not installed"; return 0; fi
  snap="$STATE/audit-$day.sqlite"
  rm -f "$snap" "$snap.gz"
  # SQLite online backup: consistent even while probe or buy is writing (WAL).
  if ! node -e 'const D=require("better-sqlite3");const db=new D(process.argv[1],{readonly:true});db.backup(process.argv[2]).then(()=>db.close(),(e)=>{console.error("backup: "+e.message);process.exit(1)})' data/audit.sqlite "$snap" >> "$LOG" 2>&1; then
    log "backup $day: snapshot failed"; rm -f "$snap"; return 1
  fi
  gzip -f "$snap"
  if run aws s3 cp --only-show-errors "$snap.gz" "s3://$BACKUP_BUCKET/audit/$day.sqlite.gz"; then log "backup $day: uploaded"; touch "$STATE/backup-$day"; else log "backup $day: upload failed"; fi
  rm -f "$snap.gz"
}

daily_buy() {
  local today="$1"
  sh -c 'echo $PPID' > "$STATE/buy.pid"
  log "daily buy $today: start (budget $LOOP_DAILY_USD USDC, per-call $LOOP_PER_CALL_USD)"
  if [ -e halt ] || [ -e halt-buy ]; then log "daily buy $today: skipped, halt or halt-buy file present"; return 0; fi
  live="${X402_AUDIT_LIVE:-$(grep -E '^X402_AUDIT_LIVE=' .env 2>/dev/null | tail -1 | cut -d= -f2)}"
  if [ "$live" != 1 ]; then log "daily buy $today: skipped, X402_AUDIT_LIVE is not 1"; return 0; fi
  if [ -n "$(git status --porcelain)" ]; then log "daily buy $today: skipped, working tree is dirty (the commit gate needs a clean, committed HEAD)"; return 0; fi
  if ! run pnpm gate; then log "daily buy $today: skipped, pnpm gate failed"; return 0; fi
  pool="$(wallet_pool_usd)"
  if [ -z "$pool" ]; then log "daily buy $today: skipped, could not read wallet balances"; return 0; fi
  if awk -v b="$pool" -v n="$LOOP_DAILY_USD" 'BEGIN { exit !(b + 0 < n + 0) }'; then
    log "daily buy $today: skipped, wallet pool holds $pool USDC, less than the day's budget $LOOP_DAILY_USD"; return 0
  fi
  seed="$(date -u +%Y%m%d)"
  log "daily buy $today: wallet pool $pool USDC, seed $seed"
  # The per-day cap counts every source since 00:00 UTC, so it is a hard ceiling on the day's spend.
  MAX_PER_CALL_USD="$LOOP_PER_CALL_USD" MAX_PER_DAY_USD="$LOOP_DAILY_USD" \
    run "${CLI[@]}" --live buy run --seed "$seed" --no-persist-tiers --budget-usd "$LOOP_DAILY_USD" --resume-since "${today}T00:00:00Z" --concurrency "$LOOP_BUY_CONCURRENCY" \
    || log "daily buy $today: buy run exited non-zero; continuing to settlement confirmation"
  run "${CLI[@]}" buy resolve || true
  run "${CLI[@]}" buy reconcile --apply || true
  run "${CLI[@]}" buy reclassify --apply --reason "loop: settlement confirmation after daily buy $today" || true
  export_publish || true
  backup "$today" || true
  log "daily buy $today: done"
}

maybe_daily() {
  local today hour
  today="$(date -u +%F)"; hour="$(date -u +%H)"
  [ "$(cat "$STATE/last-buy-date" 2>/dev/null)" = "$today" ] && return 0
  [ "$((10#$hour))" -lt "$LOOP_BUY_HOUR_UTC" ] && return 0
  if [ -f "$STATE/buy.pid" ] && kill -0 "$(cat "$STATE/buy.pid")" 2>/dev/null; then log "daily buy $today: previous buy still running; will check next hour"; return 0; fi
  echo "$today" > "$STATE/last-buy-date"   # once per UTC day, whether it buys or skips
  ( daily_buy "$today"; [ -f "$STATE/backup-$today" ] || backup "$today"; rm -f "$STATE/buy.pid" ) &
}

write_unit() {
  cat <<EOU
[Unit]
Description=paidfor x402-audit loop (hourly probe, daily gated buy, publish, backup)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$1
Group=$1
WorkingDirectory=$2
EnvironmentFile=/etc/paidfor/audit.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash $2/scripts/loop.sh
Restart=always
RestartSec=30
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOU
}

case "${1:-loop}" in
  loop)
    rm -rf "$STATE"/*.lock
    log "loop: start (daily $LOOP_DAILY_USD USDC at ${LOOP_BUY_HOUR_UTC}:00 UTC, per-call $LOOP_PER_CALL_USD, publish=$LOOP_PUBLISH)"
    trap 'log "loop: stopping"; kill $(jobs -p) 2>/dev/null; exit 0' INT TERM
    while true; do
      hourly
      maybe_daily
      sleep $((3600 - $(date +%s) % 3600 + 30)) & wait $!
    done ;;
  once)
    hourly ;;
  install)
    if [ "$(uname -s)" = Linux ]; then
      [ "$(id -u)" -eq 0 ] || { echo "run with sudo on Linux" >&2; exit 1; }
      [ -f /etc/paidfor/audit.env ] || echo "warning: /etc/paidfor/audit.env is missing; the service will not start until it exists" >&2
      write_unit "$(stat -c %U "$REPO")" "$REPO" > "$UNIT_FILE"
      chmod 644 "$UNIT_FILE"
      systemctl daemon-reload && systemctl enable --now "$UNIT" && echo "enabled $UNIT ($UNIT_FILE); log: $LOG"
      exit $?
    fi
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>/bin/bash</string><string>$REPO/scripts/loop.sh</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>LOOP_DAILY_USD</key><string>$LOOP_DAILY_USD</string>
    <key>LOOP_BUY_HOUR_UTC</key><string>$LOOP_BUY_HOUR_UTC</string>
  </dict>
</dict></plist>
EOP
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "loaded $LABEL ($PLIST); log: $LOG" ;;
  uninstall)
    if [ "$(uname -s)" = Linux ]; then
      [ "$(id -u)" -eq 0 ] || { echo "run with sudo on Linux" >&2; exit 1; }
      systemctl disable --now "$UNIT" 2>/dev/null || true; rm -f "$UNIT_FILE"; systemctl daemon-reload; echo "removed $UNIT"; exit 0
    fi
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "removed $LABEL" ;;
  status)
    if [ "$(uname -s)" = Linux ]; then
      systemctl status "$UNIT" --no-pager 2>/dev/null | head -5 || echo "$UNIT not installed"
    else
      launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" | head -5 || echo "$LABEL not loaded"
    fi
    tail -n 20 "$LOG" 2>/dev/null ;;
  unit)
    # Print the systemd unit for a given user and checkout (used by infra/aws/user-data.sh).
    write_unit "${2:-audit}" "${3:-/home/audit/x402-audit}" ;;
  *) echo "usage: $0 [loop|once|install|uninstall|status|unit]" >&2; exit 2 ;;
esac
