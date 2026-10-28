import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const RUN = '/var/run/unraid-deck-bridge';
const NATIVE = '/usr/local/sbin/plugin';
const DOWNLOAD = '/tmp/plugins';

function identity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return {
      pid,
      parent: Number(fields[1]),
      start: fields[19],
      state: fields[0],
      exit: Number(fields[49]),
    };
  } catch {
    return null;
  }
}
function nativeAncestor() {
  const executable = fs.realpathSync(NATIVE);
  let current = identity(process.ppid);
  for (let depth = 0; current && current.pid > 1 && depth < 64; depth++) {
    const args = fs
      .readFileSync(`/proc/${current.pid}/cmdline`, 'utf8')
      .split('\0');
    if (
      args.slice(0, 3).some((arg) => {
        if (!path.isAbsolute(arg)) return false;
        try {
          return fs.realpathSync(arg) === executable;
        } catch {
          return false;
        }
      })
    )
      return current;
    current = identity(current.parent);
  }
  throw new Error('NATIVE_MANAGER_REQUIRED');
}
function nativeCommand(native) {
  const args = fs
    .readFileSync(`/proc/${native.pid}/cmdline`, 'utf8')
    .split('\0');
  const executable = fs.realpathSync(NATIVE);
  const index = args.findIndex((arg) => {
    try {
      return path.isAbsolute(arg) && fs.realpathSync(arg) === executable;
    } catch {
      return false;
    }
  });
  const [method, source] = args.slice(index + 1);
  if (index < 0 || !['install', 'update'].includes(method) || !source)
    throw new Error('CAPTURE_SOURCE');
  return { method, source };
}
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
function validatePLG(bytes, version) {
  const plugin = bytes.toString('utf8').match(/<PLUGIN\s[^>]*>/i)?.[0];
  if (
    plugin?.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1] !==
      'unraid-deck-bridge' ||
    plugin?.match(/\bversion\s*=\s*["']([^"']+)["']/i)?.[1] !== version
  )
    throw new Error('SNAPSHOT_VERSION');
}
function privateDirectory(dir) {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error('SNAPSHOT_OWNER');
}
function captureDirectory(native) {
  return path.join(RUN, `plg-capture-${native.pid}-${native.start}`);
}
function snapshot(dir, version, native, metadata = 'capture.json') {
  privateDirectory(dir);
  const info = JSON.parse(fs.readFileSync(path.join(dir, metadata), 'utf8'));
  const file = path.join(dir, 'snapshot.plg');
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid() ||
    info.native.pid !== native.pid ||
    info.native.start !== native.start ||
    info.name !== 'unraid-deck-bridge' ||
    info.version !== version
  )
    throw new Error('SNAPSHOT_INVALID');
  const bytes = fs.readFileSync(file);
  validatePLG(bytes, version);
  if (digest(bytes) !== info.digest) throw new Error('SNAPSHOT_DIGEST');
  return info;
}
function capture(args) {
  if (args.length !== 1 || !/^\d{4}\.\d{2}\.\d{2}\.\d{4}$/.test(args[0]))
    throw new Error('CAPTURE_ARGUMENTS');
  if (process.getuid() !== 0) throw new Error('SNAPSHOT_OWNER');
  const version = args[0];
  const native = nativeAncestor();
  const command = nativeCommand(native);
  if (
    command.method === 'update' &&
    command.source !== 'unraid-deck-bridge.plg'
  )
    throw new Error('CAPTURE_SOURCE');
  const source =
    command.method === 'update' || /^https?:\/\//.test(command.source)
      ? path.join(DOWNLOAD, path.basename(command.source))
      : path.resolve(
          fs.readlinkSync(`/proc/${native.pid}/cwd`),
          command.source,
        );
  let bytes;
  try {
    if (
      path.basename(source) !== 'unraid-deck-bridge.plg' ||
      !fs.lstatSync(source).isFile()
    )
      throw new Error('CAPTURE_SOURCE');
    bytes = fs.readFileSync(source);
  } catch {
    throw new Error('CAPTURE_SOURCE');
  }
  validatePLG(bytes, version);
  const existing = fs.lstatSync(RUN, { throwIfNoEntry: false });
  if (existing && (!existing.isDirectory() || existing.uid !== 0))
    throw new Error('SNAPSHOT_OWNER');
  fs.mkdirSync(RUN, { recursive: true, mode: 0o700 });
  fs.chmodSync(RUN, 0o700);
  privateDirectory(RUN);
  const dir = captureDirectory(native);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'snapshot.plg'), bytes, {
    mode: 0o600,
    flag: 'wx',
  });
  fs.writeFileSync(
    path.join(dir, 'capture.json'),
    JSON.stringify({
      native,
      source,
      method: command.method,
      version,
      name: 'unraid-deck-bridge',
      digest: digest(bytes),
    }),
    { mode: 0o600, flag: 'wx' },
  );
}

export {
  identity,
  nativeAncestor,
  nativeCommand,
  captureDirectory,
  snapshot,
  capture,
};
