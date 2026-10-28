#!/bin/bash
set -euo pipefail
runtime=/usr/local/emhttp/plugins/unraid-deck-bridge/current
run=/var/run/unraid-deck-bridge
# Open only the existing lock; recheck its inode and READY state after locking.
node "$runtime/post-install.mjs" repair-allowed || exit 75
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
node "$runtime/manager.mjs" check && exit 0
# Restart even when stop partially succeeds before returning an error.
trap 'unraid-api start 9>&-' EXIT
unraid-api stop 9>&-
node "$runtime/manager.mjs" register "$runtime"
unraid-api plugins install unraid-deck-bridge --bundled --no-restart 9>&-
