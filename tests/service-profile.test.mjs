import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  rewriteHostPaths,
  stageHostCompatibility,
} from './helpers/lifecycle.mjs';
const repo = new URL('../', import.meta.url);
function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-profile-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function write(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { mode });
}
test('manager emits only supported known template dialects without an audit-source flag', (t) => {
  const root = fixture(t),
    version = path.join(root, 'unraid-version'),
    file = path.join(root, 'manager.mjs');
  write(version, 'fixture');
  write(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const script = rewriteHostPaths(
    fs.readFileSync(new URL('packaging/manager.mjs', repo), 'utf8'),
    root,
  ).replace(
    /import \{\s*assertSupportedHost\s*\} from '\.\/adapter\/check-host\.js';/,
    "const assertSupportedHost=()=>{const h=JSON.parse(process.env.HOST_REPORT);if(h.fail)throw new Error('unsupported');return h;};",
  );
  write(file, script);
  write(
    path.join(root, 'adapter/release-version.mjs'),
    fs.readFileSync(new URL('api-extension/release-version.mjs', repo), 'utf8'),
  );
  for (const [report, expected] of [
    [
      {
        dockerWriteSupported: true,
        templateProfile: 'DOCKERMAN_CLASSIC_NETWORK',
      },
      'DOCKERMAN_CLASSIC_NETWORK',
    ],
    [
      {
        dockerWriteSupported: true,
        templateProfile: 'DOCKERMAN_ENDPOINT_NETWORK',
      },
      'DOCKERMAN_ENDPOINT_NETWORK',
    ],
    [
      {
        dockerWriteSupported: false,
        templateProfile: 'DOCKERMAN_ENDPOINT_NETWORK',
      },
      '',
    ],
    [{ dockerWriteSupported: true, templateProfile: 'UNKNOWN' }, ''],
    [{ dockerWriteSupported: true }, ''],
    [{ dockerWriteSupported: true, templateProfile: null }, ''],
    [{ dockerWriteSupported: true, templateProfile: false }, ''],
    [{ dockerWriteSupported: true, templateProfile: 1 }, ''],
    [{ templateProfile: 'DOCKERMAN_ENDPOINT_NETWORK' }, ''],
    [{ fail: true }, ''],
  ]) {
    const result = spawnSync(process.execPath, [file, 'template-profile'], {
      encoding: 'utf8',
      env: { ...process.env, HOST_REPORT: JSON.stringify(report) },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, expected);
  }
});
function supervisorFixture(t) {
  const root = fixture(t);
  const release = path.join(root, 'runtime/releases/fixture');
  const persisted = path.join(root, 'boot/plugins/unraid-deck-bridge.plg');
  const registered = path.join(root, 'log/plugins/unraid-deck-bridge.plg');
  fs.mkdirSync(release, { recursive: true });
  fs.symlinkSync(release, path.join(root, 'runtime/current'));
  write(persisted, '<PLUGIN name="unraid-deck-bridge" version="2026.10.27"/>');
  fs.mkdirSync(path.dirname(registered), { recursive: true });
  fs.symlinkSync(persisted, registered);
  write(
    path.join(release, 'deck-bridge-core'),
    '#!/bin/sh\necho started >> "$CALLS"\nrm -f "$REGISTERED"\nexit 1\n',
    0o755,
  );
  write(
    path.join(release, 'manager.mjs'),
    'if(process.argv[2] === "template-profile") process.stdout.write("DOCKERMAN_CLASSIC_NETWORK");',
  );
  const bin = path.join(root, 'bin');
  write(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n', 0o755);
  write(path.join(bin, 'sleep'), '#!/bin/sh\n/bin/sleep 0.03\n', 0o755);
  const script = path.join(root, 'service.sh');
  let source = rewriteHostPaths(
    fs.readFileSync(new URL('packaging/rc.unraid-deck-bridge', repo), 'utf8'),
    root,
  );
  source = source
    .replaceAll('node ', JSON.stringify(process.execPath) + ' ')
    .replaceAll('flock ', JSON.stringify(path.join(bin, 'flock')) + ' ')
    .replaceAll('sleep ', JSON.stringify(path.join(bin, 'sleep')) + ' ');
  write(script, source);
  const run = (mode) => {
    const result = spawnSync('/bin/bash', [script, mode], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        CALLS: path.join(root, 'calls'),
        REGISTERED: registered,
      },
    });
    assert.ifError(result.error);
    return result;
  };
  return { root, release, persisted, registered, run };
}
for (const mode of ['start', 'supervise']) {
  test(`${mode} refuses missing native registration before creating run or logs`, (t) => {
    const f = supervisorFixture(t);
    fs.unlinkSync(f.registered);
    assert.notEqual(f.run(mode).status, 0);
    for (const name of ['run', 'service.log', 'calls'])
      assert.equal(fs.existsSync(path.join(f.root, name)), false);
  });
}
test('supervisor stops instead of restarting Core after registration disappears', (t) => {
  const f = supervisorFixture(t);
  fs.mkdirSync(path.join(f.root, 'run'));
  const result = f.run('supervise');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    fs.readFileSync(path.join(f.root, 'calls'), 'utf8'),
    'started\n',
  );
});
for (const [osVersion, apiVersion, expected] of [
  ['7.2.4', '4.25.3', 'DOCKERMAN_CLASSIC_NETWORK'],
  ['8.0.0', '5.0.0', 'DOCKERMAN_ENDPOINT_NETWORK'],
]) {
  test(`supervisor hands the real minimum-selected ${expected} dialect to Core`, (t) => {
    const f = supervisorFixture(t);
    stageHostCompatibility(f.root, {
      managerRoot: f.release,
      osVersion,
      apiVersion,
    });
    write(
      path.join(f.release, 'deck-bridge-core'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$CALLS"\nrm -f "$REGISTERED"\nexit 1\n',
      0o755,
    );
    fs.mkdirSync(path.join(f.root, 'run'));
    const result = f.run('supervise');
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const args = fs
      .readFileSync(path.join(f.root, 'calls'), 'utf8')
      .trim()
      .split('\n');
    assert.deepEqual(args.slice(-2), ['--template-profile', expected]);
  });
}
test('rc stop reports damaged runtime instead of pretending Core is stopped', (t) => {
  const f = supervisorFixture(t);
  const result = f.run('stop');
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'run')), false);
});
