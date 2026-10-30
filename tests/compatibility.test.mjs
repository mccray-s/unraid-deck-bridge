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
} from '../dist/check-host.js';

const dependencies = () => ({ ...compatibilityMatrix.minimumDependencies });

// Admission is independent of whether an exact release has a source audit snapshot.
test('minimum and newer stable OS/API releases retain management eligibility', () => {
  for (const [osVersion, apiVersion] of [
    ['6.12.0', '4.25.3'],
    ['7.2.3', '4.28.2'],
    ['7.3.4', '4.37.7'],
    ['7.3.4', '4.37.9+build.verified'],
    ['7.3.20', '4.38.0'],
    ['8.0.0', '5.0.0'],
    ['10.0.0', '100.0.0'],
    ['9007199254740993.0.0', '9007199254740993.0.0'],
  ]) {
    const report = resolveCompatibility(
      osVersion,
      apiVersion,
      'x64',
      dependencies(),
    );
    assert.equal(report.hostWriteSupported, true, `${osVersion}/${apiVersion}`);
    assert.equal(
      report.dockerWriteSupported,
      true,
      `${osVersion}/${apiVersion}`,
    );
    assert.equal(report.osVersion, osVersion);
    assert.equal(report.apiVersion, apiVersion.split('+')[0]);
  }
});

test('minimum-only admission still rejects older, malformed and non-x64 hosts', () => {
  for (const [osVersion, apiVersion, arch] of [
    ['6.11.99', '4.37.9', 'x64'],
    ['7.3.4', '4.25.2', 'x64'],
    ['7.3.4', '3.99.999', 'x64'],
    ['06.12.0', '4.37.9', 'x64'],
    ['6.12.0-beta.1', '4.37.9', 'x64'],
    ['7.3.4', '4.37', 'x64'],
    ['7.3.4', '4.37.9-rc.1', 'x64'],
    ['7.3.4', '04.37.9', 'x64'],
    ['7.3.4', '4.37.9+bad..tag', 'x64'],
    ['7.3.4', '4.37.9\n', 'x64'],
    ['7.3.4', '4.37.9', 'arm64'],
  ]) {
    assert.throws(() =>
      resolveCompatibility(osVersion, apiVersion, arch, dependencies()),
    );
  }
  assert.equal(stableVersion('4.37.9+build.verified'), '4.37.9');
});

test('runtime dependency patches and newer majors are admitted without exact pins', () => {
  for (const overrides of [
    { '@nestjs/common': '11.1.27', '@nestjs/core': '11.1.27' },
    { '@nestjs/graphql': '13.4.3', 'class-validator': '0.15.2' },
    { graphql: '17.0.0', 'nest-authz': '3.0.0', 'class-transformer': '1.0.0' },
  ]) {
    const report = resolveCompatibility('7.3.4', '4.37.9', 'x64', {
      ...dependencies(),
      ...overrides,
    });
    assert.equal(report.dockerWriteSupported, true);
  }
  for (const [name, value] of [
    ['@nestjs/common', '11.1.5'],
    ['class-validator', '0.14.1'],
    ['graphql', '16.10.99'],
    ['nest-authz', 'not-a-version'],
  ]) {
    assert.throws(
      () =>
        resolveCompatibility('7.3.4', '4.37.9', 'x64', {
          ...dependencies(),
          [name]: value,
        }),
      new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
  const missing = dependencies();
  delete missing['@nestjs/graphql'];
  assert.throws(
    () => resolveCompatibility('7.3.4', '4.37.9', 'x64', missing),
    /@nestjs\/graphql/,
  );
});

test('template dialect changes at its protocol floor without denying newer OS releases', () => {
  for (const [version, expected] of [
    ['6.12.0', 'DOCKERMAN_CLASSIC_NETWORK'],
    ['7.2.4', 'DOCKERMAN_CLASSIC_NETWORK'],
    ['7.2.5', 'DOCKERMAN_ENDPOINT_NETWORK'],
    ['7.2.9', 'DOCKERMAN_ENDPOINT_NETWORK'],
    ['7.3.4', 'DOCKERMAN_ENDPOINT_NETWORK'],
    ['8.0.0', 'DOCKERMAN_ENDPOINT_NETWORK'],
  ]) {
    assert.equal(
      resolveCompatibility(version, '4.37.9', 'x64', dependencies())
        .templateProfile,
      expected,
    );
  }
});

test('real host metadata checks dependencies for unlisted API versions and needs no Docker source snapshot', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = {
    osVersion: path.join(dir, 'unraid-version'),
    apiPackage: path.join(dir, 'package.json'),
    arch: 'x64',
  };
  fs.writeFileSync(paths.osVersion, 'version="7.3.4"\n');
  fs.writeFileSync(paths.apiPackage, JSON.stringify({ version: '4.37.9' }));
  assert.throws(
    () => assertSupportedHost(paths),
    /Host dependency is unavailable/,
  );
  for (const [name, version] of Object.entries(dependencies())) {
    const file = path.join(dir, 'node_modules', name, 'package.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version }));
  }
  const report = assertSupportedHost(paths);
  assert.equal(report.hostWriteSupported, true);
  assert.equal(report.dockerWriteSupported, true);
  assert.equal(report.templateProfile, 'DOCKERMAN_ENDPOINT_NETWORK');
  fs.writeFileSync(paths.osVersion, 'version="8.0.0"\n');
  fs.writeFileSync(paths.apiPackage, JSON.stringify({ version: '5.0.0' }));
  assert.equal(assertSupportedHost(paths).hostWriteSupported, true);
  const graphqlPackage = path.join(dir, 'node_modules/graphql/package.json');
  fs.writeFileSync(graphqlPackage, JSON.stringify({ version: '16.10.0' }));
  assert.throws(() => assertSupportedHost(paths), /graphql/);
  fs.rmSync(graphqlPackage);
  assert.throws(
    () => assertSupportedHost(paths),
    /Host dependency is unavailable: graphql/,
  );
});
