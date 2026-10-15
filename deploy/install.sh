#!/usr/bin/env bash
# Installs (or updates) AvityOne as a systemd service running as the current user. Run from the repo checkout.
# Optional branch (preprod, main): also installs the timer that redeploys origin/<branch> on every new commit.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="$PWD"
BRANCH="${1:-}"

# Web UI: React + Vite, built here (dev dependencies only, the server itself has none).
npm ci --no-audit --no-fund --loglevel=error
npm run build --silent

for unit in avityone.service ${BRANCH:+avityone-deploy.service avityone-deploy.timer}; do
  sed -e "s|@USER@|$USER|g" -e "s|@HOME@|$HOME|g" -e "s|@APP@|$APP|g" -e "s|@BRANCH@|$BRANCH|g" "deploy/$unit" \
    | sudo tee "/etc/systemd/system/$unit" >/dev/null
done

mkdir -p "$HOME/.local/bin"
printf '#!/bin/sh\nexec node %s/src/cli.ts "$@"\n' "$APP" > "$HOME/.local/bin/avity"
chmod +x "$HOME/.local/bin/avity"

sudo systemctl daemon-reload
sudo systemctl enable avityone >/dev/null 2>&1
if [[ -n "$BRANCH" ]]; then sudo systemctl enable --now avityone-deploy.timer >/dev/null 2>&1; fi
sudo systemctl restart avityone
sleep 2
# Fails (and autodeploy retries) when the server does not come up.
systemctl --no-pager --lines=5 status avityone
echo
echo "UI : http://$(hostname -I | awk '{print $1}'):7710"
echo "Token : jq -r .token ~/.avityone/config.json"
