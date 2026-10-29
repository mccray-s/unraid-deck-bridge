import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lifecycle, pluginVersion } from './helpers/lifecycle.mjs';
import { repo, write } from './helpers/release.mjs';

function fixture(t, state) {
  const f = lifecycle(t);
  fs.renameSync(f.stage, f.candidate);
  fs.symlinkSync(f.candidate, path.join(f.runtime, 'current'));
  f.commit();
  write(
    path.join(f.candidate, 'post-install.mjs'),
    f.rewrite(
      fs
        .readFileSync(path.join(repo, 'packaging/post-install.mjs'), 'utf8')
        .replaceAll(
          '/usr/local/sbin/plugin',
          path.join(f.root, 'native-plugin'),
        ),
    ),
  );
  const repair = path.join(f.root, 'repair.sh');
  write(
    repair,
    f.rewrite(fs.readFileSync(path.join(repo, 'packaging/repair.sh'), 'utf8')),
  );
  write(path.join(f.bin, 'node'), '#!/bin/sh\nexec "$REAL_NODE" "$@"\n', 0o755);
  // Model a missing API registration; real repair must not act until activation is READY.
  write(
    path.join(f.candidate, 'manager.mjs'),
    `import fs from 'node:fs';
if (process.argv[2] === 'check') process.exit(process.env.DISK_CURRENT === '1' ? 0 : 1);
if (process.argv[2] === 'register') {
  if (fs.readFileSync(process.env.API_STATE, 'utf8') !== 'stopped\\n') process.exit(2);
  fs.writeFileSync(process.env.MODULE_FILE, 'repaired\\n');
}
`,
  );
  const run = path.join(f.root, 'run');
  const token = 'post-install-repair';
  const dir = path.join(run, token);
  write(path.join(run, 'install.lock'), '');
  write(path.join(run, 'activation-job'), token);
  write(path.join(dir, 'owner'), token);
  const fingerprint = [
    path.join(f.root, 'log/plugins/unraid-deck-bridge.plg'),
    path.join(f.root, 'boot/plugins/unraid-deck-bridge.plg'),
  ]
    .map((file) => {
      const stat = fs.lstatSync(file, { bigint: true });
      return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    })
    .join('/');
  const lock = fs.lstatSync(path.join(run, 'install.lock'), { bigint: true });
  write(path.join(dir, 'registration.json'), JSON.stringify({ fingerprint }));
  write(
    path.join(dir, 'job.json'),
    JSON.stringify({
      dir,
      token,
      candidate: f.candidate,
      version: pluginVersion,
      before: null,
      lock: `${lock.dev}:${lock.ino}`,
    }),
  );
  write(path.join(dir, 'status.json'), JSON.stringify({ state }));
  return { f, run: (env = {}) => f.run([repair], env) };
}

for (const state of ['PENDING', 'FAILED']) {
  test(`automatic repair cannot interrupt API while activation is ${state}`, (t) => {
    const { f, run } = fixture(t, state);
    const result = run();
    assert.equal(result.status, 75, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(f.apiState, 'utf8'), 'running\n');
    assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
    assert.deepEqual(f.events(), []);
  });
}

test('automatic repair restores missing registration only after successful activation', (t) => {
  const { f, run } = fixture(t, 'READY');
  const result = run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(f.apiState, 'utf8'), 'running\n');
  assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'repaired\n');
  assert.deepEqual(f.events(), [
    'api stop',
    'api plugins install unraid-deck-bridge --bundled --no-restart',
    'api start',
  ]);
});

test('repair restarts the API after a stop command fails after stopping it', (t) => {
  const { f, run } = fixture(t, 'READY');
  const result = run({ FAIL_AT: 'api-stop' });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(f.apiState, 'utf8'), 'running\n');
  assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
  assert.deepEqual(f.events(), ['api stop', 'api start']);
});

for (const invalid of [
  'current',
  'registration',
  'selection',
  'lock',
  'removed-run',
]) {
  test(`repair refuses ${invalid} without recreating lifecycle state or changing API`, (t) => {
    const { f, run } = fixture(t, 'READY');
    const lifecycleRun = path.join(f.root, 'run');
    if (invalid === 'current') fs.unlinkSync(path.join(f.runtime, 'current'));
    if (invalid === 'registration')
      fs.unlinkSync(path.join(f.root, 'log/plugins/unraid-deck-bridge.plg'));
    if (invalid === 'selection')
      fs.unlinkSync(path.join(lifecycleRun, 'activation-job'));
    if (invalid === 'lock') {
      fs.renameSync(
        path.join(lifecycleRun, 'install.lock'),
        path.join(lifecycleRun, 'retired.lock'),
      );
      write(path.join(lifecycleRun, 'install.lock'), '');
    }
    if (invalid === 'removed-run') fs.rmSync(lifecycleRun, { recursive: true });
    const result = run();
    assert.equal(result.status, 75, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(f.apiState, 'utf8'), 'running\n');
    assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
    if (invalid === 'removed-run')
      assert.equal(fs.existsSync(lifecycleRun), false);
  });
}

test('ready loaded runtime with Core offline requires no API repair', (t) => {
  const { f, run } = fixture(t, 'READY');
  write(f.coreState, 'stopped\n');
  const result = run({ DISK_CURRENT: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(f.apiState, 'utf8'), 'running\n');
  assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
  assert.deepEqual(f.events(), []);
});

test('unknown runtime defers repair without touching API', (t) => {
  const { f, run } = fixture(t, 'READY');
  const result = run({ RUNTIME_UNKNOWN: '1' });
  assert.equal(result.status, 75, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(f.apiState, 'utf8'), 'running\n');
  assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
  assert.deepEqual(f.events(), []);
});

test('failed runtime reload is a repair failure rather than an unlimited startup deferral', (t) => {
  const { f, run } = fixture(t, 'READY');
  const result = run({
    DISK_CURRENT: '1',
    RUNTIME_MISSING: '1',
    FAIL_RELOAD: '1',
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
  assert.equal(f.events().filter((event) => event === 'api stop').length, 1);
  assert.equal(f.events().filter((event) => event === 'api start').length, 1);
});

test('missing loaded runtime reloads once while preserving correct registration', (t) => {
  const { f, run } = fixture(t, 'READY');
  const result = run({ DISK_CURRENT: '1', RUNTIME_MISSING: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
  assert.equal(f.events().filter((event) => event === 'api stop').length, 1);
  assert.equal(f.events().filter((event) => event === 'api start').length, 1);
  assert.ok(!f.events().some((event) => event.includes('plugins install')));
});
