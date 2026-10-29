import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  parseReleaseVersion,
  compareReleaseVersions,
  isObservedReleaseVersion,
} from '../api-extension/release-version.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('canonical release parsing validates calendar boundaries and derives npm metadata', () => {
  assert.deepEqual(parseReleaseVersion('2026.10.29a'), {
    version: '2026.10.29a',
    year: 2026,
    month: 10,
    day: 29,
    revision: 'a',
    npmVersion: '2026.10.2901',
  });
  for (const [version, npmVersion] of [
    ['2000.02.29', '2000.2.2900'],
    ['2024.02.29z', '2024.2.2926'],
    ['2026.01.01', '2026.1.100'],
    ['2026.12.31', '2026.12.3100'],
  ]) {
    assert.equal(parseReleaseVersion(version).npmVersion, npmVersion);
  }
  for (const value of [
    undefined,
    null,
    2026,
    '',
    '0.1.1',
    '2026.2.01',
    '2026.02.1',
    '2026.02.29',
    '1900.02.29',
    '2026.04.31',
    '2026.00.01',
    '2026.13.01',
    '2026.01.00',
    '0000.01.01',
    '2026.10.29aa',
    '2026.10.29A',
    '2026.10.29-a',
    '2026.10.29a\n',
    ' 2026.10.29',
  ]) {
    assert.throws(() => parseReleaseVersion(value), TypeError, String(value));
  }
});

test('native lexical ordering and derived npm numeric ordering agree across boundaries', () => {
  const versions = [
    '2024.02.28z',
    '2024.02.29',
    '2024.02.29a',
    '2024.03.01',
    '2026.09.30z',
    '2026.10.01',
    '2026.10.29',
    '2026.10.29a',
    '2026.10.29b',
    '2026.10.29z',
    '2026.10.30',
    '2026.12.31z',
    '2027.01.01',
  ];
  for (let i = 0; i < versions.length; i++) {
    assert.equal(compareReleaseVersions(versions[i], versions[i]), 0);
    for (let j = i + 1; j < versions.length; j++) {
      assert.equal(compareReleaseVersions(versions[i], versions[j]), -1);
      assert.equal(compareReleaseVersions(versions[j], versions[i]), 1);
      assert.ok(versions[i] < versions[j]);
      const left = parseReleaseVersion(versions[i])
        .npmVersion.split('.')
        .map(Number);
      const right = parseReleaseVersion(versions[j])
        .npmVersion.split('.')
        .map(Number);
      const differing = left.findIndex((part, index) => part !== right[index]);
      assert.ok(differing >= 0 && left[differing] < right[differing]);
    }
  }
  assert.throws(() => compareReleaseVersions('0.1.1', versions[0]), TypeError);
  assert.throws(
    () => compareReleaseVersions(versions[0], '2026.02.29'),
    TypeError,
  );
});

test('observations accept historical stable versions without legitimizing malformed releases', () => {
  for (const version of ['0.1.1', '0.0.0', '1.20.300', '2026.10.29a']) {
    assert.equal(isObservedReleaseVersion(version), true, version);
  }
  for (const version of [
    undefined,
    null,
    1,
    '',
    'v0.1.1',
    '00.1.1',
    '0.01.1',
    '0.1.01',
    '0.1.1-beta',
    '0.1.1+build',
    '0.1.1\n',
    '2026.02.29',
    '2026.10.32',
    '2026.2.1',
    '2026.10.29aa',
    '2026.10.29A',
  ]) {
    assert.equal(isObservedReleaseVersion(version), false, String(version));
  }
});

function buildFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of [
    'scripts/sync-release-version.mjs',
    'scripts/prepare-build.mjs',
    'api-extension/release-version.mjs',
    'contracts/compatibility.json',
  ]) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, name), target);
  }
  fs.writeFileSync(
    path.join(dir, 'release.json'),
    JSON.stringify({ version: '2026.10.29a' }),
  );
  const pkg = {
    name: 'release-fixture',
    version: '0.1.1',
    type: 'module',
    license: 'MIT',
    scripts: JSON.parse(
      fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
    ).scripts,
    dependencies: { example: '0.1.1' },
  };
  const lock = {
    name: pkg.name,
    version: '0.1.1',
    lockfileVersion: 3,
    packages: {
      '': { name: pkg.name, version: '0.1.1', dependencies: pkg.dependencies },
      'node_modules/example': { version: '0.1.1', integrity: 'unchanged' },
    },
  };
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    JSON.stringify(lock, null, 2) + '\n',
  );
  return { dir, pkg, lock };
}

test('prebuild synchronization updates root identities without changing resolved dependencies', async (t) => {
  const { dir, pkg, lock } = buildFixture(t);
  await exec(process.execPath, ['scripts/sync-release-version.mjs'], {
    cwd: dir,
  });
  pkg.version = '2026.10.2901';
  lock.version = pkg.version;
  lock.packages[''].version = pkg.version;
  for (const [name, expected] of [
    ['package.json', pkg],
    ['package-lock.json', lock],
  ]) {
    const target = path.join(dir, name);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), expected);
  }
});

test('adapter preparation rejects an unsynchronized npm identity before emitting mixed metadata', async (t) => {
  const { dir } = buildFixture(t);
  await assert.rejects(
    exec(process.execPath, ['scripts/prepare-build.mjs'], { cwd: dir }),
    /synchronized npm release version/,
  );
  assert.equal(fs.existsSync(path.join(dir, 'dist/release.json')), false);
});

test('compiler failure never refreshes adapter release metadata', async (t) => {
  const { dir } = buildFixture(t);
  fs.mkdirSync(path.join(dir, 'node_modules/.bin'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'node_modules/.bin/tsc'),
    '#!/bin/sh\nexit 17\n',
    { mode: 0o755 },
  );
  fs.mkdirSync(path.join(dir, 'dist'));
  const metadataPath = path.join(dir, 'dist/release.json');
  fs.writeFileSync(metadataPath, '{"version":"2026.10.28"}\n');
  await assert.rejects(exec('npm', ['run', 'build'], { cwd: dir }), {
    code: 17,
  });
  assert.equal(
    fs.readFileSync(metadataPath, 'utf8'),
    '{"version":"2026.10.28"}\n',
  );
  assert.equal(fs.existsSync(path.join(dir, 'dist/package.json')), false);
});
