import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import {
  repo,
  write,
  releaseFixture,
  parsePlugin,
} from './helpers/release.mjs';

const linux = process.platform === 'linux';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, predicate = Boolean, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    let value;
    try {
      value = read();
    } catch {}
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error('Timed out waiting for fixture process state');
}
function fixture(t, mode = 'success', options = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-controller-')),
  );
  const run = path.join(root, 'run');
  const runtime = path.join(root, 'runtime');
  const candidate = path.join(runtime, 'releases/0.6.0-123456abcdef');
  const previous = options.update
    ? path.join(runtime, 'releases/0.5.0-abcdef123456')
    : '';
  const persisted = path.join(root, 'boot/plugins/unraid-deck-bridge.plg');
  const registered = path.join(root, 'log/plugins/unraid-deck-bridge.plg');
  const nativeFile = path.join(root, 'plugin');
  const incoming = path.join(root, 'downloads/unraid-deck-bridge.plg');
  const hook = path.join(
    options.hookRoot ?? root,
    'post-hooks/unraid-deck-bridge-install',
  );
  const controller = path.join(candidate, 'post-install.mjs');
  const captureModule = path.join(candidate, 'plg-capture.mjs');
  const backup = path.join(
    root,
    'boot/plugins/unraid-deck-bridge/backups/test',
  );
  fs.mkdirSync(run, { recursive: true });
  fs.mkdirSync(candidate, { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  write(path.join(run, 'install.lock'), '');
  if (previous) {
    fs.mkdirSync(previous, { recursive: true });
    fs.symlinkSync(previous, path.join(runtime, 'current'));
    write(path.join(previous, 'running'), 'old Core remains running');
  }
  let source = fs.readFileSync(
    path.join(repo, 'packaging/post-install.mjs'),
    'utf8',
  );
  const hostPaths = {
    '/var/run/unraid-deck-bridge': run,
    '/usr/local/emhttp/plugins/unraid-deck-bridge': runtime,
    '/boot/config/plugins': path.join(root, 'boot/plugins'),
    '/var/log/plugins': path.join(root, 'log/plugins'),
    '/usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/unraid-deck-bridge-install':
      hook,
    '/tmp/plugins/unraid-deck-bridge.plg': incoming,
    '/tmp/plugins': path.dirname(incoming),
    '/usr/local/sbin/plugin': nativeFile,
    '/etc/unraid-version': path.join(root, 'unraid-version'),
  };
  const rewrite = (input) => {
    for (const [from, to] of Object.entries(hostPaths))
      input = input.replaceAll(from, to);
    assert.doesNotMatch(
      input,
      /\/(?:boot\/config|usr\/local|var\/run|var\/log|tmp\/plugins|etc\/unraid-version)/,
    );
    // Substitute only the privileged UID boundary; keep all ownership checks real.
    return input
      .replace(
        'process.getuid() !== 0',
        `process.getuid() !== ${process.getuid()}`,
      )
      .replace('existing.uid !== 0', `existing.uid !== ${process.getuid()}`);
  };
  source = rewrite(source);
  // Shorten deadlines, never bypass identity, detach, registration or locking logic.
  for (const name of ['NATIVE_MS', 'COMMIT_MS', 'LOCK_MS'])
    source = source.replace(
      new RegExp(`const ${name} = \\d+;`),
      `const ${name} = 800;`,
    );
  if (options.crashHookOnce) {
    source = source.replace(
      'fs.writeFileSync(hookDescriptor, hookSource(job));',
      `fs.writeFileSync(hookDescriptor, hookSource(job));
      const killed = ${JSON.stringify(path.join(root, 'hook-crash'))};
      if (!fs.existsSync(killed)) {
        fs.writeFileSync(killed, hookTemp);
        process.kill(process.pid, 'SIGKILL');
      }`,
    );
  }
  if (options.activationGate) {
    source = source.replace(
      "} else if (mode === 'activate') {",
      `} else if (mode === 'activate') {
        fs.writeFileSync(${JSON.stringify(path.join(root, 'acquired'))}, '');
        while (!fs.existsSync(${JSON.stringify(path.join(root, 'continue'))}))
          await sleep(20);`,
    );
  }
  write(controller, source);
  write(
    captureModule,
    rewrite(
      fs.readFileSync(path.join(repo, 'packaging/plg-capture.mjs'), 'utf8'),
    ),
  );
  if (options.preflight) {
    write(path.join(root, 'preflight.sh'), rewrite(options.preflight));
    write(path.join(root, 'unraid-version'), 'version="7.3.2"\n');
    write(path.join(root, 'bin/unraid-api'), '#!/bin/sh\nexit 0\n', 0o755);
    fs.symlinkSync(process.execPath, path.join(root, 'bin/node'));
  }
  if (options.blockHookDirectory)
    write(path.dirname(hook), 'not a directory\n');
  const stagedHook = path.join(
    path.dirname(hook),
    '.unraid-deck-bridge-install.bridge-tmp',
  );
  if (options.staleHook) write(stagedHook, 'interrupted partial hook\n', 0o755);
  if (options.redirectedHook) {
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    write(path.join(root, 'protected'), 'unrelated bytes');
    fs.symlinkSync(path.join(root, 'protected'), stagedHook);
  }
  if (options.unsafeStaging) {
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    if (options.unsafeStaging === 'directory') {
      write(path.join(stagedHook, 'protected'), 'unrelated bytes');
    } else {
      write(path.join(root, 'protected'), 'unrelated bytes');
      fs.linkSync(path.join(root, 'protected'), stagedHook);
    }
  }
  write(
    path.join(candidate, 'activate.sh'),
    `#!/bin/bash\nset -eu\nflock -n 9\nrm -f ${JSON.stringify(path.join(runtime, 'current'))}\nln -s ${JSON.stringify(candidate)} ${JSON.stringify(path.join(runtime, 'current'))}\nprintf '%s\\n' activated >> ${JSON.stringify(path.join(root, 'events'))}\n`,
    0o755,
  );
  const config = {
    root,
    candidate,
    previous,
    backup,
    controller,
    captureModule,
    persisted,
    registered,
    incoming,
    hook,
    options,
    mode,
    version: options.version || '2026.10.27.0001',
  };
  const incomingBytes =
    options.xml ||
    `<PLUGIN name="unraid-deck-bridge" version="${options.sourceVersion || config.version}"><!-- exact incoming bytes -->\n</PLUGIN>\n`;
  if (!options.missingSource) write(incoming, incomingBytes, 0o600);
  if (['unchanged', 'same-version'].includes(mode)) {
    write(persisted, incomingBytes);
    fs.mkdirSync(path.dirname(registered), { recursive: true });
    fs.symlinkSync(persisted, registered);
  }
  write(path.join(root, 'config.json'), JSON.stringify(config));
  write(
    nativeFile,
    `import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const c = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const wait = ms => new Promise(r => setTimeout(r, ms));
async function command(args, input, executable = process.execPath) {
 const scheduling = args[1] === 'schedule' && !c.options.noScheduleLock;
 const call = scheduling
   ? ['-c', 'exec 9<>"$1"; shift; flock -n 9 || exit 75; exec "$@"', 'native-prepare', c.root + '/run/install.lock', executable, ...args]
   : args;
 const child = spawn(scheduling ? '/bin/bash' : executable, call, {env: {...process.env, PATH: c.root + '/bin:' + process.env.PATH}, stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore']});
 if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
 return (await once(child, 'exit'))[0];
}
function captureIncoming() {
 return command(['--input-type=module', '-', c.version], fs.readFileSync(c.captureModule, 'utf8') + '\\ncapture(process.argv.slice(2));\\n');
}
const captureCode = c.options.preflight
 ? await command([c.root + '/preflight.sh'], undefined, '/bin/bash')
 : await captureIncoming();
fs.writeFileSync(c.root + '/captured', String(captureCode));
if (captureCode !== 0) { fs.writeFileSync(c.root + '/scheduled', 'capture-failed'); process.exit(3); }
if (c.options.deleteIncoming) fs.unlinkSync(c.incoming);
if (c.options.pauseSchedule) while (!fs.existsSync(c.root + '/start-schedule')) await wait(20);
let code = await command([c.controller, 'schedule', c.candidate, c.backup, c.previous, c.version]);
if (c.options.crashHookOnce) {
 const temp = c.hook.slice(0, c.hook.lastIndexOf('/')) + '/.unraid-deck-bridge-install.bridge-tmp';
 if (!fs.existsSync(temp) || code === 0) process.exit(9);
 fs.writeFileSync(c.root + '/observed-crash-remnant', fs.readFileSync(temp));
 await captureIncoming();
 code = await command([c.controller, 'schedule', c.candidate, c.backup, c.previous, c.version]);
}
fs.writeFileSync(c.root + '/scheduled', String(code));
if (code !== 0) process.exit(4);
if (fs.existsSync(c.hook)) fs.copyFileSync(c.hook, c.root + '/saved-hook');
while (!fs.existsSync(c.root + '/release')) {
 if (fs.existsSync(c.root + '/reschedule') && !fs.existsSync(c.root + '/rescheduled')) {
  await captureIncoming();
  const nextCode = await command([c.controller, 'schedule', c.candidate, c.backup, c.previous, c.version]);
  fs.writeFileSync(c.root + '/rescheduled', String(nextCode));
 }
 await wait(20);
}
if (c.options.deleteAtRelease) fs.unlinkSync(c.incoming);
if (c.mode === 'delayed') {
 fs.writeFileSync(c.root + '/awaiting-registration', '');
 while (!fs.existsSync(c.root + '/registration-ready')) await wait(20);
}
if (!['unregistered', 'unchanged', 'failed', 'delayed'].includes(c.mode)) {
 fs.mkdirSync(c.persisted.slice(0, c.persisted.lastIndexOf('/')), {recursive:true});
 fs.mkdirSync(c.registered.slice(0, c.registered.lastIndexOf('/')), {recursive:true});
 if (c.mode !== 'same-version' && !c.options.deleteIncoming && !c.options.deleteAtRelease)
  fs.writeFileSync(c.persisted, c.mode === 'version' ? '<PLUGIN name="unraid-deck-bridge" version="2026.10.26.0001"></PLUGIN>' : fs.readFileSync(c.incoming));
 try { fs.unlinkSync(c.registered); } catch {}
 fs.symlinkSync(c.options.wrongTarget ? c.root + '/other.plg' : c.persisted, c.registered);
}
if (c.options.supportMutation) {
 const xml = fs.readFileSync(c.persisted, 'utf8');
 fs.writeFileSync(c.persisted, '<?xml version="1.0"?>\\n' + xml.replace('<PLUGIN ', '<PLUGIN support="https://forums.unraid.net/topic/bridge/" '));
}
if (fs.existsSync(c.persisted)) {
 const s = fs.statSync(c.persisted, {bigint:true});
 fs.writeFileSync(c.root + '/native-registration.json', JSON.stringify({ino:String(s.ino),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs)}));
}
if (c.mode === 'stale') {
 try { fs.unlinkSync(c.root + '/runtime/current'); } catch {}
 fs.symlinkSync(c.root + '/runtime/releases/other', c.root + '/runtime/current');
}
const hookFile = c.options.savedHook ? c.root + '/saved-hook' : c.hook;
if (!c.options.skipHook && fs.existsSync(hookFile)) {
 const hook = spawn('/bin/bash', [hookFile, 'plugin', c.options.hookMethod || (c.previous ? 'update' : 'install'), c.options.hookPlugin || 'unraid-deck-bridge.plg', c.mode === 'failed' || c.options.nativeError ? 'native installation failed' : ''], {stdio:'ignore'});
 const [hookCode] = await once(hook, 'exit');
 fs.writeFileSync(c.root + '/hook-code', String(hookCode));
}
if (c.options.holdAfterHook) {
 fs.writeFileSync(c.root + '/hook-finished', '');
 while (!fs.existsSync(c.root + '/finish-native')) await wait(20);
}
process.exit(c.mode === 'failed' ? 7 : 0);
`,
  );
  const executable =
    mode === 'alias' ? path.join(root, 'plugin-alias') : nativeFile;
  if (mode === 'alias') fs.symlinkSync(nativeFile, executable);
  // Explicit ESM mode is needed because the actual native executable has no extension.
  const native = spawn(
    process.execPath,
    [
      '--experimental-default-type=module',
      executable,
      options.update ? 'update' : 'install',
      options.update ? 'unraid-deck-bridge.plg' : incoming,
      path.join(root, 'config.json'),
    ],
    { stdio: 'ignore' },
  );
  let holder;
  t.after(() => {
    native.kill('SIGKILL');
    holder?.kill('SIGKILL');
    try {
      for (const name of fs.readdirSync(run)) {
        if (!name.startsWith('post-install-')) continue;
        try {
          const pid = Number(
            fs.readFileSync(path.join(run, name, 'detached'), 'utf8'),
          );
          const args = fs
            .readFileSync(`/proc/${pid}/cmdline`, 'utf8')
            .split('\0');
          if (args.includes(controller)) process.kill(pid, 'SIGTERM');
        } catch {}
      }
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const job = () =>
    path.join(run, fs.readFileSync(path.join(run, 'activation-job'), 'utf8'));
  return {
    root,
    run,
    native,
    controller,
    candidate,
    previous,
    persisted,
    registered,
    incoming,
    incomingBytes,
    hook,
    current() {
      try {
        return fs.realpathSync(path.join(runtime, 'current'));
      } catch {
        return '';
      }
    },
    assertPrepared() {
      assert.equal(this.current(), previous);
      if (previous)
        assert.equal(
          fs.readFileSync(path.join(previous, 'running'), 'utf8'),
          'old Core remains running',
        );
      assert.equal(this.events(), '');
    },
    backup,
    async scheduled() {
      assert.equal(
        await until(() =>
          fs.readFileSync(path.join(root, 'scheduled'), 'utf8'),
        ),
        '0',
      );
      return job();
    },
    async captured() {
      return until(() => fs.readFileSync(path.join(root, 'captured'), 'utf8'));
    },
    release() {
      write(path.join(root, 'release'), '');
    },
    status: () =>
      JSON.parse(fs.readFileSync(path.join(job(), 'status.json'), 'utf8')),
    events: () =>
      fs.existsSync(path.join(root, 'events'))
        ? fs.readFileSync(path.join(root, 'events'), 'utf8')
        : '',
    repair() {
      return spawnSync(process.execPath, [controller, 'repair-allowed'], {
        encoding: 'utf8',
      });
    },
    async commitThenLock() {
      this.release();
      await until(() => fs.existsSync(path.join(root, 'hook-finished')));
      assert.equal(fs.readFileSync(path.join(root, 'hook-code'), 'utf8'), '0');
      await this.lock();
      write(path.join(root, 'finish-native'), '');
    },
    async lock() {
      holder = spawn(
        '/bin/bash',
        [
          '-c',
          'exec 9>"$1"; flock 9; touch "$2"; while [ ! -e "$3" ]; do sleep .02; done',
          'lock-fixture',
          path.join(run, 'install.lock'),
          path.join(root, 'locked'),
          path.join(root, 'unlock'),
        ],
        { stdio: 'ignore' },
      );
      await until(() => fs.existsSync(path.join(root, 'locked')));
    },
    unlock() {
      write(path.join(root, 'unlock'), '');
    },
  };
}
const terminal = (s) =>
  s && ['READY', 'FAILED', 'SUPERSEDED'].includes(s.state);

test('controller rejects malformed schedule arguments without leaking input', () => {
  const result = spawnSync(
    process.execPath,
    [path.join(repo, 'packaging/post-install.mjs'), 'schedule'],
    { encoding: 'utf8' },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SCHEDULE_ARGUMENTS/);
});

test(
  'stale status temporary files cannot prevent a selected worker from activating',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    const dir = await f.scheduled();
    const pid = fs.readFileSync(path.join(dir, 'detached'), 'utf8');
    const stale = path.join(dir, `status-${pid}.tmp`);
    write(stale, 'interrupted status update\n');
    f.release();
    const result = await until(f.status, terminal);
    assert.equal(result.state, 'READY', JSON.stringify(result));
    assert.equal(f.current(), f.candidate);
    assert.equal(f.events(), 'activated\n');
    assert.equal(fs.readFileSync(stale, 'utf8'), 'interrupted status update\n');
  },
);
test(
  'detached worker waits for native commit, is independently reparented and activates once',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    const dir = await f.scheduled();
    const pid = Number(fs.readFileSync(path.join(dir, 'detached'), 'utf8'));
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    assert.equal(
      Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]),
      1,
    );
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'worker.log')).mode & 0o777, 0o600);
    assert.equal(f.status().state, 'PENDING');
    f.assertPrepared();
    assert.equal(f.events(), '');
    f.release();
    assert.equal((await until(f.status, terminal)).state, 'READY');
    assert.equal(f.events(), 'activated\n');
  },
);
for (const [mode, code, state] of [
  ['failed', 'REGISTRATION_MISSING', 'FAILED'],
  ['unregistered', 'REGISTRATION_MISSING', 'FAILED'],
  ['version', 'REGISTRATION_VERSION', 'FAILED'],
  ['stale', 'STALE_CURRENT', 'SUPERSEDED'],
])
  for (const update of [false, true])
    test(
      `native ${mode} leaves ${update ? 'old' : 'absent'} runtime unchanged`,
      { skip: !linux },
      async (t) => {
        const f = fixture(t, mode, { update });
        await f.scheduled();
        f.assertPrepared();
        f.release();
        const result = await until(f.status, terminal);
        assert.equal(result.state, state);
        assert.ok([code, 'NATIVE_FAILED'].includes(result.code));
        if (mode !== 'stale') f.assertPrepared();
        assert.equal(f.events(), '');
      },
    );
test(
  'native manager disappearance/caller death cannot activate without committed registration',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    const dir = await f.scheduled();
    const detached = Number(
      fs.readFileSync(path.join(dir, 'detached'), 'utf8'),
    );
    f.native.kill('SIGKILL');
    process.kill(detached, 0);
    assert.equal((await until(f.status, terminal)).state, 'FAILED');
    assert.equal(f.events(), '');
  },
);
test(
  'worker times out deterministically while native manager remains pending',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    await f.scheduled();
    assert.equal((await until(f.status, terminal)).code, 'NATIVE_TIMEOUT');
    assert.equal(f.events(), '');
  },
);
test(
  'activation lock contention is bounded and never mutates API',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'success', { holdAfterHook: true });
    await f.scheduled();
    await f.commitThenLock();
    assert.equal((await until(f.status, terminal)).code, 'LOCK_TIMEOUT');
    assert.equal(f.events(), '');
    f.unlock();
  },
);
test(
  'activation retries lock acquisition, then rechecks current before mutation',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'success', { holdAfterHook: true });
    await f.scheduled();
    await f.commitThenLock();
    await until(f.status, (s) => s?.phase === 'activation-lock');
    fs.rmSync(path.join(f.root, 'runtime/current'), { force: true });
    fs.symlinkSync(
      path.join(f.root, 'runtime/releases/other'),
      path.join(f.root, 'runtime/current'),
    );
    f.unlock();
    assert.equal((await until(f.status, terminal)).state, 'SUPERSEDED');
    assert.equal(f.events(), '');
  },
);
test(
  'removing owned job and run directory cancels worker without late recreation',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    const dir = await f.scheduled();
    const pid = Number(fs.readFileSync(path.join(dir, 'detached'), 'utf8'));
    fs.rmSync(f.run, { recursive: true });
    f.release();
    await until(() => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
      } catch {
        return true;
      }
    });
    await delay(200);
    assert.equal(fs.existsSync(f.run), false);
    assert.equal(f.events(), '');
  },
);
for (const update of [false, true]) {
  test(
    `unchanged registration rejects ${update ? 'update' : 'first install'}`,
    { skip: !linux },
    async (t) => {
      const f = fixture(t, 'unchanged', { update });
      await f.scheduled();
      f.assertPrepared();
      f.release();
      assert.equal(
        (await until(f.status, terminal)).code,
        'REGISTRATION_UNCHANGED',
      );
      f.assertPrepared();
    },
  );
  test(
    `same-version forced ${update ? 'update' : 'install'} requires fresh native registration`,
    { skip: !linux },
    async (t) => {
      const f = fixture(t, 'same-version', { update });
      const bootXML = fs.readFileSync(f.persisted, 'utf8');
      await f.scheduled();
      f.assertPrepared();
      f.release();
      assert.equal((await until(f.status, terminal)).state, 'READY');
      assert.equal(fs.readFileSync(f.persisted, 'utf8'), bootXML);
      assert.equal(f.current(), f.candidate);
      assert.equal(f.events(), 'activated\n');
    },
  );
}
test(
  'native manager aliases resolve to the same installed executable',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'alias');
    await f.scheduled();
    f.release();
    assert.equal((await until(f.status, terminal)).state, 'READY');
    assert.equal(f.events(), 'activated\n');
  },
);
test(
  'valid schedule outside native manager fails rather than acknowledging a worker',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    await f.scheduled();
    const before = fs.readdirSync(f.run);
    const result = spawnSync(
      process.execPath,
      [f.controller, 'schedule', f.candidate, f.backup, '', '2026.10.27.0001'],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /NATIVE_MANAGER_REQUIRED/);
    assert.deepEqual(fs.readdirSync(f.run), before);
  },
);
test(
  'removing only the owned job cancels a live pending worker',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    const dir = await f.scheduled();
    const pid = Number(fs.readFileSync(path.join(dir, 'detached'), 'utf8'));
    fs.rmSync(dir, { recursive: true });
    await until(() => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
      } catch {
        return true;
      }
    });
    f.release();
    await delay(200);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(f.events(), '');
  },
);
test(
  'repair is quiet and forbidden while pending or after native failure',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'failed');
    await f.scheduled();
    for (const result of [f.repair()]) {
      assert.equal(result.status, 75);
      assert.equal(result.stdout + result.stderr, '');
    }
    f.release();
    await until(f.status, terminal);
    const failed = f.repair();
    assert.equal(failed.status, 75);
    assert.equal(failed.stdout + failed.stderr, '');
  },
);
test(
  'repair requires READY and matching current registration, and never recreates removed run',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    await f.scheduled();
    f.release();
    await until(f.status, terminal);
    assert.equal(f.status().state, 'READY');
    assert.equal(f.repair().status, 0);
    fs.unlinkSync(path.join(f.root, 'runtime/current'));
    assert.equal(f.repair().status, 75);
    fs.symlinkSync(f.candidate, path.join(f.root, 'runtime/current'));
    assert.equal(f.repair().status, 0);
    fs.unlinkSync(f.registered);
    fs.symlinkSync(f.persisted, f.registered);
    assert.equal(f.repair().status, 75);
    fs.rmSync(f.run, { recursive: true });
    const removed = f.repair();
    assert.equal(removed.status, 75);
    assert.equal(removed.stdout + removed.stderr, '');
    assert.equal(fs.existsSync(f.run), false);
  },
);
test(
  'latest same-candidate schedule supersedes old worker before native commit',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    const old = await f.scheduled();
    write(path.join(f.root, 'reschedule'), '');
    assert.equal(
      await until(() =>
        fs.readFileSync(path.join(f.root, 'rescheduled'), 'utf8'),
      ),
      '0',
    );
    const oldStatus = () =>
      JSON.parse(fs.readFileSync(path.join(old, 'status.json'), 'utf8'));
    assert.equal((await until(oldStatus, terminal)).state, 'SUPERSEDED');
    assert.equal(f.status().state, 'PENDING');
    assert.equal(f.repair().status, 75);
    assert.equal(f.events(), '');
    f.release();
    assert.equal((await until(f.status, terminal)).state, 'READY');
    assert.equal(f.events(), 'activated\n');
    assert.equal(oldStatus().state, 'SUPERSEDED');
  },
);

for (const update of [false, true])
  test(
    `delayed native registration activates ${update ? 'update' : 'first install'} only after commit`,
    { skip: !linux },
    async (t) => {
      const f = fixture(t, 'delayed', { update });
      await f.scheduled();
      f.assertPrepared();
      f.release();
      await until(() =>
        fs.existsSync(path.join(f.root, 'awaiting-registration')),
      );
      f.assertPrepared();
      assert.equal(f.repair().status, 75);
      write(f.persisted, f.incomingBytes);
      fs.mkdirSync(path.dirname(f.registered), { recursive: true });
      fs.symlinkSync(f.persisted, f.registered);
      write(path.join(f.root, 'registration-ready'), '');
      assert.equal((await until(f.status, terminal)).state, 'READY');
      assert.equal(f.current(), f.candidate);
      assert.equal(f.repair().status, 0);
    },
  );

for (const change of ['current', 'lock', 'registration', 'xml', 'selection'])
  test(
    `activation rechecks ${change} after acquiring fd9`,
    { skip: !linux },
    async (t) => {
      const f = fixture(t, 'success', { update: true, activationGate: true });
      const dir = await f.scheduled();
      f.release();
      await until(() => fs.existsSync(path.join(f.root, 'acquired')));
      assert.equal(f.current(), f.previous);
      const confirmed = JSON.parse(
        fs.readFileSync(path.join(dir, 'registration.json'), 'utf8'),
      );
      assert.equal(typeof confirmed.fingerprint, 'string');
      if (change === 'current') {
        fs.unlinkSync(path.join(f.root, 'runtime/current'));
        fs.symlinkSync(f.candidate, path.join(f.root, 'runtime/current'));
      } else if (change === 'lock') {
        fs.renameSync(
          path.join(f.run, 'install.lock'),
          path.join(f.run, 'old.lock'),
        );
        write(path.join(f.run, 'install.lock'), '');
      } else if (change === 'registration') {
        fs.unlinkSync(f.registered);
        fs.symlinkSync(f.persisted, f.registered);
      } else if (change === 'xml') {
        fs.appendFileSync(f.persisted, '\n');
      } else {
        write(path.join(f.run, 'activation-job'), 'removed-selection');
      }
      write(path.join(f.root, 'continue'), '');
      const read = () =>
        JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
      const result = await until(read, terminal);
      assert.equal(result.state, 'SUPERSEDED');
      assert.equal(
        result.code,
        {
          current: 'STALE_CURRENT',
          lock: 'LOCK_REPLACED',
          registration: 'STALE_REGISTRATION',
          xml: 'STALE_REGISTRATION',
          selection: 'NEWER_JOB',
        }[change],
      );
      assert.equal(f.events(), '');
      if (change !== 'current') f.assertPrepared();
    },
  );

test(
  'replacing the lock while waiting cannot authorize a new inode',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'success', { holdAfterHook: true });
    await f.scheduled();
    await f.commitThenLock();
    await until(f.status, (s) => s?.phase === 'activation-lock');
    fs.renameSync(
      path.join(f.run, 'install.lock'),
      path.join(f.run, 'old.lock'),
    );
    write(path.join(f.run, 'install.lock'), '');
    f.unlock();
    assert.equal((await until(f.status, terminal)).code, 'LOCK_REPLACED');
    f.assertPrepared();
  },
);

test(
  'invalidating ownership after fd9 acquisition does not recreate a job',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'success', { activationGate: true });
    const dir = await f.scheduled();
    const pid = Number(fs.readFileSync(path.join(dir, 'detached'), 'utf8'));
    f.release();
    await until(() => fs.existsSync(path.join(f.root, 'acquired')));
    fs.rmSync(f.run, { recursive: true });
    write(path.join(f.root, 'continue'), '');
    await until(() => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ');
      } catch {
        return true;
      }
    });
    assert.equal(fs.existsSync(f.run), false);
    assert.equal(f.events(), '');
    assert.equal(f.current(), '');
  },
);

for (const update of [false, true])
  test(
    `API alias cleanup restores exact captured PLG and reaches READY (${update ? 'update' : 'install'})`,
    { skip: !linux },
    async (t) => {
      const f = fixture(t, 'alias', { update, deleteIncoming: true });
      const dir = await f.scheduled();
      assert.equal(fs.existsSync(f.incoming), false);
      assert.equal(
        fs.readFileSync(path.join(dir, 'snapshot.plg'), 'utf8'),
        f.incomingBytes,
      );
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
      assert.equal(
        fs.statSync(path.join(dir, 'snapshot.plg')).mode & 0o777,
        0o600,
      );
      assert.equal(fs.existsSync(f.hook), true);
      f.assertPrepared();
      f.release();
      assert.equal((await until(f.status, terminal)).state, 'READY');
      assert.equal(fs.readFileSync(f.persisted, 'utf8'), f.incomingBytes);
      assert.equal(fs.lstatSync(f.persisted).isFile(), true);
      assert.equal(fs.realpathSync(f.registered), f.persisted);
      assert.equal(fs.existsSync(f.hook), false);
      assert.equal(fs.existsSync(path.join(dir, 'snapshot.plg')), false);
      assert.equal(fs.existsSync(path.join(dir, 'snapshot.json')), false);
      assert.equal(f.events(), 'activated\n');
    },
  );

test(
  'normal native commit is not rewritten by the hook',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'success', { holdAfterHook: true });
    await f.scheduled();
    f.release();
    await until(() => fs.existsSync(path.join(f.root, 'hook-finished')));
    const before = JSON.parse(
      fs.readFileSync(path.join(f.root, 'native-registration.json'), 'utf8'),
    );
    assert.equal(fs.readFileSync(f.persisted, 'utf8'), f.incomingBytes);
    assert.equal(fs.existsSync(f.hook), false);
    write(path.join(f.root, 'finish-native'), '');
    assert.equal((await until(f.status, terminal)).state, 'READY');
    const after = fs.statSync(f.persisted, { bigint: true });
    assert.equal(String(after.ino), before.ino);
    assert.equal(String(after.mtimeNs), before.mtime);
    assert.equal(String(after.ctimeNs), before.ctime);
  },
);

for (const options of [
  { missingSource: true },
  { sourceVersion: '2026.10.26.0001' },
])
  test(
    `capture rejects ${options.missingSource ? 'missing incoming PLG' : 'wrong incoming version'} before schedule`,
    { skip: !linux },
    async (t) => {
      const f = fixture(t, 'success', options);
      assert.notEqual(await f.captured(), '0');
      assert.equal(fs.existsSync(path.join(f.run, 'activation-job')), false);
      assert.equal(fs.existsSync(f.hook), false);
      assert.equal(fs.existsSync(f.persisted), false);
      f.assertPrepared();
    },
  );

for (const change of [
  'snapshot',
  'version',
  'target',
  'hook-target',
  'hook-method',
  'absent-registration',
  'native-error',
  'missing-hook',
  'selection',
  'lock',
  'uninstall',
])
  test(
    `native hook cannot restore after ${change}`,
    { skip: !linux },
    async (t) => {
      const f = fixture(
        t,
        change === 'absent-registration' ? 'unregistered' : 'alias',
        {
          deleteIncoming: true,
          wrongTarget: change === 'target',
          nativeError: change === 'native-error',
          hookPlugin:
            change === 'hook-target' ? 'another-plugin.plg' : undefined,
          hookMethod: change === 'hook-method' ? 'update' : undefined,
          skipHook: change === 'missing-hook',
          savedHook: true,
        },
      );
      const dir = await f.scheduled();
      if (change === 'snapshot')
        fs.appendFileSync(path.join(dir, 'snapshot.plg'), 'tampered');
      if (change === 'version') {
        const file = path.join(dir, 'snapshot.json');
        const info = JSON.parse(fs.readFileSync(file, 'utf8'));
        info.version = '2026.10.26.0001';
        write(file, JSON.stringify(info));
      }
      if (change === 'selection')
        write(path.join(f.run, 'activation-job'), 'newer-owned-job');
      if (change === 'lock') {
        fs.renameSync(
          path.join(f.run, 'install.lock'),
          path.join(f.run, 'old.lock'),
        );
        write(path.join(f.run, 'install.lock'), '');
      }
      if (change === 'uninstall') fs.rmSync(f.run, { recursive: true });
      const exited = once(f.native, 'exit');
      f.release();
      await exited;
      assert.equal(fs.existsSync(f.persisted), false);
      if (change === 'uninstall') assert.equal(fs.existsSync(f.run), false);
      else if (change !== 'selection')
        assert.notEqual((await until(f.status, terminal)).state, 'READY');
      assert.equal(f.events(), '');
    },
  );

for (const kind of ['different-version', 'symlink', 'directory'])
  test(
    `hook preserves existing canonical ${kind}`,
    { skip: !linux },
    async (t) => {
      const f = fixture(t, 'alias', { deleteIncoming: true });
      await f.scheduled();
      fs.mkdirSync(path.dirname(f.persisted), { recursive: true });
      const bytes =
        kind === 'different-version'
          ? '<PLUGIN name="unraid-deck-bridge" version="2026.10.26.0001"></PLUGIN>'
          : f.incomingBytes + '<!-- concurrent writer -->';
      const other = path.join(f.root, 'other.plg');
      if (kind === 'directory') fs.mkdirSync(f.persisted);
      else if (kind === 'symlink') {
        write(other, bytes);
        fs.symlinkSync(other, f.persisted);
      } else write(f.persisted, bytes);
      const before = fs.lstatSync(f.persisted, { bigint: true });
      f.release();
      assert.equal((await until(f.status, terminal)).state, 'FAILED');
      const after = fs.lstatSync(f.persisted, { bigint: true });
      assert.equal(after.ino, before.ino);
      assert.equal(after.ctimeNs, before.ctimeNs);
      if (kind !== 'directory')
        assert.equal(fs.readFileSync(f.persisted, 'utf8'), bytes);
      if (kind === 'symlink') assert.equal(fs.readlinkSync(f.persisted), other);
      assert.equal(f.events(), '');
    },
  );

test(
  'older hook cannot restore or remove the newer job hook',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'alias', { deleteAtRelease: true, savedHook: true });
    const old = await f.scheduled();
    write(path.join(f.root, 'reschedule'), '');
    assert.equal(
      await until(() =>
        fs.readFileSync(path.join(f.root, 'rescheduled'), 'utf8'),
      ),
      '0',
    );
    const newerHook = fs.readFileSync(f.hook, 'utf8');
    const exited = once(f.native, 'exit');
    f.release();
    await exited;
    assert.equal(fs.existsSync(f.persisted), false);
    assert.equal(fs.readFileSync(f.hook, 'utf8'), newerHook);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(old, 'status.json'), 'utf8')).state,
      'SUPERSEDED',
    );
    assert.equal(f.events(), '');
  },
);

test(
  'generated first INLINE captures the incoming PLG before native temporary cleanup',
  { skip: !linux || process.arch !== 'x64' },
  async (t) => {
    const release = releaseFixture(t);
    const result = release.run('--repository', 'test/repo');
    assert.equal(result.status, 0, result.stderr);
    const artifact = JSON.parse(result.stdout);
    const plugin = parsePlugin(artifact.plugin);
    const xml = fs.readFileSync(artifact.plugin, 'utf8');
    const f = fixture(t, 'alias', {
      preflight: plugin.files[0].INLINE,
      xml,
      version: plugin.attributes.version,
      deleteIncoming: true,
    });
    const dir = await f.scheduled();
    assert.equal(fs.existsSync(f.incoming), false);
    assert.equal(fs.readFileSync(path.join(dir, 'snapshot.plg'), 'utf8'), xml);
    f.release();
    assert.equal((await until(f.status, terminal)).state, 'READY');
    assert.equal(fs.readFileSync(f.persisted, 'utf8'), xml);
  },
);

test(
  'native support metadata and XML serialization changes remain untouched and activate',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'success', {
      supportMutation: true,
      holdAfterHook: true,
    });
    await f.scheduled();
    f.release();
    await until(() => fs.existsSync(path.join(f.root, 'hook-finished')));
    assert.equal(fs.readFileSync(path.join(f.root, 'hook-code'), 'utf8'), '0');
    const before = JSON.parse(
      fs.readFileSync(path.join(f.root, 'native-registration.json'), 'utf8'),
    );
    const nativeXML = fs.readFileSync(f.persisted, 'utf8');
    assert.match(nativeXML, /^<\?xml version="1.0"\?>\n<PLUGIN support=/);
    assert.notEqual(nativeXML, f.incomingBytes);
    write(path.join(f.root, 'finish-native'), '');
    assert.equal((await until(f.status, terminal)).state, 'READY');
    const after = fs.statSync(f.persisted, { bigint: true });
    assert.equal(String(after.ino), before.ino);
    assert.equal(String(after.mtimeNs), before.mtime);
    assert.equal(String(after.ctimeNs), before.ctime);
    assert.equal(fs.readFileSync(f.persisted, 'utf8'), nativeXML);
    assert.equal(f.events(), 'activated\n');
  },
);

test(
  'temporary global hook ignores unrelated native events without disturbing its pending job',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    const dir = await f.scheduled();
    const before = fs.readFileSync(path.join(dir, 'snapshot.plg'));
    for (const args of [
      ['plugin', 'check', 'unraid-deck-bridge.plg'],
      ['plugin', 'install', 'another-plugin.plg'],
    ]) {
      const result = spawnSync('/bin/bash', [f.hook, ...args], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout + result.stderr, '');
      assert.equal(fs.existsSync(f.hook), true);
      assert.deepEqual(fs.readFileSync(path.join(dir, 'snapshot.plg')), before);
      assert.equal(
        fs.existsSync(path.join(dir, 'native-complete.json')),
        false,
      );
      assert.equal(fs.existsSync(f.persisted), false);
      assert.equal(f.events(), '');
    }
    f.release();
    assert.equal((await until(f.status, terminal)).state, 'READY');
  },
);

test(
  'hook publication spans real separate filesystems and still restores the incoming PLG',
  { skip: !linux },
  async (t) => {
    const hookRoot = fs.mkdtempSync('/dev/shm/bridge-controller-hooks-');
    const f = fixture(t, 'alias', { hookRoot, deleteIncoming: true });
    t.after(() => fs.rmSync(hookRoot, { recursive: true, force: true }));
    assert.notEqual(fs.statSync(f.run).dev, fs.statSync(hookRoot).dev);
    await f.scheduled();
    f.assertPrepared();
    assert.equal(fs.existsSync(f.incoming), false);
    f.release();
    assert.equal((await until(f.status, terminal)).state, 'READY');
    assert.equal(fs.readFileSync(f.persisted, 'utf8'), f.incomingBytes);
    assert.equal(f.events(), 'activated\n');
    assert.deepEqual(fs.readdirSync(path.dirname(f.hook)), []);
  },
);

test(
  'schedule filesystem failure retains diagnostics but revokes activation ownership',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'success', { blockHookDirectory: true });
    assert.equal(
      await until(() =>
        fs.readFileSync(path.join(f.root, 'scheduled'), 'utf8'),
      ),
      '1',
    );
    const jobs = fs
      .readdirSync(f.run)
      .filter((name) => name.startsWith('post-install-'));
    assert.equal(jobs.length, 1);
    const dir = path.join(f.run, jobs[0]);
    const status = JSON.parse(
      fs.readFileSync(path.join(dir, 'status.json'), 'utf8'),
    );
    assert.equal(status.state, 'FAILED');
    assert.equal(status.phase, 'schedule');
    assert.equal(status.code, 'EEXIST');
    assert.equal(fs.existsSync(path.join(dir, 'owner')), false);
    assert.equal(fs.existsSync(path.join(f.run, 'activation-job')), false);
    assert.equal(
      fs.readFileSync(path.join(dir, 'snapshot.plg'), 'utf8'),
      f.incomingBytes,
    );
    f.assertPrepared();
    assert.equal(fs.existsSync(f.persisted), false);
  },
);

for (const crashHookOnce of [false, true])
  test(
    `install recovers ${crashHookOnce ? 'SIGKILL after hook write' : 'partial stale hook'} without manual cleanup`,
    { skip: !linux },
    async (t) => {
      const f = fixture(t, 'success', {
        crashHookOnce,
        staleHook: !crashHookOnce,
      });
      await f.scheduled();
      if (crashHookOnce)
        assert.equal(
          fs.existsSync(path.join(f.root, 'observed-crash-remnant')),
          true,
        );
      f.release();
      assert.equal((await until(f.status, terminal)).state, 'READY');
      assert.equal(f.events(), 'activated\n');
      assert.deepEqual(fs.readdirSync(path.dirname(f.hook)), []);
    },
  );

test(
  'unlocked scheduling cannot remove a stale hook or select a job',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'success', { staleHook: true, noScheduleLock: true });
    assert.equal(
      await until(() =>
        fs.readFileSync(path.join(f.root, 'scheduled'), 'utf8'),
      ),
      '1',
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          path.dirname(f.hook),
          '.unraid-deck-bridge-install.bridge-tmp',
        ),
        'utf8',
      ),
      'interrupted partial hook\n',
    );
    assert.equal(fs.existsSync(path.join(f.run, 'activation-job')), false);
    f.assertPrepared();
  },
);

test(
  'staging symlink is rejected without modifying its target',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'success', { redirectedHook: true });
    assert.equal(
      await until(() =>
        fs.readFileSync(path.join(f.root, 'scheduled'), 'utf8'),
      ),
      '1',
    );
    assert.equal(
      fs.readFileSync(path.join(f.root, 'protected'), 'utf8'),
      'unrelated bytes',
    );
    assert.equal(
      fs
        .lstatSync(
          path.join(
            path.dirname(f.hook),
            '.unraid-deck-bridge-install.bridge-tmp',
          ),
        )
        .isSymbolicLink(),
      true,
    );
    f.assertPrepared();
  },
);

test(
  'competing lifecycle lock prevents stale hook recovery until released',
  { skip: !linux },
  async (t) => {
    const f = fixture(t, 'success', { staleHook: true, pauseSchedule: true });
    assert.equal(await f.captured(), '0');
    await f.lock();
    write(path.join(f.root, 'start-schedule'), '');
    assert.equal(
      await until(() =>
        fs.readFileSync(path.join(f.root, 'scheduled'), 'utf8'),
      ),
      '75',
    );
    assert.equal(
      fs.readFileSync(
        path.join(
          path.dirname(f.hook),
          '.unraid-deck-bridge-install.bridge-tmp',
        ),
        'utf8',
      ),
      'interrupted partial hook\n',
    );
    assert.equal(fs.existsSync(path.join(f.run, 'activation-job')), false);
    f.unlock();
  },
);

for (const unsafeStaging of ['directory', 'hardlink'])
  test(
    `staging ${unsafeStaging} is retained without deleting unrelated content`,
    { skip: !linux },
    async (t) => {
      const f = fixture(t, 'success', { unsafeStaging });
      assert.equal(
        await until(() =>
          fs.readFileSync(path.join(f.root, 'scheduled'), 'utf8'),
        ),
        '1',
      );
      const temp = path.join(
        path.dirname(f.hook),
        '.unraid-deck-bridge-install.bridge-tmp',
      );
      const protectedFile =
        unsafeStaging === 'directory'
          ? path.join(temp, 'protected')
          : path.join(f.root, 'protected');
      assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'unrelated bytes');
      assert.equal(fs.existsSync(temp), true);
      assert.equal(fs.existsSync(path.join(f.run, 'activation-job')), false);
      f.assertPrepared();
    },
  );
