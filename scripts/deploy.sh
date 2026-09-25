#!/usr/bin/env bash
# Compatibility wrapper. The Node runner is the only deployment implementation.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/workshop.mjs" deploy "$@"
