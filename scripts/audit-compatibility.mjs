#!/usr/bin/env node
// Generate pinned evidence from Git objects; never execute upstream PHP.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const authorizationPath = 'api/src/unraid-api/auth/authorization.guard.ts';
const apiPaths = [
  'api/src/unraid-api/plugin/plugin.module.ts',
  'api/src/unraid-api/plugin/plugin.service.ts',
  'api/src/unraid-api/plugin/plugin.interface.ts',
  'api/src/unraid-api/auth/authentication.guard.ts',
  authorizationPath,
  'packages/unraid-shared/src/use-permissions.directive.ts',
  'api/src/unraid-api/cli/plugins/plugin.command.ts',
  'api/package.json',
];
const dockerPaths = [
  'emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container',
  'emhttp/plugins/dynamix.docker.manager/scripts/update_container',
  'emhttp/plugins/dynamix.docker.manager/include/DockerClient.php',
  'emhttp/plugins/dynamix.docker.manager/include/Helpers.php',
  'etc/rc.d/rc.docker',
];
const apiAuditPaths = [
  'api/src/unraid-api/graph/graph.module.ts',
  'api/src/unraid-api/app/app.module.ts',
  'api/generated-schema.graphql',
];
const dockerAuditPaths = [
  'emhttp/plugins/dynamix.docker.manager/include/CreateDocker.php',
  'emhttp/plugins/dynamix.docker.manager/default.cfg',
  'emhttp/plugins/dynamix.docker.manager/scripts/docker',
];
const otherPaths = [
  'emhttp/plugins/dynamix/DeviceInfo.page',
  'emhttp/plugins/dynamix/include/Helpers.php',
  'emhttp/plugins/dynamix.plugin.manager/scripts/plugin',
];
const runtimeDependencies = {
  NEST_11_1_6: {
    '@nestjs/common': '11.1.6',
    '@nestjs/core': '11.1.6',
    '@nestjs/graphql': '13.1.0',
    graphql: '16.11.0',
    'class-validator': '0.14.2',
    'nest-authz': '2.17.0',
    'class-transformer': '0.5.1',
  },
  NEST_11_1_26: {
    '@nestjs/common': '11.1.26',
    '@nestjs/core': '11.1.26',
    '@nestjs/graphql': '13.4.2',
    graphql: '16.11.0',
    'class-validator': '0.15.1',
    'nest-authz': '2.17.0',
    'class-transformer': '0.5.1',
  },
};

function assertApproved(condition, message) {
  if (!condition) throw new Error(message);
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function show(repo, commit, path) {
  return git(repo, 'show', `${commit}:${path}`);
}

function digest(blob) {
  return createHash('sha256').update(blob).digest('hex');
}

function auditAPI(apiRepo, version, approved, explicitGuard) {
  assertApproved(
    /^4\.\d+\.\d+$/.test(version) && version.trim() === version,
    `Invalid API version: ${version}`,
  );
  const tag = `v${version}`;
  const { commit, authProfile, runtimeProfile } = approved;
  assertApproved(
    typeof commit === 'string' &&
      commit.length === 40 &&
      /^[0-9a-f]{40}$/.test(commit),
    `${tag} requires a full commit pin`,
  );
  assertApproved(
    git(apiRepo, 'rev-parse', `${tag}^{commit}`).toString().trim() === commit,
    `${tag} tag/commit mismatch`,
  );
  assertApproved(
    git(apiRepo, 'rev-parse', `${commit}^{commit}`).toString().trim() ===
      commit,
    `${tag} invalid commit object`,
  );
  assertApproved(
    ['LEGACY_AUTHZ', 'EXPLICIT_NAMESPACE'].includes(authProfile),
    `${tag} unknown auth profile`,
  );
  assertApproved(
    Object.hasOwn(runtimeDependencies, runtimeProfile),
    `${tag} unknown runtime profile`,
  );
  const graph = show(
    apiRepo,
    commit,
    'api/src/unraid-api/graph/graph.module.ts',
  ).toString();
  assertApproved(
    /fieldResolverEnhancers:\s*\[\s*'guards'\s*\]/.test(graph),
    `${tag} does not enforce nested field guards`,
  );
  const cli = show(
    apiRepo,
    commit,
    'api/src/unraid-api/cli/plugins/plugin.command.ts',
  ).toString();
  assertApproved(
    cli.includes('--bundled') && cli.includes('--no-restart'),
    `${tag} lacks the required registration CLI flags`,
  );
  const pkg = JSON.parse(show(apiRepo, commit, 'api/package.json'));
  assertApproved(
    pkg.version === version,
    `${tag} package version contradicts approved release`,
  );
  const dependencies = Object.fromEntries(
    Object.keys(runtimeDependencies[runtimeProfile]).map((name) => [
      name,
      pkg.dependencies[name],
    ]),
  );
  assertApproved(
    isDeepStrictEqual(dependencies, runtimeDependencies[runtimeProfile]),
    `${tag} dependencies contradict runtime profile`,
  );
  assertApproved(
    isDeepStrictEqual(dependencies, approved.dependencies),
    `${tag} approved dependency drift`,
  );
  const guardExists = Boolean(
    git(apiRepo, 'ls-tree', commit, '--', authorizationPath).toString().trim(),
  );
  assertApproved(
    guardExists === (authProfile === 'EXPLICIT_NAMESPACE'),
    `${tag} authorization guard contradicts profile`,
  );
  const app = show(
    apiRepo,
    commit,
    'api/src/unraid-api/app/app.module.ts',
  ).toString();
  const guards = [
    ...app.matchAll(/provide:\s*APP_GUARD,\s*useClass:\s*(\w+)/g),
  ].map((match) => match[1]);
  assertApproved(
    isDeepStrictEqual(guards, [
      'AuthenticationGuard',
      guardExists ? 'AuthorizationGuard' : 'AuthZGuard',
    ]),
    `${tag} global guard registration contradicts profile`,
  );
  for (const [path, expected] of Object.entries({
    'api/src/unraid-api/auth/authentication.guard.ts':
      'c5f23e30c6036b1527d893baf99237789291cfd3d98f043db117046016620250',
    'packages/unraid-shared/src/use-permissions.directive.ts':
      '9b94f9ab85bb9cd98184eb939fe7e518120fb51cc6f3ee460756293014a0b312',
  })) {
    assertApproved(
      digest(show(apiRepo, commit, path)) === expected,
      `${tag} unreviewed authentication/permissions contract: ${path}`,
    );
  }
  const row = {
    commit,
    authProfile,
    runtimeProfile,
    dependencies,
    sources: {},
  };
  for (const path of apiPaths) {
    if (path === authorizationPath && !guardExists) continue;
    const blob = show(apiRepo, commit, path);
    if (path === authorizationPath) {
      assertApproved(
        blob.equals(explicitGuard),
        `${tag} unreviewed authorization guard contract`,
      );
    }
    row.sources[path] = digest(blob);
  }
  row.auditEvidence = Object.fromEntries(
    apiAuditPaths.map((path) => [path, digest(show(apiRepo, commit, path))]),
  );
  return row;
}

function auditOS(webguiRepo, version, approved) {
  const { commit } = approved;
  assertApproved(
    typeof commit === 'string' &&
      commit.length === 40 &&
      /^[0-9a-f]{40}$/.test(commit),
    `${version} requires a full commit pin`,
  );
  assertApproved(
    git(webguiRepo, 'rev-parse', `${commit}^{commit}`).toString().trim() ===
      commit,
    `${version} invalid commit object`,
  );
  const row = { ...approved, dockerFiles: {}, sources: {} };
  for (const path of [...dockerPaths, ...otherPaths]) {
    const fingerprint = digest(show(webguiRepo, commit, path));
    row.sources[path] = fingerprint;
    if (dockerPaths.includes(path))
      row.dockerFiles[`/usr/local/${path}`] = fingerprint;
  }
  row.auditEvidence = Object.fromEntries(
    dockerAuditPaths.map((path) => [
      path,
      digest(show(webguiRepo, commit, path)),
    ]),
  );
  return row;
}

function main() {
  const { values } = parseArgs({
    options: {
      'api-repo': { type: 'string' },
      'webgui-repo': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(`Usage: audit-compatibility.mjs --api-repo PATH --webgui-repo PATH

Options:
  --api-repo PATH     Required local official API Git checkout with approved tags/commits.
  --webgui-repo PATH  Required local official webgui Git checkout with approved commits.
  -h, --help         Show this help without reading Git objects or writing evidence.

Audits every existing approved API/OS pin; no versions are discovered or added.
Rewrites this checkout's contracts/compatibility.json only after all checks pass.
Reads pinned Git objects; partial clones may fetch missing objects. Never executes upstream code.`);
    return;
  }
  assertApproved(
    values['api-repo']?.trim() && values['webgui-repo']?.trim(),
    '--api-repo and --webgui-repo are required',
  );
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outputPath = join(repo, 'contracts/compatibility.json');
  const previous = JSON.parse(readFileSync(outputPath, 'utf8'));
  const explicitGuard = readFileSync(
    join(repo, 'vendor/unraid-authorization-4.37.4.ts'),
  );
  assertApproved(
    digest(explicitGuard) ===
      'db7bb221f9a19f51d23c6c3cb4697eb9f2943ad7b229bdb1aaf5f08e7ee62154',
    'Official guard fixture drift',
  );
  assertApproved(Object.keys(previous.api).length, 'No approved API pins');
  const result = {
    format: 1,
    minimumOSVersion: previous.minimumOSVersion,
    api: {},
    os: {},
    liveVerification: previous.liveVerification,
  };
  for (const [version, approved] of Object.entries(previous.api)) {
    result.api[version] = auditAPI(
      values['api-repo'],
      version,
      approved,
      explicitGuard,
    );
  }
  assertApproved(Object.keys(previous.os).length, 'No approved OS pins');
  for (const [version, approved] of Object.entries(previous.os)) {
    result.os[version] = auditOS(values['webgui-repo'], version, approved);
  }
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({
      osVersions: Object.keys(result.os).length,
      apiVersions: Object.keys(result.api).length,
      routingCombinations:
        Object.keys(result.os).length * Object.keys(result.api).length,
    }),
  );
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
