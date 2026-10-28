#!/bin/bash
set -euo pipefail
[ "$#" -eq 3 ] || {
  echo 'Usage: install.sh STAGING BUILD PLUGIN_VERSION' >&2
  exit 1
}
base=/boot/config/plugins/unraid-deck-bridge
runtime=/usr/local/emhttp/plugins/unraid-deck-bridge
staging="$1"
build="$2"
plugin_version="$3"
[[ "$plugin_version" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}$ ]] || {
  echo 'Invalid Bridge plugin version' >&2
  exit 1
}
[[ "$build" =~ ^[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{12}$ ]] || {
  echo 'Invalid Bridge build identifier' >&2
  exit 1
}
name="${staging#"$runtime/releases/"}"
if [[ "$staging" != "$runtime/releases/"* || "$name" != .staging-?* || "$name" == */* ]] ||
  [ ! -d "$staging" ] || [ -L "$staging" ]; then
  echo 'STAGING must be a real runtime/releases/.staging-* directory' >&2
  exit 1
fi
staging_real=$(cd "$staging" && pwd -P)
if [ -d "$runtime/current" ] && [ "$(cd "$runtime/current" && pwd -P)" = "$staging_real" ]; then
  echo 'STAGING must not be the current release' >&2
  exit 1
fi
version=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version' "$staging/adapter/package.json")
[[ "$build" == "$version-"* ]] || {
  echo 'BUILD does not match the candidate adapter version' >&2
  exit 1
}
node --input-type=module - <<'NODE'
import fs from 'node:fs';
function safe(file) {
  const parts = file.split('/').filter(Boolean);
  let prefix = '';
  for (const part of parts) {
    prefix += '/' + part;
    if (!fs.existsSync(prefix) && !fs.lstatSync(prefix, { throwIfNoEntry: false })) continue;
    const stat = fs.lstatSync(prefix);
    if (stat.isSymbolicLink()) {
      if (prefix === '/var/run' && fs.realpathSync(prefix) === '/run') continue;
      throw new Error('Unsafe Bridge directory: ' + prefix);
    }
    if (!stat.isDirectory()) throw new Error('Not a Bridge directory: ' + prefix);
  }
}
for (const directory of ['/var/run/unraid-deck-bridge', '/boot/config/plugins/unraid-deck-bridge/backups', '/usr/local/emhttp/plugins/unraid-deck-bridge/releases']) safe(directory);
const lock = fs.lstatSync('/var/run/unraid-deck-bridge/install.lock', { throwIfNoEntry: false });
if (lock && (!lock.isFile() || lock.isSymbolicLink())) throw new Error('Unsafe lifecycle lock');
NODE
mkdir -p /var/run/unraid-deck-bridge
chmod 700 /var/run/unraid-deck-bridge
if [ ! -e /dev/fd/9 ]; then exec 9>/var/run/unraid-deck-bridge/install.lock; fi
flock -n 9 || {
  echo 'Another Bridge lifecycle operation is running'
  exit 1
}
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const held = fs.fstatSync(9);
for (const directory of ['/var/run/unraid-deck-bridge', '/boot/config/plugins/unraid-deck-bridge/backups', '/usr/local/emhttp/plugins/unraid-deck-bridge/releases']) {
  let prefix = '';
  for (const part of directory.split('/').filter(Boolean)) {
    prefix += '/' + part;
    const entry = fs.lstatSync(prefix, { throwIfNoEntry: false });
    if (!entry) continue;
    if (entry.isSymbolicLink() && prefix === '/var/run' && fs.realpathSync(prefix) === '/run') continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Unsafe preparation directory: ' + prefix);
  }
}
const file = fs.lstatSync('/var/run/unraid-deck-bridge/install.lock');
if (!file.isFile() || held.dev !== file.dev || held.ino !== file.ino) throw new Error('Lifecycle lock was replaced');
const runtime = '/usr/local/emhttp/plugins/unraid-deck-bridge';
const current = fs.lstatSync(runtime + '/current', { throwIfNoEntry: false });
if (current) {
  if (!current.isSymbolicLink()) throw new Error('current must be a release symlink');
  const target = fs.readlinkSync(runtime + '/current');
  if (!target.startsWith(runtime + '/releases/') || target.slice((runtime + '/releases/').length).includes('/') ||
      !fs.lstatSync(target).isDirectory() || fs.realpathSync(target) !== target)
    throw new Error('Invalid previous release');
}
NODE
mkdir -p "$base/backups" "$runtime/releases"
(cd "$staging" && sha256sum -c SHA256SUMS)
node "$staging/manager.mjs" preflight
candidate="$runtime/releases/$build"
if [ -e "$candidate" ] || [ -L "$candidate" ]; then
  [ -d "$candidate" ] && [ ! -L "$candidate" ] || {
    echo 'Existing release is not a real directory' >&2
    exit 1
  }
  # Compare every member; never overwrite an existing release.
  node --input-type=module - "$staging" "$candidate" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
function members(root, relative = '') {
  return fs.readdirSync(path.join(root, relative)).sort().flatMap((name) => {
    const entry = path.join(relative, name);
    const file = path.join(root, entry);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) return [[entry + '/', 'directory'], ...members(root, entry)];
    if (!stat.isFile()) throw new Error('Release contains a non-regular member: ' + entry);
    return [[entry, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
  });
}
const [staging, candidate] = process.argv.slice(2);
if (JSON.stringify(members(staging)) !== JSON.stringify(members(candidate))) {
  throw new Error('Existing release differs from staging; refusing to overwrite');
}
NODE
else
  mv -- "$staging" "$candidate"
fi
backup="$base/backups/$(date +%Y%m%dT%H%M%S)-$$"
previous=$(readlink "$runtime/current" || true)
mkdir -m 700 "$backup"
# Preparation reserves recovery space only; activation snapshots the actual live rc.
node "$candidate/post-install.mjs" schedule "$candidate" "$backup" "$previous" "$plugin_version" || {
  echo 'Bridge preparation FAILED; runtime/API unchanged; candidate and diagnostics retained' >&2
  exit 1
}
echo "Unraid Deck Bridge $version package prepared; runtime/API activation pending native plugin registration"
