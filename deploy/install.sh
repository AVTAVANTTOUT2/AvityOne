#!/usr/bin/env bash
# Installs (or updates) AvityOne as a systemd service running as the current user. Run from the repo checkout.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD"

sed -e "s|@USER@|$USER|g" -e "s|@HOME@|$HOME|g" -e "s|@APP@|$APP|g" deploy/avityone.service \
  | sudo tee /etc/systemd/system/avityone.service >/dev/null

mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec node %s/src/cli.ts "$@"\n' "$APP" > "$HOME/.local/bin/avity"
chmod +x "$HOME/.local/bin/avity"

sudo systemctl daemon-reload
sudo systemctl enable avityone >/dev/null 2>&1
sudo systemctl restart avityone
sleep 2
systemctl --no-pager --lines=5 status avityone || true
echo
echo "UI : http://$(hostname -I | awk '{print $1}'):7710"
echo "Token : jq -r .token ~/.avityone/config.json"
