import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { executable, lifecycle } from './helpers/lifecycle.mjs';
import { removalHTTP } from './helpers/removal-http.mjs';
import { write } from './helpers/release.mjs';

const require = createRequire(import.meta.url);
const { tryLock } = require('fs-native-extensions');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const name = 'unraid-deck-bridge';
async function fixture(
  t,
  { systemRunLink = false, systemServiceLink = false, realProc = false } = {},
) {
  const f = lifecycle(t);
  const systemRun = path.join(f.root, 'system-run');
  const runLink = path.join(f.root, 'host-var/run');
  if (systemRunLink) {
    fs.mkdirSync(systemRun);
    fs.mkdirSync(path.dirname(runLink));
    fs.symlinkSync(systemRun, runLink);
  }
  const systemServiceDirectory = path.join(f.root, 'system-rc');
  if (systemServiceLink) {
    fs.renameSync(path.dirname(f.service), systemServiceDirectory);
    fs.symlinkSync(systemServiceDirectory, path.dirname(f.service));
  }
  const resolve = (source) => {
    source = source.replaceAll(
      '/tmp/plugins/pluginPending/unraid-deck-bridge.plg',
      path.join(f.root, 'pending/unraid-deck-bridge.plg'),
    );
    if (systemRunLink)
      source = source
        .replaceAll('/var/run/unraid-deck-bridge', path.join(runLink, name))
        .replaceAll("path.join('/', 'run')", JSON.stringify(systemRun));
    if (systemServiceLink)
      source = source.replaceAll(
        "path.join('/', 'usr', 'local', 'etc', 'rc.d')",
        JSON.stringify(systemServiceDirectory),
      );
    source = f
      .rewrite(source)
      .replaceAll(
        'const productionUID = 0;',
        `const productionUID = ${process.getuid()};`,
      )
      .replaceAll(
        "command('unraid-api',",
        `command(${JSON.stringify(path.join(f.bin, 'unraid-api'))},`,
      )
      .replaceAll(
        "spawnSync('flock',",
        `spawnSync(${JSON.stringify(path.join(f.bin, 'flock'))},`,
      )
      .replaceAll(
        'const STOP_TIMEOUT_MS = 180000;',
        'const STOP_TIMEOUT_MS = 400;',
      )
      .replaceAll(
        'const TASK_TIMEOUT_MS = 35000;',
        'const TASK_TIMEOUT_MS = 500;',
      )
      .replaceAll(
        'const HEALTH_TIMEOUT_MS = 30000;',
        'const HEALTH_TIMEOUT_MS = 500;',
      );
    // Only the explicit Linux process fixtures may observe the real read-only process table.
    if (realProc)
      source = source.replaceAll(
        path.join(f.root, 'process-table') + '/',
        '/proc/',
      );
    return source;
  };
  const remove = path.join(f.root, 'standalone-remove.sh');
  write(
    remove,
    resolve(fs.readFileSync(path.join(repo, 'packaging/remove.sh'), 'utf8')),
  );
  fs.mkdirSync(path.join(f.root, 'process-table'), { recursive: true });
  fs.renameSync(f.stage, f.candidate);
  fs.symlinkSync(f.candidate, path.join(f.runtime, 'current'));
  // A service file is payload, never the process ownership or stop authority.
  write(f.service, '#!/bin/sh\nexit 93\n', 0o755);
  const manifest = resolve('/usr/local/unraid-api/package.json');
  const config = resolve(
    '/boot/config/plugins/dynamix.my.servers/configs/api.json',
  );
  const originalPackage = {
    version: '4.35.1',
    dependencies: { unrelated: '1.0.0', [name]: '0.6.0' },
    peerDependencies: { another: '2.0.0', [name]: '0.6.0' },
    unrelated: { keep: true },
  };
  const originalConfig = {
    plugins: ['unrelated', name, 'another'],
    unrelated: { keep: true },
  };
  write(manifest, JSON.stringify(originalPackage), 0o640);
  write(config, JSON.stringify(originalConfig), 0o600);
  const adapter = resolve(
    '/usr/local/unraid-api/node_modules/unraid-deck-bridge',
  );
  write(path.join(adapter, 'index.js'), 'installed adapter\n');
  const base = resolve('/boot/config/plugins/unraid-deck-bridge');
  const runDir = resolve('/var/run/unraid-deck-bridge');
  const log = resolve('/var/log/unraid-deck-bridge.log');
  const temporary = resolve('/tmp/unraid-deck-bridge');
  const recovery = new Map([
    [path.join(base, 'state/operations/pending.json'), 'journal bytes\n'],
    [path.join(base, 'backups/old/api.json'), 'old backup bytes\n'],
    [
      path.join(base, 'backups/native/native-registration.tmp'),
      'partial PLG bytes\n',
    ],
    [path.join(base, 'packages/archive.tar.gz'), 'cache bytes\n'],
    [log, 'log bytes\n'],
    [path.join(temporary, 'cache'), 'temporary bytes\n'],
  ]);
  for (const [file, bytes] of recovery) write(file, bytes);
  write(path.join(runDir, 'supervisor.pid'), '999999\n');
  const hook = resolve(
    '/usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/unraid-deck-bridge-remove',
  );
  const remnants = [
    resolve(
      '/usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/unraid-deck-bridge-install',
    ),
    path.join(path.dirname(hook), '.unraid-deck-bridge-install.bridge-tmp'),
    log + '.trim',
    manifest + '.bridge-tmp',
    config + '.bridge-tmp',
    manifest + '.bridge-remove-tmp',
    config + '.bridge-remove-tmp',
    hook + '.bridge-remove-tmp',
    resolve('/boot/config/plugins-error/unraid-deck-bridge.plg'),
    resolve('/boot/config/plugins-nextboot/unraid-deck-bridge.plg'),
    resolve('/boot/config/plugins-stale/unraid-deck-bridge.plg'),
    resolve('/tmp/plugins/unraid-deck-bridge.plg'),
    resolve('/tmp/plugins/pluginPending/unraid-deck-bridge.plg'),
  ];
  for (const file of remnants) write(file, 'crashed Bridge artifact\n');
  const protectedFiles = new Map([
    [path.join(f.root, 'docker/containers/container.json'), 'container\n'],
    [path.join(f.root, 'docker/images/image'), 'image\n'],
    [path.join(f.root, 'docker/volumes/data'), 'volume\n'],
    [path.join(path.dirname(f.service), 'rc.unrelated'), 'other service\n'],
    [
      resolve('/boot/config/plugins/dockerMan/templates-user/my-app.xml'),
      '<Container/>\n',
    ],
    [
      path.join(f.root, 'api/node_modules/unrelated/index.js'),
      'other plugin\n',
    ],
    [path.join(path.dirname(hook), 'another-hook'), '#!/bin/sh\nexit 0\n'],
  ]);
  for (const directory of [
    'plugins-error',
    'plugins-nextboot',
    'plugins-stale',
  ])
    protectedFiles.set(
      resolve(`/boot/config/${directory}/another-plugin.plg`),
      'other plugin\n',
    );
  for (const [file, bytes] of protectedFiles) write(file, bytes);
  const persistent = resolve('/boot/config/plugins/unraid-deck-bridge.plg');
  const registered = resolve('/var/log/plugins/unraid-deck-bridge.plg');
  const archived = resolve(
    '/boot/config/plugins-removed/unraid-deck-bridge.plg',
  );
  write(persistent, 'canonical plugin bytes\n');
  fs.mkdirSync(path.dirname(registered), { recursive: true });
  fs.symlinkSync(persistent, registered);
  write(path.join(f.bin, 'node'), '#!/bin/sh\nexec "$REAL_NODE" "$@"\n', 0o755);
  const apiState = path.join(f.root, 'api-state');
  write(apiState, 'running\n');
  write(
    path.join(f.bin, 'unraid-api'),
    '#!/bin/sh\n[ ! -e /dev/fd/9 ] || exit 91\necho "api $1" >> "$EVENTS"\n[ "$FAIL_AT" != "api-$1" ] || exit 9\nif [ "$1" = stop ]; then echo stopped > "$API_STATE"; fi\nif [ "$1" = start ]; then echo running > "$API_STATE"; fi\n',
    0o755,
  );
  const http = await removalHTTP(t, f.root);
  const run = (env = {}, args = []) =>
    f.run([remove, ...args], { API_STATE: apiState, ...env });
  const invokeHook = (args = ['plugin', 'remove', name + '.plg']) =>
    f.run([hook, ...args]);
  function assertProtected() {
    for (const [file, bytes] of protectedFiles)
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
  function assertRecovery() {
    for (const [file, bytes] of recovery)
      assert.equal(fs.readFileSync(file, 'utf8'), bytes);
    assert.ok(fs.existsSync(f.candidate));
    assert.ok(fs.existsSync(adapter));
    assertProtected();
  }
  function assertRemoved() {
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest)), {
      ...originalPackage,
      dependencies: { unrelated: '1.0.0' },
      peerDependencies: { another: '2.0.0' },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(config)), {
      ...originalConfig,
      plugins: ['unrelated', 'another'],
    });
    assert.equal(fs.statSync(manifest).mode & 0o777, 0o640);
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
    for (const file of [
      base,
      f.runtime,
      runDir,
      f.service,
      adapter,
      log,
      temporary,
      ...remnants,
    ])
      assert.equal(fs.existsSync(file), false, file);
    assert.equal(fs.readFileSync(apiState, 'utf8'), 'running\n');
    assertProtected();
  }
  function finishOfficial() {
    fs.rmSync(registered, { force: true });
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(persistent, archived);
    const result = invokeHook();
    success(result);
    assert.match(result.stdout, /Bridge removal verified/);
    assert.equal(fs.existsSync(archived), false);
    assert.equal(fs.existsSync(hook), false);
    assertProtected();
  }
  return {
    f,
    run,
    remove,
    manifest,
    config,
    apiState,
    originalPackage,
    originalConfig,
    adapter,
    base,
    runDir,
    log,
    temporary,
    remnants,
    recovery,
    protectedFiles,
    hook,
    persistent,
    registered,
    archived,
    invokeHook,
    assertProtected,
    assertRecovery,
    assertRemoved,
    finishOfficial,
    http,
  };
}
function success(result) {
  assert.equal(result.status, 0, result.stdout + result.stderr);
}

test('native removal retains the manager input until synchronous final verification', async (t) => {
  const f = await fixture(t);
  const result = f.run();
  success(result);
  assert.doesNotMatch(result.stdout, /Bridge removal verified/);
  assert.ok(fs.existsSync(f.persistent));
  f.assertRemoved();
  assert.deepEqual(f.f.events(), ['api stop', 'api start']);
  f.finishOfficial();
});

test('standalone removes registration itself and repeated removal leaves no new lock or hook', async (t) => {
  const f = await fixture(t);
  write(f.archived, 'archive\n');
  success(f.run({}, ['--standalone']));
  f.assertRemoved();
  for (const file of [f.persistent, f.registered, f.archived, f.hook])
    assert.equal(fs.existsSync(file), false);
  write(f.f.log, '');
  success(f.run({}, ['--standalone']));
  assert.deepEqual(f.f.events(), []);
  assert.equal(fs.existsSync(f.runDir), false);
  assert.equal(fs.existsSync(f.hook), false);
});

test('stop-only leaves metadata, activation selection and all recovery payload unchanged', async (t) => {
  const f = await fixture(t);
  const selected = path.join(f.runDir, 'activation-job');
  write(selected, 'selected-job\n');
  const lock = path.join(f.runDir, 'install.lock');
  assert.equal(fs.existsSync(lock), false);
  success(f.run({}, ['--stop-only']));
  f.assertRecovery();
  assert.equal(fs.readFileSync(selected, 'utf8'), 'selected-job\n');
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest)), f.originalPackage);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)), f.originalConfig);
  assert.deepEqual(f.f.events(), []);
});

for (const args of [
  ['--invalid'],
  ['--standalone', '--stop-only'],
  ['--stop-only', 'extra'],
]) {
  test(`invalid remove arguments ${args.join(' ')} have no lifecycle effects`, async (t) => {
    const f = await fixture(t);
    assert.notEqual(f.run({}, args).status, 0);
    f.assertRecovery();
    assert.equal(fs.existsSync(path.join(f.runDir, 'install.lock')), false);
    assert.deepEqual(f.f.events(), []);
  });
}

test('standard system links survive complete uninstall', async (t) => {
  const f = await fixture(t, { systemRunLink: true, systemServiceLink: true });
  success(f.run());
  f.assertRemoved();
  f.finishOfficial();
  assert.ok(fs.lstatSync(path.dirname(f.runDir)).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(path.join(f.f.root, 'system-run')), []);
  assert.ok(fs.lstatSync(path.dirname(f.f.service)).isSymbolicLink());
});

for (const link of ['run', 'service'])
  for (const kind of ['wrong-target', 'indirect-target', 'missing-target']) {
    test(`system ${link} rejects ${kind} without following redirects`, async (t) => {
      const f = await fixture(t, {
        systemRunLink: true,
        systemServiceLink: true,
      });
      const target = path.join(
        f.f.root,
        link === 'run' ? 'system-run' : 'system-rc',
      );
      if (kind === 'wrong-target') {
        const entry =
          link === 'run' ? path.dirname(f.runDir) : path.dirname(f.f.service);
        fs.unlinkSync(entry);
        fs.symlinkSync(path.join(f.f.root, 'docker/volumes'), entry);
      } else {
        fs.renameSync(target, target + '-retained');
        if (kind === 'indirect-target')
          fs.symlinkSync(target + '-retained', target);
      }
      assert.notEqual(f.run().status, 0);
      assert.equal(
        fs.readFileSync(path.join(f.f.root, 'docker/volumes/data'), 'utf8'),
        'volume\n',
      );
      const serviceRoot =
        link === 'service' && kind !== 'wrong-target'
          ? 'system-rc-retained'
          : 'system-rc';
      assert.equal(
        fs.readFileSync(
          path.join(f.f.root, serviceRoot, 'rc.unrelated'),
          'utf8',
        ),
        'other service\n',
      );
      assert.ok(fs.existsSync(f.adapter));
      assert.ok(fs.existsSync(f.f.candidate));
      assert.deepEqual(f.f.events(), []);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(f.manifest)),
        f.originalPackage,
      );
    });
  }

for (const missingRuntime of [false, true])
  test(`self-contained remove with missing service and runtime=${missingRuntime}`, async (t) => {
    const f = await fixture(t);
    fs.unlinkSync(f.f.service);
    if (missingRuntime) fs.rmSync(f.f.runtime, { recursive: true });
    success(f.run());
    f.assertRemoved();
    f.finishOfficial();
    assert.deepEqual(f.f.events(), ['api stop', 'api start']);
  });

for (const fail of ['api-stop', 'api-start'])
  test(`${fail} retains recovery and restores targeted metadata`, async (t) => {
    const f = await fixture(t);
    assert.notEqual(f.run({ FAIL_AT: fail }).status, 0);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(f.manifest)),
      f.originalPackage,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(f.config)), f.originalConfig);
    assert.equal(fs.statSync(f.manifest).mode & 0o777, 0o640);
    assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
    f.assertRecovery();
    success(f.run());
    f.assertRemoved();
    f.finishOfficial();
  });

test('unhealthy official GraphQL retains payload and restores metadata', async (t) => {
  const f = await fixture(t);
  write(path.join(f.f.root, 'api-health-failure'), '503\n');
  assert.notEqual(f.run().status, 0);
  f.assertRecovery();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.manifest)), f.originalPackage);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.config)), f.originalConfig);
});

test('absent Bridge metadata skips restart but still requires healthy official GraphQL', async (t) => {
  const f = await fixture(t);
  const pkg = {
    ...f.originalPackage,
    dependencies: { unrelated: '1.0.0' },
    peerDependencies: { another: '2.0.0' },
  };
  write(f.manifest, JSON.stringify(pkg));
  write(
    f.config,
    JSON.stringify({ ...f.originalConfig, plugins: ['unrelated', 'another'] }),
  );
  fs.rmSync(f.adapter, { recursive: true });
  write(path.join(f.f.root, 'api-health-failure'), '503\n');
  assert.notEqual(f.run({}, ['--standalone']).status, 0);
  assert.ok(fs.existsSync(f.base));
  assert.ok(fs.existsSync(f.f.candidate));
  assert.deepEqual(f.f.events(), []);
  fs.unlinkSync(path.join(f.f.root, 'api-health-failure'));
  success(f.run({}, ['--standalone']));
  f.assertRemoved();
  assert.deepEqual(f.f.events(), []);
});

test('unused adapter files do not restart an already deregistered healthy API', async (t) => {
  const f = await fixture(t);
  write(
    f.manifest,
    JSON.stringify({
      ...f.originalPackage,
      dependencies: { unrelated: '1.0.0' },
      peerDependencies: { another: '2.0.0' },
    }),
  );
  write(
    f.config,
    JSON.stringify({ ...f.originalConfig, plugins: ['unrelated', 'another'] }),
  );
  success(f.run({}, ['--standalone']));
  f.assertRemoved();
  assert.deepEqual(f.f.events(), []);
});

for (const mode of ['native-complete', 'native-complete-locked']) {
  test(`removal retains recovery while a native ${mode} task is still running`, async (t) => {
    const f = await fixture(t);
    const proc = path.join(f.f.root, 'process-table/424242');
    const fields = Array(50).fill('0');
    fields[0] = 'S';
    fields[1] = '1';
    fields[19] = '12345';
    write(path.join(proc, 'stat'), `424242 (node) ${fields.join(' ')}`);
    write(
      path.join(proc, 'cmdline'),
      [
        process.execPath,
        path.join(f.f.candidate, 'post-install.mjs'),
        mode,
        'job',
      ].join('\0') + '\0',
    );
    fs.symlinkSync(process.execPath, path.join(proc, 'exe'));
    const result = f.run({}, ['--standalone']);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /tasks did not exit/);
    f.assertRecovery();
    assert.deepEqual(f.f.events(), []);
    assert.ok(fs.existsSync(path.join(f.runDir, 'install.lock')));
  });
}

test('busy lifecycle transaction does not invalidate selected work or mutate recovery', async (t) => {
  const f = await fixture(t);
  write(path.join(f.runDir, 'activation-job'), 'active\n');
  const fd = fs.openSync(path.join(f.runDir, 'install.lock'), 'w');
  try {
    if (process.platform === 'linux') {
      const lock = spawnSync(executable('flock'), ['-n', '9'], {
        stdio: [
          'ignore',
          'ignore',
          'pipe',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          'ignore',
          fd,
        ],
      });
      assert.ifError(lock.error);
      assert.equal(lock.status, 0, lock.stderr?.toString());
    } else assert.ok(tryLock(fd));
    assert.notEqual(f.run().status, 0);
    f.assertRecovery();
    assert.equal(
      fs.readFileSync(path.join(f.runDir, 'activation-job'), 'utf8'),
      'active\n',
    );
    assert.deepEqual(f.f.events(), []);
  } finally {
    fs.closeSync(fd);
  }
});

test('malformed metadata fails without printing secrets or deleting recovery', async (t) => {
  const f = await fixture(t);
  const invalid = 'token-demo-do-not-print';
  write(f.config, invalid);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.ok(!(result.stdout + result.stderr).includes('token-demo'));
  f.assertRecovery();
  assert.equal(fs.readFileSync(f.config, 'utf8'), invalid);
  assert.deepEqual(f.f.events(), []);
});

test('owned leaf links are unlinked without touching business data', async (t) => {
  const f = await fixture(t);
  const external = path.join(f.f.root, 'docker/volumes');
  for (const file of [f.base, f.adapter, f.log, f.temporary, ...f.remnants]) {
    fs.rmSync(file, { recursive: true, force: true });
    fs.symlinkSync(external, file);
  }
  success(f.run());
  f.assertRemoved();
  f.finishOfficial();
});
for (const location of ['run', 'metadata', 'parent'])
  test(`unsafe ${location} link fails without traversing it`, async (t) => {
    const f = await fixture(t);
    const external = path.join(f.f.root, 'docker/volumes');
    const target =
      location === 'run'
        ? f.runDir
        : location === 'metadata'
          ? f.config
          : path.dirname(f.hook);
    fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(external, target);
    assert.notEqual(f.run().status, 0);
    assert.equal(
      fs.readFileSync(path.join(external, 'data'), 'utf8'),
      'volume\n',
    );
    assert.ok(fs.existsSync(f.f.candidate));
    assert.ok(fs.existsSync(f.adapter));
    assert.deepEqual(f.f.events(), []);
  });

test('hook rejects invalid invocations and reports incomplete matching removal', async (t) => {
  const f = await fixture(t);
  success(f.run());
  write(f.archived, 'archive bytes\n');
  for (const args of [
    [],
    ['plugin', 'install', name + '.plg'],
    ['plugin', 'remove', 'other.plg'],
  ]) {
    assert.notEqual(f.invokeHook(args).status, 0);
    assert.ok(fs.existsSync(f.hook));
  }
  for (const args of [
    ['plugin', 'remove', name + '.plg', 'failed'],
    ['plugin', 'remove', name + '.plg'],
  ]) {
    const result = f.invokeHook(args);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(f.archived, 'utf8'), 'archive bytes\n');
  }
  fs.unlinkSync(f.persistent);
  assert.notEqual(
    f.invokeHook().status,
    0,
    'dangling registration is still registration',
  );
  fs.unlinkSync(f.registered);
  success(f.invokeHook());
  assert.equal(fs.existsSync(f.archived), false);
  assert.equal(fs.existsSync(f.hook), false);
});

// Run these on Linux as UID99 (or another unprivileged UID), not as root on the host.
// The executable is a private copy of the running Node ELF, never production Core.
async function controlledCore(
  t,
  f,
  {
    outside = false,
    state = path.join(f.base, 'state/operations'),
    ignoreTerm = false,
  } = {},
) {
  const dir = outside
    ? path.join(f.f.root, 'external')
    : path.join(f.f.runtime, 'releases/process-fixture');
  fs.mkdirSync(dir, { recursive: true });
  const executable = path.join(dir, 'deck-bridge-core');
  if (!fs.existsSync(executable)) {
    fs.copyFileSync(process.execPath, executable);
    fs.chmodSync(executable, 0o755);
  }
  const script = path.join(
    f.f.root,
    `core-${outside ? 'outside' : 'owned'}-${Math.random()}.cjs`,
  );
  write(
    script,
    `process.on('SIGTERM', () => { ${ignoreTerm ? '' : 'process.exit(0);'} }); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n`,
  );
  const child = spawn(executable, [script, '--state', state], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
    await exited;
  });
  await once(child.stdout, 'data');
  assert.equal(fs.realpathSync(`/proc/${child.pid}/exe`), executable);
  return { child, exited };
}

for (const pidFile of ['missing', 'stale'])
  test(
    `Linux owned orphan with ${pidFile} PID is stopped; unrelated same names survive`,
    { skip: process.platform !== 'linux' },
    async (t) => {
      const f = await fixture(t, { realProc: true });
      const owned = await controlledCore(t, f);
      const outside = await controlledCore(t, f, { outside: true });
      const otherState = await controlledCore(t, f, {
        state: path.join(f.f.root, 'other-state'),
      });
      const pid = path.join(f.runDir, 'supervisor.pid');
      if (pidFile === 'missing') fs.unlinkSync(pid);
      else write(pid, `${outside.child.pid}\n`);
      success(f.run({}, ['--stop-only']));
      await owned.exited;
      assert.equal(owned.child.signalCode, null);
      assert.equal(outside.child.exitCode, null);
      assert.equal(outside.child.signalCode, null);
      assert.equal(otherState.child.exitCode, null);
      assert.equal(otherState.child.signalCode, null);
      assert.deepEqual(f.f.events(), []);
      f.assertRecovery();
    },
  );

test(
  'Linux TERM timeout is nonzero and preserves live Core socket, lock and journal',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t, { realProc: true });
    const owned = await controlledCore(t, f, { ignoreTerm: true });
    const socket = path.join(f.runDir, 'core.sock');
    const lock = path.join(f.runDir, 'core.lock');
    write(socket, 'socket sentinel\n');
    write(lock, 'instance lock sentinel\n');
    assert.notEqual(f.run({}, ['--standalone']).status, 0);
    assert.equal(owned.child.exitCode, null);
    assert.equal(owned.child.signalCode, null);
    assert.equal(fs.readFileSync(socket, 'utf8'), 'socket sentinel\n');
    assert.equal(fs.readFileSync(lock, 'utf8'), 'instance lock sentinel\n');
    f.assertRecovery();
    assert.deepEqual(f.f.events(), []);
  },
);

test(
  'Linux canonical supervisor forwards TERM, waits for Core and never restarts it',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t, { realProc: true, systemServiceLink: true });
    const core = path.join(f.f.runtime, 'releases/supervised/deck-bridge-core');
    fs.mkdirSync(path.dirname(core), { recursive: true });
    fs.copyFileSync(process.execPath, core);
    fs.chmodSync(core, 0o755);
    const script = path.join(f.f.root, 'supervised.cjs');
    write(
      script,
      "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n",
    );
    const starts = path.join(f.f.root, 'supervisor-starts');
    write(
      f.f.service,
      `#!/bin/bash\nprintf 'start\\n' >> ${JSON.stringify(starts)}\n${JSON.stringify(core)} ${JSON.stringify(script)} --state ${JSON.stringify(path.join(f.base, 'state/operations'))} &\nchild=$!\ntrap 'kill -TERM "$child"; wait "$child"; exit 0' TERM\nwait "$child"\n`,
      0o755,
    );
    const supervisor = spawn(
      executable('bash'),
      [fs.realpathSync(f.f.service), 'supervise'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const exited = once(supervisor, 'exit');
    t.after(async () => {
      if (supervisor.exitCode === null && supervisor.signalCode === null)
        supervisor.kill('SIGTERM');
      await exited;
    });
    await once(supervisor.stdout, 'data');
    write(path.join(f.runDir, 'supervisor.pid'), `${supervisor.pid}\n`);
    success(f.run({}, ['--stop-only']));
    await exited;
    assert.equal(supervisor.exitCode, 0);
    assert.equal(fs.existsSync(path.join(f.runDir, 'supervisor.pid')), false);
    assert.equal(fs.readFileSync(starts, 'utf8'), 'start\n');
    f.assertRecovery();
    assert.deepEqual(f.f.events(), []);
  },
);

test(
  'Linux waiting worker observes selection invalidation and exits without resurrection',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t, { realProc: true });
    const selected = path.join(f.runDir, 'activation-job');
    write(selected, 'waiting\n');
    const script = path.join(f.f.candidate, 'post-install.mjs');
    const stopped = path.join(f.f.root, 'worker-stopped');
    write(
      script,
      `import fs from 'node:fs'; process.stdout.write('ready\\n'); setInterval(() => { if (!fs.existsSync(${JSON.stringify(selected)})) { fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped'); process.exit(0); } }, 10);\n`,
    );
    const worker = spawn(process.execPath, [script, 'run'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(worker, 'exit');
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null)
        worker.kill('SIGKILL');
      await exited;
    });
    await once(worker.stdout, 'data');
    success(f.run({}, ['--standalone']));
    await exited;
    assert.equal(worker.exitCode, 0);
    assert.equal(fs.readFileSync(stopped, 'utf8'), 'stopped');
    f.assertRemoved();
    assert.equal(fs.existsSync(f.runDir), false);
  },
);

function procStat(pid, state, start) {
  const fields = Array(20).fill('0');
  fields[0] = state;
  fields[1] = '1';
  fields[19] = String(start);
  return `${pid} (controlled fixture) ${fields.join(' ')}\n`;
}

test('zombie proc snapshots count as exited even with an owned-looking command line', async (t) => {
  const f = await fixture(t);
  const dir = path.join(f.f.root, 'process-table/999998');
  write(path.join(dir, 'stat'), procStat(999998, 'Z', 123));
  write(
    path.join(dir, 'cmdline'),
    [
      path.join(f.f.candidate, 'deck-bridge-core'),
      '--state',
      path.join(f.base, 'state/operations'),
      '',
    ].join('\0'),
  );
  fs.symlinkSync(
    path.join(f.f.candidate, 'deck-bridge-core'),
    path.join(dir, 'exe'),
  );
  success(f.run({}, ['--stop-only']));
  f.assertRecovery();
  assert.deepEqual(f.f.events(), []);
});

test(
  'Linux controlled PID reuse snapshot never signals the replacement process',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t);
    const unrelated = await controlledCore(t, f, { outside: true });
    const pid = unrelated.child.pid;
    const dir = path.join(f.f.root, 'process-table', String(pid));
    const stat = path.join(dir, 'stat');
    const exe = path.join(dir, 'exe');
    write(stat, procStat(pid, 'S', 123));
    write(
      path.join(dir, 'cmdline'),
      [
        path.join(f.f.candidate, 'deck-bridge-core'),
        '--state',
        path.join(f.base, 'state/operations'),
        '',
      ].join('\0'),
    );
    fs.symlinkSync(path.join(f.f.candidate, 'deck-bridge-core'), exe);
    // Real PID reuse is nondeterministic. Change only the read-only proc snapshot
    // between ownership scan and signal recheck; process.kill remains real.
    const source = fs.readFileSync(f.remove, 'utf8');
    const injection = `let fixtureStatReads = 0;
const fixtureRead = fs.readFileSync.bind(fs);
const fixtureLink = fs.readlinkSync.bind(fs);
fs.readFileSync = (file, ...args) => {
  if (file === ${JSON.stringify(stat)}) {
    fixtureStatReads++;
    return fixtureStatReads <= 4 ? ${JSON.stringify(procStat(pid, 'S', 123))} : ${JSON.stringify(procStat(pid, 'S', 456))};
  }
  return fixtureRead(file, ...args);
};
fs.readlinkSync = (file, ...args) => file === ${JSON.stringify(exe)} && fixtureStatReads >= 5
  ? ${JSON.stringify(path.join(f.f.root, 'external/deck-bridge-core'))} : fixtureLink(file, ...args);
`;
    write(
      f.remove,
      source.replace(
        'const productionUID =',
        injection + 'const productionUID =',
      ),
    );
    success(f.run({}, ['--stop-only']));
    assert.equal(unrelated.child.exitCode, null);
    assert.equal(unrelated.child.signalCode, null);
    f.assertRecovery();
    assert.deepEqual(f.f.events(), []);
  },
);

test('stop-only with an absent run directory does not create lifecycle files', async (t) => {
  const f = await fixture(t);
  fs.rmSync(f.runDir, { recursive: true });
  success(f.run({}, ['--stop-only']));
  assert.equal(fs.existsSync(f.runDir), false);
  f.assertRecovery();
  assert.deepEqual(f.f.events(), []);
});

test(
  'Linux non-exiting selected worker times out without being killed or purged',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t, { realProc: true });
    const selected = path.join(f.runDir, 'activation-job');
    write(selected, 'waiting\n');
    const script = path.join(f.f.candidate, 'post-install.mjs');
    write(
      script,
      "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);\n",
    );
    const worker = spawn(process.execPath, [script, 'run'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(worker, 'exit');
    t.after(async () => {
      if (worker.exitCode === null && worker.signalCode === null)
        worker.kill('SIGKILL');
      await exited;
    });
    await once(worker.stdout, 'data');
    assert.notEqual(f.run({}, ['--standalone']).status, 0);
    assert.equal(fs.existsSync(selected), false);
    assert.equal(worker.exitCode, null);
    assert.equal(worker.signalCode, null);
    f.assertRecovery();
    assert.deepEqual(f.f.events(), []);
  },
);

test(
  'Linux deleted release executable is still recognized and drained',
  { skip: process.platform !== 'linux' },
  async (t) => {
    const f = await fixture(t, { realProc: true });
    const owned = await controlledCore(t, f);
    const binary = path.join(
      f.f.runtime,
      'releases/process-fixture/deck-bridge-core',
    );
    fs.unlinkSync(binary);
    assert.match(
      fs.readlinkSync(`/proc/${owned.child.pid}/exe`),
      / \(deleted\)$/,
    );
    success(f.run({}, ['--stop-only']));
    await owned.exited;
    assert.equal(owned.child.exitCode, 0);
    f.assertRecovery();
    assert.deepEqual(f.f.events(), []);
  },
);

for (const fail of ['', 'api-start'])
  test(`API stop flush preserves unrelated fields on ${fail ? 'failed start rollback' : 'successful removal'}`, async (t) => {
    const f = await fixture(t);
    const flush = path.join(f.f.root, 'api-flush.cjs');
    write(
      flush,
      `const fs = require('node:fs');
for (const file of ${JSON.stringify([f.manifest, f.config])}) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.officialStopFlush = { revision: 42 };
  value.unrelated = { keep: true, flushed: true };
  fs.writeFileSync(file, JSON.stringify(value));
}
`,
    );
    write(
      path.join(f.f.bin, 'unraid-api'),
      `#!/bin/sh
[ ! -e /dev/fd/9 ] || exit 91
echo "api $1" >> "$EVENTS"
if [ "$1" = stop ]; then
  ${JSON.stringify(process.execPath)} ${JSON.stringify(flush)} || exit 8
  echo stopped > "$API_STATE"
fi
[ "$FAIL_AT" != "api-$1" ] || exit 9
if [ "$1" = start ]; then echo running > "$API_STATE"; fi
`,
      0o755,
    );
    const result = f.run({ FAIL_AT: fail });
    if (fail) {
      assert.notEqual(result.status, 0);
      f.assertRecovery();
    } else success(result);
    const pkg = JSON.parse(fs.readFileSync(f.manifest));
    const config = JSON.parse(fs.readFileSync(f.config));
    for (const value of [pkg, config]) {
      assert.deepEqual(value.officialStopFlush, { revision: 42 });
      assert.deepEqual(value.unrelated, { keep: true, flushed: true });
    }
    assert.equal(fs.statSync(f.manifest).mode & 0o777, 0o640);
    assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
    if (fail) {
      assert.equal(pkg.dependencies[name], '0.6.0');
      assert.equal(pkg.peerDependencies[name], '0.6.0');
      assert.deepEqual(config.plugins, f.originalConfig.plugins);
    } else {
      assert.deepEqual(pkg.dependencies, { unrelated: '1.0.0' });
      assert.deepEqual(pkg.peerDependencies, { another: '2.0.0' });
      assert.deepEqual(config.plugins, ['unrelated', 'another']);
      assert.equal(fs.existsSync(f.base), false);
      assert.equal(fs.existsSync(f.f.runtime), false);
      assert.deepEqual(f.f.events(), ['api stop', 'api start']);
      f.finishOfficial();
    }
    f.assertProtected();
  });
