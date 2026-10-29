#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  identity,
  nativeAncestor,
  nativeCommand,
  captureDirectory,
  snapshot,
} from './plg-capture.mjs';
import { inspectRuntime, waitForApi } from './api-runtime.mjs';
import { logLifecycle } from './lifecycle-log.mjs';
import { parseReleaseVersion } from './adapter/release-version.mjs';

const RUN = '/var/run/unraid-deck-bridge';
const RUNTIME = '/usr/local/emhttp/plugins/unraid-deck-bridge';
const PERSISTED = '/boot/config/plugins/unraid-deck-bridge.plg';
const REGISTERED = '/var/log/plugins/unraid-deck-bridge.plg';
const HOOK =
  '/usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/unraid-deck-bridge-install';
const SELF = fileURLToPath(import.meta.url);
const POLL_MS = 100;
const DETACH_MS = 10000;
const NATIVE_MS = 300000;
const COMMIT_MS = 10000;
const LOCK_MS = 30000;
const API_STARTUP_MS = 300000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const exists = (p) => fs.existsSync(p);

function hookSource(job) {
  return (
    '#!/bin/bash\nset -euo pipefail\n' +
    '[ "${1:-}" = plugin ] && [ "${3:-}" = unraid-deck-bridge.plg ] || exit 0\n' +
    '[ "${2:-}" = install ] || [ "${2:-}" = update ] || exit 0\n' +
    'exec ' +
    JSON.stringify(process.execPath) +
    ' ' +
    JSON.stringify(SELF) +
    ' native-complete ' +
    JSON.stringify(job.dir) +
    ' "$@"\n'
  );
}
function cleanHook(job) {
  try {
    if (
      selected(job) &&
      fs.lstatSync(HOOK).isFile() &&
      fs.readFileSync(HOOK, 'utf8') === hookSource(job)
    )
      fs.unlinkSync(HOOK);
  } catch {}
}
function receipt(job, ok, code = null) {
  if (!selected(job) || !validLock(job)) throw new Error('JOB_CANCELLED');
  fs.writeFileSync(
    path.join(job.dir, 'native-complete.json'),
    JSON.stringify({ ok, code, digest: job.digest }),
    { mode: 0o600, flag: 'wx' },
  );
}
async function nativeComplete(args) {
  const [dir, type, method, plugin] = args;
  const job = readJob(dir);
  const native = nativeAncestor();
  if (
    native.pid !== job.native.pid ||
    native.start !== job.native.start ||
    type !== 'plugin' ||
    !['install', 'update'].includes(method) ||
    plugin !== 'unraid-deck-bridge.plg' ||
    !selected(job) ||
    !validLock(job)
  )
    throw new Error('NATIVE_CONTEXT');
  const lock = fs.openSync(path.join(RUN, 'install.lock'), 'r+');
  const child = spawn(
    '/bin/bash',
    [
      '-c',
      'flock -w 30 9 || exit 75; exec "$@"',
      'bridge-native-complete',
      process.execPath,
      SELF,
      'native-complete-locked',
      ...args,
    ],
    {
      stdio: [
        'ignore',
        1,
        2,
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        lock,
      ],
    },
  );
  fs.closeSync(lock);
  process.exitCode = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
async function nativeCompleteLocked(args) {
  const [dir, type, method, plugin, ...errors] = args;
  const job = readJob(dir);
  const native = nativeAncestor();
  const pending = JSON.parse(
    fs.readFileSync(path.join(job.dir, 'status.json'), 'utf8'),
  );
  if (
    native.pid !== job.native.pid ||
    native.start !== job.native.start ||
    type !== 'plugin' ||
    !['install', 'update'].includes(method) ||
    plugin !== 'unraid-deck-bridge.plg' ||
    !selected(job) ||
    !validLock(job, 9) ||
    !currentMatches(job.previous) ||
    nativeCommand(native).method !== method ||
    pending.state !== 'PENDING' ||
    pending.phase !== 'native-manager' ||
    fs.existsSync(path.join(job.dir, 'native-complete.json'))
  )
    throw new Error('NATIVE_CONTEXT');
  try {
    const info = snapshot(job.dir, job.version, native, 'snapshot.json');
    if (info.digest !== job.digest || info.method !== method)
      throw new Error('SNAPSHOT_DIGEST');
    if (errors.some((error) => error !== '')) throw new Error('NATIVE_FAILED');
    let persisted;
    try {
      persisted = fs.lstatSync(PERSISTED);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (!persisted) {
      const registered = fs.lstatSync(REGISTERED, { throwIfNoEntry: false });
      if (
        !registered?.isSymbolicLink() ||
        path.resolve(path.dirname(REGISTERED), fs.readlinkSync(REGISTERED)) !==
          PERSISTED
      )
        throw new Error('REGISTRATION_MISSING');
      const temporary = path.join(job.backup, 'native-registration.tmp');
      fs.copyFileSync(
        path.join(job.dir, 'snapshot.plg'),
        temporary,
        fs.constants.COPYFILE_EXCL,
      );
      try {
        if (
          !selected(job) ||
          !validLock(job, 9) ||
          !currentMatches(job.previous)
        )
          throw new Error('JOB_CANCELLED');
        // GNU mv uses renameat2(RENAME_NOREPLACE): atomic publication also on VFAT,
        // unlike hardlinks, and never replaces a concurrent canonical PLG.
        const move = spawn('/bin/mv', ['-nT', temporary, PERSISTED], {
          stdio: 'inherit',
        });
        const result = await new Promise((resolve) => {
          move.once('error', () => resolve(1));
          move.once('exit', (code) => resolve(code));
        });
        if (result !== 0 || exists(temporary))
          throw new Error('REGISTRATION_CHANGED');
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
    if (committed(job)) throw new Error(committed(job));
    if (!selected(job) || !validLock(job, 9)) throw new Error('JOB_CANCELLED');
    cleanHook(job);
    fs.unlinkSync(path.join(job.dir, 'snapshot.plg'));
    fs.unlinkSync(path.join(job.dir, 'snapshot.json'));
    receipt(job, true);
  } catch (error) {
    receipt(job, false, error.message);
    status(job, 'FAILED', 'native-hook', error.message);
    throw error;
  }
}
function fingerprint() {
  try {
    return [REGISTERED, PERSISTED]
      .map((file) => {
        const s = fs.lstatSync(file, { bigint: true });
        return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
      })
      .join('/');
  } catch {
    return null;
  }
}
function committed(job) {
  try {
    if (
      !fs.lstatSync(REGISTERED).isSymbolicLink() ||
      !fs.lstatSync(PERSISTED).isFile() ||
      fs.realpathSync(REGISTERED) !== fs.realpathSync(PERSISTED)
    )
      return 'REGISTRATION_MISSING';
    const xml = fs.readFileSync(PERSISTED, 'utf8');
    const plugin = xml.match(/<PLUGIN\s[^>]*>/i)?.[0];
    const name = plugin?.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
    const version = plugin?.match(/\bversion\s*=\s*["']([^"']+)["']/i)?.[1];
    if (name !== 'unraid-deck-bridge' || version !== job.version)
      return 'REGISTRATION_VERSION';
    const actual = fingerprint();
    if (actual === job.before) return 'REGISTRATION_UNCHANGED';
    if (job.confirmed && actual !== job.confirmed)
      return 'REGISTRATION_CHANGED';
    return null;
  } catch {
    return 'REGISTRATION_MISSING';
  }
}
function currentMatches(expected) {
  const current = path.join(RUNTIME, 'current');
  let stat;
  try {
    stat = fs.lstatSync(current);
  } catch (error) {
    return expected === '' && error.code === 'ENOENT';
  }
  try {
    return stat.isSymbolicLink() && fs.realpathSync(current) === expected;
  } catch {
    return false;
  }
}
function lockIdentity(fd) {
  const stat =
    fd === undefined
      ? fs.lstatSync(path.join(RUN, 'install.lock'), { bigint: true })
      : fs.fstatSync(fd, { bigint: true });
  if (!stat.isFile()) throw new Error('LOCK_REPLACED');
  return `${stat.dev}:${stat.ino}`;
}
function validLock(job, fd) {
  try {
    return (
      lockIdentity() === job.lock &&
      (fd === undefined || lockIdentity(fd) === job.lock)
    );
  } catch {
    return false;
  }
}
function owned(job) {
  try {
    return fs.readFileSync(path.join(job.dir, 'owner'), 'utf8') === job.token;
  } catch {
    return false;
  }
}
function selected(job) {
  if (!owned(job)) return false;
  try {
    if (fs.readFileSync(path.join(RUN, 'activation-job'), 'utf8') === job.token)
      return true;
  } catch {}
  status(job, 'SUPERSEDED', 'ownership', 'NEWER_JOB');
  return false;
}
function repairAllowed() {
  try {
    const token = fs.readFileSync(path.join(RUN, 'activation-job'), 'utf8');
    const job = readJob(path.join(RUN, token));
    if (
      !selected(job) ||
      !job.confirmed ||
      !validLock(job) ||
      committed(job) ||
      !currentMatches(job.candidate)
    )
      return false;
    return (
      JSON.parse(fs.readFileSync(path.join(job.dir, 'status.json'), 'utf8'))
        .state === 'READY'
    );
  } catch {
    return false;
  }
}
function status(job, state, phase, code = null) {
  if (!owned(job)) return false;
  let previous;
  try {
    previous = JSON.parse(
      fs.readFileSync(path.join(job.dir, 'status.json'), 'utf8'),
    );
  } catch {}
  const temp = path.join(job.dir, `status-${process.pid}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(
      temp,
      JSON.stringify({ state, phase, code, pid: process.pid }) + '\n',
      { mode: 0o600, flag: 'wx' },
    );
    if (!owned(job)) {
      fs.rmSync(temp, { force: true });
      return false;
    }
    fs.renameSync(temp, path.join(job.dir, 'status.json'));
    if (
      previous?.state !== state ||
      previous?.phase !== phase ||
      previous?.code !== code
    )
      logLifecycle('job-status', { job: job.token, state, phase, code });
    return true;
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    return false;
  }
}
function readJob(dir) {
  if (
    path.dirname(dir) !== RUN ||
    !path.basename(dir).startsWith('post-install-')
  )
    throw new Error('JOB_PATH');
  const job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
  if (job.dir !== dir || !owned(job)) throw new Error('JOB_CANCELLED');
  try {
    job.confirmed = JSON.parse(
      fs.readFileSync(path.join(dir, 'registration.json'), 'utf8'),
    ).fingerprint;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return job;
}
async function worker(job) {
  try {
    return await runWorker(job);
  } finally {
    if (!owned(job))
      logLifecycle('job-cancelled', {
        job: job.token,
        phase: 'ownership',
        code: 'JOB_CANCELLED',
      });
  }
}
async function runWorker(job) {
  let deadline = Date.now() + DETACH_MS;
  while (process.ppid !== 1) {
    if (!selected(job)) return;
    if (Date.now() >= deadline)
      return status(job, 'FAILED', 'detach', 'DETACH_TIMEOUT');
    await sleep(POLL_MS);
  }
  if (!selected(job) || !status(job, 'PENDING', 'native-manager')) return;
  // This is the acknowledgement: it is written only after the launcher exited.
  fs.writeFileSync(path.join(job.dir, 'detached'), String(process.pid), {
    flag: 'wx',
    mode: 0o600,
  });
  deadline = Date.now() + NATIVE_MS;
  while (true) {
    if (!selected(job)) return;
    if (!currentMatches(job.previous))
      return status(job, 'SUPERSEDED', 'native-manager', 'STALE_CURRENT');
    const native = identity(job.native.pid);
    if (!native || native.start !== job.native.start) break;
    if (native.state === 'Z') {
      if (native.exit !== 0)
        return status(job, 'FAILED', 'native-manager', 'NATIVE_FAILED');
      break;
    }
    if (Date.now() >= deadline)
      return status(job, 'FAILED', 'native-manager', 'NATIVE_TIMEOUT');
    await sleep(POLL_MS);
  }
  let completion;
  try {
    completion = JSON.parse(
      fs.readFileSync(path.join(job.dir, 'native-complete.json'), 'utf8'),
    );
  } catch {
    return status(job, 'FAILED', 'native-hook', 'NATIVE_HOOK_MISSING');
  }
  if (!completion.ok || completion.digest !== job.digest)
    return status(
      job,
      'FAILED',
      'native-hook',
      completion.code || 'NATIVE_FAILED',
    );
  deadline = Date.now() + COMMIT_MS;
  let reason;
  while ((reason = committed(job))) {
    if (!selected(job)) return;
    if (!currentMatches(job.previous))
      return status(job, 'SUPERSEDED', 'registration', 'STALE_CURRENT');
    if (Date.now() >= deadline)
      return status(job, 'FAILED', 'registration', reason);
    await sleep(POLL_MS);
  }
  if (!selected(job)) return;
  if (!currentMatches(job.previous))
    return status(job, 'SUPERSEDED', 'registration', 'STALE_CURRENT');
  job.confirmed = fingerprint();
  if (!job.confirmed || committed(job))
    return status(job, 'SUPERSEDED', 'registration', 'STALE_REGISTRATION');
  fs.writeFileSync(
    path.join(job.dir, 'registration.json'),
    JSON.stringify({ fingerprint: job.confirmed }),
    { mode: 0o600, flag: 'wx' },
  );
  let lockDeadline = null;
  const startupDeadline = Date.now() + API_STARTUP_MS;
  let waitReason;
  let waitStarted = false;
  let stableResult;
  async function startup() {
    if (!status(job, 'PENDING', 'api-startup')) return false;
    if (!waitStarted) {
      waitStarted = true;
      logLifecycle('api-wait-begin', { job: job.token, phase: 'api-startup' });
    }
    try {
      if (Date.now() >= startupDeadline)
        throw Object.assign(new Error(), { code: 'API_STARTUP_TIMEOUT' });
      const ready = await waitForApi({
        valid: () =>
          selected(job) &&
          validLock(job) &&
          currentMatches(job.previous) &&
          !committed(job),
        timeoutMs: Math.max(1, startupDeadline - Date.now()),
        onWait: (code) => {
          if (code === waitReason) return;
          waitReason = code;
          logLifecycle('api-wait-reason', {
            job: job.token,
            phase: 'api-startup',
            code,
          });
        },
      });
      const stable = JSON.stringify([ready?.code, ready?.identity]);
      if (stable !== stableResult) {
        stableResult = stable;
        logLifecycle('api-wait-ready', {
          job: job.token,
          code: ready?.code,
          identity: ready?.identity,
          expectedVersion: ready?.expectedVersion,
          loadedVersion: ready?.loadedVersion,
          coreOnline: ready?.coreOnline,
          compatible: ready?.compatible,
        });
      }
      return true;
    } catch (error) {
      if (!selected(job)) return false;
      const stale =
        !validLock(job) || !currentMatches(job.previous) || committed(job);
      status(
        job,
        stale ? 'SUPERSEDED' : 'FAILED',
        'api-startup',
        stale
          ? 'STALE_ACTIVATION'
          : error.code === 'API_STARTUP_TIMEOUT'
            ? 'API_STARTUP_TIMEOUT'
            : 'JOB_CANCELLED',
      );
      return false;
    }
  }
  if (!(await startup())) return;
  while (selected(job)) {
    if (!status(job, 'PENDING', 'activation-lock')) return;
    lockDeadline ??= Date.now() + LOCK_MS;
    if (!currentMatches(job.previous))
      return status(job, 'SUPERSEDED', 'activation-lock', 'STALE_CURRENT');
    if (!validLock(job))
      return status(job, 'SUPERSEDED', 'activation-lock', 'LOCK_REPLACED');
    if (committed(job))
      return status(job, 'SUPERSEDED', 'activation-lock', 'STALE_REGISTRATION');
    const lock = fs.openSync(path.join(RUN, 'install.lock'), 'r+');
    if (!validLock(job, lock)) {
      fs.closeSync(lock);
      return status(job, 'SUPERSEDED', 'activation-lock', 'LOCK_REPLACED');
    }
    // fd 9 is shared with flock and activate.sh, and remains locked until both exit.
    const stdio = [
      'ignore',
      1,
      2,
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      lock,
    ];
    const child = spawn(
      '/bin/bash',
      [
        '-c',
        'flock -n -E 74 9 || exit 74; exec "$@"',
        'bridge-activation',
        process.execPath,
        SELF,
        'activate',
        job.dir,
      ],
      { stdio, detached: true },
    );
    fs.closeSync(lock);
    const result = await new Promise((resolve) => {
      // Killing the transaction group could interrupt rollback recovery.
      // activate.sh owns bounded service/health waits; retain its lock to exit.
      child.once('error', () => resolve(-1));
      child.once('exit', (code) => resolve(code));
    });
    if (!selected(job)) return;
    if (result === 75) {
      lockDeadline = null;
      if (!(await startup())) return;
      continue;
    }
    if (result === 74 && Date.now() < lockDeadline) {
      await sleep(POLL_MS);
      continue;
    }
    if (result === 74)
      return status(job, 'FAILED', 'activation-lock', 'LOCK_TIMEOUT');
    if (result === 76) return;
    return status(
      job,
      result === 0 ? 'READY' : 'FAILED',
      'activation',
      result === 0 ? null : 'ACTIVATION_FAILED',
    );
  }
}
async function schedule(args) {
  if (args.length !== 4) throw new Error('SCHEDULE_ARGUMENTS');
  const [candidate, backup, previous, version] = args;
  parseReleaseVersion(version);
  if (
    !/^\d{4}\.\d{2}\.\d{2}[a-z]?$/.test(version) ||
    fs.realpathSync(candidate) !== candidate ||
    path.dirname(candidate) !== path.join(RUNTIME, 'releases') ||
    !currentMatches(previous) ||
    (previous !== '' &&
      (path.dirname(previous) !== path.join(RUNTIME, 'releases') ||
        fs.realpathSync(previous) !== previous)) ||
    !backup.startsWith('/boot/config/plugins/unraid-deck-bridge/backups/')
  )
    throw new Error('SCHEDULE_TARGET');
  const native = nativeAncestor();
  // Reclaiming a prior hook is safe only inside the installer's inherited lock.
  const lock = lockIdentity();
  if (!validLock({ lock }, 9)) throw new Error('SCHEDULE_LOCK_REQUIRED');
  const locked = spawnSync('flock', ['-n', '9'], {
    stdio: [
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      'ignore',
      9,
    ],
  });
  if (locked.error || locked.status !== 0 || !validLock({ lock }, 9))
    throw new Error('SCHEDULE_LOCK_REQUIRED');
  const captured = captureDirectory(native);
  const info = snapshot(captured, version, native);
  // RUN is created by prepare; never recreate it after uninstall.
  const dir = fs.mkdtempSync(path.join(RUN, 'post-install-'));
  fs.chmodSync(dir, 0o700);
  const token = path.basename(dir);
  const job = {
    dir,
    token,
    candidate,
    backup,
    previous,
    version,
    native,
    before: fingerprint(),
    lock,
    digest: info.digest,
  };
  const hookTemp = path.join(
    path.dirname(HOOK),
    '.unraid-deck-bridge-install.bridge-tmp',
  );
  let stagedHook = false;
  try {
    fs.writeFileSync(path.join(dir, 'owner'), token, {
      mode: 0o600,
      flag: 'wx',
    });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(job), {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(
      path.join(captured, 'snapshot.plg'),
      path.join(dir, 'snapshot.plg'),
    );
    fs.renameSync(
      path.join(captured, 'capture.json'),
      path.join(dir, 'snapshot.json'),
    );
    fs.rmdirSync(captured);
    status(job, 'PENDING', 'detach');
    const pointer = path.join(RUN, `activation-job-${job.token}.tmp`);
    fs.writeFileSync(pointer, token, { mode: 0o600, flag: 'wx' });
    fs.renameSync(pointer, path.join(RUN, 'activation-job'));
    fs.mkdirSync(path.dirname(HOOK), { recursive: true });
    const hookDirectory = path.dirname(HOOK);
    const directory = fs.lstatSync(hookDirectory);
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid() ||
      directory.mode & 0o022 ||
      fs.realpathSync(hookDirectory) !== hookDirectory
    )
      throw new Error('HOOK_STAGING_UNSAFE');
    if (!selected(job) || !validLock(job, 9)) throw new Error('JOB_CANCELLED');
    const leftover = fs.lstatSync(hookTemp, { throwIfNoEntry: false });
    if (leftover) {
      // Never follow links or recursively delete an unexpected directory.
      if (
        !leftover.isFile() ||
        leftover.uid !== process.getuid() ||
        leftover.nlink !== 1
      )
        throw new Error('HOOK_STAGING_UNSAFE');
      fs.unlinkSync(hookTemp);
    }
    const hookDescriptor = fs.openSync(hookTemp, 'wx', 0o755);
    stagedHook = true;
    try {
      fs.writeFileSync(hookDescriptor, hookSource(job));
    } finally {
      fs.closeSync(hookDescriptor);
    }
    fs.renameSync(hookTemp, HOOK);
    stagedHook = false;
    const log = fs.openSync(path.join(dir, 'worker.log'), 'wx', 0o600);
    const launcher = spawn(process.execPath, [SELF, 'launch', dir], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    fs.closeSync(log);
    let launchError = false;
    launcher.on('error', () => {
      launchError = true;
    });
    launcher.unref();
    const deadline = Date.now() + DETACH_MS;
    while (!exists(path.join(dir, 'detached'))) {
      if (launchError || !selected(job) || Date.now() >= deadline)
        throw new Error('DETACH_FAILED');
      await sleep(POLL_MS);
    }
    console.log(
      'Package prepared; runtime/API activation pending native plugin registration.',
    );
  } catch (error) {
    status(job, 'FAILED', 'schedule', error.code || error.message);
    cleanHook(job);
    if (stagedHook) fs.rmSync(hookTemp, { force: true });
    // Revoke ownership without destroying the private failure diagnostics.
    fs.rmSync(path.join(dir, 'owner'), { force: true });
    try {
      const pointer = path.join(RUN, 'activation-job');
      if (fs.readFileSync(pointer, 'utf8') === token) fs.unlinkSync(pointer);
    } catch {}
    fs.rmSync(path.join(RUN, `activation-job-${job.token}.tmp`), {
      force: true,
    });
    throw error;
  }
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'repair-allowed') {
    process.exitCode = args.length === 0 && repairAllowed() ? 0 : 75;
    return;
  }
  if (mode === 'native-complete') return nativeComplete(args);
  if (mode === 'native-complete-locked') return nativeCompleteLocked(args);
  if (mode === 'schedule') return schedule(args);
  if (args.length !== 1) throw new Error('JOB_ARGUMENTS');
  const job = readJob(args[0]);
  if (mode === 'launch') {
    const child = spawn(process.execPath, [SELF, 'run', job.dir], {
      detached: true,
      stdio: ['ignore', 1, 2],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } else if (mode === 'run') {
    try {
      await worker(job);
    } catch {
      status(job, 'FAILED', 'controller', 'CONTROLLER_ERROR');
    }
  } else if (mode === 'activate') {
    const reason = !selected(job)
      ? 'NEWER_JOB'
      : !validLock(job, 9)
        ? 'LOCK_REPLACED'
        : !currentMatches(job.previous)
          ? 'STALE_CURRENT'
          : !job.confirmed || committed(job)
            ? 'STALE_REGISTRATION'
            : null;
    if (reason) {
      status(job, 'SUPERSEDED', 'activation', reason);
      process.exitCode = 76;
      return;
    }
    if (!(await inspectRuntime()).ready) {
      process.exitCode = 75;
      return;
    }
    if (
      !selected(job) ||
      !validLock(job, 9) ||
      !currentMatches(job.previous) ||
      committed(job)
    ) {
      process.exitCode = 76;
      return;
    }
    if (!status(job, 'PENDING', 'activation')) {
      process.exitCode = 76;
      return;
    }
    const child = spawn(
      '/bin/bash',
      [
        path.join(job.candidate, 'activate.sh'),
        job.candidate,
        job.backup,
        job.previous,
        job.version,
      ],
      {
        stdio: [
          'ignore',
          1,
          2,
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          9,
        ],
      },
    );
    process.exitCode = await new Promise((resolve) => {
      child.once('error', () => resolve(1));
      child.once('exit', (code) => resolve(code ?? 1));
    });
  } else throw new Error('MODE');
}
main().catch((error) => {
  const safe = [
    'CAPTURE_SOURCE',
    'SNAPSHOT_VERSION',
    'SNAPSHOT_OWNER',
    'SNAPSHOT_INVALID',
    'SNAPSHOT_DIGEST',
    'NATIVE_CONTEXT',
    'NATIVE_FAILED',
    'NATIVE_MANAGER_REQUIRED',
    'SCHEDULE_ARGUMENTS',
    'SCHEDULE_TARGET',
    'SCHEDULE_LOCK_REQUIRED',
    'HOOK_STAGING_UNSAFE',
    'DETACH_FAILED',
    'JOB_ARGUMENTS',
    'JOB_PATH',
    'JOB_CANCELLED',
    'MODE',
  ];
  const code = safe.includes(error.message)
    ? error.message
    : typeof error.code === 'string' && /^E[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'CONTROLLER_ERROR';
  console.error(`Deferred API activation failed (${code}).`);
  process.exitCode = 1;
});
