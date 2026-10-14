#!/usr/bin/env bash
# Provision a fresh Debian 13 VM for AvityOne (idempotent). Run as the service user (needs sudo).
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates tmux ripgrep jq >/dev/null

if ! command -v node >/dev/null || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi

# Global npm packages live in ~/.local so agents can self-update without sudo.
npm config set prefix "$HOME/.local"
grep -q '.local/bin' "$HOME/.profile" 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"
export PATH="$HOME/.local/bin:$PATH"

# Agent CLIs. claude/codex npm packages self-install native binaries into ~/.local/bin,
# so they go one at a time (a bin-link clash would roll back a combined install).
command -v claude >/dev/null || npm install -g @anthropic-ai/claude-code || true
command -v codex >/dev/null || npm install -g @openai/codex || true
command -v agent >/dev/null || curl -fsS https://cursor.com/install | bash
# ACP adapters (Cursor and OpenCode speak ACP natively).
npm install -g @agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp opencode-ai

for c in node claude claude-agent-acp codex codex-acp opencode agent; do
  printf '%-18s %s\n' "$c" "$(command -v $c || echo MISSING)"
done
