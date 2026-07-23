#!/usr/bin/env bash
# Atelier launcher (macOS/Linux). One job: find Node, then hand off everything to
# scripts/bootstrap.mjs (checks deps, Claude CLI, login, build; then starts the app).
# Usage: ./run.sh [dev|doctor] [--yes] [--no-launch]
set -euo pipefail
cd "$(dirname "$0")"

# Tell bootstrap.mjs which shell it's really in, so its instructions match (winget vs apt vs brew,
# curl vs irm, ./run.sh vs run.bat). uname distinguishes Git Bash (MINGW/MSYS) on Windows from a
# real *nix; WSL is Linux with a distro name set.
case "$(uname -s)" in
  MINGW* | MSYS*) export ATELIER_SHELL=git-bash ;;
  Darwin) export ATELIER_SHELL=macos ;;
  *) if [ -n "${WSL_DISTRO_NAME:-}" ]; then export ATELIER_SHELL=wsl; else export ATELIER_SHELL=shell; fi ;;
esac

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
  echo " Node.js is the runtime Atelier is built on. Atelier needs version"
  echo " 20.19+ or 22.12+."
  echo
  echo " The reliable way that works on every system:"
  echo "     Download the LTS installer from https://nodejs.org and run it."
  echo
  # Only suggest a package manager we can SEE is installed here, and only ones that ship a
  # current Node (brew / winget / nvm). We deliberately do not print a distro apt/dnf command:
  # it may be absent (wrong distro) or too old, which would loop the user back here.
  shown=0
  if command -v brew >/dev/null 2>&1; then
    echo " Or, since Homebrew is installed here:   brew install node"
    shown=1
  fi
  if command -v winget >/dev/null 2>&1; then
    echo " Or, since winget is installed here:     winget install OpenJS.NodeJS.LTS"
    shown=1
  fi
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    echo " Or, since nvm is installed here:        nvm install --lts"
    shown=1
  fi
  if [ "$shown" -eq 0 ]; then
    echo " (Prefer a version manager? Install nvm from https://github.com/nvm-sh/nvm,"
    echo "  then run: nvm install --lts)"
  fi
  echo
  echo " When it finishes, open a fresh terminal and run ./run.sh again from"
  echo " this folder."
  exit 10
fi

exec node scripts/bootstrap.mjs "$@"
