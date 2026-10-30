#!/usr/bin/env bash
# Keeps the public index alive without an operator.
#   hourly : one probe round over the current probe set, settlement re-check (moves no money), export, publish
#   6-hour : at each hour in LOOP_RUN_HOURS_UTC (00, 06, 12, 18), a gated live buy with coverage-first allocation
#            (--allocation coverage: COVERAGE_SHARE of the run to sellers below 30 calls, the rest to maintenance; every
#            planned call written to run_allocations before signing) plus the expensive-sellers lane and, when
#            CANDIDATE_BUYS_ENABLED=1, queued candidates: per-run cap LOOP_RUN_USD, per-call cap LOOP_PER_CALL_USD,
#            per-seller cap MAX_PER_SELLER_PER_DAY_USD / runs, scheduled-buy day budget LOOP_DAILY_USD (MAX_PER_DAY_USD
#            stays the all-sources backstop); then settlement confirmation and the free candidate import (discover
#            import-candidates). After the LOOP_AUDIT_HOUR_UTC run only: audit-triggers (records its decisions; buys only
#            with AUDIT_TRIGGERS_ENABLED=1), and on weekday LOOP_BREADTH_WEEKDAY_UTC the breadth run (buys only with
#            BREADTH_RUN_ENABLED=1). After the 00:00 run only: discover refresh (free). Then export, publish.
#   publish: export into the root of a worktree at data/paidfor-data (orphan branch paidfor-data-main), then
#            git add -A && git commit -m "data: <timestamp>" && git push to main of the public repo
#            sarmadahsan/paidfor-data (remote "paidfor-data"). The main checkout stays clean for the commit gate.
#            The old public-data branch of this repo is no longer updated.
# Every existing gate stays: --live, X402_AUDIT_LIVE=1, --network eip155:8453, `pnpm gate` on a clean committed HEAD,
# the MAX_* caps, and the halt / halt-buy / halt-probe files. A skipped step is logged; the loop itself never stops.
#
# Usage: scripts/loop.sh            run the loop in the foreground (what launchd runs)
#        scripts/loop.sh once       one hourly cycle now, then exit
#        scripts/loop.sh dry-run-buy    print what the current slot's scheduled buy would buy; spends nothing
#        scripts/loop.sh dry-run-audit  print (and record as dry_run) the audits the index would trigger now
#        scripts/loop.sh dry-run-breadth  print what the weekly breadth run would buy; spends nothing
#        scripts/loop.sh install    macOS: write and load the launchd agent (com.x402audit.loop)
#                                   Linux: (sudo) write /etc/systemd/system/paidfor-audit.service and enable it
#        scripts/loop.sh uninstall  stop and remove the agent or service
#        scripts/loop.sh status     agent or service state and the last log lines
#        scripts/loop.sh health [trigger] [--dry-run]  post machine and loop health to the index now (--dry-run prints it)
# On Linux every setting and secret comes from /etc/paidfor/audit.env (systemd EnvironmentFile); nothing logs them.
# health : after every probe round, buy and export/publish, `x402-audit health` posts machine and loop state to
#          {PAIDFOR_INDEX_URL}/v1/admin/health, signed with AUDIT_SECRET like the audit callback; on Linux a systemd timer
#          (paidfor-audit-health.timer, written by install) also posts every 15 minutes. A failed post never changes the loop.
# backup : after the first scheduled run of the UTC day, a consistent snapshot of data/audit.sqlite is gzipped and copied to
#          s3://$BACKUP_BUCKET/audit/<date>.sqlite.gz (skipped and logged when BACKUP_BUCKET or the aws CLI is missing).
# Env:   LOOP_RUN_USD (1.00)  LOOP_RUN_HOURS_UTC ("0 6 12 18")  LOOP_AUDIT_HOUR_UTC (12)  LOOP_DAILY_USD (4.00)
#        LOOP_PER_CALL_USD (0.10)  LOOP_BUY_CONCURRENCY (4)  (LOOP_BUY_HOUR_UTC is no longer used)
#        LOOP_REFRESH_HOUR_UTC (0)  LOOP_BREADTH_WEEKDAY_UTC (1 = Monday, `date -u +%u`)
#        LOOP_CAP_OVERRIDE_UNTIL_UTC + LOOP_CAP_OVERRIDE_RUN_USD + LOOP_CAP_OVERRIDE_DAILY_USD: a dated, operator-approved
#        override of LOOP_RUN_USD and LOOP_DAILY_USD, honoured only while now is before the until time (evaluated at every
#        scheduled run, so the revert is automatic); `scripts/loop.sh caps [epoch]` prints what applies at a moment.
#        COVERAGE_SHARE, BREADTH_RUN_ENABLED, BREADTH_MAX_PER_CALL_USD, BREADTH_WEEKLY_USD are read by the CLI.
#        LOOP_PUBLISH (1; 0 = export but do not commit or push)  BACKUP_BUCKET (unset = no backup)
#        LOOP_PUBLISH_URL (https://github.com/sarmadahsan/paidfor-data.git; the server uses the SSH alias
#        git@github-data:sarmadahsan/paidfor-data.git so its write deploy key for that repo is offered)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$REPO" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

LOOP_DAILY_USD="${LOOP_DAILY_USD:-4.00}"
LOOP_PER_CALL_USD="${LOOP_PER_CALL_USD:-0.10}"
LOOP_RUN_USD="${LOOP_RUN_USD:-1.00}"
LOOP_RUN_HOURS_UTC="${LOOP_RUN_HOURS_UTC:-0 6 12 18}"
LOOP_AUDIT_HOUR_UTC="${LOOP_AUDIT_HOUR_UTC:-12}"
LOOP_BUY_CONCURRENCY="${LOOP_BUY_CONCURRENCY:-4}"
LOOP_REFRESH_HOUR_UTC="${LOOP_REFRESH_HOUR_UTC:-0}"
LOOP_BREADTH_WEEKDAY_UTC="${LOOP_BREADTH_WEEKDAY_UTC:-1}"
LOOP_PUBLISH="${LOOP_PUBLISH:-1}"
NETWORK="eip155:8453"
LOG="$REPO/data/loop.log"
STATE="$REPO/data/loop-state"
PUB_URL="${LOOP_PUBLISH_URL:-https://github.com/sarmadahsan/paidfor-data.git}"
PUB_REMOTE="paidfor-data"
PUB_DIR="$REPO/data/paidfor-data"
PUB_LOCAL_BRANCH="paidfor-data-main"
# Commits to the public repo carry a neutral identity, never the operator's own name or email.
PUB_IDENT=(env GIT_AUTHOR_NAME=paidfor-audit GIT_AUTHOR_EMAIL=paidfor-audit@users.noreply.github.com GIT_COMMITTER_NAME=paidfor-audit GIT_COMMITTER_EMAIL=paidfor-audit@users.noreply.github.com)
LABEL="com.x402audit.loop"
UNIT="paidfor-audit"
UNIT_FILE="/etc/systemd/system/$UNIT.service"
HEALTH_UNIT="paidfor-audit-health"
HEALTH_SERVICE_FILE="/etc/systemd/system/$HEALTH_UNIT.service"
HEALTH_TIMER_FILE="/etc/systemd/system/$HEALTH_UNIT.timer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
CLI=(pnpm -s tsx src/cli.ts --db data/audit.sqlite --network "$NETWORK")
mkdir -p "$STATE"

log() { echo "$(date -u +%FT%TZ) [$$] $*" >> "$LOG"; }
run() { log "run: $*"; "$@" >> "$LOG" 2>&1; local rc=$?; [ "$rc" -ne 0 ] && log "exit $rc: $*"; return "$rc"; }
lock() { until mkdir "$STATE/$1.lock" 2>/dev/null; do sleep 5; done; }
unlock() { rmdir "$STATE/$1.lock" 2>/dev/null || true; }
# Health post after a step (trigger probe|buy|export). Not through `run`, so the log tail it sends is the step that just
# ran, not itself; bounded in time where `timeout` exists; its output goes to the log and its exit status is ignored.
health_post() {
  local t=()
  command -v timeout >/dev/null 2>&1 && t=(timeout 180)
  ${t[@]+"${t[@]}"} "${CLI[@]}" health --trigger "$1" >> "$LOG" 2>&1 || true
}

# Worktree for the public data repo: an orphan branch of this repo whose upstream is main of paidfor-data.
# Before every export it is reset to the remote's main, so any publisher (laptop or server) fast-forwards.
ensure_pub_worktree() {
  if git remote get-url "$PUB_REMOTE" >/dev/null 2>&1; then git remote set-url "$PUB_REMOTE" "$PUB_URL"; else git remote add "$PUB_REMOTE" "$PUB_URL"; fi
  local have_remote=0
  git fetch -q "$PUB_REMOTE" main 2>/dev/null && git show-ref -q --verify "refs/remotes/$PUB_REMOTE/main" && have_remote=1
  if [ ! -e "$PUB_DIR/.git" ]; then
    if [ "$have_remote" = 1 ]; then git worktree add -q -B "$PUB_LOCAL_BRANCH" "$PUB_DIR" "$PUB_REMOTE/main"
    else git worktree add -q --orphan -b "$PUB_LOCAL_BRANCH" "$PUB_DIR"; fi
  elif [ "$have_remote" = 1 ]; then
    git -C "$PUB_DIR" reset -q --hard "$PUB_REMOTE/main"
  fi
}

export_publish() {
  local rc=0
  export_publish_once || rc=$?
  health_post export
  return "$rc"
}

export_publish_once() {
  lock publish
  if [ "$LOOP_PUBLISH" = 1 ]; then
    if ! ensure_pub_worktree >> "$LOG" 2>&1; then log "publish skipped: could not set up worktree $PUB_DIR"; unlock publish; return 1; fi
    out="$PUB_DIR"
  else
    out="$REPO/public-data"
  fi
  if ! run "${CLI[@]}" export --out "$out"; then log "export failed; nothing published"; unlock publish; return 1; fi
  if [ "$LOOP_PUBLISH" = 1 ]; then
    ts="$(date -u +%FT%TZ)"
    git -C "$PUB_DIR" add -A >> "$LOG" 2>&1
    if git -C "$PUB_DIR" diff --cached --quiet; then
      log "publish: no change"
    elif ("${PUB_IDENT[@]}" git -C "$PUB_DIR" commit -q -m "data: $ts" && git -C "$PUB_DIR" push -q "$PUB_REMOTE" "HEAD:main") >> "$LOG" 2>&1; then
      log "published data: $ts to $PUB_REMOTE main"
    else
      log "publish failed (commit or push to $PUB_REMOTE); will retry next hour"
    fi
  fi
  unlock publish
}

hourly() {
  if [ -e halt ]; then
    log "halt file present: skipping probe and settlement re-check"
  else
    run "${CLI[@]}" probe run --once || log "probe round failed; continuing"
    health_post probe
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

runs_per_day() { set -- $LOOP_RUN_HOURS_UTC; echo "$#"; }

# Effective per-run and daily budget at epoch $1 (default now): the dated override while it is in force, else the base
# LOOP_RUN_USD / LOOP_DAILY_USD. Sets RUN_USD, DAILY_USD and CAP_NOTE. An unreadable until time means no override.
effective_caps() {
  local at="${1:-$(date -u +%s)}" until_s=""
  RUN_USD="$LOOP_RUN_USD"; DAILY_USD="$LOOP_DAILY_USD"; CAP_NOTE="base"
  [ -z "${LOOP_CAP_OVERRIDE_UNTIL_UTC:-}" ] && return 0
  until_s="$(node -e 'const t=Date.parse(process.argv[1]);process.stdout.write(Number.isFinite(t)?String(Math.floor(t/1000)):"")' "$LOOP_CAP_OVERRIDE_UNTIL_UTC")"
  if [ -z "$until_s" ]; then CAP_NOTE="base (override until '$LOOP_CAP_OVERRIDE_UNTIL_UTC' is not a date; ignored)"; return 0; fi
  if [ "$at" -lt "$until_s" ]; then
    RUN_USD="${LOOP_CAP_OVERRIDE_RUN_USD:-$LOOP_RUN_USD}"; DAILY_USD="${LOOP_CAP_OVERRIDE_DAILY_USD:-$LOOP_DAILY_USD}"
    CAP_NOTE="override until $LOOP_CAP_OVERRIDE_UNTIL_UTC"
  else
    CAP_NOTE="base (override ended $LOOP_CAP_OVERRIDE_UNTIL_UTC)"
  fi
}

# A scheduled buy that does not go ahead still leaves a `buy run` row (status skipped, the reason in notes), a health
# post and an export, so `last_buy_run` in the export and the buy tile on the dashboard show the skip instead of the
# previous run. (2026-10-30 00:00 UTC: `pnpm gate` failed and the slot passed with only a line in this log.)
skipped_buy() {
  local today="$1" hh="$2" reason="$3"
  log "scheduled buy $today $hh:00: skipped, $reason"
  run "${CLI[@]}" buy skipped --slot "${today}T${hh}" --reason "$reason" || log "scheduled buy $today $hh:00: could not record the skip; continuing"
  health_post buy
  export_publish || true
  log "scheduled buy $today $hh:00: done (skipped)"
}

# The scheduled buy for one run slot. `live` = 1 spends (every gate below must pass); 0 prints the plan (dry run).
buy_args() {
  local seed="$1" since="$2"
  effective_caps
  echo --seed "$seed" --no-persist-tiers --budget-usd "$RUN_USD" --run-usd "$RUN_USD" --per-call-usd "$LOOP_PER_CALL_USD" \
    --runs-per-day "$(runs_per_day)" --day-budget-usd "$DAILY_USD" --resume-since "$since" --concurrency "$LOOP_BUY_CONCURRENCY" --expensive --candidates \
    --allocation coverage
}

# The weekly breadth run: its own budget (BREADTH_WEEKLY_USD) and per-call cap (BREADTH_MAX_PER_CALL_USD); --per-call-usd is the
# scheduled cap that decides which sellers it is for. Buys only with BREADTH_RUN_ENABLED=1; otherwise prints its plan.
breadth_args() {
  echo --breadth --per-call-usd "$LOOP_PER_CALL_USD" --concurrency "$LOOP_BUY_CONCURRENCY"
}

scheduled_buy() {
  local today="$1" hh="$2" since seed
  since="${today}T${hh}:00:00Z"
  seed="$(date -u +%Y%m%d)${hh}"   # a fresh seed per run, so the tail sample and each seller's calls spread across runs
  sh -c 'echo $PPID' > "$STATE/buy.pid"
  effective_caps
  log "scheduled buy $today $hh:00: start (run cap $RUN_USD USDC, per-call $LOOP_PER_CALL_USD, day budget $DAILY_USD; $CAP_NOTE)"
  if [ -e halt ] || [ -e halt-buy ]; then skipped_buy "$today" "$hh" "halt or halt-buy file present"; return 0; fi
  live="${X402_AUDIT_LIVE:-$(grep -E '^X402_AUDIT_LIVE=' .env 2>/dev/null | tail -1 | cut -d= -f2)}"
  if [ "$live" != 1 ]; then skipped_buy "$today" "$hh" "X402_AUDIT_LIVE is not 1"; return 0; fi
  if [ -n "$(git status --porcelain)" ]; then skipped_buy "$today" "$hh" "working tree is dirty (the commit gate needs a clean, committed HEAD)"; return 0; fi
  if ! run pnpm gate; then skipped_buy "$today" "$hh" "pnpm gate failed"; return 0; fi
  pool="$(wallet_pool_usd)"
  if [ -z "$pool" ]; then skipped_buy "$today" "$hh" "could not read wallet balances"; return 0; fi
  if awk -v b="$pool" -v n="$RUN_USD" 'BEGIN { exit !(b + 0 < n + 0) }'; then
    skipped_buy "$today" "$hh" "wallet pool holds $pool USDC, less than the run cap $RUN_USD"; return 0
  fi
  log "scheduled buy $today $hh:00: wallet pool $pool USDC, seed $seed"
  # shellcheck disable=SC2046
  run "${CLI[@]}" --live buy run $(buy_args "$seed" "$since") \
    || log "scheduled buy $today $hh:00: buy run exited non-zero; continuing to settlement confirmation"
  health_post buy
  run "${CLI[@]}" buy resolve || true
  run "${CLI[@]}" buy reconcile --apply || true
  run "${CLI[@]}" buy reclassify --apply --reason "loop: settlement confirmation after scheduled buy $today $hh:00" || true
  # Free: import and probe user candidates after every run, so queued ones enter the next one.
  run "${CLI[@]}" discover import-candidates --per-call-usd "$LOOP_PER_CALL_USD" || log "candidate import failed; continuing"
  if [ "$((10#$hh))" -eq "$((10#$LOOP_AUDIT_HOUR_UTC))" ]; then
    # Records every decision; spends only when AUDIT_TRIGGERS_ENABLED=1 (and the live gates above).
    run "${CLI[@]}" --live audit-triggers || log "audit-triggers $today: exited non-zero"
    if [ "$(date -u +%u)" = "$LOOP_BREADTH_WEEKDAY_UTC" ]; then
      # Weekly; buys only with BREADTH_RUN_ENABLED=1, otherwise logs its plan.
      # shellcheck disable=SC2046
      run "${CLI[@]}" --live buy run $(breadth_args) || log "breadth run $today: exited non-zero"
      health_post buy
      run "${CLI[@]}" buy resolve || true
      run "${CLI[@]}" buy reclassify --apply --reason "loop: settlement confirmation after breadth run $today" || true
    fi
  fi
  if [ "$((10#$hh))" -eq "$((10#$LOOP_REFRESH_HOUR_UTC))" ]; then
    # Free: Bazaar recrawl, seed hosts, unmapped facilitator payees; new sellers join the probe set for the next hour.
    run "${CLI[@]}" discover refresh || log "discover refresh $today: exited non-zero"
  fi
  export_publish || true
  log "scheduled buy $today $hh:00: done"
}

# The latest run slot at or before `hour`, zero-padded, or empty before the first slot of the day.
current_slot() {
  local hour="$1" best="" h
  for h in $LOOP_RUN_HOURS_UTC; do [ "$((10#$h))" -le "$((10#$hour))" ] && best="$(printf %02d "$((10#$h))")"; done
  echo "$best"
}

maybe_scheduled() {
  local today hour slot key
  today="$(date -u +%F)"; hour="$(date -u +%H)"
  slot="$(current_slot "$hour")"
  [ -z "$slot" ] && return 0
  key="${today}T${slot}"
  if [ ! -f "$STATE/last-buy-slot" ]; then
    # First start on the six-hourly schedule: the next boundary is the first run, never a catch-up buy at deploy time.
    echo "$key" > "$STATE/last-buy-slot"; log "schedule: first start; next scheduled buy at the next boundary in ($LOOP_RUN_HOURS_UTC) UTC"; return 0
  fi
  [ "$(cat "$STATE/last-buy-slot" 2>/dev/null)" = "$key" ] && return 0
  if [ -f "$STATE/buy.pid" ] && kill -0 "$(cat "$STATE/buy.pid")" 2>/dev/null; then log "scheduled buy $key: previous buy still running; will check next hour"; return 0; fi
  echo "$key" > "$STATE/last-buy-slot"   # once per slot, whether it buys or skips
  ( scheduled_buy "$today" "$slot"; [ -f "$STATE/backup-$today" ] || backup "$today"; rm -f "$STATE/buy.pid" ) &
}

write_unit() {
  cat <<EOU
[Unit]
Description=paidfor x402-audit loop (hourly probe, six-hourly gated buy, audit triggers, discovery, publish, backup)
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

# The 15-minute health post on Linux: a oneshot service and its timer, same user, checkout and env file as the loop.
write_health_service() {
  cat <<EOU
[Unit]
Description=paidfor x402-audit health post (machine and loop state to the index; moves no money)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$1
Group=$1
WorkingDirectory=$2
EnvironmentFile=/etc/paidfor/audit.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash $2/scripts/loop.sh health timer
TimeoutStartSec=300
EOU
}

write_health_timer() {
  cat <<EOU
[Unit]
Description=paidfor x402-audit health post every 15 minutes

[Timer]
OnCalendar=*:0/15
AccuracySec=30s
Unit=$HEALTH_UNIT.service

[Install]
WantedBy=timers.target
EOU
}

# Test hook: `LOOP_SOURCE_ONLY=1 . scripts/loop.sh` defines the functions above and returns without running anything.
[ "${LOOP_SOURCE_ONLY:-0}" = 1 ] && return 0

case "${1:-loop}" in
  loop)
    rm -rf "$STATE"/*.lock
    effective_caps
    log "loop: start (runs at ($LOOP_RUN_HOURS_UTC) UTC, $RUN_USD USDC per run, day budget $DAILY_USD ($CAP_NOTE), per-call $LOOP_PER_CALL_USD, audits after ${LOOP_AUDIT_HOUR_UTC}:00, publish=$LOOP_PUBLISH)"
    trap 'log "loop: stopping"; kill $(jobs -p) 2>/dev/null; exit 0' INT TERM
    while true; do
      hourly
      maybe_scheduled
      sleep $((3600 - $(date +%s) % 3600 + 30)) & wait $!
    done ;;
  once)
    hourly ;;
  dry-run-buy)
    # What the next scheduled run would buy, without spending: the same command without --live (no gate needed).
    today="$(date -u +%F)"; slot="$(current_slot "$(date -u +%H)")"; slot="${slot:-00}"
    # shellcheck disable=SC2046
    "${CLI[@]}" buy run $(buy_args "$(date -u +%Y%m%d)$slot" "${today}T${slot}:00:00Z") ;;
  dry-run-audit)
    # Planned audits from the live index, recorded as dry_run decisions; spends nothing.
    "${CLI[@]}" audit-triggers ;;
  caps)
    # What applies at epoch $2 (default now): `scripts/loop.sh caps 1793836800` (2026-11-05 00:00 UTC).
    effective_caps "${2:-}"; echo "run_usd=$RUN_USD daily_usd=$DAILY_USD ($CAP_NOTE)" ;;
  dry-run-breadth)
    # shellcheck disable=SC2046
    "${CLI[@]}" buy run $(breadth_args) ;;
  install)
    if [ "$(uname -s)" = Linux ]; then
      [ "$(id -u)" -eq 0 ] || { echo "run with sudo on Linux" >&2; exit 1; }
      [ -f /etc/paidfor/audit.env ] || echo "warning: /etc/paidfor/audit.env is missing; the service will not start until it exists" >&2
      write_unit "$(stat -c %U "$REPO")" "$REPO" > "$UNIT_FILE"
      write_health_service "$(stat -c %U "$REPO")" "$REPO" > "$HEALTH_SERVICE_FILE"
      write_health_timer > "$HEALTH_TIMER_FILE"
      chmod 644 "$UNIT_FILE" "$HEALTH_SERVICE_FILE" "$HEALTH_TIMER_FILE"
      systemctl daemon-reload && systemctl enable --now "$UNIT" && echo "enabled $UNIT ($UNIT_FILE); log: $LOG" \
        && systemctl enable --now "$HEALTH_UNIT.timer" && echo "enabled $HEALTH_UNIT.timer ($HEALTH_TIMER_FILE, every 15 minutes)"
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
    <key>LOOP_RUN_USD</key><string>$LOOP_RUN_USD</string>
  </dict>
</dict></plist>
EOP
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "loaded $LABEL ($PLIST); log: $LOG" ;;
  uninstall)
    if [ "$(uname -s)" = Linux ]; then
      [ "$(id -u)" -eq 0 ] || { echo "run with sudo on Linux" >&2; exit 1; }
      systemctl disable --now "$HEALTH_UNIT.timer" 2>/dev/null || true; rm -f "$HEALTH_TIMER_FILE" "$HEALTH_SERVICE_FILE"
      systemctl disable --now "$UNIT" 2>/dev/null || true; rm -f "$UNIT_FILE"; systemctl daemon-reload; echo "removed $UNIT and $HEALTH_UNIT.timer"; exit 0
    fi
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "removed $LABEL" ;;
  status)
    if [ "$(uname -s)" = Linux ]; then
      systemctl status "$UNIT" --no-pager 2>/dev/null | head -5 || echo "$UNIT not installed"
      systemctl list-timers "$HEALTH_UNIT.timer" --no-pager 2>/dev/null | head -2 || true
    else
      launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" | head -5 || echo "$LABEL not loaded"
    fi
    tail -n 20 "$LOG" 2>/dev/null ;;
  unit)
    # Print the systemd unit for a given user and checkout (used by infra/aws/user-data.sh).
    write_unit "${2:-audit}" "${3:-/home/audit/x402-audit}" ;;
  health-units)
    # Print the health service and timer for a given user and checkout (what install writes).
    write_health_service "${2:-audit}" "${3:-/home/audit/x402-audit}"; echo; write_health_timer ;;
  health)
    # One health post now: `scripts/loop.sh health [timer|probe|buy|export|manual] [--dry-run]` (the timer runs `health timer`).
    t="${2:-manual}"; shift; shift || true
    "${CLI[@]}" health --trigger "$t" "$@" ;;
  *) echo "usage: $0 [loop|once|caps|dry-run-buy|dry-run-audit|dry-run-breadth|install|uninstall|status|unit|health-units|health]" >&2; exit 2 ;;
esac
