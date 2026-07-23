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
  echo " Node.js is the runtime Atelier is built on. To install it,"
  echo " paste ONE of these into this same terminal and press Enter:"
  echo
  case "$(uname -s)" in
    Darwin)
      echo "     brew install node          # if you use Homebrew"
      echo "     (or download the installer from https://nodejs.org)"
      ;;
    MINGW* | MSYS*)
      echo "     winget install OpenJS.NodeJS.LTS   # Windows (Git Bash)"
      echo "     (or download the installer from https://nodejs.org)"
      ;;
    *)
      echo "     sudo apt install nodejs npm   # Debian/Ubuntu"
      echo "     (or your distro's package manager / https://nodejs.org)"
      ;;
  esac
  echo
  echo " When it finishes, run ./run.sh again from this folder."
  exit 10
fi

exec node scripts/bootstrap.mjs "$@"
