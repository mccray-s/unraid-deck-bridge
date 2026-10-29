import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';
import {
  inspectRuntime,
  inspectCore,
  waitForApi,
} from '../packaging/api-runtime.mjs';

async function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-runtime-')),
  );
  fs.chmodSync(root, 0o700);
  const options = {
    procRoot: path.join(root, 'proc'),
    apiSocket: path.join(root, 'a.sock'),
    emhttpSocket: path.join(root, 'e.sock'),
    coreSocket: path.join(root, 'c.sock'),
    tokenPath: path.join(root, 'session'),
    ownerUid: process.getuid(),
    expectedVersion: '0.6.0',
    requestTimeoutMs: 80,
  };
  fs.mkdirSync(options.procRoot);
  const secret = 'a'.repeat(64);
  fs.writeFileSync(options.tokenPath, secret, { mode: 0o600 });
  const state = {
    loaded: true,
    version: '0.6.0',
    coreOnline: true,
    compatible: true,
    accepting: true,
    dockerAvailable: false,
    auth: true,
    infoError: false,
    schemaError: false,
    blocked: false,
    oversized: false,
    queries: 0,
    webCalls: 0,
  };
  const record = (pid, exe, args, start = '100', environment = '') => {
    const base = path.join(options.procRoot, String(pid));
    fs.mkdirSync(base, { recursive: true });
    const fields = Array(52).fill('0');
    fields[0] = 'S';
    fields[1] = '1';
    fields[19] = start;
    fs.writeFileSync(
      path.join(base, 'stat'),
      `${pid} (fixture) ${fields.join(' ')}`,
    );
    fs.writeFileSync(path.join(base, 'cmdline'), `${args.join('\0')}\0`);
    fs.writeFileSync(path.join(base, 'environ'), environment);
    fs.rmSync(path.join(base, 'exe'), { force: true });
    fs.symlinkSync(exe, path.join(base, 'exe'));
  };
  record(11, '/usr/local/bin/node', [
    'node /usr/local/unraid-api/dist/main.js',
  ]);
  record(12, '/usr/libexec/unraid/emhttpd', ['/usr/libexec/unraid/emhttpd']);
  const sockets = new Set();
  const servers = [];
  async function serve(socket, handler) {
    const server = http.createServer(handler);
    server.on('connection', (connection) => {
      sockets.add(connection);
      connection.on('close', () => sockets.delete(connection));
    });
    server.listen(socket);
    await once(server, 'listening');
    servers.push(server);
  }
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });
  await serve(options.emhttpSocket, (req, res) => {
    state.webCalls++;
    assert.equal(req.method, 'GET');
    assert.equal(req.url, '/');
    if (!state.blocked) {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  await serve(options.apiSocket, async (req, res) => {
    state.queries++;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/graphql');
    assert.equal(req.headers['x-local-session'], secret);
    assert.equal(req.headers['x-api-key'], undefined);
    let body = '';
    for await (const chunk of req) body += chunk;
    const { query } = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    if (state.oversized) return res.end('x'.repeat(300000));
    if (
      !state.auth ||
      state.schemaError ||
      (state.infoError && !query.includes('__schema'))
    )
      return res.end(
        JSON.stringify({
          errors: [
            {
              message: `${secret}: unrelated validation failure`,
              extensions: { code: 'FORBIDDEN' },
            },
          ],
        }),
      );
    const data = query.includes('__schema')
      ? {
          me: { name: 'root' },
          __schema: {
            queryType: {
              fields: (state.loaded ? ['deckBridge', 'me'] : ['me']).map(
                (name) => ({ name }),
              ),
            },
          },
        }
      : {
          deckBridge: {
            info: {
              version: state.version,
              coreOnline: state.coreOnline,
              compatible: state.compatible,
            },
          },
        };
    state.onQuery?.(query);
    res.end(JSON.stringify({ data }));
  });
  await serve(options.coreSocket, (req, res) => {
    assert.equal(req.url, '/info');
    assert.equal(req.headers['x-bridge-actor'], 'installer');
    res.end(
      JSON.stringify({
        version: state.version,
        accepting: state.accepting,
        dockerAvailable: state.dockerAvailable,
      }),
    );
  });
  return {
    options,
    state,
    record,
    root,
    secret,
    remove: (pid) =>
      fs.rmSync(path.join(options.procRoot, String(pid)), {
        recursive: true,
        force: true,
      }),
  };
}

test('loaded version is proven independently of Core or Docker availability', async (t) => {
  const f = await fixture(t);
  const current = await inspectRuntime(f.options);
  assert.equal(current.adapter, 'current');
  assert.equal(current.expectedVersion, '0.6.0');
  assert.equal(current.loadedVersion, '0.6.0');
  f.state.coreOnline = false;
  f.state.compatible = false;
  const offline = await inspectRuntime(f.options);
  assert.equal(offline.ready, true);
  assert.equal(offline.adapter, 'current');
  assert.equal(offline.coreOnline, false);
  assert.equal((await inspectCore(f.options)).healthy, true);
  f.state.accepting = false;
  assert.equal((await inspectCore(f.options)).healthy, false);
  f.state.version = '0.5.0';
  assert.equal((await inspectRuntime(f.options)).adapter, 'different');
});

test('schema proof distinguishes not loaded yet, old loaded code, and post-reload target', async (t) => {
  const f = await fixture(t);
  f.state.loaded = false;
  assert.deepEqual(await inspectRuntime(f.options), {
    ready: true,
    identity: '11:100/12:100',
    expectedVersion: '0.6.0',
    adapter: 'missing',
    code: 'ADAPTER_MISSING',
  });
  f.state.loaded = true;
  f.state.version = '0.5.0';
  assert.equal((await inspectRuntime(f.options)).adapter, 'different');
  f.record(
    11,
    '/usr/local/bin/node',
    ['node', '/usr/local/unraid-api/dist/main.js'],
    '101',
  );
  f.state.version = '0.6.0';
  const after = await inspectRuntime(f.options);
  assert.equal(after.identity, '11:101/12:100');
  assert.equal(after.adapter, 'current');
});

test('auth, unrelated GraphQL errors, and network errors never prove absence', async (t) => {
  const f = await fixture(t);
  for (const property of ['auth', 'schemaError', 'infoError', 'oversized']) {
    const old = f.state[property];
    f.state[property] = property === 'auth' ? false : true;
    const result = await inspectRuntime(f.options);
    assert.equal(result.adapter, 'unknown');
    assert.equal(result.ready, false);
    assert.ok(!JSON.stringify(result).includes(f.secret));
    f.state[property] = old;
  }
  assert.equal(
    (
      await inspectRuntime({
        ...f.options,
        apiSocket: path.join(f.root, 'absent.sock'),
      })
    ).adapter,
    'unknown',
  );
});

test('invalid expected metadata cannot authorize reload or health', async (t) => {
  const f = await fixture(t);
  for (const expectedVersion of [
    undefined,
    null,
    '',
    '01.6.0',
    '0.6',
    '0.6.0-beta',
    '0.6.0+build',
    '0.6.0\n',
    '0.6.0\r\n',
    6,
  ]) {
    const options = { ...f.options, expectedVersion };
    for (const loaded of [true, false]) {
      f.state.loaded = loaded;
      const result = await inspectRuntime(options);
      assert.equal(result.ready, false);
      assert.equal(result.adapter, 'unknown');
      assert.equal(result.code, 'METADATA_UNKNOWN');
      assert.equal(result.expectedVersion, undefined);
    }
    assert.equal((await inspectCore(options)).healthy, false);
  }
  assert.equal(f.state.queries, 0);
});

test('invalid loaded versions stay unknown and do not leak raw metadata', async (t) => {
  const f = await fixture(t);
  for (const version of [null, '0.6.0\n', `0.6.0-${f.secret}`]) {
    f.state.version = version;
    const result = await inspectRuntime(f.options);
    assert.equal(result.ready, false);
    assert.equal(result.adapter, 'unknown');
    assert.equal(result.loadedVersion, undefined);
    assert.ok(!JSON.stringify(result).includes(f.secret));
  }
});

test('HTTP200 GraphQL is insufficient while emhttp is blocked', async (t) => {
  const f = await fixture(t);
  f.state.blocked = true;
  const result = await inspectRuntime(f.options);
  assert.equal(result.ready, false);
  assert.equal(result.adapter, 'unknown');
  assert.equal(f.state.queries, 0);
});

test('exact boot and API control commands block readiness, substring lookalikes do not', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['bash', '/etc/rc.d/rc.local'],
    ['bash', '/boot/config/go'],
    ['bash', '/etc/rc.d/rc.unraid-api', 'start'],
    ['bash', '/etc/rc.d/rc.nginx', 'restart'],
  ]) {
    f.record(13, '/bin/bash', args);
    assert.equal((await inspectRuntime(f.options)).code, 'API_STARTING');
    f.remove(13);
  }
  for (const operation of ['start', 'stop', 'restart']) {
    f.record(13, '/usr/local/bin/node', [
      'node',
      '/usr/local/unraid-api/dist/cli.js',
      operation,
    ]);
    assert.equal((await inspectRuntime(f.options)).ready, false);
    f.remove(13);
  }
  f.record(13, '/bin/bash', ['bash', '/tmp/lookalike-rc.local', 'start']);
  assert.equal((await inspectRuntime(f.options)).ready, true);
  f.record(11, '/bin/bash', ['node /usr/local/unraid-api/dist/main.js']);
  assert.equal((await inspectRuntime(f.options)).ready, false);
});

test('local session override is private, no-follow, bounded and never exposed', async (t) => {
  const f = await fixture(t);
  const alternate = path.join(f.root, 'alternate');
  fs.renameSync(f.options.tokenPath, alternate);
  f.record(
    11,
    '/usr/local/bin/node',
    ['node /usr/local/unraid-api/dist/main.js'],
    '100',
    `OTHER_SECRET=not-for-output\0PATHS_LOCAL_SESSION_FILE=${alternate}\0`,
  );
  assert.equal((await inspectRuntime(f.options)).adapter, 'current');
  fs.chmodSync(alternate, 0o644);
  assert.equal((await inspectRuntime(f.options)).adapter, 'unknown');
  fs.chmodSync(alternate, 0o600);
  fs.renameSync(alternate, `${alternate}.real`);
  fs.symlinkSync(`${alternate}.real`, alternate);
  const result = await inspectRuntime(f.options);
  assert.equal(result.ready, false);
  assert.ok(!JSON.stringify(result).includes('not-for-output'));
  assert.ok(!JSON.stringify(result).includes(f.secret));
});

test('a process replaced during an authenticated request invalidates proof', async (t) => {
  const f = await fixture(t);
  f.state.onQuery = () =>
    f.record(
      11,
      '/usr/local/bin/node',
      ['node /usr/local/unraid-api/dist/main.js'],
      '200',
    );
  assert.equal((await inspectRuntime(f.options)).code, 'API_PROCESS_CHANGED');
});

test('PID reuse between stat and executable observation cannot establish ownership', async (t) => {
  const f = await fixture(t);
  const readlink = fs.readlinkSync;
  let replaced = false;
  t.mock.method(fs, 'readlinkSync', (file, ...args) => {
    const result = readlink(file, ...args);
    if (!replaced && file === path.join(f.options.procRoot, '11/exe')) {
      replaced = true;
      f.record(
        11,
        '/usr/local/bin/node',
        ['node /usr/local/unraid-api/dist/main.js'],
        '999',
      );
    }
    return result;
  });
  const result = await inspectRuntime(f.options);
  assert.equal(result.ready, false);
  assert.equal(result.code, 'PROCESS_UNKNOWN');
  assert.equal(f.state.queries, 0);
});

test('foreign process ownership cannot establish API identity', async (t) => {
  const f = await fixture(t);
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const stat = lstat(file, ...args);
    return file === path.join(f.options.procRoot, '11')
      ? { ...stat, uid: process.getuid() + 1, isDirectory: () => true }
      : stat;
  });
  assert.equal((await inspectRuntime(f.options)).code, 'PROCESS_UNKNOWN');
  assert.equal(f.state.queries, 0);
});

test('canonical rc aliases require the root-owned host alias and keep go boot blocked', async (t) => {
  const f = await fixture(t);
  const lstat = fs.lstatSync;
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'lstatSync', (file, ...args) =>
    file === '/etc/rc.d'
      ? { uid: 0, isSymbolicLink: () => true }
      : lstat(file, ...args),
  );
  t.mock.method(fs, 'realpathSync', (file, ...args) =>
    file === '/etc/rc.d' ? '/usr/local/etc/rc.d' : realpath(file, ...args),
  );
  for (const [script, ...args] of [
    ['rc.local'],
    ['rc.unraid-api', 'start'],
    ['rc.nginx', 'restart'],
  ]) {
    f.record(13, '/bin/bash', [
      'bash',
      `/usr/local/etc/rc.d/${script}`,
      ...args,
    ]);
    f.record(14, '/bin/bash', ['bash', '/var/tmp/go']);
    assert.equal((await inspectRuntime(f.options)).code, 'API_STARTING');
  }
  f.remove(13);
  assert.equal((await inspectRuntime(f.options)).ready, true);
  f.record(13, '/bin/bash', ['bash', '/usr/local/etc/rc.d/rc.local-lookalike']);
  assert.equal((await inspectRuntime(f.options)).ready, true);
});

test('wait enforces initial delay, identity stability and transient readiness reset', async (t) => {
  const f = await fixture(t);
  const started = Date.now();
  let waits = 0;
  const result = await waitForApi({
    ...f.options,
    initialDelayMs: 25,
    intervalMs: 2,
    stableSamples: 3,
    timeoutMs: 2000,
    onWait: () => {
      waits++;
      if (waits === 1)
        f.record(
          11,
          '/usr/local/bin/node',
          ['node /usr/local/unraid-api/dist/main.js'],
          '201',
        );
      if (waits === 2) f.state.auth = false;
      if (waits === 3) f.state.auth = true;
    },
  });
  assert.ok(Date.now() - started >= 25);
  assert.ok(waits >= 5);
  assert.equal(result.identity, '11:201/12:100');
});

test('cancel and timeout are read-only and never resurrect removed state', async (t) => {
  const f = await fixture(t);
  let valid = true;
  await assert.rejects(
    waitForApi({
      ...f.options,
      valid: () => valid,
      initialDelayMs: 0,
      intervalMs: 1,
      stableSamples: 3,
      timeoutMs: 1000,
      onWait: () => {
        valid = false;
        fs.rmSync(f.options.procRoot, { recursive: true });
      },
    }),
    { code: 'JOB_CANCELLED' },
  );
  assert.equal(fs.existsSync(f.options.procRoot), false);
  await assert.rejects(
    waitForApi({
      ...f.options,
      initialDelayMs: 0,
      intervalMs: 1,
      timeoutMs: 15,
    }),
    { code: 'API_STARTUP_TIMEOUT' },
  );
  assert.equal(fs.existsSync(f.options.procRoot), false);
});

test('initial delay cancellation is prompt and never recreates removed state', async (t) => {
  const f = await fixture(t);
  let valid = true;
  const started = Date.now();
  const timer = setTimeout(() => {
    valid = false;
    fs.rmSync(f.options.procRoot, { recursive: true });
  }, 20);
  t.after(() => clearTimeout(timer));
  await assert.rejects(
    waitForApi({
      ...f.options,
      valid: () => valid,
      initialDelayMs: 10000,
      timeoutMs: 30000,
    }),
    { code: 'JOB_CANCELLED' },
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.state.queries, 0);
  assert.equal(fs.existsSync(f.options.procRoot), false);
});

test('info authorization failure never satisfies the stable startup gate', async (t) => {
  const f = await fixture(t);
  f.state.infoError = true;
  await assert.rejects(
    waitForApi({
      ...f.options,
      initialDelayMs: 0,
      intervalMs: 1,
      stableSamples: 1,
      timeoutMs: 80,
    }),
    { code: 'API_STARTUP_TIMEOUT' },
  );
  f.state.infoError = false;
  f.state.coreOnline = false;
  const result = await waitForApi({
    ...f.options,
    initialDelayMs: 0,
    stableSamples: 1,
    timeoutMs: 1000,
  });
  assert.equal(result.adapter, 'current');
  assert.equal(result.coreOnline, false);
});

test('initial pause is bounded by the total startup deadline', async (t) => {
  const f = await fixture(t);
  const started = Date.now();
  await assert.rejects(
    waitForApi({
      ...f.options,
      initialDelayMs: 10000,
      timeoutMs: 30,
    }),
    { code: 'API_STARTUP_TIMEOUT' },
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.state.queries, 0);
});

test('CLI exit codes preserve reload decisions and health requirements', async (t) => {
  const f = await fixture(t);
  let source = fs.readFileSync(
    new URL('../packaging/api-runtime.mjs', import.meta.url),
    'utf8',
  );
  for (const key of [
    'procRoot',
    'apiSocket',
    'emhttpSocket',
    'coreSocket',
    'tokenPath',
  ])
    source = source.replace(
      new RegExp(`${key}: '[^']+'`),
      `${key}: ${JSON.stringify(f.options[key])}`,
    );
  source = source.replace('ownerUid: 0', `ownerUid: ${process.getuid()}`);
  const module = path.join(f.root, 'api-runtime.mjs');
  fs.writeFileSync(module, source);
  const entry = path.join(f.root, 'current.mjs');
  fs.symlinkSync(module, entry);
  const log = path.join(f.root, 'decisions.jsonl');
  fs.writeFileSync(
    path.join(f.root, 'lifecycle-log.mjs'),
    `
    import fs from 'node:fs';
    export function logLifecycle(event, details) {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({event, ...details}) + '\\n');
      return true;
    }
  `,
  );
  fs.mkdirSync(path.join(f.root, 'adapter'));
  fs.writeFileSync(
    path.join(f.root, 'adapter/package.json'),
    JSON.stringify({ version: '0.6.0' }),
  );
  const run = async (command) => {
    const child = spawn(process.execPath, [entry, command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const [code] = await once(child, 'close');
    assert.ok(!output.includes(f.secret));
    return { code, output };
  };
  assert.equal((await run('core')).code, 0);
  assert.equal((await run('loaded')).code, 0);
  assert.equal((await run('health')).code, 0);
  f.state.coreOnline = false;
  assert.equal((await run('loaded')).code, 0);
  assert.equal((await run('health')).code, 75);
  f.state.loaded = false;
  assert.equal((await run('ready')).code, 0);
  assert.equal((await run('loaded')).code, 10);
  f.state.loaded = true;
  f.state.version = '0.5.0';
  assert.equal((await run('loaded')).code, 10);
  f.state.auth = false;
  assert.equal((await run('loaded')).code, 75);
  assert.equal(fs.existsSync(log), false);
  assert.equal((await run('decision')).code, 75);
  let entries = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'api-detected');
  assert.equal(entries[0].code, 'API_AUTH_UNKNOWN');
  f.state.auth = true;
  assert.equal((await run('decision')).code, 10);
  f.state.version = '0.6.0';
  assert.equal((await run('decision')).code, 0);
  f.state.loaded = false;
  assert.equal((await run('decision')).code, 10);
  entries = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entries.length, 4);
  assert.equal(entries[1].expectedVersion, '0.6.0');
  assert.equal(entries[1].loadedVersion, '0.5.0');
  assert.equal(entries[2].identity, '11:100/12:100');
  assert.ok(!fs.readFileSync(log, 'utf8').includes(f.secret));
  f.state.auth = false;
  const observed = await run('inspect');
  assert.equal(JSON.parse(observed.output).adapter, 'unknown');
  assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 4);
  f.state.auth = true;
  f.state.loaded = false;
  for (const metadata of [{}, { version: null }, { version: '0.6.0\n' }]) {
    fs.writeFileSync(
      path.join(f.root, 'adapter/package.json'),
      JSON.stringify(metadata),
    );
    assert.equal((await run('loaded')).code, 75);
    assert.equal((await run('health')).code, 75);
    assert.equal(
      JSON.parse((await run('inspect')).output).code,
      'METADATA_UNKNOWN',
    );
  }
  fs.writeFileSync(
    path.join(f.root, 'adapter/package.json'),
    JSON.stringify({ version: '0.6.0' }),
  );
  fs.writeFileSync(
    path.join(f.root, 'lifecycle-log.mjs'),
    `
    export function logLifecycle() { throw new Error(${JSON.stringify(f.secret)}); }
  `,
  );
  const unavailableLog = await run('decision');
  assert.equal(unavailableLog.code, 10);
  assert.equal(unavailableLog.output, 'lifecycle-log: LOG_WRITE_FAILED\n');
  f.state.loaded = true;
  assert.equal((await run('decision')).code, 0);
  f.state.auth = false;
  assert.equal((await run('decision')).code, 75);
});
