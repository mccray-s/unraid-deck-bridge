import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertSupportedHost,
  resolveCompatibility,
  compatibilityMatrix,
  stableVersion,
  filterCapabilities,
} from '../dist/check-host.js';

test('audited OS/API combinations preserve their exact write profiles', () => {
  for (const [osVersion, osProfile] of Object.entries(compatibilityMatrix.os))
    for (const [apiVersion, apiProfile] of Object.entries(
      compatibilityMatrix.api,
    )) {
      const report = resolveCompatibility(
        osVersion,
        apiVersion + '+build.verified',
        'x64',
        apiProfile.dependencies,
        osProfile.dockerFiles,
      );
      assert.equal(report.hostWriteSupported, true);
      assert.equal(report.dockerWriteSupported, true);
      assert.equal(report.templateProfile, osProfile.templateProfile);
      assert.equal(report.dockerProfile, osProfile.dockerProfile);
      assert.equal(report.apiProfile, apiProfile.authProfile);
      assert.equal(report.runtimeProfile, apiProfile.runtimeProfile);
      assert.equal(
        report.verification,
        osVersion === '7.3.2' && apiVersion === '4.36.1'
          ? 'LIVE_TESTED_SCOPE'
          : 'SOURCE_AND_CONTRACT',
      );
    }
});

test('stable OS 6.12+ admission does not confer unaudited host write capabilities', () => {
  const api = compatibilityMatrix.api['4.36.1'];
  for (const version of [
    '6.12.0',
    '6.12.14',
    '7.0.0',
    '7.2.3',
    '7.3.20',
    '7.10.0',
    '10.0.0',
    '9007199254740993.0.0',
  ]) {
    const known = compatibilityMatrix.os[version];
    const report = resolveCompatibility(
      version + '+build.1',
      '4.36.1',
      'x64',
      api.dependencies,
      known?.dockerFiles ?? compatibilityMatrix.os['7.3.2'].dockerFiles,
    );
    assert.equal(report.osVersion, version);
    assert.equal(report.hostWriteSupported, !!known);
    if (known) continue;
    assert.equal(report.dockerProfile, 'UNVERIFIED');
    assert.equal(report.templateProfile, undefined);
    assert.equal(report.dockerWriteSupported, false);
    assert.equal(report.osEvidence, 'UNVERIFIED_OS_PROFILE');
    assert.equal(report.verification, 'API_CONTRACT_ONLY');
    assert.deepEqual(report.reasons, ['OS_PROFILE_UNVERIFIED']);
  }
});

test('invalid OS, architecture, API and dependency drift fail closed for unknown and audited OS', () => {
  const api = compatibilityMatrix.api['4.36.1'],
    known = compatibilityMatrix.os['7.3.2'];
  for (const bad of [
    '6.11.9',
    '6.2.99',
    '5.99.99',
    '0.0.0',
    '6.12',
    '6.12.0-beta.1',
    '7.2.0-rc.1',
    '06.12.0',
    '6.012.0',
    '6.12.00',
    '6.12.0+',
    '6.12.0+bad..tag',
    '6.12.0\n',
  ])
    assert.throws(() =>
      resolveCompatibility(
        bad,
        '4.36.1',
        'x64',
        api.dependencies,
        known.dockerFiles,
      ),
    );
  for (const version of ['6.12.0', '7.3.2', '7.3.20']) {
    for (const bad of [
      '4.37.7',
      '4.38.0',
      '4.25.2',
      '4.36',
      '4.36.1-rc.1',
      '04.36.1',
      '4.36.1+',
      '4.36.1+bad..tag',
    ])
      assert.throws(() =>
        resolveCompatibility(
          version,
          bad,
          'x64',
          api.dependencies,
          known.dockerFiles,
        ),
      );
    assert.throws(() =>
      resolveCompatibility(
        version,
        '4.36.1',
        'arm64',
        api.dependencies,
        known.dockerFiles,
      ),
    );
    for (const name of Object.keys(api.dependencies)) {
      assert.throws(() =>
        resolveCompatibility(
          version,
          '4.36.1',
          'x64',
          { ...api.dependencies, [name]: 'unverified' },
          known.dockerFiles,
        ),
      );
      const missing = { ...api.dependencies };
      delete missing[name];
      assert.throws(() =>
        resolveCompatibility(
          version,
          '4.36.1',
          'x64',
          missing,
          known.dockerFiles,
        ),
      );
    }
  }
  assert.equal(stableVersion('4.36.1+f3205d97'), '4.36.1');
});

for (const [version, commit] of [
  ['4.37.5', 'd4d9733646a7a271eeb345b41648217ea3b10179'],
  ['4.37.6', '4e27bb8ce274e51664aadf16116a047abeaef468'],
])
  test(`${version} uses its exact approved namespace/runtime contract and rejects dependency drift`, () => {
    const api = compatibilityMatrix.api[version],
      known = compatibilityMatrix.os['7.3.2'];
    assert.equal(api.commit, commit);
    assert.equal(api.authProfile, 'EXPLICIT_NAMESPACE');
    assert.equal(api.runtimeProfile, 'NEST_11_1_26');
    assert.deepEqual(api.dependencies, {
      '@nestjs/common': '11.1.26',
      '@nestjs/core': '11.1.26',
      '@nestjs/graphql': '13.4.2',
      graphql: '16.11.0',
      'class-validator': '0.15.1',
      'nest-authz': '2.17.0',
      'class-transformer': '0.5.1',
    });
    for (const osVersion of ['7.3.2', '7.3.20']) {
      const report = resolveCompatibility(
        osVersion,
        version + '+build.verified',
        'x64',
        api.dependencies,
        known.dockerFiles,
      );
      assert.equal(report.apiProfile, 'EXPLICIT_NAMESPACE');
      assert.equal(report.runtimeProfile, 'NEST_11_1_26');
      assert.equal(report.hostWriteSupported, osVersion === '7.3.2');
      assert.equal(report.dockerWriteSupported, osVersion === '7.3.2');
      for (const name of Object.keys(api.dependencies)) {
        assert.throws(() =>
          resolveCompatibility(
            osVersion,
            version,
            'x64',
            { ...api.dependencies, [name]: 'unverified' },
            known.dockerFiles,
          ),
        );
        const missing = { ...api.dependencies };
        delete missing[name];
        assert.throws(() =>
          resolveCompatibility(
            osVersion,
            version,
            'x64',
            missing,
            known.dockerFiles,
          ),
        );
      }
    }
  });

test('capability policy keeps unknown OS read-only and confines audited Docker drift', () => {
  const api = compatibilityMatrix.api['4.36.1'],
    known = compatibilityMatrix.os['7.3.2'];
  const reads = [
    'operations.events',
    'system.read',
    'plugins.read',
    'array.read',
  ];
  const writes = [
    'system.preview',
    'system.execute',
    'plugins.preview',
    'plugins.execute',
    'plugins.uninstall',
    'array.preview',
    'array.execute',
  ];
  const docker = [
    'docker.read',
    'docker.restart',
    'docker.install',
    'docker.edit',
    'docker.template',
    'docker.templateDrafts',
    'docker.customCreate',
    'docker.fullConfiguration',
  ];
  const capabilities = [...reads, ...writes, ...docker, 'future.write'];
  const unknown = resolveCompatibility(
    '7.3.20',
    '4.36.1',
    'x64',
    api.dependencies,
    known.dockerFiles,
  );
  assert.deepEqual(filterCapabilities(unknown, capabilities), reads);
  const matching = resolveCompatibility(
    '7.3.2',
    '4.36.1',
    'x64',
    api.dependencies,
    known.dockerFiles,
  );
  assert.deepEqual(filterCapabilities(matching, capabilities), capabilities);
  for (const fingerprints of [
    {},
    { ...known.dockerFiles, [Object.keys(known.dockerFiles)[0]]: 'drift' },
  ]) {
    const drift = resolveCompatibility(
      '7.3.2',
      '4.36.1',
      'x64',
      api.dependencies,
      fingerprints,
    );
    assert.equal(drift.hostWriteSupported, true);
    assert.equal(drift.dockerWriteSupported, false);
    assert.ok(
      drift.reasons.every((x) => x.startsWith('DOCKER_MANAGER_MISMATCH:')),
    );
    assert.deepEqual(filterCapabilities(drift, capabilities), [
      ...reads,
      ...writes,
      'docker.read',
      'docker.restart',
      'future.write',
    ]);
  }
  assert.deepEqual(filterCapabilities(undefined, capabilities), capabilities);
});

test('unknown OS still requires each audited dependency on disk', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = {
    osVersion: path.join(dir, 'unraid-version'),
    apiPackage: path.join(dir, 'package.json'),
    arch: 'x64',
  };
  fs.writeFileSync(paths.osVersion, 'version="6.12.0"\n');
  fs.writeFileSync(paths.apiPackage, JSON.stringify({ version: '4.37.4' }));
  assert.throws(() => assertSupportedHost(paths));
  for (const [name, version] of Object.entries(
    compatibilityMatrix.api['4.37.4'].dependencies,
  )) {
    const file = path.join(dir, 'node_modules', name, 'package.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version }));
  }
  const report = assertSupportedHost(paths);
  assert.equal(report.apiProfile, 'EXPLICIT_NAMESPACE');
  assert.equal(report.hostWriteSupported, false);
  fs.writeFileSync(paths.osVersion, 'version="7.3.20"');
  assert.equal(assertSupportedHost(paths).verification, 'API_CONTRACT_ONLY');
  fs.writeFileSync(paths.osVersion, 'version="6.11.9"');
  assert.throws(() => assertSupportedHost(paths));
});
