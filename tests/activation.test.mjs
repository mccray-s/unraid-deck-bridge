import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lifecycle } from './helpers/lifecycle.mjs';

function prepared(t, options = {}) {
  const f = lifecycle(t, { previous: true, ...options });
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return f;
}
function oldRuntime(f) {
  assert.equal(
    fs.readlinkSync(path.join(f.runtime, 'current')),
    path.join(f.runtime, 'releases/previous'),
  );
  assert.ok(fs.readFileSync(f.service, 'utf8').includes('oldcore'));
  assert.equal(fs.readFileSync(f.coreState, 'utf8'), 'old\n');
}
function untouchedAPI(f) {
  assert.equal(fs.readFileSync(f.moduleFile, 'utf8'), 'official-old\n');
  assert.equal(fs.readFileSync(f.apiState, 'utf8'), 'running\n');
}
for (const previous of [false, true]) {
  test(`prepare only stages candidate and schedules activation (${previous ? 'update' : 'first install'})`, (t) => {
    const f = prepared(t, { previous });
    assert.deepEqual(f.events(), ['manager preflight', 'schedule']);
    untouchedAPI(f);
    if (previous) oldRuntime(f);
    else {
      assert.ok(!fs.existsSync(path.join(f.runtime, 'current')));
      assert.ok(!fs.existsSync(f.service));
      assert.equal(fs.readFileSync(f.coreState, 'utf8'), 'stopped\n');
    }
    const backup = f.activationArgs().at(-3);
    assert.deepEqual(fs.readdirSync(backup), []);
  });
  test(`schedule failure leaves runtime untouched (${previous ? 'update' : 'first install'})`, (t) => {
    const f = lifecycle(t, { previous, fail: 'schedule' });
    assert.notEqual(f.run().status, 0);
    assert.deepEqual(f.events(), ['manager preflight', 'schedule']);
    untouchedAPI(f);
    if (previous) oldRuntime(f);
    else
      assert.ok(
        !fs.existsSync(f.service) &&
          !fs.existsSync(path.join(f.runtime, 'current')),
      );
  });
}
for (const guard of [
  'no registration',
  'wrong version',
  'wrong target',
  'superseded current',
  'no lock',
  'wrong lock',
  'redirected rc',
  'redirected previous',
]) {
  test(`activation rejects ${guard} without runtime or API mutation`, (t) => {
    const f = prepared(t);
    if (guard !== 'no registration') f.commit();
    if (guard === 'wrong version')
      fs.writeFileSync(
        path.join(f.root, 'boot/plugins/unraid-deck-bridge.plg'),
        '<PLUGIN name="unraid-deck-bridge" version="2020.01.01.0001"/>',
      );
    if (guard === 'wrong target') {
      const registered = path.join(
        f.root,
        'log/plugins/unraid-deck-bridge.plg',
      );
      fs.unlinkSync(registered);
      fs.symlinkSync(f.moduleFile, registered);
    }
    if (guard === 'superseded current') {
      fs.unlinkSync(path.join(f.runtime, 'current'));
      fs.symlinkSync(f.candidate, path.join(f.runtime, 'current'));
    }
    if (guard === 'redirected rc') {
      fs.renameSync(
        path.dirname(f.service),
        path.join(f.root, 'redirected-rc'),
      );
      fs.symlinkSync(
        path.join(f.root, 'redirected-rc'),
        path.dirname(f.service),
      );
    }
    if (guard === 'redirected previous') {
      const previous = path.join(f.runtime, 'releases/previous');
      fs.renameSync(previous, path.join(f.root, 'redirected-previous'));
      fs.symlinkSync(path.join(f.root, 'redirected-previous'), previous);
    }
    const before = f.events();
    const args = f.activationArgs();
    if (guard === 'wrong lock') args[3] = path.join(f.root, 'unrelated.lock');
    const result = f.run(guard === 'no lock' ? args.slice(4) : args);
    assert.notEqual(result.status, 0);
    assert.deepEqual(f.events(), before);
    untouchedAPI(f);
    assert.equal(fs.readFileSync(f.coreState, 'utf8'), 'old\n');
  });
}
test('activation snapshots actual old rc, switches runtime and checks Core before touching API', (t) => {
  const f = prepared(t);
  fs.appendFileSync(f.service, '# changed after preparation\n');
  const actualService = fs.readFileSync(f.service, 'utf8');
  f.commit();
  const result = f.activate({ API_FLUSH_VALUE: 'shutdown-flushed' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.readlinkSync(path.join(f.runtime, 'current')), f.candidate);
  assert.equal(fs.readFileSync(f.coreState, 'utf8'), 'new\n');
  assert.deepEqual(f.events(), [
    'manager preflight',
    'schedule',
    'stop-only old',
    'newcore start',
    'api stop',
    'manager backup',
    'manager register',
    'import',
    'api plugins install unraid-deck-bridge --bundled --no-restart',
    'api start',
  ]);
  const backup = f.activationArgs().at(-3);
  assert.equal(
    fs.readFileSync(path.join(backup, 'module'), 'utf8'),
    'shutdown-flushed\n',
  );
  assert.equal(
    fs.readFileSync(path.join(backup, 'service'), 'utf8'),
    actualService,
  );
});
test('old Core stop failure preserves old runtime without API mutation or restart', (t) => {
  const f = prepared(t);
  f.commit();
  assert.notEqual(f.activate({ FAIL_AT: 'core-stop' }).status, 0);
  oldRuntime(f);
  untouchedAPI(f);
  assert.deepEqual(f.events(), [
    'manager preflight',
    'schedule',
    'stop-only old',
  ]);
});
for (const previous of [false, true]) {
  for (const fail of [
    'core-start',
    'core-health',
    'api-stop',
    'backup',
    'register',
    'import',
    'plugins',
    'start-once',
    'health',
  ]) {
    test(`activation ${fail} failure recovers ${previous ? 'old runtime' : 'absent runtime'} and retains native commit`, (t) => {
      const f = prepared(t, { previous });
      f.commit();
      const result = f.activate({ FAIL_AT: fail });
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      if (previous) oldRuntime(f);
      else {
        assert.ok(!fs.existsSync(path.join(f.runtime, 'current')));
        assert.ok(!fs.existsSync(f.service));
        assert.equal(fs.readFileSync(f.coreState, 'utf8'), 'stopped\n');
      }
      untouchedAPI(f);
      const apiReached = !['core-start', 'core-health'].includes(fail);
      assert.equal(f.events().includes('api start'), apiReached);
      assert.equal(
        f.events().includes('manager restore'),
        !['core-start', 'core-health', 'api-stop', 'backup'].includes(fail),
      );
      assert.ok(fs.existsSync(f.candidate));
      assert.ok(
        fs.existsSync(path.join(f.root, 'boot/plugins/unraid-deck-bridge.plg')),
      );
    });
  }
}
test('failed activation retains live candidate and recovery files when candidate refuses to drain', (t) => {
  const f = prepared(t);
  f.commit();
  const result = f.activate({ FAIL_AT: 'health', FAIL_CORE_STOP: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Recovery incomplete/);
  assert.equal(fs.readlinkSync(path.join(f.runtime, 'current')), f.candidate);
  assert.equal(fs.readFileSync(f.coreState, 'utf8'), 'new\n');
  assert.ok(fs.readFileSync(f.service, 'utf8').includes('newcore'));
  assert.ok(!f.events().includes('oldcore start'));
  assert.ok(fs.existsSync(path.join(f.activationArgs().at(-3), 'service')));
  assert.ok(f.events().includes('api start'));
});
