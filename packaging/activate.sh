#!/bin/bash
set -euo pipefail
[ "$#" -eq 4 ] || {
  echo 'Usage: activate.sh CANDIDATE BACKUP PREVIOUS PLUGIN_VERSION' >&2
  exit 1
}
candidate="$1"
backup="$2"
previous="$3"
plugin_version="$4"
runtime=/usr/local/emhttp/plugins/unraid-deck-bridge
base=/boot/config/plugins/unraid-deck-bridge
service=/etc/rc.d/rc.unraid-deck-bridge
# The controller owns this open file description for the entire activation.
[ -e /dev/fd/9 ] && flock -n 9 || {
  echo 'Activation requires the lifecycle lock' >&2
  exit 1
}
node --input-type=module - "$candidate" "$backup" "$previous" "$plugin_version" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
const [candidate, backup, previous, version] = process.argv.slice(2);
const runtime = '/usr/local/emhttp/plugins/unraid-deck-bridge';
const base = '/boot/config/plugins/unraid-deck-bridge';
const persisted = '/boot/config/plugins/unraid-deck-bridge.plg';
const registered = '/var/log/plugins/unraid-deck-bridge.plg';
const held = fs.fstatSync(9);
const expected = fs.lstatSync('/var/run/unraid-deck-bridge/install.lock');
if (!expected.isFile() || held.dev !== expected.dev || held.ino !== expected.ino)
  throw new Error('Activation requires the Bridge lifecycle lock');
function safeDirectory(file) {
  let prefix = '';
  for (const part of file.split('/').filter(Boolean)) {
    prefix += '/' + part;
    const stat = fs.lstatSync(prefix);
    if (stat.isSymbolicLink()) {
      if ((prefix === '/var/run' && fs.realpathSync(prefix) === '/run') ||
          (prefix === '/etc/rc.d' && fs.realpathSync(prefix) === '/usr/local/etc/rc.d')) continue;
      throw new Error('Unsafe activation directory: ' + prefix);
    }
    if (!stat.isDirectory()) throw new Error('Invalid activation directory: ' + prefix);
  }
}
for (const file of [runtime + '/releases', base + '/backups', '/var/run/unraid-deck-bridge', '/etc/rc.d']) safeDirectory(file);
const service = fs.lstatSync('/etc/rc.d/rc.unraid-deck-bridge', { throwIfNoEntry: false });
if (service && !service.isFile()) throw new Error('Unsafe Bridge service file');
const current = fs.lstatSync(runtime + '/current', { throwIfNoEntry: false });
const currentMatches = previous
  ? current?.isSymbolicLink() && fs.readlinkSync(runtime + '/current') === previous
  : !current;
function realDirectory(file, parent) {
  return path.dirname(file) === parent && fs.lstatSync(file).isDirectory() && fs.realpathSync(file) === file;
}
if (!realDirectory(candidate, runtime + '/releases') ||
    !realDirectory(backup, base + '/backups') ||
    (previous && !realDirectory(previous, runtime + '/releases')) ||
    !/^\d{4}\.\d{2}\.\d{2}$/.test(version) || !currentMatches ||
    !fs.lstatSync(registered).isSymbolicLink() ||
    fs.realpathSync(registered) !== persisted ||
    !fs.lstatSync(persisted).isFile()) throw new Error('Stale or unregistered Bridge activation');
const xml = fs.readFileSync(persisted, 'utf8');
const plugin = xml.match(/<PLUGIN\b([^>]*)>/);
const attrs = Object.fromEntries([...((plugin?.[1] || '').matchAll(/([A-Za-z][\w-]*)\s*=\s*(["'])(.*?)\2/g))].map(m => [m[1], m[3]]));
if (attrs.name !== 'unraid-deck-bridge' || attrs.version !== version) throw new Error('Persisted Bridge registration does not match activation');
NODE
api_touched=0
backup_ready=0
registration_touched=0
core_stopped=0
candidate_started=0
current_switched=0
service_installed=0
rollback() {
  code=$?
  trap - EXIT
  trap - TERM INT
  [ "$code" -ne 0 ] || exit 0
  echo 'Bridge activation FAILED; native PLG registration remains committed; recovering API and runtime'
  recovery_failed=0
  api_safe=1
  if [ "$registration_touched" = 1 ]; then
    unraid-api stop 9>&- || {
      api_safe=0
      recovery_failed=1
    }
    if [ "$api_safe" = 1 ] && [ "$backup_ready" = 1 ]; then
      node "$candidate/manager.mjs" restore "$backup" || recovery_failed=1
    fi
  fi
  # Do not replace the runtime until its service has drained.
  if [ "$candidate_started" = 1 ] && ! bash "$candidate/remove.sh" --stop-only; then
    echo 'Recovery incomplete: candidate Core did not drain; retaining current, rc and recovery files'
    if [ "$api_touched" = 1 ]; then unraid-api start 9>&- || true; fi
    exit "$code"
  fi
  if [ "$current_switched" = 1 ]; then
    if [ -n "$previous" ]; then
      ln -sfn "$previous" "$runtime/current" || recovery_failed=1
    else rm -f "$runtime/current" || recovery_failed=1; fi
  fi
  if [ "$service_installed" = 1 ]; then
    if [ -f "$backup/service" ]; then
      install -m 755 "$backup/service" "$service" || recovery_failed=1
    else rm -f "$service" || recovery_failed=1; fi
  fi
  if [ "$core_stopped" = 1 ] && [ -n "$previous" ] && [ "$recovery_failed" = 0 ]; then
    "$service" start 9>&- || recovery_failed=1
  fi
  if [ "$api_touched" = 1 ]; then unraid-api start 9>&- || recovery_failed=1; fi
  if [ "$recovery_failed" = 1 ]; then echo 'Recovery incomplete: inspect retained backup and services before retrying'; fi
  exit "$code"
}
trap rollback EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
# Snapshot the actual old rc only once native registration and ownership are confirmed.
if [ -f "$service" ]; then cp "$service" "$backup/service"; fi
bash "$candidate/remove.sh" --stop-only
core_stopped=1
current_switched=1
ln -sfn "$candidate" "$runtime/current"
service_installed=1
install -m 755 "$candidate/rc.unraid-deck-bridge" "$service"
candidate_started=1
"$service" start 9>&-
healthy=0
for attempt in $(seq 1 30); do
  if bash "$candidate/health.sh" --core-only; then
    healthy=1
    break
  fi
  sleep 1
done
[ "$healthy" = 1 ] || {
  echo 'Bridge Core readiness check failed'
  exit 1
}
# Stop before snapshot/registration: shutdown may flush old in-memory config.
api_touched=1
unraid-api stop 9>&-
node "$candidate/manager.mjs" backup "$backup"
backup_ready=1
registration_touched=1
node "$candidate/manager.mjs" register "$candidate"
node --input-type=module -e "await import('/usr/local/unraid-api/node_modules/unraid-deck-bridge/index.js')"
unraid-api plugins install unraid-deck-bridge --bundled --no-restart 9>&-
unraid-api start 9>&-
healthy=0
for attempt in $(seq 1 30); do
  if bash "$candidate/health.sh"; then
    healthy=1
    break
  fi
  sleep 1
done
[ "$healthy" = 1 ] || {
  echo 'Bridge full API health check failed'
  exit 1
}
trap - EXIT
echo 'Unraid Deck Bridge API activation READY'
