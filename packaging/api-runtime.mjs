#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { logLifecycle } from './lifecycle-log.mjs';
import {
  parseReleaseVersion,
  isObservedReleaseVersion,
} from './adapter/release-version.mjs';

const DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS = {
  procRoot: '/proc',
  apiSocket: '/var/run/unraid-api.sock',
  emhttpSocket: '/var/run/emhttpd.socket',
  coreSocket: '/var/run/unraid-deck-bridge/core.sock',
  tokenPath: '/var/run/unraid-api/local-session',
  ownerUid: 0,
  requestTimeoutMs: 3000,
  maxResponseBytes: 262144,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failure = (code) => Object.assign(new Error(code), { code });
function settings(options) {
  return { ...DEFAULTS, ...options };
}
function expectedVersion(options) {
  const version = Object.hasOwn(options, 'expectedVersion')
    ? options.expectedVersion
    : JSON.parse(
        fs.readFileSync(path.join(DIRECTORY, 'adapter/release.json'), 'utf8'),
      ).version;
  try {
    parseReleaseVersion(version);
  } catch {
    throw failure('METADATA_UNKNOWN');
  }
  return version;
}
function check(valid) {
  if (valid && !valid()) throw failure('JOB_CANCELLED');
}

function processRecord(root, pid) {
  const base = path.join(root, String(pid));
  const readIdentity = () => {
    const owner = fs.lstatSync(base);
    if (!owner.isDirectory()) throw failure('PROCESS_UNKNOWN');
    const stat = fs.readFileSync(path.join(base, 'stat'), 'utf8');
    if (!stat.startsWith(`${pid} (`)) throw failure('PROCESS_UNKNOWN');
    const fields = stat
      .slice(stat.lastIndexOf(')') + 2)
      .trim()
      .split(/\s+/);
    if (!/^\d+$/.test(fields[19] ?? '')) throw failure('PROCESS_UNKNOWN');
    return {
      start: fields[19],
      dead: ['Z', 'X'].includes(fields[0]),
      uid: owner.uid,
    };
  };
  const before = readIdentity();
  if (before.dead) return null;
  const args = fs
    .readFileSync(path.join(base, 'cmdline'), 'utf8')
    .split('\0')
    .filter(Boolean);
  const exe = fs.readlinkSync(path.join(base, 'exe'));
  const after = readIdentity();
  if (after.dead || after.start !== before.start || after.uid !== before.uid)
    throw failure('PROCESS_UNKNOWN');
  return { pid, start: before.start, uid: before.uid, args, exe, base };
}
function command(record) {
  const { args, exe } = record;
  const binary = path.basename(exe);
  if (['bash', 'sh', 'dash'].includes(binary)) {
    let index = 1;
    while (args[index]?.startsWith('-') && args[index] !== '-c') index++;
    if (args[index] === '-c') return null;
    return { script: args[index], args: args.slice(index + 1) };
  }
  if (['node', 'nodejs'].includes(binary)) {
    let index = 1;
    while (args[index]?.startsWith('--') && !args[index].includes('=')) {
      if (!['--no-warnings', '--enable-source-maps'].includes(args[index]))
        return null;
      index++;
    }
    return { script: args[index], args: args.slice(index + 1) };
  }
  return { script: exe, args: args.slice(1) };
}
function rcScript(script) {
  const canonical = '/usr/local/etc/rc.d/';
  if (
    !['rc.local', 'rc.unraid-api', 'rc.nginx'].some(
      (name) => script === `${canonical}${name}`,
    )
  )
    return script;
  // Accept the alternate spelling only when it is the host's verified alias.
  try {
    const alias = fs.lstatSync('/etc/rc.d');
    if (
      alias.isSymbolicLink() &&
      alias.uid === 0 &&
      fs.realpathSync('/etc/rc.d') === '/usr/local/etc/rc.d'
    )
      return `/etc/rc.d/${script.slice(canonical.length)}`;
  } catch {
    throw failure('PROCESS_UNKNOWN');
  }
  throw failure('PROCESS_UNKNOWN');
}
function classify(record) {
  // PM2 replaces argv with one exact process title on the pinned host.
  if (
    ['node', 'nodejs'].includes(path.basename(record.exe)) &&
    record.args.length === 1 &&
    record.args[0] === 'node /usr/local/unraid-api/dist/main.js'
  )
    return 'api';
  const cmd = command(record);
  if (!cmd) return null;
  cmd.script = rcScript(cmd.script);
  if (['/etc/rc.d/rc.local', '/boot/config/go'].includes(cmd.script))
    return 'startup';
  if (
    ['/etc/rc.d/rc.unraid-api', '/etc/rc.d/rc.nginx'].includes(cmd.script) &&
    ['start', 'stop', 'restart'].includes(cmd.args[0])
  )
    return 'startup';
  if (
    record.exe === '/usr/libexec/unraid/emhttpd' &&
    record.args[0] === '/usr/libexec/unraid/emhttpd'
  )
    return 'emhttp';
  if (
    [
      '/usr/local/bin/unraid-api',
      '/usr/bin/unraid-api',
      '/usr/local/unraid-api/bin/unraid-api',
      '/usr/local/unraid-api/dist/cli.js',
    ].includes(cmd.script) &&
    ['start', 'stop', 'restart'].includes(cmd.args[0])
  )
    return 'startup';
  if (
    cmd.script === '/usr/local/unraid-api/dist/main.js' &&
    ['node', 'nodejs'].includes(path.basename(record.exe))
  )
    return 'api';
  return null;
}
function snapshot(options) {
  const records = [];
  for (const entry of fs.readdirSync(options.procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const record = processRecord(options.procRoot, Number(entry));
      if (record) {
        if (classify(record) && record.uid !== options.ownerUid)
          throw failure('PROCESS_UNKNOWN');
        records.push(record);
      }
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code))
        throw failure('PROCESS_UNKNOWN');
    }
  }
  if (records.some((record) => classify(record) === 'startup'))
    throw failure('API_STARTING');
  const api = records.filter((record) => classify(record) === 'api');
  const web = records.filter((record) => classify(record) === 'emhttp');
  if (api.length !== 1 || web.length !== 1) throw failure('PROCESS_UNKNOWN');
  return {
    api: api[0],
    identity: `${api[0].pid}:${api[0].start}/${web[0].pid}:${web[0].start}`,
  };
}
function token(options, api) {
  // Read only this process's path override; never return or report its environment.
  const environment = fs
    .readFileSync(path.join(api.base, 'environ'), 'utf8')
    .split('\0');
  const override = environment.find((entry) =>
    entry.startsWith('PATHS_LOCAL_SESSION_FILE='),
  );
  const file = override
    ? override.slice('PATHS_LOCAL_SESSION_FILE='.length)
    : options.tokenPath;
  if (!path.isAbsolute(file)) throw failure('SESSION_UNSAFE');
  for (let parent = path.dirname(file); ; parent = path.dirname(parent)) {
    let stat = fs.lstatSync(parent);
    // Unraid uses this one canonical, root-owned runtime alias.
    if (
      parent === '/var/run' &&
      stat.isSymbolicLink() &&
      stat.uid === 0 &&
      fs.readlinkSync(parent) === '/run'
    )
      stat = fs.lstatSync('/run');
    if (
      !stat.isDirectory() ||
      ![0, options.ownerUid].includes(stat.uid) ||
      (stat.mode & 0o022 && !(stat.uid === 0 && stat.mode & 0o1000))
    )
      throw failure('SESSION_UNSAFE');
    if (parent === path.dirname(parent)) break;
  }
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== options.ownerUid ||
      stat.mode & 0o077 ||
      stat.size !== 64
    )
      throw failure('SESSION_UNSAFE');
    const value = fs.readFileSync(fd, 'utf8');
    if (!/^[a-f0-9]{64}$/.test(value)) throw failure('SESSION_UNSAFE');
    return value;
  } finally {
    fs.closeSync(fd);
  }
}
function request(options, socketPath, route, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: route, method: body ? 'POST' : 'GET', headers },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > options.maxResponseBytes)
            req.destroy(failure('RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        res.on('error', () => reject(failure('HTTP_UNAVAILABLE')));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    const timer = setTimeout(
      () => req.destroy(failure('HTTP_TIMEOUT')),
      options.requestTimeoutMs,
    );
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(failure('HTTP_UNAVAILABLE')));
    if (body) req.write(body);
    req.end();
  });
}
async function graphql(options, credential, query) {
  const response = await request(
    options,
    options.apiSocket,
    '/graphql',
    { 'content-type': 'application/json', 'x-local-session': credential },
    JSON.stringify({ query }),
  );
  if (response.status !== 200) throw failure('API_AUTH_UNKNOWN');
  let result;
  try {
    result = JSON.parse(response.body);
  } catch {
    throw failure('API_RESPONSE_UNKNOWN');
  }
  if (result.errors?.length || !result.data) throw failure('API_AUTH_UNKNOWN');
  return result.data;
}
export async function inspectCore(input = {}) {
  const options = settings(input);
  try {
    check(options.valid);
    const response = await request(options, options.coreSocket, '/info', {
      'x-bridge-actor': 'installer',
    });
    check(options.valid);
    const info = JSON.parse(response.body);
    return {
      healthy:
        response.status === 200 &&
        info.version === expectedVersion(options) &&
        info.accepting === true,
      code: 'CORE_CHECKED',
    };
  } catch (error) {
    if (error.code === 'JOB_CANCELLED') throw error;
    return { healthy: false, code: 'CORE_UNKNOWN' };
  }
}
export async function inspectRuntime(input = {}) {
  const options = settings(input);
  let identity = null;
  let version;
  try {
    check(options.valid);
    version = expectedVersion(options);
    const before = snapshot(options);
    identity = before.identity;
    const credential = token(options, before.api);
    const web = await request(options, options.emhttpSocket, '/');
    check(options.valid);
    if (![200, 302, 404].includes(web.status))
      throw failure('EMHTTP_UNAVAILABLE');
    const schema = await graphql(
      options,
      credential,
      '{ me { name } __schema { queryType { fields { name } } } }',
    );
    check(options.valid);
    if (typeof schema.me?.name !== 'string') throw failure('API_AUTH_UNKNOWN');
    const fields = schema.__schema?.queryType?.fields;
    if (
      !Array.isArray(fields) ||
      !fields.every((field) => typeof field.name === 'string')
    )
      throw failure('API_SCHEMA_UNKNOWN');
    if (snapshot(options).identity !== identity)
      throw failure('API_PROCESS_CHANGED');
    if (!fields.some((field) => field.name === 'deckBridge'))
      return {
        ready: true,
        identity,
        expectedVersion: version,
        adapter: 'missing',
        code: 'ADAPTER_MISSING',
      };
    const data = await graphql(
      options,
      credential,
      '{ deckBridge { info { version coreOnline compatible } } }',
    );
    check(options.valid);
    if (snapshot(options).identity !== identity)
      throw failure('API_PROCESS_CHANGED');
    const info = data.deckBridge?.info;
    if (
      !isObservedReleaseVersion(info?.version) ||
      typeof info.coreOnline !== 'boolean' ||
      typeof info.compatible !== 'boolean'
    )
      throw failure('ADAPTER_UNKNOWN');
    const adapter = info.version === version ? 'current' : 'different';
    return {
      ready: true,
      expectedVersion: version,
      loadedVersion: info.version,
      identity,
      adapter,
      code: adapter === 'current' ? 'ADAPTER_CURRENT' : 'ADAPTER_DIFFERENT',
      coreOnline: info.coreOnline,
      compatible: info.compatible,
    };
  } catch (error) {
    if (error.code === 'JOB_CANCELLED') throw error;
    const known = [
      'METADATA_UNKNOWN',
      'PROCESS_UNKNOWN',
      'API_STARTING',
      'API_PROCESS_CHANGED',
      'SESSION_UNSAFE',
      'HTTP_UNAVAILABLE',
      'EMHTTP_UNAVAILABLE',
      'API_AUTH_UNKNOWN',
      'API_RESPONSE_UNKNOWN',
      'API_SCHEMA_UNKNOWN',
      'ADAPTER_UNKNOWN',
    ];
    return {
      ready: false,
      ...(version ? { expectedVersion: version } : {}),
      identity,
      adapter: 'unknown',
      code: known.includes(error.code) ? error.code : 'RUNTIME_UNKNOWN',
    };
  }
}
export async function waitForApi({
  valid = () => true,
  onWait = () => {},
  initialDelayMs = 10000,
  intervalMs = 2000,
  stableSamples = 3,
  timeoutMs = 300000,
  ...options
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const pause = async (ms) => {
    const until = Math.min(Date.now() + Math.max(0, ms), deadline);
    check(valid);
    while (Date.now() < until) {
      await sleep(Math.min(100, until - Date.now()));
      check(valid);
    }
  };
  await pause(initialDelayMs);
  let previous = null;
  let samples = 0;
  while (Date.now() < deadline) {
    check(valid);
    const result = await inspectRuntime({ ...options, valid });
    check(valid);
    if (Date.now() >= deadline) break;
    samples =
      result.ready && result.identity === previous
        ? samples + 1
        : result.ready
          ? 1
          : 0;
    previous = result.ready ? result.identity : null;
    if (samples >= stableSamples) return result;
    onWait(result.code);
    await pause(intervalMs);
  }
  throw failure('API_STARTUP_TIMEOUT');
}
async function cli(command) {
  if (command === 'core') return (await inspectCore()).healthy ? 0 : 75;
  if (command === 'wait') {
    await waitForApi();
    return 0;
  }
  if (!['ready', 'loaded', 'decision', 'health', 'inspect'].includes(command))
    return 64;
  const result = await inspectRuntime();
  if (command === 'decision') {
    const {
      code,
      identity,
      expectedVersion,
      loadedVersion,
      coreOnline,
      compatible,
    } = result;
    try {
      logLifecycle('api-detected', {
        code,
        identity,
        expectedVersion,
        loadedVersion,
        coreOnline,
        compatible,
      });
    } catch {
      process.stderr.write('lifecycle-log: LOG_WRITE_FAILED\n');
    }
  }
  if (command === 'inspect') {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ready ? 0 : 75;
  }
  if (command === 'ready') return result.ready ? 0 : 75;
  if (!result.ready || result.adapter === 'unknown') return 75;
  if (command === 'loaded' || command === 'decision')
    return result.adapter === 'current' ? 0 : 10;
  return result.adapter === 'current' &&
    result.coreOnline &&
    result.compatible &&
    (await inspectCore()).healthy
    ? 0
    : 75;
}
function isMainModule() {
  try {
    return (
      Boolean(process.argv[1]) &&
      fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
}
if (isMainModule()) {
  try {
    process.exitCode =
      process.argv.length === 3 ? await cli(process.argv[2]) : 64;
  } catch {
    process.exitCode = 75;
  }
}
