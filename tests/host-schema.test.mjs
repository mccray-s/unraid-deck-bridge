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
import { compatibilityMatrix } from '../dist/check-host.js';

const user = (resource) => ({
  id: 'host-reader',
  resource,
  action: 'READ_ANY',
});

function hostFixture(t, version, apiVersion = '5.0.0') {
  const dependencies = Object.fromEntries(
    Object.entries(compatibilityMatrix.minimumDependencies).map(
      ([name, value]) => {
        const parts = value.split('.').map(Number);
        parts[2] += 1;
        return [name, parts.join('.')];
      },
    ),
  );
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
}
async function execution(
  t,
  { coreVersion = bridgePackage.version, dockerAvailable = true } = {},
) {
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
          version: coreVersion,
          accepting: true,
          dockerAvailable,
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
  ['system', 'prepare(input:{action:"REBOOT"})', 'OS', 'UPDATE_ANY'],
  ['system', `shutdown(${submit})`, 'OS', 'UPDATE_ANY'],
  ['system', `reboot(${submit})`, 'OS', 'UPDATE_ANY'],
  ['plugins', 'prepareUninstall(pluginId:"fixture")', 'CONFIG', 'DELETE_ANY'],
  ['plugins', `uninstall(${submit})`, 'CONFIG', 'DELETE_ANY'],
  ['array', 'prepare(input:{action:"START"})', 'ARRAY', 'UPDATE_ANY'],
  ['array', `start(${submit})`, 'ARRAY', 'UPDATE_ANY'],
  ['array', `stop(${submit})`, 'ARRAY', 'UPDATE_ANY'],
  [
    'array',
    'prepareParity(input:{action:START,correct:false})',
    'ARRAY',
    'UPDATE_ANY',
  ],
  ...['startParity', 'pauseParity', 'resumeParity', 'cancelParity'].map(
    (name) => ['array', `${name}(${submit})`, 'ARRAY', 'UPDATE_ANY'],
  ),
  [
    'docker',
    'importTemplate(input:{source:XML,xml:"<Container/>"})',
    'DOCKER',
    'CREATE_ANY',
  ],
  ['docker', `prepareInstall(${config})`, 'DOCKER', 'CREATE_ANY'],
  [
    'docker',
    `prepareEdit(containerId:"server:container",${config})`,
    'DOCKER',
    'UPDATE_ANY',
  ],
  ['docker', `install(${submit})`, 'DOCKER', 'CREATE_ANY'],
  ['docker', `edit(${submit})`, 'DOCKER', 'UPDATE_ANY'],
  ['docker', `restart(${submit})`, 'DOCKER', 'UPDATE_ANY'],
];
const mutation = (domain, field) =>
  `mutation { deckBridge { ${domain} { ${field} { id } } } }`;

test(
  'newer stable hosts preserve mutation authorization before Unix Core IO',
  { concurrency: false },
  async (t) => {
    for (const version of ['7.3.4', '8.0.0'])
      await t.test(version, { concurrency: false }, async (t) => {
        hostFixture(t, version);
        const { run, requests } = await execution(t);
        for (const [domain, field] of mutationCases) {
          const query = mutation(domain, field);
          const anonymous = await run(query, undefined);
          assert.equal(anonymous.errors?.length, 1);
          assert.equal(anonymous.errors[0].extensions.code, 'UNAUTHENTICATED');
          const denied = await run(query, user('ME'));
          assert.match(denied.errors?.[0]?.message ?? '', /forbidden/i);
        }
        assert.deepEqual(requests, []);
      });
  },
);

test(
  'newer OS and API forward exactly the capabilities declared by Core',
  { concurrency: false },
  async (t) => {
    hostFixture(t, '7.3.4');
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
    ]);
    assert.equal(
      result.data.deckBridge.info.compatibility.hostWriteSupported,
      true,
    );
    assert.equal(
      result.data.deckBridge.info.compatibility.dockerWriteSupported,
      true,
    );
    assert.deepEqual(requests, [
      { method: 'GET', url: '/info', actor: 'host-reader' },
    ]);
  },
);

test(
  'newer stable OS and API retain supported host and Docker writes',
  { concurrency: false },
  async (t) => {
    hostFixture(t, '8.0.0');
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
    const unavailable = await run(mutation('docker', `install(${submit})`), {
      id: 'authorized-writer',
      resource: 'DOCKER',
      action: 'CREATE_ANY',
    });
    assert.equal(unavailable.errors?.[0]?.extensions.code, 'NOT_FOUND');
    assert.deepEqual(
      requests.map(({ url }) => url),
      [
        '/info',
        '/system/preview',
        '/info',
        '/system/submit/reboot',
        '/info',
        '/docker/submit/restart',
        '/info',
        '/docker/submit/install',
      ],
    );
  },
);

for (const [coreState, expected] of [
  [{ dockerAvailable: false }, 'DOCKER_UNAVAILABLE'],
  [{ coreVersion: '0.0.0' }, 'CORE_VERSION_MISMATCH'],
])
  test(
    `newer hosts still reject Docker writes for ${expected}`,
    { concurrency: false },
    async (t) => {
      hostFixture(t, '7.3.4');
      const { run, requests } = await execution(t, coreState);
      const result = await run(mutation('docker', `restart(${submit})`), {
        id: 'authorized-writer',
        resource: 'DOCKER',
        action: 'UPDATE_ANY',
      });
      assert.equal(result.errors?.[0]?.extensions.code, expected);
      assert.deepEqual(
        requests.map(({ url }) => url),
        ['/info'],
      );
    },
  );
