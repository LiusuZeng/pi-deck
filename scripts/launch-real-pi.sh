#!/usr/bin/env bash
set -euo pipefail

# Launch Pi Deck against a real local Pi RPC worker.
#
# Usage:
#   scripts/launch-real-pi.sh [project-dir]
#
# If [project-dir] is omitted, the current working directory is used as the
# project cwd for `pi --mode rpc`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_CWD="${1:-$PWD}"

if [[ ! -d "$PROJECT_CWD" ]]; then
  echo "Project directory does not exist: $PROJECT_CWD" >&2
  exit 1
fi

PROJECT_CWD="$(cd "$PROJECT_CWD" && pwd)"
PI_BINARY="${PI_DECK_PI_BINARY:-}"

if [[ -z "$PI_BINARY" ]]; then
  if command -v pi >/dev/null 2>&1; then
    PI_BINARY="$(command -v pi)"
  elif [[ -x /usr/local/bin/pi ]]; then
    PI_BINARY="/usr/local/bin/pi"
  elif [[ -x /opt/homebrew/bin/pi ]]; then
    PI_BINARY="/opt/homebrew/bin/pi"
  else
    echo "Could not find pi. Set PI_DECK_PI_BINARY=/absolute/path/to/pi and retry." >&2
    exit 1
  fi
fi

if [[ ! -x "$PI_BINARY" ]]; then
  echo "Pi binary is not executable: $PI_BINARY" >&2
  exit 1
fi

echo "Launching Pi Deck with real Pi backend"
echo "  Repo:    $REPO_ROOT"
echo "  Project: $PROJECT_CWD"
echo "  Pi:      $PI_BINARY"
echo

PI_DECK_BACKEND=real \
PI_DECK_PI_BINARY="$PI_BINARY" \
PI_DECK_PROJECT_CWD="$PROJECT_CWD" \
npm --prefix "$REPO_ROOT" run launch
