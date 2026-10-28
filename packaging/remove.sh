#!/bin/bash
set -euo pipefail
case "$#:${1:-}" in
  0:) mode=native ;;
  1:--stop-only) mode=stop ;;
  1:--standalone) mode=standalone ;;
  *)
    echo 'Usage: remove.sh [--stop-only|--standalone]' >&2
    exit 1
    ;;
esac
node --input-type=module - "$mode" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
const productionUID = 0;
const STOP_TIMEOUT_MS = 180000;
const TASK_TIMEOUT_MS = 35000;
const HEALTH_TIMEOUT_MS = 30000;
const POLL_MS = 100;
const name = 'unraid-deck-bridge';
const base = '/boot/config/plugins/unraid-deck-bridge';
const runtime = '/usr/local/emhttp/plugins/unraid-deck-bridge';
const run = '/var/run/unraid-deck-bridge';
const service = '/etc/rc.d/rc.unraid-deck-bridge';
const log = '/var/log/unraid-deck-bridge.log';
const temporary = '/tmp/unraid-deck-bridge';
const manifest = '/usr/local/unraid-api/package.json';
const config = '/boot/config/plugins/dynamix.my.servers/configs/api.json';
const adapter = '/usr/local/unraid-api/node_modules/unraid-deck-bridge';
const hook = '/usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/unraid-deck-bridge-remove';
const persistent = '/boot/config/plugins/unraid-deck-bridge.plg';
const registered = '/var/log/plugins/unraid-deck-bridge.plg';
const archived = '/boot/config/plugins-removed/unraid-deck-bridge.plg';
const apiSocket = '/var/run/unraid-api.sock';
const systemRun = path.join('/', 'run');
const systemServiceDirectory = path.join('/', 'usr', 'local', 'etc', 'rc.d');
const remnants = [
  log + '.trim',
  manifest + '.bridge-tmp', config + '.bridge-tmp',
  manifest + '.bridge-remove-tmp', config + '.bridge-remove-tmp',
  hook + '.bridge-remove-tmp',
  '/usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/unraid-deck-bridge-install',
  path.join(path.dirname(hook), '.unraid-deck-bridge-install.bridge-tmp'),
  '/boot/config/plugins-error/unraid-deck-bridge.plg',
  '/boot/config/plugins-nextboot/unraid-deck-bridge.plg',
  '/boot/config/plugins-stale/unraid-deck-bridge.plg',
  '/tmp/plugins/unraid-deck-bridge.plg',
  '/tmp/plugins/pluginPending/unraid-deck-bridge.plg',
];
const payload = [adapter, service, base, runtime, log, temporary, ...remnants];
function exists(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function standardSystemLink(current) {
  const target = current === path.dirname(run) ? systemRun :
    current === path.dirname(service) ? systemServiceDirectory : undefined;
  if (!target || fs.readlinkSync(current) !== target) return false;
  return exists(target)?.isDirectory() && fs.realpathSync(target) === target;
}
// Only known system aliases may redirect ancestors. Removable leaf links are
// unlinked, never traversed (including a broken current/runtime or adapter).
function safe(file, leafLink = false) {
  let current = '/';
  for (const part of file.split('/').filter(Boolean)) {
    current = path.join(current, part);
    if (exists(current)?.isSymbolicLink() &&
        !(leafLink && current === file) && !standardSystemLink(current))
      throw new Error('Unsafe symlink in uninstall path: ' + current);
  }
}
function erase(file) {
  safe(file, true);
  fs.rmSync(file, { recursive: true, force: true });
  if (exists(file)) throw new Error('Removal left a remnant: ' + file);
}
function command(program, args) {
  const result = spawnSync(program, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(program + ' failed: ' + result.status);
}
function atomic(file, bytes, mode) {
  safe(file);
  const temp = file + '.bridge-remove-tmp';
  safe(temp, true);
  fs.rmSync(temp, { force: true });
  const fd = fs.openSync(temp, 'wx', mode);
  try {
    try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function identity(pid) {
  try {
    const dir = '/proc/' + pid;
    if (fs.statSync(dir).uid !== productionUID) return null;
    const stat = fs.readFileSync(dir + '/stat', 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const item = { pid: Number(pid), start: fields[19], state: fields[0], parent: Number(fields[1]) };
    if (item.state === 'Z' || item.state === 'X') return item;
    item.args = fs.readFileSync(dir + '/cmdline', 'utf8').split('\0').filter(Boolean);
    item.exe = fs.readlinkSync(dir + '/exe').replace(/ \(deleted\)$/, '');
    // Re-read starttime after exe/cmdline, rather than mixing two PID owners.
    const again = fs.readFileSync(dir + '/stat', 'utf8');
    if (again.slice(again.lastIndexOf(')') + 2).split(' ')[19] !== item.start) return null;
    return item;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}
function releaseFile(file, basename) {
  return path.isAbsolute(file) && path.basename(file) === basename &&
    path.dirname(path.dirname(file)) === runtime + '/releases';
}
function kind(item) {
  if (!item?.args || item.state === 'Z' || item.state === 'X') return null;
  const args = item.args;
  const state = base + '/state/operations';
  const states = args.flatMap((arg, index) => arg === '--state' ? [args[index + 1]] :
    arg.startsWith('--state=') ? [arg.slice('--state='.length)] : []);
  const hasState = states.length === 1 && states[0] === state;
  if (releaseFile(item.exe, 'deck-bridge-core') && hasState) return 'core';
  if (path.basename(item.exe) === 'bash' && args.length === 3 &&
      [service, path.join(systemServiceDirectory, path.basename(service))].includes(args[1]) &&
      args[2] === 'supervise') return 'supervisor';
  const script = (file, basename) => file === runtime + '/current/' + basename || releaseFile(file, basename);
  if (args.some((arg, index) => script(arg, 'post-install.mjs') &&
      ['schedule', 'launch', 'run', 'activate', 'native-complete', 'native-complete-locked'].includes(args[index + 1]))) return 'task';
  if (args.some(arg => script(arg, 'repair.sh'))) return 'task';
  return null;
}
function scan() {
  return fs.readdirSync('/proc/').filter(pid => /^[1-9]\d*$/.test(pid))
    .map(identity).filter(item => kind(item));
}
function same(item) {
  const current = identity(item.pid);
  return current && current.start === item.start &&
    current.state !== 'Z' && current.state !== 'X' && kind(current) === kind(item);
}
function signal(item) {
  if (!same(item)) return;
  try { process.kill(item.pid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function stopOwned() {
  safe(run);
  const initial = scan().filter(item => kind(item) !== 'task');
  const pidFile = run + '/supervisor.pid';
  safe(pidFile);
  let recorded;
  if (exists(pidFile)?.isFile()) {
    const bytes = fs.readFileSync(pidFile, 'utf8');
    const stat = fs.lstatSync(pidFile);
    const owner = initial.find(item => kind(item) === 'supervisor' && String(item.pid) === bytes.trim());
    if (owner) recorded = { bytes, stat, owner };
  }
  const deadline = performance.now() + STOP_TIMEOUT_MS;
  const signaled = new Set();
  while (true) {
    const owned = scan().filter(item => kind(item) !== 'task');
    if (!owned.length) break;
    const supervisors = owned.filter(item => kind(item) === 'supervisor');
    for (const item of owned) {
      // A verified supervisor forwards TERM and waits for its child. Orphans
      // (including children left after supervisor exit) are drained directly.
      if (kind(item) === 'core' && supervisors.some(parent => parent.pid === item.parent)) continue;
      const key = item.pid + ':' + item.start;
      if (!signaled.has(key)) { signal(item); signaled.add(key); }
    }
    if (performance.now() >= deadline)
      throw new Error('Bridge stop timed out; live processes and recovery files retained');
    await sleep(POLL_MS);
  }
  if (recorded) {
    safe(pidFile);
    const current = exists(pidFile);
    if (current?.isFile() && current.dev === recorded.stat.dev && current.ino === recorded.stat.ino &&
        fs.readFileSync(pidFile, 'utf8') === recorded.bytes && !same(recorded.owner)) fs.unlinkSync(pidFile);
  }
}
function metadata(file) {
  safe(file);
  if (!exists(file)) return null;
  const bytes = fs.readFileSync(file, 'utf8');
  let value;
  try { value = JSON.parse(bytes); }
  catch { throw new Error('Invalid API metadata JSON: ' + file); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid API metadata: ' + file);
  if (file === manifest) {
    for (const section of ['dependencies', 'peerDependencies'])
      if (value[section] !== undefined && (!value[section] || typeof value[section] !== 'object' || Array.isArray(value[section])))
        throw new Error('Invalid API dependency map: ' + file);
  } else if (value.plugins !== undefined && !Array.isArray(value.plugins)) throw new Error('Invalid API plugins list');
  return value;
}
function hasBridge(file, value) {
  return value && (file === manifest
    ? ['dependencies', 'peerDependencies'].some(section => value[section] && Object.hasOwn(value[section], name))
    : value.plugins?.includes(name));
}
function queryAPI() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query: '{ __schema { queryType { name fields { name } } } }' });
    const req = http.request({ socketPath: apiSocket, path: '/graphql', method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => {
      let bytes = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { bytes += chunk; if (bytes.length > 4 * 1024 * 1024) req.destroy(new Error('API response too large')); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          let value;
          try { value = JSON.parse(bytes); }
          catch { throw new Error('Invalid official GraphQL JSON response'); }
          const query = value.data?.__schema?.queryType;
          if (res.statusCode !== 200 || (value.errors && (!Array.isArray(value.errors) || value.errors.length)) ||
              query?.name !== 'Query' || !Array.isArray(query.fields) || !query.fields.length ||
              query.fields.some(field => typeof field?.name !== 'string' || field.name === 'deckBridge'))
            throw new Error('Official GraphQL unhealthy or Query.deckBridge remains');
          resolve();
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Official API request timeout')), 3000);
    req.once('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(body);
  });
}
async function health() {
  safe(apiSocket);
  const deadline = performance.now() + HEALTH_TIMEOUT_MS;
  let failure;
  do {
    try { await queryAPI(); return; } catch (error) { failure = error; }
    if (performance.now() >= deadline) break;
    await sleep(POLL_MS);
  } while (true);
  throw new Error('Official GraphQL removal verification failed: ' + failure.message);
}
async function removeAPI() {
  const initial = [manifest, config].map(file => ({ file, value: metadata(file) }));
  if (!initial.some(({ file, value }) => hasBridge(file, value))) {
    if (!exists(adapter)) { await health(); return; }
    // Adapter files alone are not an active API entry. Avoid an unnecessary
    // restart when the official schema already proves Bridge is absent.
    try { await queryAPI(); return; } catch {}
  }
  const applied = [];
  let stopped = false;
  try {
    stopped = true;
    command('unraid-api', ['stop']);
    // Stop may flush unrelated configuration. Snapshot and edit the actual
    // stopped API files, not the earlier restart-decision snapshots.
    const edits = [];
    for (const file of [manifest, config]) {
      const before = metadata(file);
      if (!hasBridge(file, before)) continue;
      const value = structuredClone(before);
      if (file === manifest) {
        for (const section of ['dependencies', 'peerDependencies']) {
          if (!value[section]) continue;
          delete value[section][name];
          if (!Object.keys(value[section]).length) delete value[section];
        }
      } else value.plugins = value.plugins.filter(entry => entry !== name);
      edits.push({ file, before, next: value, mode: fs.statSync(file).mode & 0o7777 });
    }
    for (const edit of edits) {
      atomic(edit.file, JSON.stringify(edit.next, null, 2) + '\n', edit.mode);
      applied.push(edit);
    }
    command('unraid-api', ['start']);
    await health();
  } catch (error) {
    const failures = [error];
    for (const edit of applied.reverse()) {
      try {
        // Restore only our dependency entries/list membership, not unrelated
        // metadata which the official API may have updated during startup.
        const value = metadata(edit.file);
        if (!value) throw new Error('API metadata disappeared: ' + edit.file);
        if (edit.file === manifest) {
          for (const section of ['dependencies', 'peerDependencies']) {
            if (edit.before[section] && Object.hasOwn(edit.before[section], name)) {
              value[section] ??= {};
              value[section][name] = edit.before[section][name];
            }
          }
        } else {
          value.plugins ??= [];
          value.plugins = value.plugins.filter(entry => entry !== name);
          edit.before.plugins.forEach((entry, index) => {
            if (entry === name) value.plugins.splice(index, 0, name);
          });
        }
        atomic(edit.file, JSON.stringify(value, null, 2) + '\n', edit.mode);
      } catch (restoreError) { failures.push(restoreError); }
    }
    if (stopped) {
      try { command('unraid-api', ['start']); } catch (restartError) { failures.push(restartError); }
    }
    throw new AggregateError(failures, 'Bridge removal/API recovery failed; payload and recovery files retained: ' + failures.map(item => item.message).join('; '));
  }
}
function assertStopped() {
  const owned = scan();
  if (owned.length) throw new Error('Bridge processes remain: ' + owned.map(item => item.pid).join(', '));
}
function absent(files) {
  for (const file of files) {
    safe(file, true);
    if (exists(file)) throw new Error('Bridge remnant remains: ' + file);
  }
}
async function auditBody(allowPending = false) {
  assertStopped();
  absent([...payload.filter(file => !allowPending || file !== '/tmp/plugins/pluginPending/unraid-deck-bridge.plg'), run]);
  for (const file of [manifest, config])
    if (hasBridge(file, metadata(file))) throw new Error('Bridge API metadata remains: ' + file);
  await health();
}
async function finalize() {
  // Check preconditions before removing the official archive or this hook.
  absent([persistent, registered]);
  await auditBody(true);
  erase(archived);
  erase('/tmp/plugins/pluginPending/unraid-deck-bridge.plg');
  absent([persistent, registered, archived]);
  await auditBody();
  erase(hook);
  absent([hook]);
  console.log('Bridge removal verified');
}
async function postRemove() {
  if (process.getuid() !== productionUID) throw new Error('Bridge removal requires root');
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== 'plugin' || args[1] !== 'remove' || args[2] !== name + '.plg')
    throw new Error('Invalid Bridge post-remove arguments');
  await finalize();
}
// The official manager ignores post-hook exit status. This hook emits explicit
// failures; only its independent audit can print the final verification message.
function installHook() {
  safe(path.dirname(hook));
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  const constants = { productionUID, STOP_TIMEOUT_MS, TASK_TIMEOUT_MS, HEALTH_TIMEOUT_MS, POLL_MS,
    name, base, runtime, run, service, log, temporary, manifest, config, adapter, hook,
    persistent, registered, archived, apiSocket, systemRun, systemServiceDirectory, remnants, payload };
  const functions = [exists, standardSystemLink, safe, erase, sleep, identity, releaseFile, kind,
    scan, metadata, hasBridge, queryAPI, health, assertStopped, absent, auditBody, finalize, postRemove];
  const source = '#!/bin/bash\nset -euo pipefail\n' + JSON.stringify(process.execPath) +
    ' --input-type=module - "$@" <<\'BRIDGE_POST_REMOVE\'\n' +
    "import fs from 'node:fs';\nimport path from 'node:path';\nimport http from 'node:http';\n" +
    Object.entries(constants).map(([key, value]) => `const ${key} = ${JSON.stringify(value)};\n`).join('') +
    functions.map(fn => fn.toString() + '\n').join('') +
    'await postRemove();\nBRIDGE_POST_REMOVE\n';
  safe(hook, true);
  if (exists(hook)?.isSymbolicLink()) fs.unlinkSync(hook);
  atomic(hook, source, 0o755);
}
async function main() {
  if (process.getuid() !== productionUID) throw new Error('Bridge removal requires root');
  const mode = process.argv[2];
  if (!['native', 'stop', 'standalone'].includes(mode) || process.argv.length !== 3) throw new Error('Invalid removal mode');
  if (mode === 'stop') { await stopOwned(); return; }
  for (const file of [...payload, persistent, registered, archived, hook]) safe(file, true);
  for (const file of [run, run + '/install.lock', manifest, config, apiSocket]) safe(file);
  fs.mkdirSync(run, { recursive: true, mode: 0o700 });
  fs.chmodSync(run, 0o700);
  const lock = fs.openSync(run + '/install.lock', 'a', 0o600);
  try {
    const stdio = ['ignore', 'inherit', 'inherit', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', lock];
    const result = spawnSync('flock', ['-n', '9'], { stdio });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Another Bridge lifecycle operation is running (busy)');
    function validLock() {
      safe(run + '/install.lock');
      const current = fs.lstatSync(run + '/install.lock');
      const held = fs.fstatSync(lock);
      if (!current.isFile() || current.dev !== held.dev || current.ino !== held.ino)
        throw new Error('Bridge lifecycle lock was replaced');
    }
    validLock();
    const selected = run + '/activation-job';
    safe(selected, true);
    fs.rmSync(selected, { force: true });
    const deadline = performance.now() + TASK_TIMEOUT_MS;
    while (scan().some(item => kind(item) === 'task')) {
      validLock();
      if (performance.now() >= deadline) throw new Error('Bridge activation/repair tasks did not exit; files retained');
      await sleep(POLL_MS);
    }
    await stopOwned();
    validLock();
    assertStopped();
    await removeAPI();
    validLock();
    assertStopped();
    if (mode === 'native') installHook();
    for (const file of payload) erase(file);
    if (mode === 'standalone') for (const file of [persistent, registered, archived, hook]) erase(file);
    validLock();
    assertStopped();
    // No worker may recreate state after invalidation, and the held descriptor
    // remains locked until the complete transaction/final audit has finished.
    erase(run);
    if (mode === 'standalone') await finalize();
    else {
      await auditBody();
      console.log('Bridge removal body verified; native archive/post-hook verification pending');
    }
  } finally { fs.closeSync(lock); }
}
await main();
NODE
