#!/bin/bash
set -euo pipefail
runtime=/usr/local/emhttp/plugins/unraid-deck-bridge/current
run=/var/run/unraid-deck-bridge
audit() { node "$runtime/lifecycle-log.mjs" "$@" || true; }
# Open only the existing lock; recheck its inode and READY state after locking.
node "$runtime/post-install.mjs" repair-allowed || exit 75
node "$runtime/api-runtime.mjs" ready || exit 75
node --input-type=module - <<'NODE' || exit 75
import fs from 'node:fs';
const run = '/var/run/unraid-deck-bridge';
for (const file of [run, run + '/install.lock']) {
  let prefix = '';
  for (const part of file.split('/').filter(Boolean)) {
    prefix += '/' + part;
    const stat = fs.lstatSync(prefix);
    if (stat.isSymbolicLink() && !(prefix === '/var/run' && fs.realpathSync(prefix) === '/run'))
      throw new Error('Unsafe repair lock path');
  }
}
if (!fs.lstatSync(run + '/install.lock').isFile()) throw new Error('Invalid repair lock');
NODE
exec 9<"$run/install.lock" || exit 75
flock -n 9 || exit 75
node --input-type=module - <<'NODE' || exit 75
import fs from 'node:fs';
const held = fs.fstatSync(9), current = fs.lstatSync('/var/run/unraid-deck-bridge/install.lock');
if (!current.isFile() || held.dev !== current.dev || held.ino !== current.ino)
  throw new Error('Repair lock was replaced');
NODE
node "$runtime/post-install.mjs" repair-allowed || exit 75
node "$runtime/manager.mjs" preflight
node "$runtime/api-runtime.mjs" ready || exit 75
loaded=0
node "$runtime/api-runtime.mjs" decision || loaded=$?
[ "$loaded" = 0 ] || [ "$loaded" = 10 ] || exit 75
disk_current=0
if node "$runtime/manager.mjs" check; then disk_current=1; fi
if [ "$disk_current" = 1 ] && [ "$loaded" = 0 ]; then
  audit api-reload-skipped CURRENT
  exit 0
fi
audit api-repair-start PRIMARY
if [ "$disk_current" = 0 ]; then
  audit api-reload-required DISK_REPAIR_REQUIRED
else
  audit api-reload-required ADAPTER_RELOAD_REQUIRED
fi
# Restart even when stop partially succeeds before returning an error.
recover() {
  code=$?
  trap - EXIT
  audit api-repair-failed FAILED
  audit api-start ROLLBACK
  unraid-api start 9>&-
  exit "$code"
}
trap recover EXIT
audit api-stop PRIMARY
unraid-api stop 9>&-
if [ "$disk_current" = 0 ]; then
  node "$runtime/manager.mjs" register "$runtime"
  unraid-api plugins install unraid-deck-bridge --bundled --no-restart 9>&-
fi
audit api-start PRIMARY
unraid-api start 9>&-
trap - EXIT
# A failed reload is a bounded repair failure, not a startup deferral.
for attempt in $(seq 1 30); do
  if node "$runtime/api-runtime.mjs" loaded; then
    audit api-repair-ready READY
    exit 0
  fi
  sleep 1
done
audit api-repair-failed FAILED
exit 1
