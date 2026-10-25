#!/usr/bin/env bash
# Installs a user-level launchd agent that keeps `x402-audit probe run` alive:
#  - restarts it if it crashes or exits (KeepAlive),
#  - starts it at login/boot (RunAtLoad),
#  - keeps it STOPPED while the repo-root `halt` file exists (KeepAlive.PathState), so the brief's halt
#    semantics still hold; the job itself also exits on `halt-probe`, and launchd then restarts it only
#    when that file is gone (checked by the wrapper below).
# Usage: scripts/install-probe-agent.sh [install|uninstall|status]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.x402audit.probe"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
WRAPPER="$REPO/scripts/probe-agent.sh"
PNPM="$(command -v pnpm)"
case "${1:-install}" in
  install)
    cat > "$WRAPPER" <<EOW
#!/usr/bin/env bash
# Run by launchd. Waits while a job-specific halt-probe file exists, then runs the hourly probe loop.
cd "$REPO"
while [ -e halt-probe ]; do sleep 30; done
exec "$PNPM" tsx src/cli.ts --db data/audit.sqlite --network eip155:8453 probe run --every-minutes 60
EOW
    chmod +x "$WRAPPER"
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOP
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$WRAPPER</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict>
    <key>PathState</key><dict><key>$REPO/halt</key><false/></dict>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$REPO/data/probe-loop.log</string>
  <key>StandardErrorPath</key><string>$REPO/data/probe-loop.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$PNPM"):/usr/local/bin:/usr/bin:/bin</string></dict>
</dict></plist>
EOP
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "installed $LABEL (plist: $PLIST)"; launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|pid" | head -3 ;;
  uninstall)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "removed $LABEL" ;;
  status)
    launchctl print "gui/$(id -u)/$LABEL" | grep -E "state|pid|last exit" | head -5 ;;
esac
