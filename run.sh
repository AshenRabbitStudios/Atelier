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
  echo "============================================================"
  echo " Atelier needs Node.js, which was not found on this machine."
  echo "============================================================"
  echo
  echo " Node.js is the runtime Atelier is built on. To install it,"
  echo " paste ONE of these into this same terminal and press Enter:"
  echo
  if [ "$(uname)" = "Darwin" ]; then
    echo "     brew install node          # if you use Homebrew"
    echo "     (or download the installer from https://nodejs.org)"
  else
    echo "     sudo apt install nodejs npm   # Debian/Ubuntu"
    echo "     (or your distro's package manager / https://nodejs.org)"
  fi
  echo
  echo " When it finishes, run ./run.sh again from this folder."
  exit 10
fi

exec node scripts/bootstrap.mjs "$@"
