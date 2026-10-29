import test from 'node:test';
import assert from 'node:assert/strict';
import bridgePackage from '../dist/release.json' with { type: 'json' };
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForbiddenException } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  GqlExecutionContext,
} from '@nestjs/graphql';
import { AuthZGuard } from 'nest-authz';
import { graphql } from 'graphql';
import * as api from '../dist/index.js';
import {
  compatibilityMatrix,
  resolveCompatibility,
} from '../dist/check-host.js';

const user = (resource) => ({
  id: 'host-reader',
  resource,
  action: 'READ_ANY',
});

function hostFixture(t, version) {
  const apiVersion = '4.36.1',
    dependencies = compatibilityMatrix.api[apiVersion].dependencies;
  const files = new Map([
    ['/etc/unraid-version', `version="${version}"\n`],
    [
      '/usr/local/unraid-api/package.json',
      JSON.stringify({ version: apiVersion }),
    ],
    ...Object.entries(dependencies).map(([name, value]) => [
      `/usr/local/unraid-api/node_modules/${name}/package.json`,
      JSON.stringify({ version: value }),
    ]),
  ]);
  // Keep drift synthetic even when the test runs on a matching Unraid host.
  for (const file of Object.keys(
    compatibilityMatrix.os[version]?.dockerFiles ?? {},
  ))
    files.set(file, Buffer.from('fixture Docker Manager drift\n'));
  const arch = Object.getOwnPropertyDescriptor(process, 'arch');
  Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
  t.after(() => Object.defineProperty(process, 'arch', arch));
  const exists = fs.existsSync.bind(fs),
    read = fs.readFileSync.bind(fs);
  t.mock.method(fs, 'existsSync', (file) => files.has(file) || exists(file));
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (!files.has(file)) return read(file, ...args);
    return files.get(file);
  });
  // Synthetic host identity; production policy still calculates all profiles.
  return {
    report: resolveCompatibility(version, apiVersion, 'x64', dependencies, {}),
  };
}
async function execution(t) {
  const app = await NestFactory.createApplicationContext(
    GraphQLSchemaBuilderModule,
    { logger: false },
  );
  t.after(() => app.close());
  const schema = await app.get(GraphQLSchemaFactory).create(api.resolvers);
  const service = new api.DeckBridgeService();
  const namespaceGuard = new api.DeckBridgeNamespaceGuard();
  const permissionGuard = new AuthZGuard(
    new Reflector(),
    {
      enforce: async (subject, resource, action) =>
        subject?.resource === resource && subject?.action === action,
    },
    {
      enablePossession: false,
      userFromContext: (ctx) =>
        GqlExecutionContext.create(ctx).getContext().req.user,
      resourceFromContext: (_ctx, permission) => permission.resource,
    },
  );
  // SchemaBuilder generates types without executable Nest handlers. Bind the real
  // resolver instances and run their declared guards at the GraphQL field boundary.
  const bindings = new Map([
    ['Query.deckBridge', [new api.DeckBridgeRootResolver(), 'query', () => []]],
    [
      'DeckBridgeQueries.info',
      [
        new api.DeckBridgeQueriesResolver(service),
        'info',
        (_args, ctx) => [ctx],
      ],
    ],
    [
      'Mutation.deckBridge',
      [new api.DeckBridgeRootResolver(), 'mutation', () => []],
    ],
    ...['system', 'plugins', 'array', 'docker'].map((name) => [
      `DeckBridgeMutations.${name}`,
      [new api.DeckBridgeMutationsResolver(), name, () => []],
    ]),
    [
      'DeckBridgeSystemMutations.prepare',
      [
        new api.DeckBridgeSystemMutationsResolver(),
        'prepare',
        (args, ctx) => [args.input, ctx],
      ],
    ],
    ...['shutdown', 'reboot'].map((name) => [
      `DeckBridgeSystemMutations.${name}`,
      [
        new api.DeckBridgeSystemMutationsResolver(),
        name,
        (args, ctx) => [args.input, ctx],
      ],
    ]),
    [
      'DeckBridgePluginMutations.prepareUninstall',
      [
        new api.DeckBridgePluginMutationsResolver(),
        'prepareUninstall',
        (args, ctx) => [args.pluginId, ctx],
      ],
    ],
    [
      'DeckBridgePluginMutations.uninstall',
      [
        new api.DeckBridgePluginMutationsResolver(),
        'uninstall',
        (args, ctx) => [args.input, ctx],
      ],
    ],
    ...[
      'prepare',
      'start',
      'stop',
      'prepareParity',
      'startParity',
      'pauseParity',
      'resumeParity',
      'cancelParity',
    ].map((name) => [
      `DeckBridgeArrayMutations.${name}`,
      [
        new api.DeckBridgeArrayMutationsResolver(),
        name,
        (args, ctx) => [args.input, ctx],
      ],
    ]),
    [
      'DeckBridgeDockerMutations.importTemplate',
      [
        new api.DeckBridgeDockerMutationsResolver(service),
        'importTemplate',
        (args, ctx) => [args.input, ctx],
      ],
    ],
    [
      'DeckBridgeDockerMutations.prepareInstall',
      [
        new api.DeckBridgeDockerMutationsResolver(service),
        'prepareInstall',
        (args, ctx) => [args.input, ctx],
      ],
    ],
    [
      'DeckBridgeDockerMutations.prepareEdit',
      [
        new api.DeckBridgeDockerMutationsResolver(service),
        'prepareEdit',
        (args, ctx) => [
          args.containerId,
          args.input,
          args.updateImage,
          args.adoptTemplate,
          ctx,
        ],
      ],
    ],
    ...['install', 'edit', 'restart'].map((name) => [
      `DeckBridgeDockerMutations.${name}`,
      [
        new api.DeckBridgeDockerMutationsResolver(service),
        name,
        (args, ctx) => [args.input, ctx],
      ],
    ]),
  ]);
  for (const [field, [instance, name, parameters]] of bindings) {
    const [typeName, fieldName] = field.split('.');
    schema.getType(typeName).getFields()[fieldName].resolve = async (
      source,
      args,
      ctx,
      info,
    ) => {
      const handler = instance[name];
      const executionContext = {
        getType: () => 'graphql',
        getHandler: () => handler,
        getClass: () => instance.constructor,
        getArgs: () => [source, args, ctx, info],
      };
      for (const Guard of Reflect.getMetadata('__guards__', handler) ?? []) {
        assert.equal(Guard, api.DeckBridgeNamespaceGuard);
        namespaceGuard.canActivate(executionContext);
      }
      if (Reflect.getMetadata('__PERMISSIONS__', handler)) {
        if (!(await permissionGuard.canActivate(executionContext)))
          throw new ForbiddenException();
      }
      return handler.apply(instance, parameters(args, ctx));
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-host-'));
  const socket = path.join(dir, 'core.sock'),
    requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      actor: req.headers['x-bridge-actor'],
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/info')
      res.end(
        JSON.stringify({
          version: bridgePackage.version,
          accepting: true,
          dockerAvailable: true,
          capabilities: [
            'operations.events',
            'system.read',
            'plugins.read',
            'array.read',
            'system.preview',
            'system.execute',
            'plugins.preview',
            'plugins.execute',
            'plugins.uninstall',
            'array.preview',
            'array.execute',
            'docker.install',
            'docker.restart',
            'docker.read',
          ],
        }),
      );
    else if (
      req.url === '/system/preview' ||
      req.url === '/system/submit/reboot' ||
      req.url === '/docker/submit/restart'
    )
      res.end(JSON.stringify({ id: 'accepted-operation' }));
    else {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'Endpoint not found' },
        }),
      );
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = http.request.bind(http);
  t.mock.method(http, 'request', (options) =>
    request({ ...options, socketPath: socket }),
  );
  return {
    requests,
    run: (source, subject, variableValues) =>
      graphql({
        schema,
        source,
        variableValues,
        contextValue: { req: { user: subject } },
      }),
  };
}

const submit =
  'input:{planId:"plan-fixture",containerId:"server:container",requestId:"request-fixture"}';
const config =
  'input:{name:"fixture",image:"alpine:3",network:"bridge",privileged:false,start:false,autoStart:false,ports:[],mounts:[],environment:[],labels:[]}';
const mutationCases = [
  [
    'system',
    `prepare(input:{action:"REBOOT"})`,
    'OS',
    'UPDATE_ANY',
    'HOST_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'system',
    `shutdown(${submit})`,
    'OS',
    'UPDATE_ANY',
    'HOST_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'system',
    `reboot(${submit})`,
    'OS',
    'UPDATE_ANY',
    'HOST_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'plugins',
    'prepareUninstall(pluginId:"fixture")',
    'CONFIG',
    'DELETE_ANY',
    'HOST_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'plugins',
    `uninstall(${submit})`,
    'CONFIG',
    'DELETE_ANY',
    'HOST_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'array',
    'prepare(input:{action:"START"})',
    'ARRAY',
    'UPDATE_ANY',
    'HOST_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'array',
    `start(${submit})`,
    'ARRAY',
    'UPDATE_ANY',
    'HOST_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'array',
    `stop(${submit})`,
    'ARRAY',
    'UPDATE_ANY',
    'HOST_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'array',
    'prepareParity(input:{action:START,correct:false})',
    'ARRAY',
    'UPDATE_ANY',
    'HOST_COMPATIBILITY_UNVERIFIED',
  ],
  ...['startParity', 'pauseParity', 'resumeParity', 'cancelParity'].map(
    (name) => [
      'array',
      `${name}(${submit})`,
      'ARRAY',
      'UPDATE_ANY',
      'HOST_COMPATIBILITY_UNVERIFIED',
    ],
  ),
  [
    'docker',
    'importTemplate(input:{source:XML,xml:"<Container/>"})',
    'DOCKER',
    'CREATE_ANY',
    'DOCKER_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'docker',
    `prepareInstall(${config})`,
    'DOCKER',
    'CREATE_ANY',
    'DOCKER_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'docker',
    `prepareEdit(containerId:"server:container",${config})`,
    'DOCKER',
    'UPDATE_ANY',
    'DOCKER_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'docker',
    `install(${submit})`,
    'DOCKER',
    'CREATE_ANY',
    'DOCKER_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'docker',
    `edit(${submit})`,
    'DOCKER',
    'UPDATE_ANY',
    'DOCKER_COMPATIBILITY_UNVERIFIED',
  ],
  [
    'docker',
    `restart(${submit})`,
    'DOCKER',
    'UPDATE_ANY',
    'DOCKER_COMPATIBILITY_UNVERIFIED',
  ],
];
const mutation = (domain, field) =>
  `mutation { deckBridge { ${domain} { ${field} { id } } } }`;

test(
  'unknown stable OS real mutation guards reject every write before Unix Core IO',
  { concurrency: false },
  async (t) => {
    for (const version of ['6.12.0', '7.3.20'])
      await t.test(version, { concurrency: false }, async (t) => {
        const { report } = hostFixture(t, version);
        assert.equal(report.hostWriteSupported, false);
        assert.equal(report.verification, 'API_CONTRACT_ONLY');
        const { run, requests } = await execution(t);
        for (const [domain, field, resource, action, code] of mutationCases) {
          const query = mutation(domain, field);
          const result = await run(query, {
            id: 'authorized-writer',
            resource,
            action,
          });
          assert.equal(
            result.errors?.length,
            1,
            `${domain}.${field}: ${JSON.stringify(result.errors)}`,
          );
          assert.equal(
            result.errors[0].extensions.code,
            code,
            `${domain}.${field}`,
          );
          assert.equal(result.data, null);
          const anonymous = await run(query, undefined);
          assert.equal(anonymous.errors?.length, 1);
          assert.equal(anonymous.errors[0].extensions.code, 'UNAUTHENTICATED');
          if (domain !== 'docker') {
            const denied = await run(query, user('DOCKER'));
            assert.match(denied.errors?.[0]?.message ?? '', /forbidden/i);
          }
        }
        assert.deepEqual(requests, []);
      });
  },
);

test(
  'unknown OS GraphQL info exposes only read/event capabilities from real Core response',
  { concurrency: false },
  async (t) => {
    hostFixture(t, '7.3.20');
    const { run, requests } = await execution(t);
    const result = await run(
      '{ deckBridge { info { capabilities compatibility } } }',
      user('ME'),
    );
    assert.equal(result.errors, undefined);
    assert.deepEqual(result.data.deckBridge.info.capabilities, [
      'operations.events',
      'system.read',
      'plugins.read',
      'array.read',
    ]);
    const report = result.data.deckBridge.info.compatibility;
    assert.equal(Object.hasOwn(report, 'storageProfile'), false);
    assert.equal(report.dockerProfile, 'UNVERIFIED');
    assert.equal(report.hostWriteSupported, false);
    assert.equal(report.dockerWriteSupported, false);
    assert.equal(report.osEvidence, 'UNVERIFIED_OS_PROFILE');
    assert.equal(report.verification, 'API_CONTRACT_ONLY');
    assert.deepEqual(report.reasons, ['OS_PROFILE_UNVERIFIED']);
    assert.deepEqual(requests, [
      { method: 'GET', url: '/info', actor: 'host-reader' },
    ]);
  },
);

test(
  'audited OS Docker drift preserves host operations and the existing restart exception',
  { concurrency: false },
  async (t) => {
    const { report } = hostFixture(t, '7.2.3');
    assert.equal(report.hostWriteSupported, true);
    assert.equal(report.dockerWriteSupported, false);
    const { run, requests } = await execution(t);
    for (const [domain, field, resource] of [
      ['system', 'prepare(input:{action:"REBOOT"})', 'OS'],
      ['system', `reboot(${submit})`, 'OS'],
      ['docker', `restart(${submit})`, 'DOCKER'],
    ]) {
      const result = await run(mutation(domain, field), {
        id: 'authorized-writer',
        resource,
        action: 'UPDATE_ANY',
      });
      assert.equal(result.errors, undefined);
      assert.equal(
        result.data.deckBridge[domain][field.split('(')[0]].id,
        'accepted-operation',
      );
    }
    const denied = await run(mutation('docker', `install(${submit})`), {
      id: 'authorized-writer',
      resource: 'DOCKER',
      action: 'CREATE_ANY',
    });
    assert.equal(
      denied.errors?.[0]?.extensions.code,
      'DOCKER_COMPATIBILITY_UNVERIFIED',
    );
    assert.deepEqual(
      requests.map(({ url }) => url),
      [
        '/info',
        '/system/preview',
        '/info',
        '/system/submit/reboot',
        '/info',
        '/docker/submit/restart',
      ],
    );
  },
);
