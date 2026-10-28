#!/bin/bash
set -euo pipefail
if [ "$#" -gt 1 ] || { [ "$#" -eq 1 ] && [ "$1" != --core-only ]; }; then
  echo 'Usage: health.sh [--core-only]' >&2
  exit 1
fi
directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
version="$(
  node -e '
    const fs = require("node:fs");
    const { version } = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (
      typeof version !== "string" ||
      /^[0-9]+\.[0-9]+\.[0-9]+$/.exec(version)?.[0] !== version
    ) process.exit(1);
    process.stdout.write(version);
  ' "$directory/adapter/package.json"
)"
curl --max-time 3 -fsS --unix-socket /var/run/unraid-deck-bridge/core.sock http://localhost/info -H 'x-bridge-actor: installer' |
  node -e '
    let body = "";
    process.stdin.on("data", chunk => { body += chunk; });
    process.stdin.on("end", () => {
      const info = JSON.parse(body);
      if (info.version !== process.argv[1] || !info.accepting) process.exit(1);
    });
  ' "$version"
if [ "${1:-}" = --core-only ]; then exit 0; fi
# Check the official GraphQL field without reading or creating administrator keys.
curl --max-time 3 -fsS --unix-socket /var/run/unraid-api.sock http://localhost/graphql -H 'content-type: application/json' --data '{"query":"{ deckBridge { info { version } } }"}' |
  node -e '
    let body = "";
    process.stdin.on("data", chunk => { body += chunk; });
    process.stdin.on("end", () => {
      const result = JSON.parse(body);
      const unauthenticated = result.errors?.some(
        error => error.extensions?.code === "UNAUTHENTICATED"
      );
      if (!result.data?.deckBridge?.info && !unauthenticated) process.exit(1);
    });
  '
