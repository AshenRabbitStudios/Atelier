#!/usr/bin/env bash
# Atelier launcher (macOS/Linux). One job: find Node, then hand off everything to
# scripts/bootstrap.mjs (checks deps, Claude CLI, login, build; then starts the app).
# Usage: ./run.sh [dev|doctor] [--yes] [--no-launch]
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  # Common install locations that may not be on a non-interactive PATH.
  for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.local/bin"; do
    [ -x "$dir/node" ] && PATH="$dir:$PATH" && break
  done
  # Latest nvm-installed Node, if any.
  if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
    latest=$(ls -1 "$HOME/.nvm/versions/node" | sort -V | tail -n 1)
    [ -n "$latest" ] && PATH="$HOME/.nvm/versions/node/$latest/bin:$PATH"
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found on this machine."
  if [ "$(uname)" = "Darwin" ]; then
    echo "Install it with:   brew install node"
  else
    echo "Install it via your package manager or https://nodejs.org"
  fi
  echo "Then run ./run.sh again."
  exit 10
fi

exec node scripts/bootstrap.mjs "$@"
