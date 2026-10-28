import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rewriteHostPaths } from './helpers/lifecycle.mjs';
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
test('manager emits only a verified known template profile without disabling other domains', (t) => {
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
  write(
    persisted,
    '<PLUGIN name="unraid-deck-bridge" version="2026.10.27.0001"/>',
  );
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
test('rc stop reports damaged runtime instead of pretending Core is stopped', (t) => {
  const f = supervisorFixture(t);
  const result = f.run('stop');
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'run')), false);
});
test('health uses adjacent package version and accepts healthy Core without Docker or array availability', (t) => {
  const root = fixture(t),
    bin = path.join(root, 'bin'),
    file = path.join(root, 'release/health.sh'),
    metadata = path.join(root, 'release/adapter/package.json'),
    calls = path.join(root, 'calls');
  write(
    file,
    rewriteHostPaths(
      fs.readFileSync(new URL('packaging/health.sh', repo), 'utf8'),
      root,
    ),
  );
  write(
    path.join(bin, 'curl'),
    '#!/bin/sh\necho "$*" >> "$CALLS"\ncase "$*" in *graphql*) printf "%s" "$GRAPHQL" ;; *) printf "%s" "$INFO" ;; esac\n',
    0o755,
  );
  const version = '8.12.34';
  const run = (
    info = {},
    graphql = { errors: [{ extensions: { code: 'UNAUTHENTICATED' } }] },
  ) => {
    write(calls, '');
    const result = spawnSync('/bin/bash', [file], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(
          path.delimiter,
        ),
        CALLS: calls,
        INFO: JSON.stringify({
          version,
          accepting: true,
          dockerAvailable: false,
          arrayAvailable: false,
          ...info,
        }),
        GRAPHQL: JSON.stringify(graphql),
      },
    });
    assert.ifError(result.error);
    return result;
  };
  write(metadata, JSON.stringify({ version }));
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 2);
  result = run({}, { data: { deckBridge: { info: { version } } } });
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(run({ version: '0.6.0' }).status, 0);
  assert.notEqual(run({ accepting: false }).status, 0);
  assert.notEqual(
    run({}, { errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })
      .status,
    0,
  );
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
    assert.notEqual(run().status, 0);
    assert.equal(
      fs.readFileSync(calls, 'utf8'),
      '',
      'invalid metadata fails before probing services',
    );
  }
  fs.unlinkSync(metadata);
  assert.notEqual(run().status, 0);
  assert.equal(fs.readFileSync(calls, 'utf8'), '');
});
