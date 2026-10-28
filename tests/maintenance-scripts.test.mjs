import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-maintenance-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'contracts', 'vendor'])
    mkdirSync(join(root, directory));
  for (const name of ['audit-compatibility', 'check-host-runtimes'])
    copyFileSync(
      join(repo, 'scripts', `${name}.mjs`),
      join(root, 'scripts', `${name}.mjs`),
    );
  for (const name of ['openapi.json', 'compatibility.json'])
    copyFileSync(join(repo, 'contracts', name), join(root, 'contracts', name));
  copyFileSync(
    join(repo, 'vendor/unraid-authorization-4.37.4.ts'),
    join(root, 'vendor/unraid-authorization-4.37.4.ts'),
  );
  return root;
}
function cli(root, name, args) {
  return spawnSync(
    process.execPath,
    [join(root, 'scripts', `${name}.mjs`), ...args],
    { encoding: 'utf8' },
  );
}
function success(result) {
  assert.equal(result.status, 0, result.stderr);
}
function failure(result) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.equal(result.error, undefined);
}

test('invalid CLI arguments reject writes for all maintenance tools', (t) => {
  const root = fixture(t);
  const before = readFileSync(join(root, 'contracts/compatibility.json'));
  const absent = join(root, 'absent');
  failure(cli(root, 'audit-compatibility', ['--api-repo', absent]));
  failure(
    cli(root, 'audit-compatibility', [
      '--api-repo',
      absent,
      '--webgui-repo',
      absent,
      '--unknown',
    ]),
  );
  const approved = Object.keys(JSON.parse(before).api)[0];
  failure(
    cli(root, 'check-host-runtimes', [
      '--api-repo',
      absent,
      '--out',
      absent,
      '--api-version',
      approved,
      '--api-version',
      'unapproved',
    ]),
  );
  assert.equal(existsSync(absent), false);
  failure(
    cli(root, 'check-host-runtimes', [
      '--api-repo',
      absent,
      '--out',
      absent,
      '--api-version',
      '',
    ]),
  );
  assert.equal(existsSync(absent), false);
  assert.deepEqual(
    readFileSync(join(root, 'contracts/compatibility.json')),
    before,
  );
});

test('audit refuses unreviewed official guard bytes without rewriting the matrix', (t) => {
  const root = fixture(t);
  const before = readFileSync(join(root, 'contracts/compatibility.json'));
  writeFileSync(
    join(root, 'vendor/unraid-authorization-4.37.4.ts'),
    'unreviewed guard',
  );
  const result = cli(root, 'audit-compatibility', [
    '--api-repo',
    join(root, 'absent-api'),
    '--webgui-repo',
    join(root, 'absent-webgui'),
  ]);
  failure(result);
  assert.match(result.stderr, /Official guard fixture drift/);
  assert.deepEqual(
    readFileSync(join(root, 'contracts/compatibility.json')),
    before,
  );
});

test('audit propagates unavailable official Git input without rewriting approved evidence', (t) => {
  const root = fixture(t);
  const before = readFileSync(join(root, 'contracts/compatibility.json'));
  failure(
    cli(root, 'audit-compatibility', [
      '--api-repo',
      join(root, 'absent-api'),
      '--webgui-repo',
      join(root, 'absent-webgui'),
    ]),
  );
  assert.deepEqual(
    readFileSync(join(root, 'contracts/compatibility.json')),
    before,
  );
});

test('help does not require inputs or create output for maintenance tools', (t) => {
  const root = fixture(t);
  const before = readFileSync(join(root, 'contracts/compatibility.json'));
  const absent = join(root, 'help-output');
  for (const name of ['audit-compatibility', 'check-host-runtimes']) {
    success(cli(root, name, ['--help']));
    success(cli(root, name, ['-h']));
  }
  success(cli(root, 'check-host-runtimes', ['--help', '--out', absent]));
  assert.equal(existsSync(absent), false);
  assert.deepEqual(
    readFileSync(join(root, 'contracts/compatibility.json')),
    before,
  );
});

test('runtime version selection requires a whole approved value before writing', (t) => {
  const root = fixture(t);
  const matrix = JSON.parse(
    readFileSync(join(root, 'contracts/compatibility.json'), 'utf8'),
  );
  const approved = Object.keys(matrix.api)[0];
  const absent = join(root, 'runtime-output');
  for (const version of [
    `${approved}\n`,
    ` ${approved}`,
    `${approved}-extra`,
  ]) {
    failure(
      cli(root, 'check-host-runtimes', [
        '--api-repo',
        join(root, 'absent-api'),
        '--out',
        absent,
        '--api-version',
        version,
      ]),
    );
    assert.equal(existsSync(absent), false);
  }
});
