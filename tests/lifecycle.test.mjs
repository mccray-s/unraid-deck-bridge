import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  lifecycle,
  build,
  pluginVersion,
  rewriteHostPaths,
  stageHostCompatibility,
  versionedHealth,
} from './helpers/lifecycle.mjs';
import { releaseFixture, parsePlugin } from './helpers/release.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { removalHTTP } from './helpers/removal-http.mjs';
import { parseReleaseVersion } from '../api-extension/release-version.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function write(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function installation(t, options) {
  const f = lifecycle(t, options);
  const prepared = f.run();
  if (prepared.status !== 0)
    return { ...f, result: prepared, events: f.events() };
  f.commit();
  return { ...f, result: f.activate(), events: f.events() };
}
function assertOldState(f) {
  assert.equal(
    fs.readlinkSync(path.join(f.runtime, 'current')),
    path.join(f.runtime, 'releases/0.1.1-00c5ac46d699'),
  );
  assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
  assert.equal(
    fs.readFileSync(
      path.join(f.runtime, 'releases/0.1.1-00c5ac46d699/deck-bridge-core'),
      'utf8',
    ),
    'old core bytes\n',
  );
}
function assertBeforeStop(f) {
  assert.ok(
    !f
      .events()
      .some((event) =>
        /^(oldcore|newcore|api) |^manager (backup|register|restore)$/.test(
          event,
        ),
      ),
    f.events().join('\n'),
  );
  assertOldState(f);
}
test('backup failure restarts API even before a snapshot exists', (t) => {
  const f = installation(t, { fail: 'backup' });
  assert.notEqual(f.result.status, 0);
  assert.ok(f.events.includes('api start'));
  assert.ok(!f.events.includes('manager register'));
  assert.ok(!f.events.includes('manager restore'));
});
test('first-install health failure removes failed runtime selection and service', (t) => {
  const f = installation(t, { fail: 'health' });
  assert.notEqual(f.result.status, 0);
  assert.ok(f.events.includes('manager restore'));
  assert.equal(fs.readFileSync(f.coreState, 'utf8'), 'stopped\n');
  assert.ok(!fs.existsSync(path.join(f.runtime, 'current')));
  assert.ok(!fs.existsSync(f.service));
  assert.ok(
    fs.existsSync(f.candidate),
    'failed candidate retained for diagnosis',
  );
  assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
  assert.equal(f.events.at(-1), 'api start');
});
for (const fail of ['start-once', 'health']) {
  test(`failed update (${fail}) restores previous service, current and official module`, (t) => {
    const f = installation(t, { previous: true, fail });
    assert.notEqual(f.result.status, 0);
    assertOldState(f);
    assert.ok(f.events.includes('oldcore start'));
    assert.ok(f.events.includes('manager restore'));
    assert.ok(fs.existsSync(f.candidate));
    assert.equal(f.events.filter((e) => e === 'api start').length, 2);
  });
}
test('successful install stops API before registration and keeps candidate', (t) => {
  const f = installation(t);
  assert.equal(f.result.status, 0, f.result.stderr);
  assert.ok(
    f.events.indexOf('api stop') < f.events.indexOf('manager register'),
  );
  assert.ok(
    f.events.indexOf('manager register') < f.events.indexOf('api start'),
  );
  assert.equal(fs.readlinkSync(path.join(f.runtime, 'current')), f.candidate);
  assert.ok(
    !fs.existsSync(f.stage),
    'staging renamed into immutable candidate',
  );
  assert.ok(!f.events.includes('manager restore'));
});

for (const metadataVersion of ['2026.10.29a', '2026.11.01z']) {
  for (const matches of [true, false]) {
    test(`Core version handshake ${matches ? 'accepts matching Core' : 'rolls back mismatched Core'} against adapter ${metadataVersion}`, async (t) => {
      const f = lifecycle(t, { previous: true });
      write(
        path.join(f.stage, 'adapter/package.json'),
        JSON.stringify({
          version: parseReleaseVersion(metadataVersion).npmVersion,
        }),
      );
      write(
        path.join(f.stage, 'adapter/release.json'),
        JSON.stringify({ version: metadataVersion }),
      );
      f.args[3] = metadataVersion;
      const candidateBuild = `${metadataVersion}-${build.split('-')[1]}`;
      f.args[2] = candidateBuild;
      const candidate = path.join(f.runtime, 'releases', candidateBuild);
      const coreVersion = matches ? metadataVersion : '0.0.1';
      const health = await versionedHealth(t, f, { coreVersion });
      const result = await health.install();
      const events = f.events();
      const requests = health.requests();
      const coreRequests = requests.filter(
        (request) => request.kind === 'core',
      );
      const apiRequests = requests.filter((request) => request.kind === 'api');
      assert.equal(
        result.status,
        matches ? 0 : 1,
        result.stdout + result.stderr,
      );
      assert.deepEqual(health.serviceState(), {
        core: 'start\n',
        api: 'start\n',
      });
      assert.ok(
        coreRequests.length > 0,
        'real detector reached the Core /info peer',
      );
      for (const request of coreRequests) {
        assert.equal(request.url, '/info');
        assert.equal(request.method, 'GET');
        assert.equal(request.actor, 'installer');
      }
      for (const request of requests) {
        assert.equal(
          request.current,
          candidate,
          'health probes the selected candidate',
        );
        assert.equal(
          request.module,
          requests.indexOf(request) === 0 || !matches
            ? 'official-old\n'
            : 'official-new\n',
          'core-only health precedes API registration; full health follows it',
        );
      }
      if (matches)
        assert.ok(
          events.indexOf('newcore start') < events.indexOf('manager register'),
        );
      assert.ok(
        fs.existsSync(candidate),
        'candidate retained after health decision',
      );
      assert.ok(
        !fs.existsSync(f.stage),
        'transaction places staging before health',
      );
      if (matches) {
        assert.equal(coreRequests.length, 2);
        assert.equal(
          fs.readlinkSync(path.join(f.runtime, 'current')),
          candidate,
        );
        assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-new\n');
        assert.ok(!events.includes('manager restore'));
        assert.ok(result.stdout.includes('API activation READY'));
      } else {
        assert.equal(
          coreRequests.length,
          30,
          'every bounded health retry sees the mismatch',
        );
        assert.equal(
          apiRequests.length,
          0,
          'Core mismatch fails before GraphQL health',
        );
        assertOldState(f);
        assert.equal(fs.readFileSync(f.coreState, 'utf8'), 'old\n');
        assert.ok(!events.includes('manager restore'));
        assert.equal(
          events.filter((event) => event.startsWith('api ')).length,
          0,
        );
        assert.equal(events.at(-1), 'oldcore start');
        assert.ok(!result.stdout.includes('activation READY'));
      }
    });
  }
}
const invalidInstallations = {
  'no arguments': (f) => [f.args[0]],
  'one argument': (f) => f.args.slice(0, 2),
  'extra argument': (f) => [...f.args, 'extra'],
  'malformed build': (f) => [f.args[0], f.stage, '../escape', pluginVersion],
  'wrong adapter version': (f) => [
    f.args[0],
    f.stage,
    '9.9.9-123456abcdef',
    pluginVersion,
  ],
  'legacy two arguments': (f) => f.args.slice(0, 3),
  'invalid plugin version': (f) => [...f.args.slice(0, 3), 'bad'],
  'four-segment plugin version': (f) => [
    ...f.args.slice(0, 3),
    `${pluginVersion}.0001`,
  ],
  'plugin version with suffix': (f) => [
    ...f.args.slice(0, 3),
    `${pluginVersion}beta`,
  ],
  'non-staging directory': (f) => {
    const target = path.join(f.runtime, 'releases/ordinary');
    fs.renameSync(f.stage, target);
    return [f.args[0], target, build, pluginVersion];
  },
  'nested staging directory': (f) => {
    const target = path.join(f.stage, '.staging-nested');
    fs.mkdirSync(target);
    return [f.args[0], target, build, pluginVersion];
  },
  'symlink staging': (f) => {
    const target = path.join(f.runtime, 'releases/.staging-link');
    fs.symlinkSync(f.stage, target);
    return [f.args[0], target, build, pluginVersion];
  },
  'outside runtime releases': (f) => {
    const target = path.join(f.root, '.staging-outside');
    fs.renameSync(f.stage, target);
    return [f.args[0], target, build, pluginVersion];
  },
  'digest mismatch': (f) => {
    fs.appendFileSync(path.join(f.stage, 'deck-bridge-core'), 'tampered');
    return f.args;
  },
  'missing checksums': (f) => {
    fs.unlinkSync(path.join(f.stage, 'SHA256SUMS'));
    return f.args;
  },
};
for (const [name, change] of Object.entries(invalidInstallations)) {
  test(`install rejects ${name} before stopping services`, (t) => {
    const f = lifecycle(t, { previous: true });
    assert.notEqual(f.run(change(f)).status, 0);
    assertBeforeStop(f);
  });
}
test('staging selected as current is rejected before stopping services', (t) => {
  const f = lifecycle(t);
  fs.symlinkSync(f.stage, path.join(f.runtime, 'current'));
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(f.events(), []);
  assert.equal(fs.readlinkSync(path.join(f.runtime, 'current')), f.stage);
});
test('manager preflight failure never stops services', (t) => {
  const f = lifecycle(t, { previous: true, fail: 'preflight' });
  assert.notEqual(f.run().status, 0);
  assert.ok(f.events().includes('manager preflight'));
  assertBeforeStop(f);
});
for (const [osVersion, apiVersion, templateProfile] of [
  ['6.12.0', '4.25.3', 'DOCKERMAN_CLASSIC_NETWORK'],
  ['7.2.4', '4.36.1', 'DOCKERMAN_CLASSIC_NETWORK'],
  ['7.2.5', '4.36.1', 'DOCKERMAN_ENDPOINT_NETWORK'],
  ['7.3.20', '4.99.0', 'DOCKERMAN_ENDPOINT_NETWORK'],
  ['8.0.0', '5.0.0', 'DOCKERMAN_ENDPOINT_NETWORK'],
]) {
  test(`installer admits OS ${osVersion} API ${apiVersion} through real host preflight`, (t) => {
    const f = lifecycle(t, { previous: true });
    stageHostCompatibility(f.root, {
      managerRoot: f.stage,
      osVersion,
      apiVersion,
    });
    f.sums();
    const profile = spawnSync(
      process.execPath,
      [path.join(f.stage, 'manager.mjs'), 'template-profile'],
      { encoding: 'utf8' },
    );
    assert.equal(profile.status, 0, profile.stderr);
    assert.equal(profile.stdout, templateProfile);
    const prepared = f.run(f.args, { REAL_HOST_PREFLIGHT: '1' });
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    assert.ok(f.events().includes('manager preflight'));
    assert.ok(!f.events().includes('manager register'));
    assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
    f.commit();
    const activated = f.activate();
    assert.equal(activated.status, 0, activated.stdout + activated.stderr);
    assert.equal(fs.readlinkSync(path.join(f.runtime, 'current')), f.candidate);
    assert.equal(fs.readFileSync(f.coreState, 'utf8'), 'new\n');
    assert.ok(f.events().includes('manager register'));
  });
}
for (const [label, host] of [
  ['below-minimum OS', { osVersion: '6.11.9', apiVersion: '5.0.0' }],
  ['below-minimum API', { osVersion: '8.0.0', apiVersion: '4.25.2' }],
  [
    'missing dependencies on newer API',
    { osVersion: '8.0.0', apiVersion: '5.0.0', dependencies: {} },
  ],
  [
    'below-minimum dependency on newer API',
    { osVersion: '8.0.0', apiVersion: '5.0.0', dependency: '0.0.1' },
  ],
  [
    'invalid dependency on newer API',
    { osVersion: '8.0.0', apiVersion: '5.0.0', dependency: 'invalid' },
  ],
]) {
  test(`installer rejects ${label} before service or API mutation`, (t) => {
    const f = lifecycle(t, { previous: true });
    stageHostCompatibility(f.root, { managerRoot: f.stage, ...host });
    if (host.dependency)
      write(
        path.join(f.root, 'api/node_modules/@nestjs/common/package.json'),
        JSON.stringify({ version: host.dependency }),
      );
    const journal = path.join(
      f.root,
      'boot/plugins/unraid-deck-bridge/journal/operation.jsonl',
    );
    write(journal, '{"phase":"awaiting-recovery"}\n');
    f.sums();
    const result = f.run(f.args, { REAL_HOST_PREFLIGHT: '1' });
    assert.notEqual(result.status, 0);
    assert.ok(f.events().includes('manager preflight'));
    assertBeforeStop(f);
    assert.equal(fs.readFileSync(f.apiState, 'utf8'), 'running\n');
    assert.equal(fs.readFileSync(f.coreState, 'utf8'), 'old\n');
    assert.equal(
      fs.readFileSync(journal, 'utf8'),
      '{"phase":"awaiting-recovery"}\n',
    );
    const profile = spawnSync(
      process.execPath,
      [path.join(f.stage, 'manager.mjs'), 'template-profile'],
      { encoding: 'utf8' },
    );
    assert.equal(profile.status, 0, profile.stderr);
    assert.equal(profile.stdout, '');
  });
}
test('Core stop failure does not switch runtime, stop API or register modules', (t) => {
  const f = installation(t, { previous: true, fail: 'core-stop' });
  assert.notEqual(f.result.status, 0);
  assert.ok(
    !f.events.some(
      (event) =>
        event.startsWith('api ') ||
        event === 'manager register' ||
        event === 'newcore start',
    ),
  );
  assertOldState(f);
});
test('identical existing candidate is reused without replacing active Core inode', (t) => {
  const f = lifecycle(t);
  fs.cpSync(f.stage, f.candidate, { recursive: true });
  fs.symlinkSync(f.candidate, path.join(f.runtime, 'current'));
  const core = path.join(f.candidate, 'deck-bridge-core');
  const before = fs.statSync(core);
  assert.equal(f.run().status, 0);
  assert.equal(fs.statSync(core).ino, before.ino);
  assert.equal(fs.readFileSync(core, 'utf8'), 'new core bytes\n');
  assert.ok(
    fs.existsSync(f.stage),
    'caller retains ownership of unused staging',
  );
});
for (const conflict of ['changed', 'extra', 'missing', 'symlink']) {
  test(`existing candidate ${conflict} conflict preserves all old files`, (t) => {
    const f = lifecycle(t, { previous: true });
    fs.cpSync(f.stage, f.candidate, { recursive: true });
    if (conflict === 'changed')
      write(
        path.join(f.candidate, 'deck-bridge-core'),
        'retained conflicting core\n',
      );
    if (conflict === 'extra')
      write(path.join(f.candidate, 'extra'), 'retained extra\n');
    if (conflict === 'missing')
      fs.unlinkSync(path.join(f.candidate, 'health.sh'));
    if (conflict === 'symlink')
      fs.symlinkSync(f.moduleFile, path.join(f.candidate, 'linked'));
    const core = fs.readFileSync(path.join(f.candidate, 'deck-bridge-core'));
    assert.notEqual(f.run().status, 0);
    assertBeforeStop(f);
    assert.deepEqual(
      fs.readFileSync(path.join(f.candidate, 'deck-bridge-core')),
      core,
    );
    assert.ok(fs.existsSync(f.stage));
    if (conflict === 'extra')
      assert.equal(
        fs.readFileSync(path.join(f.candidate, 'extra'), 'utf8'),
        'retained extra\n',
      );
    if (conflict === 'symlink')
      assert.ok(
        fs.lstatSync(path.join(f.candidate, 'linked')).isSymbolicLink(),
      );
  });
}
test('two installation transactions contend on a real inherited descriptor lock', async (t) => {
  const f = lifecycle(t, { previous: true });
  const hold = path.join(f.root, 'hold');
  const ready = path.join(f.root, 'ready');
  write(hold, '');
  const first = spawn('/bin/bash', f.args, {
    env: { ...f.env, HOLD_FILE: hold, READY_FILE: ready },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  first.stdout.on('data', (data) => {
    output += data;
  });
  first.stderr.on('data', (data) => {
    output += data;
  });
  const done = new Promise((resolve, reject) => {
    first.once('error', reject);
    first.once('close', resolve);
  });
  t.after(() => {
    if (first.exitCode === null) first.kill('SIGKILL');
  });
  try {
    for (
      let i = 0;
      i < 500 && !fs.existsSync(ready) && first.exitCode === null;
      i++
    )
      await delay(20);
    assert.ok(
      fs.existsSync(ready),
      `first transaction acquired lock: ${output}`,
    );
    const secondStage = path.join(f.runtime, 'releases/.staging-second');
    fs.cpSync(f.stage, secondStage, { recursive: true });
    const before = f.events();
    assert.notEqual(
      f.run([f.args[0], secondStage, build, pluginVersion]).status,
      0,
    );
    assert.deepEqual(
      f.events(),
      before,
      'contending transaction never reaches preflight or service boundaries',
    );
    assertOldState(f);
    assert.ok(fs.existsSync(secondStage));
  } finally {
    fs.rmSync(hold, { force: true });
  }
  assert.equal(await done, 0, output);
  assertOldState(f);
});

function generatedPlugin(t) {
  const release = releaseFixture(t);
  const plg = path.join(release.root, 'unraid-deck-bridge.plg');
  const result = release.run(
    '--repository',
    'fixture/bridge',
    '--plg-out',
    plg,
  );
  assert.equal(result.status, 0, result.stderr);
  return { release, files: parsePlugin(plg).files };
}
for (const [name, changes, missing] of [
  ['arm64', { TEST_ARCH: 'aarch64' }],
  ['32-bit x86', { TEST_ARCH: 'i686' }],
  ['non-Linux', { TEST_OS: 'Darwin' }],
  ['Node non-x64', { TEST_NODE_ARCH: 'arm64' }],
  ['missing Node', {}, 'node'],
  ['missing official API', {}, 'unraid-api'],
]) {
  test(`generated PLG rejects ${name} before resource download or install`, (t) => {
    const { files } = generatedPlugin(t);
    const f = lifecycle(t, { previous: true });
    if (missing) fs.unlinkSync(path.join(f.bin, missing));
    const preflight = path.join(f.root, 'preflight.sh');
    write(preflight, f.rewrite(files[0].INLINE));
    const result = f.run([preflight], changes);
    // Official FILE order gates the resource phase on this failure.
    const cache = f.rewrite(files[1].attributes.Name);
    if (result.status === 0) {
      write(f.log, 'download\n');
      assert.fail('preflight incorrectly permitted resource download');
    }
    assert.ok(!fs.existsSync(cache));
    assert.deepEqual(f.events(), []);
    assertOldState(f);
  });
}
test('generated install INLINE rejects a corrupt cached archive before service changes', (t) => {
  const { files } = generatedPlugin(t);
  const f = lifecycle(t, { previous: true });
  write(f.rewrite(files[1].attributes.Name), 'corrupt archive bytes');
  const inline = path.join(f.root, 'inline.sh');
  write(inline, f.rewrite(files[2].INLINE));
  assert.notEqual(f.run([inline]).status, 0);
  assertBeforeStop(f);
  assert.ok(!fs.existsSync(f.candidate));
});
test('generated install INLINE runs real installer and rejects manager preflight before stopping services', (t) => {
  const f = lifecycle(t, { previous: true, fail: 'preflight' });
  const release = releaseFixture(t);
  write(
    path.join(release.root, 'packaging/install.sh'),
    f.rewrite(fs.readFileSync(path.join(repo, 'packaging/install.sh'), 'utf8')),
  );
  const plg = path.join(release.root, 'unraid-deck-bridge.plg');
  const result = release.run(
    '--repository',
    'fixture/bridge',
    '--plg-out',
    plg,
  );
  assert.equal(result.status, 0, result.stderr);
  const files = parsePlugin(plg).files;
  const archive = fs
    .readdirSync(path.join(release.root, 'out'))
    .find((name) => name.endsWith('.tar.gz'));
  write(
    f.rewrite(files[1].attributes.Name),
    fs.readFileSync(path.join(release.root, 'out', archive)),
  );
  const inline = path.join(f.root, 'inline-preflight.sh');
  write(inline, f.rewrite(files[2].INLINE));
  const installed = f.run([inline]);
  assert.notEqual(installed.status, 0);
  assert.ok(
    f.events().includes('manager preflight'),
    'archive was authenticated, extracted, and real installer reached preflight: ' +
      installed.stdout +
      installed.stderr,
  );
  assertBeforeStop(f);
  assert.deepEqual(
    fs
      .readdirSync(path.join(f.runtime, 'releases'))
      .filter((name) => name.startsWith('.staging-')),
    ['.staging-fixture'],
    'EXIT trap cleans only its own staging',
  );
});
for (const missingRuntime of [false, true]) {
  test(`generated PLG removes Bridge-owned state ${missingRuntime ? 'without runtime payload' : 'with installed runtime'}`, (t) => {
    const { files } = generatedPlugin(t);
    const f = lifecycle(t, { previous: true });
    fs.mkdirSync(path.join(f.root, 'process-table'), { recursive: true });
    const owned = (suffix = '') =>
      path.join(f.root, 'boot/plugins/unraid-deck-bridge', suffix);
    const config = path.join(
      f.root,
      'boot/plugins/dynamix.my.servers/configs/api.json',
    );
    const metadata = path.join(f.root, 'api/package.json');
    write(
      metadata,
      JSON.stringify({
        name: 'official-api',
        dependencies: { official: '1', 'unraid-deck-bridge': '0.6.0' },
        unrelated: { keep: true },
      }),
    );
    write(
      config,
      JSON.stringify({
        plugins: ['official', 'unraid-deck-bridge', 'another-plugin'],
        unrelated: { keep: true },
      }),
    );
    write(
      path.join(f.root, 'api/node_modules/unraid-deck-bridge/index.js'),
      'Bridge adapter\n',
    );
    write(
      path.join(f.root, 'api/node_modules/official/index.js'),
      'official\n',
    );
    for (const name of [
      'settings.json',
      'state/tasks/journal',
      'backups/old',
      'packages/cache.tar.gz',
    ])
      write(owned(name), 'Bridge-owned\n');
    write(path.join(f.root, 'service.log'), 'Bridge log\n');
    write(
      path.join(f.rewrite('/tmp/unraid-deck-bridge'), 'diagnostic'),
      'Bridge tmp\n',
    );
    const business = [
      'docker/containers/example',
      'docker/images/example',
      'docker/volumes/example',
      'boot/config/plugins/dockerMan/templates-user/example.xml',
      'boot/plugins/another-plugin/settings.json',
    ].map((name) => path.join(f.root, name));
    for (const file of business) write(file, 'user-owned\n');
    const persistent = path.join(f.root, 'boot/plugins/unraid-deck-bridge.plg');
    const registration = path.join(
      f.root,
      'log/plugins/unraid-deck-bridge.plg',
    );
    write(persistent, 'official persistent PLG\n');
    fs.mkdirSync(path.dirname(registration), { recursive: true });
    fs.symlinkSync(persistent, registration);
    // The official manager unlinks registration before executing remove INLINE.
    fs.unlinkSync(registration);
    if (missingRuntime) {
      fs.rmSync(f.runtime, { recursive: true });
      fs.unlinkSync(f.service);
    }
    const http = removalHTTP(t, f.root);
    const remove = path.join(f.root, 'remove-inline.sh');
    write(
      remove,
      f
        .rewrite(files[3].INLINE)
        .replace(
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
        ),
    );
    const result = f.run([remove]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    for (const file of [
      owned(),
      f.runtime,
      f.service,
      path.join(f.root, 'run'),
      path.join(f.root, 'service.log'),
      f.rewrite('/tmp/unraid-deck-bridge'),
      path.join(f.root, 'api/node_modules/unraid-deck-bridge'),
    ])
      assert.ok(!fs.existsSync(file), `Bridge residue removed: ${file}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(metadata)), {
      name: 'official-api',
      dependencies: { official: '1' },
      unrelated: { keep: true },
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(config)), {
      plugins: ['official', 'another-plugin'],
      unrelated: { keep: true },
    });
    assert.equal(
      fs.readFileSync(
        path.join(f.root, 'api/node_modules/official/index.js'),
        'utf8',
      ),
      'official\n',
    );
    for (const file of business)
      assert.equal(fs.readFileSync(file, 'utf8'), 'user-owned\n');
    const hook = f.rewrite(
      '/usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/unraid-deck-bridge-remove',
    );
    assert.ok(fs.existsSync(persistent), 'manager still owns persistent PLG');
    const archived = path.join(
      f.root,
      'boot/plugins-removed/unraid-deck-bridge.plg',
    );
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(persistent, archived);
    const post = f.run([hook, 'plugin', 'remove', 'unraid-deck-bridge.plg']);
    assert.equal(post.status, 0, post.stdout + post.stderr);
    assert.ok(http.requests().length > 0);
    for (const request of http.requests()) {
      assert.equal(request.authenticated, true);
      assert.equal(request.url, '/graphql');
      assert.doesNotMatch(request.query, /__schema|__type/);
    }
    assert.ok(!fs.existsSync(archived));
    assert.ok(!fs.existsSync(hook));
  });
}
test('legacy 0.1.1 adapter upgrade and rollback preserve task recovery and unrelated metadata', (t) => {
  const root = fixture(t);
  const api = path.join(root, 'api'),
    config = path.join(
      root,
      'boot/plugins/dynamix.my.servers/configs/api.json',
    ),
    runtime = path.join(root, 'runtime');
  const name = 'unraid-deck-bridge',
    poc = 'unraid-deck-bridge-poc';
  write(
    path.join(api, 'package.json'),
    JSON.stringify({
      version: '4.36.1+f3205d97',
      dependencies: { official: '1', [poc]: '0.0.1' },
      peerDependencies: { [name]: '0.1.1' },
    }),
  );
  write(
    config,
    JSON.stringify({ plugins: ['official', poc, name], sandbox: true }),
  );
  const adapter = path.join(api, 'node_modules', name);
  const legacyFiles = {
    'index.js': 'export const capturedVersion = "0.1.1";\n',
    'package.json': JSON.stringify({ name, version: '0.1.1', type: 'module' }),
    'core-client.js': 'export const legacy = true;\n',
    'runtime.types.js': 'export const legacyType = true;\n',
    'configuration-feedback.js': 'export const legacyFeedback = true;\n',
    'check-host.js': 'export const legacyHost = true;\n',
    'compatibility.json': '{"legacy":true}\n',
  };
  for (const [file, bytes] of Object.entries(legacyFiles))
    write(path.join(adapter, file), bytes);
  const state = path.join(root, 'boot/plugins/unraid-deck-bridge');
  const preserved = {
    'tasks/task-docker-42.json': JSON.stringify({
      id: 'task-docker-42',
      state: 'running',
    }),
    'journal/docker.jsonl': '{"taskId":"task-docker-42","phase":"pulling"}\n',
    'recovery/pending.json': JSON.stringify({
      taskId: 'task-docker-42',
      candidate: 'container-42',
      phase: 'awaiting-recovery',
    }),
  };
  for (const [file, bytes] of Object.entries(preserved))
    write(path.join(state, file), bytes);
  write(path.join(root, 'unraid-version'), 'version="7.3.2"');
  write(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const candidate = path.join(root, 'candidate');
  for (const f of [
    'index.js',
    'runtime.types.js',
    'configuration-feedback.js',
    'core-client.js',
    'check-host.js',
    'compatibility.json',
    'package.json',
  ])
    write(path.join(candidate, 'adapter', f), '{}');
  const metadata = path.join(candidate, 'adapter/package.json');
  const version = '2026.10.2901';
  const packageBytes = JSON.stringify({
    name,
    version,
    type: 'module',
    main: 'index.js',
    license: 'GPL-2.0-only',
  });
  write(metadata, packageBytes);
  write(
    path.join(candidate, 'adapter/release.json'),
    JSON.stringify({ version: '2026.10.29a' }),
  );
  for (const dest of [candidate, root])
    write(
      path.join(dest, 'adapter/release-version.mjs'),
      fs.readFileSync(
        path.join(repo, 'api-extension/release-version.mjs'),
        'utf8',
      ),
    );
  let script = rewriteHostPaths(
    fs.readFileSync(path.join(repo, 'packaging/manager.mjs'), 'utf8'),
    root,
  );
  for (const file of ['check-host.js', 'compatibility.json'])
    write(
      path.join(root, 'adapter', file),
      fs.readFileSync(path.join(repo, 'dist', file)),
    );
  const matrix = JSON.parse(
    fs.readFileSync(path.join(repo, 'contracts/compatibility.json')),
  );
  for (const [name, version] of Object.entries(matrix.minimumDependencies))
    write(
      path.join(api, 'node_modules', name, 'package.json'),
      JSON.stringify({ version }),
    );
  script = script.replace(/arch:\s*process\.arch/, "arch:'x64'");
  const file = path.join(root, 'manager.mjs');
  write(file, script);
  const backup = path.join(root, 'backup');
  const command = (...args) =>
    spawnSync(process.execPath, [file, ...args], {
      encoding: 'utf8',
    });
  const run = (...args) => {
    const r = command(...args);
    assert.equal(r.status, 0, r.stderr);
  };
  run('backup', backup);
  assert.ok(!fs.existsSync(path.join(backup, 'adapter/release.json')));
  assert.ok(!fs.existsSync(path.join(backup, 'adapter/release-version.mjs')));
  run('register', candidate);
  let pkg = JSON.parse(fs.readFileSync(path.join(api, 'package.json')));
  assert.equal(pkg.peerDependencies[name], version);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(adapter, 'release.json'))).version,
    '2026.10.29a',
  );
  for (const [file, bytes] of Object.entries(preserved))
    assert.equal(fs.readFileSync(path.join(state, file), 'utf8'), bytes);
  assert.equal(pkg.dependencies[poc], '0.0.1');
  const beforeCurrent = [
    fs.readFileSync(path.join(api, 'package.json'), 'utf8'),
    fs.readFileSync(config, 'utf8'),
  ];
  assert.notEqual(
    command('check').status,
    0,
    'check requires selected runtime metadata',
  );
  assert.deepEqual(
    [
      fs.readFileSync(path.join(api, 'package.json'), 'utf8'),
      fs.readFileSync(config, 'utf8'),
    ],
    beforeCurrent,
  );
  fs.mkdirSync(runtime, { recursive: true });
  fs.symlinkSync(candidate, path.join(runtime, 'current'));
  run('check');
  const apiPackage = path.join(api, 'package.json');
  const snapshot = () => [
    fs.readFileSync(apiPackage, 'utf8'),
    fs.readFileSync(config, 'utf8'),
  ];
  const unchangedFailure = (...args) => {
    const before = snapshot();
    assert.notEqual(command(...args).status, 0);
    assert.deepEqual(
      snapshot(),
      before,
      'failed checks leave official metadata intact',
    );
  };
  pkg.peerDependencies[name] = '8.12.35';
  write(apiPackage, JSON.stringify(pkg));
  unchangedFailure('check');
  pkg.peerDependencies[name] = version;
  write(apiPackage, JSON.stringify(pkg));
  for (const file of ['index.js', 'release.json', 'release-version.mjs']) {
    const installed = path.join(adapter, file);
    write(installed, 'different registered adapter');
    unchangedFailure('check');
    fs.copyFileSync(path.join(candidate, 'adapter', file), installed);
  }
  for (const invalid of [
    '{}',
    '{"version":null}',
    '{"version":123}',
    '{"version":""}',
    '{"version":"invalid"}',
    JSON.stringify({ version: version + '\n' }),
    '{',
  ]) {
    write(metadata, invalid);
    unchangedFailure('register', candidate);
    unchangedFailure('check');
  }
  fs.unlinkSync(metadata);
  unchangedFailure('register', candidate);
  unchangedFailure('check');
  // Both absent values must not accidentally pass equality.
  delete pkg.peerDependencies[name];
  write(apiPackage, JSON.stringify(pkg));
  write(metadata, '{}');
  unchangedFailure('check');
  write(metadata, packageBytes);
  pkg.peerDependencies[name] = version;
  write(apiPackage, JSON.stringify(pkg));
  run('check');
  pkg.dependencies[poc] = '0.0.2';
  pkg.dependencies.unrelated = '2';
  write(path.join(api, 'package.json'), JSON.stringify(pkg));
  let cfg = JSON.parse(fs.readFileSync(config));
  cfg.plugins.push('unrelated');
  write(config, JSON.stringify(cfg));
  run('restore', backup);
  pkg = JSON.parse(fs.readFileSync(path.join(api, 'package.json')));
  cfg = JSON.parse(fs.readFileSync(config));
  assert.equal(pkg.dependencies.unrelated, '2');
  assert.equal(pkg.dependencies[poc], '0.0.2');
  assert.equal(pkg.peerDependencies[name], '0.1.1');
  assert.ok(cfg.plugins.includes('unrelated'));
  assert.ok(cfg.plugins.includes(poc));
  assert.ok(cfg.plugins.includes(name));
  assert.deepEqual(
    fs.readdirSync(adapter).sort(),
    Object.keys(legacyFiles).sort(),
  );
  for (const [file, bytes] of Object.entries(legacyFiles))
    assert.equal(fs.readFileSync(path.join(adapter, file), 'utf8'), bytes);
  for (const [file, bytes] of Object.entries(preserved))
    assert.equal(fs.readFileSync(path.join(state, file), 'utf8'), bytes);
  assert.equal(cfg.sandbox, true);
  const sensitive = 'private-admin-token-never-log';
  write(metadata, `{"version": "${sensitive}", invalid}`);
  const malformed = command('register', candidate);
  assert.notEqual(malformed.status, 0);
  assert.ok(
    !malformed.stderr.includes(sensitive),
    'JSON diagnostics must not echo sensitive fragments',
  );
  write(metadata, packageBytes);
  for (const [version, expected] of [
    ['6.12.0', 'DOCKERMAN_CLASSIC_NETWORK'],
    ['6.12.14', 'DOCKERMAN_CLASSIC_NETWORK'],
    ['7.3.20', 'DOCKERMAN_ENDPOINT_NETWORK'],
  ]) {
    write(path.join(root, 'unraid-version'), `version="${version}"`);
    run('preflight');
    const template = spawnSync(process.execPath, [file, 'template-profile'], {
      encoding: 'utf8',
    });
    assert.equal(template.status, 0, template.stderr);
    assert.equal(template.stdout, expected);
  }
  write(path.join(root, 'unraid-version'), 'version="6.11.9"');
  const unsupported = spawnSync(process.execPath, [file, 'preflight'], {
    encoding: 'utf8',
  });
  assert.notEqual(
    unsupported.status,
    0,
    'must reject OS versions below 6.12.0',
  );
});
