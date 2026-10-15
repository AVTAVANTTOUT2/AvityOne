#!/usr/bin/env bash
# Continuous deployment: deploys origin/<branch> whenever it moves. Run every minute by avityone-deploy.timer.
# Braces: bash parses the whole script before git rewrites it.
{
set -euo pipefail
BRANCH="${1:?usage: autodeploy.sh <branch>}"
cd "$(dirname "$0")/.."
STATE="${AVITY_HOME:-$HOME/.avityone}/deployed"
mkdir -p "$(dirname "$STATE")"
exec 9>"$STATE.lock" && flock 9   # one deploy at a time (timer vs manual run)

git fetch -q origin "$BRANCH"
TARGET="$(git rev-parse FETCH_HEAD)"
[[ "$(cat "$STATE" 2>/dev/null)" == "$TARGET" ]] && exit 0

echo "Déploiement de $BRANCH @ ${TARGET:0:7}"
git checkout -qf -B "$BRANCH" "$TARGET"
bash deploy/install.sh "$BRANCH"
# Written only after a successful install: a failed deploy is retried on the next tick.
echo "$TARGET" > "$STATE"
exit
}
