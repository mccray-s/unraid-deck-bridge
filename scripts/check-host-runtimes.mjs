#!/usr/bin/env node
// Exercise real schema, transformer and guards with audited dependencies; no Unraid mutation.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const testNames = [
  'schema.test.mjs',
  'host-schema.test.mjs',
  'docker-updates.test.mjs',
  'image-update.test.mjs',
];

// These programs run inside each isolated dependency installation, using this Node.
const transpileGuard = `
import ts from 'typescript';
import fs from 'node:fs';

const source = fs.readFileSync('upstream-guard.ts', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
  },
});
fs.writeFileSync('upstream-guard.js', compiled.outputText);
`;

const upstreamGuardTest = `
import test from 'node:test';
import assert from 'node:assert/strict';
import { Reflector } from '@nestjs/core';
import { AuthorizationGuard } from '../upstream-guard.js';
import * as api from '../dist/index.js';

const context = (handler, user) => ({
  getType: () => 'graphql',
  getHandler: () => handler,
  getArgs: () => [{}, {}, { req: { user } }, {}],
});

test('actual pinned upstream guard accepts authenticated namespaces but enforces every leaf', async () => {
  const guard = new AuthorizationGuard(
    new Reflector(),
    { enforce: async (user, resource, action) => user?.resource === resource && user?.action === action },
    {
      enablePossession: false,
      userFromContext: (context) => context.getArgs()[2].req.user,
      resourceFromContext: (_context, permission) => permission.resource,
    },
  );
  for (const Resolver of api.resolvers) {
    for (const name of Object.getOwnPropertyNames(Resolver.prototype)) {
      if (name === 'constructor') continue;
      const handler = Resolver.prototype[name];
      if (typeof handler !== 'function') continue;
      const permissions = Reflect.getMetadata('__PERMISSIONS__', handler);
      if (!permissions) {
        assert.equal(
          await guard.canActivate(context(handler, { id: 'actor' })),
          Reflect.getMetadata('isAuthenticatedEndpoint', handler) === true,
        );
        assert.equal(await guard.canActivate(context(handler, undefined)), false);
        continue;
      }
      const permission = permissions[0];
      assert.equal(await guard.canActivate(context(handler, {
        id: 'actor', resource: permission.resource, action: permission.action,
      })), true);
      assert.equal(await guard.canActivate(context(handler, {
        id: 'actor', resource: 'NONE', action: 'NONE',
      })), false);
    }
  }
});
`;

const productionSchemaSmoke = `
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import {
  UsePermissionsDirective,
  usePermissionsSchemaTransformer,
} from '@unraid/shared/use-permissions.directive.js';
import { parse, validate } from 'graphql';
import { resolvers } from './dist/index.js';

const app = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, { logger: false });
try {
  const built = await app.get(GraphQLSchemaFactory).create(resolvers, {
    directives: [UsePermissionsDirective],
  });
  const schema = usePermissionsSchemaTransformer(built);
  assert.match(
    schema.getType('DeckBridgeDockerMutations').getFields().install.description,
    /CREATE_ANY/,
  );
  assert.match(
    schema.getType('DeckBridgeDockerQueries').getFields().creationDefaults.description,
    /READ_ANY/,
  );
  assert.deepEqual(
    validate(schema, parse('{deckBridge{docker{creationDefaults{appDataRoot}}}}')),
    [],
  );
  console.log('PASS: production permission schema transformer and current Bridge query');
} finally {
  await app.close();
}
`;

function run(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(
      `${command} failed (${result.status ?? result.signal})`,
    );
    error.exitCode = result.status || 1;
    throw error;
  }
}

function npmCLI() {
  // mise's bin/npm can be a shell wrapper rather than a symlink to npm-cli.js.
  const bundled = resolve(
    dirname(process.execPath),
    '../lib/node_modules/npm/bin/npm-cli.js',
  );
  if (existsSync(bundled)) return bundled;
  for (const directory of [
    dirname(process.execPath),
    ...(process.env.PATH ?? '').split(':'),
  ]) {
    const candidate = join(directory, 'npm');
    if (!existsSync(candidate)) continue;
    const resolved = realpathSync(candidate);
    if (resolved.endsWith('/npm-cli.js')) return resolved;
  }
  throw new Error(
    'Cannot locate npm-cli.js; install npm alongside the current Node runtime',
  );
}

function selectVersions(matrix, requestedVersions) {
  const representatives = new Map();
  for (const [version, row] of Object.entries(matrix.api)) {
    const key = JSON.stringify([row.authProfile, row.runtimeProfile]);
    if (!representatives.has(key)) representatives.set(key, version);
  }
  const versions = requestedVersions ?? [...representatives.values()];
  // Validate the entire selection before creating directories or invoking git/npm.
  for (const version of versions) {
    if (!Object.hasOwn(matrix.api, version))
      throw new Error(`API version has not been approved: ${version}`);
  }
  return versions;
}

function officialSource(apiRepo, commit, path) {
  return execFileSync('git', ['-C', apiRepo, 'show', `${commit}:${path}`], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function installDependencies(repo, root, apiRepo, row) {
  const dependencies = {
    ...row.dependencies,
    '@unraid/shared': `file:${join(repo, 'vendor/unraid-shared-4.25.3.tgz')}`,
    'graphql-scalars': '1.24.2',
    'reflect-metadata': '0.1.14',
    rxjs: '7.8.2',
    'class-transformer': '0.5.1',
    typescript: '5.9.2',
  };
  const official = JSON.parse(
    officialSource(apiRepo, row.commit, 'api/package.json'),
  );
  for (const name of [
    '@graphql-tools/utils',
    '@nestjs/platform-fastify',
    'fastify',
    'undici',
  ]) {
    dependencies[name] = official.dependencies[name];
  }
  mkdirSync(root, { recursive: true });
  const pkg = {
    name: 'bridge-runtime-contract',
    version: '0.0.0',
    private: true,
    type: 'module',
    dependencies,
  };
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
  // Invoke npm itself with this exact Node, not another PATH-selected runtime.
  run(
    process.execPath,
    [
      npmCLI(),
      'install',
      '--ignore-scripts',
      '--legacy-peer-deps',
      '--no-audit',
      '--no-fund',
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
}

function copyTestInputs(repo, root) {
  cpSync(join(repo, 'dist'), join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  for (const name of testNames)
    copyFileSync(join(repo, 'tests', name), join(root, 'tests', name));
  mkdirSync(join(root, 'contracts'), { recursive: true });
  for (const name of ['openapi.json', 'compatibility.json']) {
    copyFileSync(join(repo, 'contracts', name), join(root, 'contracts', name));
  }
  mkdirSync(join(root, 'vendor'), { recursive: true });
  copyFileSync(
    join(repo, 'vendor/unraid-authorization-4.37.4.ts'),
    join(root, 'vendor/unraid-authorization-4.37.4.ts'),
  );
}

function prepareUpstreamGuard(root, apiRepo, commit) {
  // Replace only host-specific imports; retain the pinned guard's authorization logic.
  const source = officialSource(
    apiRepo,
    commit,
    'api/src/unraid-api/auth/authorization.guard.ts',
  )
    .replace(
      "import { IS_AUTHENTICATED_ENDPOINT_KEY } from '@app/unraid-api/auth/authenticated.decorator.js';",
      "const IS_AUTHENTICATED_ENDPOINT_KEY='isAuthenticatedEndpoint';",
    )
    .replace(
      "import { IS_PUBLIC_ENDPOINT_KEY } from '@app/unraid-api/auth/public.decorator.js';",
      "const IS_PUBLIC_ENDPOINT_KEY='isPublic';",
    )
    .replace(
      "import { getRequest } from '@app/utils.js';",
      'const getRequest=(context:any)=>context.getArgs()[2]?.req;',
    );
  writeFileSync(join(root, 'upstream-guard.ts'), source);
  run(process.execPath, ['--input-type=module', '-e', transpileGuard], {
    cwd: root,
    stdio: 'inherit',
  });
  writeFileSync(join(root, 'tests/upstream-guard.test.mjs'), upstreamGuardTest);
}

function checkRuntime(repo, out, apiRepo, version, row) {
  const root = join(out, version);
  installDependencies(repo, root, apiRepo, row);
  copyTestInputs(repo, root);
  const tests = testNames.map((name) => join(root, 'tests', name));
  if (row.authProfile === 'EXPLICIT_NAMESPACE') {
    prepareUpstreamGuard(root, apiRepo, row.commit);
    tests.push(join(root, 'tests/upstream-guard.test.mjs'));
  }
  const result = spawnSync(process.execPath, ['--test', ...tests], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  writeFileSync(join(root, 'test-output.txt'), output);
  console.log(
    JSON.stringify({
      api: version,
      runtime: row.runtimeProfile,
      exitCode: result.status ?? 1,
    }),
  );
  if (result.status !== 0) {
    console.log(output);
    const error = new Error(`Runtime tests failed for ${version}`);
    error.exitCode = result.status || 1;
    throw error;
  }
  run(process.execPath, ['--input-type=module', '-e', productionSchemaSmoke], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'inherit',
  });
}

function main() {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      'api-repo': { type: 'string' },
      'api-version': { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(`Usage: check-host-runtimes.mjs --out PATH --api-repo PATH [--api-version VERSION ...]

Options:
  --out PATH            Required output parent; writes/reuses PATH/VERSION directories.
  --api-repo PATH       Required local official API Git checkout with approved commits.
  --api-version VERSION Repeat to select exact approved versions. Default: first matrix
                        entry for each authentication/runtime profile pair.
  -h, --help            Show this help without installing dependencies or running tests.

Requires an existing dist build. Installs pinned dependencies using npm (network/cache
access, lifecycle scripts disabled), copies test inputs, and writes test-output.txt.
Runs real guard/schema tests and a production schema smoke check with the current Node.
Does not fetch Git objects or mutate Unraid. Stops at the first failed runtime.`);
    return;
  }
  if (!values.out?.trim() || !values['api-repo']?.trim())
    throw new Error('--out and --api-repo are required');
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
  const out = resolve(values.out);
  const matrix = JSON.parse(
    readFileSync(join(repo, 'contracts/compatibility.json'), 'utf8'),
  );
  const versions = selectVersions(matrix, values['api-version']);
  for (const version of versions) {
    checkRuntime(repo, out, values['api-repo'], version, matrix.api[version]);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = error.exitCode || 1;
}
