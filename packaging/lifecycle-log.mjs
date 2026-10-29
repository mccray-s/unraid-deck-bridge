#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  parseReleaseVersion,
  isObservedReleaseVersion,
} from './adapter/release-version.mjs';

const BASE = '/boot/config/plugins/unraid-deck-bridge';
const OWNER = 0;
const MAX_BYTES = 256 * 1024;
const SELF = fileURLToPath(import.meta.url);
const token = /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/;

function safeStat(target, directory = false) {
  const stat = fs.lstatSync(target);
  if (
    stat.uid !== OWNER ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
  )
    throw new Error('UNSAFE_ENTRY');
  return stat;
}
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
function regular(target) {
  try {
    return safeStat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function privateMode(target, stat, directory = false) {
  const mode = directory ? 0o700 : 0o600;
  if ((stat.mode & 0o777) === mode) return;
  const fd = fs.openSync(
    target,
    fs.constants.O_RDONLY |
      fs.constants.O_NOFOLLOW |
      (directory ? fs.constants.O_DIRECTORY : 0),
  );
  try {
    if (!same(stat, fs.fstatSync(fd))) throw new Error('UNSAFE_ENTRY');
    try {
      fs.fchmodSync(fd, mode);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code))
        throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
}
function metadata() {
  let boot = 'unknown';
  let programVersion = 'unknown';
  try {
    const value = fs
      .readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')
      .trim();
    if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))
      boot = value;
  } catch {}
  try {
    const adapter = path.join(path.dirname(SELF), 'adapter');
    safeStat(adapter, true);
    const file = path.join(adapter, 'release.json');
    const stat = safeStat(file);
    if (stat.size <= 65536) {
      const fd = fs.openSync(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
      );
      try {
        if (!same(stat, fs.fstatSync(fd))) throw new Error('UNSAFE_ENTRY');
        const value = JSON.parse(fs.readFileSync(fd, 'utf8')).version;
        programVersion = parseReleaseVersion(value).version;
      } finally {
        fs.closeSync(fd);
      }
    }
  } catch {}
  return {
    boot,
    programVersion,
    ...(programVersion === 'unknown'
      ? {}
      : { expectedVersion: programVersion }),
  };
}
function fields(details) {
  const result = {};
  for (const key of ['state', 'phase', 'code', 'loadedStatus']) {
    if (typeof details[key] === 'string' && token.test(details[key]))
      result[key] = details[key];
  }
  if (
    typeof details.job === 'string' &&
    /^post-install-[a-zA-Z0-9-]{1,100}$/.test(details.job)
  )
    result.job = details.job;
  for (const key of ['pid', 'start']) {
    if (Number.isSafeInteger(details[key]) && details[key] > 0)
      result[key] = details[key];
  }
  if (
    typeof details.identity === 'string' &&
    /^\d{1,16}:\d{1,20}(?:\/\d{1,16}:\d{1,20})?$/.test(details.identity)
  )
    result.identity = details.identity;
  for (const key of ['expectedVersion', 'loadedVersion']) {
    if (isObservedReleaseVersion(details[key])) result[key] = details[key];
  }
  for (const key of ['diskCurrent', 'coreOnline', 'compatible']) {
    if (typeof details[key] === 'boolean') result[key] = details[key];
  }
  return result;
}

// Importing this module never touches flash. All failures remain nonfatal.
function appendLifecycle(event, details = {}) {
  let fd;
  try {
    if (typeof event !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(event))
      throw new Error('INVALID_EVENT');
    const line = Buffer.from(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...metadata(),
        event,
        pid: process.pid,
        ...fields(details),
      }) + '\n',
    );
    // Check every ancestor, without creating the plugin base after uninstall.
    let ancestor = BASE;
    while (true) {
      safeStat(ancestor, true);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const base = safeStat(BASE, true);
    const directory = path.join(BASE, 'logs');
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const logs = safeStat(directory, true);
    const current = path.join(directory, 'lifecycle.log');
    const previous = path.join(directory, 'lifecycle.log.1');
    let stat = regular(current);
    const rotated = regular(previous);
    if (stat?.size > MAX_BYTES || rotated?.size > MAX_BYTES)
      throw new Error('OVERSIZED_ENTRY');
    privateMode(directory, logs, true);
    if (stat) privateMode(current, stat);
    if (rotated) privateMode(previous, rotated);
    if (
      !same(base, safeStat(BASE, true)) ||
      !same(logs, safeStat(directory, true))
    )
      throw new Error('UNSAFE_ENTRY');
    if (stat && stat.size + line.length > MAX_BYTES) {
      if (rotated) fs.unlinkSync(previous);
      fs.renameSync(current, previous);
      stat = null;
    }
    fd = fs.openSync(
      current,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_NOFOLLOW |
        (stat ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL),
      0o600,
    );
    const opened = fs.fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.uid !== OWNER ||
      opened.nlink !== 1 ||
      (stat && !same(stat, opened)) ||
      !same(base, safeStat(BASE, true)) ||
      !same(logs, safeStat(directory, true))
    )
      throw new Error('UNSAFE_ENTRY');
    if (opened.size + line.length > MAX_BYTES) throw new Error('LOG_BUSY');
    try {
      fs.fchmodSync(fd, 0o600);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code))
        throw error;
    }
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
    return true;
  } catch (error) {
    const reason = [
      'UNSAFE_ENTRY',
      'OVERSIZED_ENTRY',
      'INVALID_EVENT',
      'LOG_BUSY',
    ].includes(error.message)
      ? error.message
      : ['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EEXIST'].includes(
            error.code,
          )
        ? error.code
        : 'LOG_WRITE_FAILED';
    try {
      process.stderr.write(`bridge lifecycle log: ${reason}\n`);
    } catch {}
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
}

export function logLifecycle(event, details = {}) {
  let lock;
  try {
    let ancestor = BASE;
    while (true) {
      safeStat(ancestor, true);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const directory = path.join(BASE, 'logs');
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    safeStat(directory, true);
    const target = path.join(directory, 'lifecycle.lock');
    const before = regular(target);
    lock = fs.openSync(
      target,
      fs.constants.O_RDWR |
        fs.constants.O_NOFOLLOW |
        (before ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL),
      0o600,
    );
    const opened = fs.fstatSync(lock);
    if (
      !opened.isFile() ||
      opened.uid !== OWNER ||
      opened.nlink !== 1 ||
      (before && !same(before, opened))
    )
      throw new Error();
    privateMode(target, opened);
    let start;
    try {
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      start = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
    } catch {}
    const result = spawnSync(
      '/bin/bash',
      [
        '-c',
        'flock -n 9 || exit 75; exec "$@"',
        'bridge-lifecycle-log',
        process.execPath,
        SELF,
        '--locked',
        event,
        JSON.stringify(fields({ pid: process.pid, start, ...details })),
      ],
      {
        stdio: [
          'ignore',
          'ignore',
          'inherit',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          lock,
        ],
        timeout: 2000,
        env: { PATH: '/usr/bin:/bin' },
      },
    );
    if (result.error || result.status !== 0) throw new Error();
    return true;
  } catch {
    try {
      process.stderr.write('bridge lifecycle log: LOG_UNAVAILABLE\n');
    } catch {}
    return false;
  } finally {
    if (lock !== undefined) {
      try {
        fs.closeSync(lock);
      } catch {}
    }
  }
}

function isMainModule() {
  try {
    return (
      Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === SELF
    );
  } catch {
    return false;
  }
}
if (isMainModule()) {
  const [event, code, data] = process.argv.slice(2);
  if (event === '--locked') {
    try {
      const target = path.join(BASE, 'logs/lifecycle.lock');
      if (!same(safeStat(target), fs.fstatSync(9))) throw new Error();
      process.exitCode = appendLifecycle(code, JSON.parse(data)) ? 0 : 1;
    } catch {
      process.stderr.write('bridge lifecycle log: LOG_UNAVAILABLE\n');
      process.exitCode = 1;
    }
  } else logLifecycle(event, { code });
}
