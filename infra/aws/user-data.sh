#!/bin/bash
# cloud-init user data for the paidfor-audit host (Ubuntu 24.04 arm64).
# Installs the toolchain, creates the `audit` system user, /etc/paidfor (mode 700), an SSH deploy key for `audit`,
# and the systemd unit (installed but DISABLED; the operator enables it after copying data and env files).
# Never writes secrets: /etc/paidfor/audit.env is copied in by the operator afterwards.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
apt-get install -y ca-certificates curl gnupg git build-essential python3 unzip sqlite3 jq

# Node 22 (NodeSource) and pnpm via corepack.
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
corepack enable
corepack prepare pnpm@10 --activate

# AWS CLI v2 (arm64).
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp && /tmp/aws/install --update && rm -rf /tmp/aws /tmp/awscliv2.zip

# System user that owns the checkout and runs the loop.
id audit >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/audit --shell /bin/bash audit

# Settings and secrets directory (root only; systemd reads EnvironmentFile as root before dropping to `audit`).
install -d -o root -g root -m 700 /etc/paidfor

# Two deploy keys, one per repository (GitHub accepts a deploy key for only one repo):
#   id_audit_read  -> sarmadahsan/x402-audit, read-only (clone and pull the harness)
#   id_data_write  -> sarmadahsan/paidfor-data, write (the loop publishes there)
# SSH host aliases make git offer the right key for each repo.
install -d -o audit -g audit -m 700 /home/audit/.ssh
sudo -u audit ssh-keygen -t ed25519 -N "" -C "paidfor-audit read x402-audit" -f /home/audit/.ssh/id_audit_read
sudo -u audit ssh-keygen -t ed25519 -N "" -C "paidfor-audit write paidfor-data" -f /home/audit/.ssh/id_data_write
cat > /home/audit/.ssh/config <<'EOS'
Host github-audit
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_audit_read
  IdentitiesOnly yes
Host github-data
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_data_write
  IdentitiesOnly yes
EOS
chown audit:audit /home/audit/.ssh/config && chmod 600 /home/audit/.ssh/config
ssh-keyscan -t ed25519,rsa,ecdsa github.com > /home/audit/.ssh/known_hosts 2>/dev/null
chown audit:audit /home/audit/.ssh/known_hosts && chmod 644 /home/audit/.ssh/known_hosts
sudo -u audit git config --global user.name "paidfor-audit"
sudo -u audit git config --global user.email "paidfor-audit@users.noreply.github.com"

# Foundry (anvil) so `pnpm gate` runs the integration suite instead of skipping it.
sudo -u audit bash -c 'curl -fsSL https://foundry.paradigm.xyz | bash && /home/audit/.foundry/bin/foundryup'

# systemd unit: same text as `scripts/loop.sh unit audit /home/audit/x402-audit`. Installed disabled.
cat > /etc/systemd/system/paidfor-audit.service <<'EOU'
[Unit]
Description=paidfor x402-audit loop (hourly probe, daily gated buy, publish, backup)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=audit
Group=audit
WorkingDirectory=/home/audit/x402-audit
EnvironmentFile=/etc/paidfor/audit.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash /home/audit/x402-audit/scripts/loop.sh
Restart=always
RestartSec=30
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOU
chmod 644 /etc/systemd/system/paidfor-audit.service
systemctl daemon-reload
systemctl disable paidfor-audit.service || true

touch /var/lib/paidfor-audit-bootstrap-done
