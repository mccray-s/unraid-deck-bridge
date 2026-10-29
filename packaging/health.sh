#!/bin/bash
set -euo pipefail
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --core-only ]; }; then
  echo 'Usage: health.sh [--core-only]' >&2
  exit 1
fi
directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ "${1:-}" = --core-only ]; then
  exec node "$directory/api-runtime.mjs" core
fi
exec node "$directory/api-runtime.mjs" health
