#!/usr/bin/env bash
set -euo pipefail

# Compatibility wrapper. Prefer:
#   npm run dev:real -- [project-dir]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
exec node "$REPO_ROOT/scripts/start-pi-deck.mjs" --real --dev "$@"
