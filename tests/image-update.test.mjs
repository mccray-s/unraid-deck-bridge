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
import ts from 'typescript';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { graphql, parse, validate } from 'graphql';
import * as api from '../dist/index.js';
import {
  compatibilityMatrix,
  resolveCompatibility,
  filterCapabilities,
} from '../dist/check-host.js';

// Exercise the official guard logic with only metadata and request access replaced.
const require = createRequire(import.meta.url);
const guardSource = fs
  .readFileSync(
    new URL('../vendor/unraid-authorization-4.37.4.ts', import.meta.url),
    'utf8',
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
const guardModule = ts
  .transpileModule(guardSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      experimentalDecorators: true,
      emitDecoratorMetadata: true,
    },
  })
  .outputText.replace(
    "from '@nestjs/common'",
    `from '${pathToFileURL(require.resolve('@nestjs/common')).href}'`,
  )
  .replace(
    "from 'nest-authz'",
    `from '${pathToFileURL(require.resolve('nest-authz')).href}'`,
  );
const { AuthorizationGuard } = await import(
  'data:text/javascript;base64,' + Buffer.from(guardModule).toString('base64')
);

const domains = [
  ['docker', 'Docker', 'DOCKER'],
  ['system', 'System', 'OS'],
  ['plugins', 'Plugin', 'CONFIG'],
  ['array', 'Array', 'ARRAY'],
];
const selection =
  'id domain kind status stage created updated name containerId oldId imageUpdate imageUpdateResult configurationResult startResult error{code message} events{sequence time stage code message} pullProgress{revision finished layers{id phase current total}}';
const subject = (resource = 'DOCKER', action = 'READ_ANY') => ({
  id: 'image-update-principal',
  resource,
  action,
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const operation = (domain = 'docker', fields = {}) => ({
  id: 'task',
  domain,
  kind:
    domain === 'docker'
      ? 'EDIT'
      : domain === 'system'
        ? 'REBOOT'
        : domain === 'plugins'
          ? 'UNINSTALL'
          : 'START',
  status: 'SUCCEEDED',
  stage: 'DONE',
  created: '2026-10-12T00:00:00Z',
  updated: '2026-10-12T00:00:01Z',
  name: 'fixture',
  events: [],
  ...fields,
});
const getQuery = (domain = 'docker', after = 0) =>
  `{deckBridge{operations{${domain}{get(id:"task",after:${after}){${selection}}}}}}`;
const byRequestQuery = (domain = 'docker', requestId = 'image-request') =>
  `{deckBridge{operations{${domain}{byRequestId(requestId:"${requestId}"){${selection}}}}}}`;
const configuration = {
  name: 'fixture',
  image: 'example/image:stable',
  network: 'bridge',
  privileged: false,
  start: true,
  autoStart: true,
  ports: [],
  mounts: [],
  environment: [],
  labels: [],
};
const prepareQuery =
  'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareEdit(containerId:"server:original",input:$input,updateImage:true){id kind source updateImage changeSummary{field} directoriesToCreate warnings}}}}';
const editQuery = `mutation{deckBridge{docker{edit(input:{planId:"plan",requestId:"image-request"}){${selection}}}}}`;
const installQuery = `mutation{deckBridge{docker{install(input:{planId:"plan",requestId:"install-request"}){${selection}}}}}`;

// Use the generated Nest schema, production resolvers and the official global
// fail-closed guard. Only Core transport and external App accessors are fixtures.
async function harness(
  t,
  {
    operations = new Map(),
    capabilities = [
      'docker.edit',
      'docker.fullConfiguration',
      'docker.imageUpdate',
      'docker.templateManagementRead',
    ],
    version = bridgePackage.version,
  } = {},
) {
  const app = await NestFactory.createApplicationContext(
    GraphQLSchemaBuilderModule,
    { logger: false },
  );
  t.after(() => app.close());
  const schema = await app.get(GraphQLSchemaFactory).create(api.resolvers);
  const namespaces = new api.DeckBridgeNamespaceGuard();
  const permissions = new AuthorizationGuard(
    new Reflector(),
    {
      enforce: async (user, resource, action) =>
        user?.resource === resource && user?.action === action,
    },
    {
      enablePossession: false,
      userFromContext: (ctx) =>
        GqlExecutionContext.create(ctx).getContext().req.user,
      resourceFromContext: (_ctx, p) => p.resource,
    },
  );
  const handlers = new api.DeckBridgeService(),
    fields = new api.DeckBridgeOperationResolver();
  const bindings = [
    [
      'Query',
      'deckBridge',
      new api.DeckBridgeRootResolver(),
      'query',
      () => [],
    ],
    [
      'Mutation',
      'deckBridge',
      new api.DeckBridgeRootResolver(),
      'mutation',
      () => [],
    ],
    [
      'DeckBridgeQueries',
      'operations',
      new api.DeckBridgeQueriesResolver(),
      'operations',
      () => [],
    ],
    [
      'DeckBridgeQueries',
      'info',
      new api.DeckBridgeQueriesResolver(handlers),
      'info',
      (_a, c) => [c],
    ],
    [
      'DeckBridgeMutations',
      'docker',
      new api.DeckBridgeMutationsResolver(),
      'docker',
      () => [],
    ],
    [
      'DeckBridgeDockerMutations',
      'prepareEdit',
      new api.DeckBridgeDockerMutationsResolver(handlers),
      'prepareEdit',
      (a, c) => [a.containerId, a.input, a.updateImage, a.adoptTemplate, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'edit',
      new api.DeckBridgeDockerMutationsResolver(handlers),
      'edit',
      (a, c) => [a.input, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'install',
      new api.DeckBridgeDockerMutationsResolver(handlers),
      'install',
      (a, c) => [a.input, c],
    ],
    [
      'DeckBridgeOperation',
      'imageUpdate',
      fields,
      'imageUpdate',
      (_a, _c, s) => [s],
    ],
    [
      'DeckBridgeOperation',
      'imageUpdateResult',
      fields,
      'imageUpdateResult',
      (_a, _c, s) => [s],
    ],
    [
      'DeckBridgeOperation',
      'configurationResult',
      fields,
      'configurationResult',
      (_a, _c, s) => [s],
    ],
    [
      'DeckBridgeOperation',
      'startResult',
      fields,
      'startResult',
      (_a, _c, s) => [s],
    ],
  ];
  for (const [domain, label] of domains) {
    bindings.push([
      'DeckBridgeOperationsQueries',
      domain,
      new api.DeckBridgeOperationsResolver(),
      domain,
      () => [],
    ]);
    const resolver = new api['DeckBridge' + label + 'OperationsResolver']();
    bindings.push([
      'DeckBridge' + label + 'Operations',
      'get',
      resolver,
      'get',
      (a, c) => [a.id, a.after, c],
    ]);
    bindings.push([
      'DeckBridge' + label + 'Operations',
      'byRequestId',
      resolver,
      'byRequestId',
      (a, c) => [a.requestId, c],
    ]);
  }
  for (const [type, field, instance, name, args] of bindings) {
    schema.getType(type).getFields()[field].resolve = async (
      source,
      input,
      context,
      info,
    ) => {
      const handler = instance[name],
        ec = {
          getType: () => 'graphql',
          getHandler: () => handler,
          getClass: () => instance.constructor,
          getArgs: () => [source, input, context, info],
        };
      for (const guard of Reflect.getMetadata('__guards__', handler) ?? []) {
        assert.equal(guard, api.DeckBridgeNamespaceGuard);
        namespaces.canActivate(ec);
      }
      if (!(await permissions.canActivate(ec))) throw new ForbiddenException();
      return handler.apply(instance, args(input, context, source));
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-image-update-')),
    socket = path.join(dir, 'core.sock'),
    requests = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    requests.push({
      path: req.url,
      method: req.method,
      actor: req.headers['x-bridge-actor'],
      body,
    });
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/info') {
      res.end(
        JSON.stringify({
          version,
          accepting: true,
          dockerAvailable: true,
          capabilities,
        }),
      );
      return;
    }
    if (url.pathname === '/docker/preview') {
      res.end(
        JSON.stringify({
          id: 'plan',
          kind: 'EDIT',
          expires: '2026-10-12T00:10:00Z',
          source: 'UNRAID_TEMPLATE',
          sourceAfter: 'UNRAID_TEMPLATE',
          targetContainerId: body.containerId,
          limitations: [],
          metadata: { iconUrl: '', webUi: '', shell: '' },
          updateImage: true,
          config: configuration,
          changed: [],
          changeSummary: [],
          directoriesToCreate: [],
          warnings: ['Application data writes are not rolled back'],
        }),
      );
      return;
    }
    if (url.pathname === '/docker/submit/edit') {
      res.end(JSON.stringify(operations.get('docker')));
      return;
    }
    if (url.pathname === '/docker/submit/install') {
      res.end(
        JSON.stringify(
          operation('docker', {
            kind: 'INSTALL',
            status: 'QUEUED',
            stage: 'QUEUED',
            imageUpdate: false,
            configurationResult: 'NOT_APPLIED',
            startResult: 'NOT_REQUESTED',
          }),
        ),
      );
      return;
    }
    if (
      url.pathname === '/operations' ||
      url.pathname === '/operations/by-request'
    ) {
      const value = operations.get(url.searchParams.get('domain'));
      if (
        url.pathname === '/operations/by-request' &&
        url.searchParams.get('requestId') !== 'image-request'
      ) {
        res.end('null');
        return;
      }
      if (value !== undefined) {
        res.end(JSON.stringify(value));
        return;
      }
    }
    res.statusCode = 404;
    res.end(
      JSON.stringify({
        error: { code: 'NOT_FOUND', message: 'Task unavailable' },
      }),
    );
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
    schema,
    requests,
    run: (source, user, variableValues) =>
      graphql({
        schema,
        source,
        contextValue: { req: { user } },
        variableValues,
      }),
  };
}

test('image update schema has a required boolean, nullable closed enum and no private recovery evidence', async (t) => {
  const { schema } = await harness(t);
  const fields = schema.getType('DeckBridgeOperation').getFields();
  assert.equal(String(fields.imageUpdate.type), 'Boolean!');
  assert.equal(
    String(fields.imageUpdateResult.type),
    'DeckBridgeImageUpdateResult',
  );
  assert.deepEqual(
    schema
      .getType('DeckBridgeImageUpdateResult')
      .getValues()
      .map((x) => x.name),
    ['IMAGE_UPDATED', 'IMAGE_UNCHANGED'],
  );
  assert.deepEqual(validate(schema, parse(getQuery())), []);
  assert.deepEqual(
    validate(
      schema,
      parse(byRequestQuery('docker', 'bridge-image-update-contract')),
    ),
    [],
  );
  for (const privateField of ['expectedFingerprint', 'ExpectedFingerprint']) {
    assert.equal(fields[privateField], undefined);
    assert.ok(
      validate(
        schema,
        parse(
          `{deckBridge{operations{docker{get(id:"task"){${privateField}}}}}}`,
        ),
      ).length > 0,
    );
  }
  assert.equal(
    schema.getType('DeckBridgeDockerMutations').getFields().update,
    undefined,
  );
  const contract = JSON.parse(
    fs.readFileSync(
      new URL('../contracts/openapi.json', import.meta.url),
      'utf8',
    ),
  );
  const op = contract.components.schemas.Operation;
  assert.equal(op.additionalProperties, false);
  assert.ok(op.required.includes('imageUpdate'));
  assert.equal(op.properties.imageUpdate.type, 'boolean');
  assert.ok(!op.required.includes('imageUpdateResult'));
  assert.deepEqual(op.properties.imageUpdateResult.type, ['string', 'null']);
  assert.deepEqual(op.properties.imageUpdateResult.enum, [
    'IMAGE_UPDATED',
    'IMAGE_UNCHANGED',
    null,
  ]);
  const event = contract.components.schemas.Event;
  assert.equal(
    String(schema.getType('DeckBridgeEvent').getFields().code.type),
    'String',
  );
  assert.ok(!event.required.includes('code'));
  assert.deepEqual(event.properties.code.type, ['string', 'null']);
  assert.ok(!op.properties.kind.enum.includes('UPDATE'));
  assert.equal(op.properties.expectedFingerprint, undefined);
  assert.equal(op.properties.ExpectedFingerprint, undefined);
  assert.ok(contract.paths['/docker/image-updates/preview']);
  assert.ok(
    !Object.keys(contract.paths).some((x) => x.includes('/submit/update')),
  );
});

for (const result of ['IMAGE_UPDATED', 'IMAGE_UNCHANGED'])
  test(
    result +
      ' persists through task reads, request lookup and event cursor changes',
    async (t) => {
      const original =
        result === 'IMAGE_UNCHANGED' ? 'original' : 'replacement';
      const value = operation('docker', {
        imageUpdate: true,
        imageUpdateResult: result,
        containerId: original,
        oldId: 'original',
        expectedFingerprint: 'private-journal-evidence',
        pullProgress: null,
      });
      const { run, requests } = await harness(t, {
        operations: new Map([['docker', value]]),
      });
      for (const after of [0, 999]) {
        const out = await run(getQuery('docker', after), subject());
        assert.equal(out.errors, undefined);
        const read = plain(out.data.deckBridge.operations.docker.get);
        assert.equal(read.imageUpdate, true);
        assert.equal(read.imageUpdateResult, result);
        assert.equal(read.containerId, original);
        assert.equal(read.oldId, 'original');
        assert.deepEqual(read.events, []);
        assert.equal(read.pullProgress, null);
        assert.ok(!JSON.stringify(out).includes('private-journal-evidence'));
      }
      const found = await run(byRequestQuery(), subject());
      assert.equal(found.errors, undefined);
      assert.equal(
        found.data.deckBridge.operations.docker.byRequestId.imageUpdateResult,
        result,
      );
      assert.deepEqual(
        requests.map((x) => [x.path, x.method, x.actor]),
        [
          [
            '/operations?domain=docker&id=task&after=0',
            'GET',
            'image-update-principal',
          ],
          [
            '/operations?domain=docker&id=task&after=999',
            'GET',
            'image-update-principal',
          ],
          [
            '/operations/by-request?domain=docker&requestId=image-request',
            'GET',
            'image-update-principal',
          ],
        ],
      );
      const probe = await run(
        byRequestQuery('docker', 'bridge-image-update-contract'),
        subject(),
      );
      assert.equal(probe.errors, undefined);
      assert.equal(probe.data.deckBridge.operations.docker.byRequestId, null);
    },
  );

test('historical and ordinary tasks read false/null without inventing an image outcome', async (t) => {
  const operations = new Map(),
    { run } = await harness(t, { operations });
  for (const [domain, , resource] of domains) {
    const cases = [{}, { imageUpdate: false, imageUpdateResult: null }];
    if (domain !== 'docker')
      cases.push({ imageUpdate: true, imageUpdateResult: 'IMAGE_UPDATED' });
    else
      cases.push(
        { imageUpdate: true },
        { imageUpdate: true, imageUpdateResult: null },
        { imageUpdate: false, imageUpdateResult: 'IMAGE_UPDATED' },
      );
    for (const fields of cases) {
      operations.set(domain, operation(domain, fields));
      for (const query of [getQuery(domain), byRequestQuery(domain)]) {
        const out = await run(query, subject(resource));
        assert.equal(out.errors, undefined);
        const read =
          out.data.deckBridge.operations[domain][
            query === getQuery(domain) ? 'get' : 'byRequestId'
          ];
        assert.equal(
          read.imageUpdate,
          domain === 'docker' && fields.imageUpdate === true,
        );
        assert.equal(read.imageUpdateResult, null);
      }
    }
  }
  for (const kind of ['INSTALL', 'ENGINE_EDIT', 'EDIT', 'RESTART']) {
    operations.set('docker', operation('docker', { kind, imageUpdate: false }));
    const out = await run(getQuery(), subject());
    assert.equal(out.errors, undefined);
    assert.equal(out.data.deckBridge.operations.docker.get.imageUpdate, false);
    assert.equal(
      out.data.deckBridge.operations.docker.get.imageUpdateResult,
      null,
    );
  }
});

test('shared operation receipt fields remain nullable closed enums for unrelated operations', async (t) => {
  const { schema } = await harness(t);
  const fields = schema.getType('DeckBridgeOperation').getFields();
  const operationSchema = JSON.parse(
    fs.readFileSync(
      new URL('../contracts/openapi.json', import.meta.url),
      'utf8',
    ),
  ).components.schemas.Operation;
  for (const [field, type, values] of [
    [
      'configurationResult',
      'DeckBridgeConfigurationResult',
      ['NOT_APPLIED', 'APPLIED', 'UNKNOWN'],
    ],
    [
      'startResult',
      'DeckBridgeStartResult',
      ['NOT_REQUESTED', 'ACCEPTED', 'FAILED', 'UNKNOWN'],
    ],
  ]) {
    assert.equal(String(fields[field].type), type);
    assert.deepEqual(
      schema
        .getType(type)
        .getValues()
        .map((value) => value.name),
      values,
    );
    assert.ok(!operationSchema.required.includes(field));
    assert.deepEqual(operationSchema.properties[field].type, [
      'string',
      'null',
    ]);
    assert.deepEqual(operationSchema.properties[field].enum, [...values, null]);
  }
});

test('ordinary configuration results survive read and lookup without inferring from status or stage', async (t) => {
  const operations = new Map(),
    { run } = await harness(t, { operations });
  for (const kind of [
    'INSTALL',
    'EDIT',
    'ENGINE_EDIT',
    'TEMPLATE_ADOPT',
    'TEMPLATE_REPLACE',
  ]) {
    for (const configurationResult of ['NOT_APPLIED', 'APPLIED', 'UNKNOWN']) {
      for (const startResult of [
        'NOT_REQUESTED',
        'ACCEPTED',
        'FAILED',
        'UNKNOWN',
      ]) {
        operations.set(
          'docker',
          operation('docker', {
            kind,
            imageUpdate: false,
            configurationResult,
            startResult,
            status: 'NEEDS_ATTENTION',
            stage: 'COMMITTED',
            containerId: 'candidate',
          }),
        );
        for (const query of [getQuery(), byRequestQuery()]) {
          const out = await run(query, subject());
          assert.equal(out.errors, undefined);
          const value =
            out.data.deckBridge.operations.docker[
              query === getQuery() ? 'get' : 'byRequestId'
            ];
          assert.equal(value.configurationResult, configurationResult);
          assert.equal(value.startResult, startResult);
          assert.equal(value.status, 'NEEDS_ATTENTION');
          assert.equal(value.stage, 'COMMITTED');
          assert.equal(value.containerId, 'candidate');
        }
      }
    }
  }
});

test('Bridge does not manufacture UNKNOWN receipts from malformed Core configuration records', async (t) => {
  const operations = new Map(),
    { run } = await harness(t, { operations });
  for (const kind of [
    'INSTALL',
    'EDIT',
    'ENGINE_EDIT',
    'TEMPLATE_ADOPT',
    'TEMPLATE_REPLACE',
  ]) {
    for (const fields of [
      {},
      { configurationResult: null, startResult: null },
      { configurationResult: 'APPLIED' },
      { startResult: 'ACCEPTED' },
    ]) {
      operations.set('docker', operation('docker', { kind, ...fields }));
      for (const query of [getQuery(), byRequestQuery()]) {
        const out = await run(query, subject());
        assert.equal(out.errors, undefined);
        const value =
          out.data.deckBridge.operations.docker[
            query === getQuery() ? 'get' : 'byRequestId'
          ];
        assert.equal(
          value.configurationResult,
          fields.configurationResult ?? null,
        );
        assert.equal(value.startResult, fields.startResult ?? null);
      }
    }
  }
});

test('committed install Start rejection stays terminal FAILED while an explicit unknown stays unresolved', async (t) => {
  const operations = new Map(),
    { run } = await harness(t, { operations });
  for (const [startResult, status, code] of [
    ['FAILED', 'FAILED', 'START_FAILED'],
    ['UNKNOWN', 'NEEDS_ATTENTION', 'RECOVERY_REQUIRED'],
  ]) {
    operations.set(
      'docker',
      operation('docker', {
        kind: 'INSTALL',
        imageUpdate: false,
        configurationResult: 'APPLIED',
        startResult,
        status,
        stage: 'COMMITTED',
        containerId: 'installed',
        error: { code, message: 'Start outcome' },
      }),
    );
    for (const query of [getQuery(), byRequestQuery()]) {
      const out = await run(query, subject());
      assert.equal(out.errors, undefined);
      const value =
        out.data.deckBridge.operations.docker[
          query === getQuery() ? 'get' : 'byRequestId'
        ];
      assert.equal(value.configurationResult, 'APPLIED');
      assert.equal(value.startResult, startResult);
      assert.equal(value.status, status);
      assert.equal(value.containerId, 'installed');
      assert.equal(value.error.code, code);
    }
  }
});

test('configuration results cannot leak from other domains, pure updates or unrelated kinds', async (t) => {
  const operations = new Map(),
    { run } = await harness(t, { operations });
  const configurationKinds = [
    'INSTALL',
    'EDIT',
    'ENGINE_EDIT',
    'TEMPLATE_ADOPT',
    'TEMPLATE_REPLACE',
  ];
  for (const [domain, , resource] of domains) {
    const cases =
      domain === 'docker'
        ? [
            ...configurationKinds.map((kind) => ({ kind, imageUpdate: true })),
            ...[
              'RESTART',
              'ENGINE_IMAGE_UPDATE',
              'IMAGE_UPDATE_BATCH',
              'UNKNOWN_KIND',
            ].map((kind) => ({ kind, imageUpdate: false })),
          ]
        : configurationKinds.map((kind) => ({ kind, imageUpdate: false }));
    for (const fields of cases) {
      operations.set(
        domain,
        operation(domain, {
          ...fields,
          configurationResult: 'APPLIED',
          startResult: 'ACCEPTED',
        }),
      );
      for (const query of [getQuery(domain), byRequestQuery(domain)]) {
        const out = await run(query, subject(resource));
        assert.equal(out.errors, undefined);
        const value =
          out.data.deckBridge.operations[domain][
            query === getQuery(domain) ? 'get' : 'byRequestId'
          ];
        assert.equal(value.configurationResult, null);
        assert.equal(value.startResult, null);
      }
    }
  }
});

test('committed image replacement needing attention does not become success in GraphQL', async (t) => {
  const value = operation('docker', {
    imageUpdate: true,
    imageUpdateResult: 'IMAGE_UPDATED',
    status: 'NEEDS_ATTENTION',
    stage: 'COMMITTED',
    containerId: 'replacement',
    oldId: 'original',
    error: { code: 'BACKUP_CLEANUP_FAILED', message: 'Backup needs attention' },
  });
  const { run } = await harness(t, {
    operations: new Map([['docker', value]]),
  });
  const out = await run(getQuery(), subject());
  assert.equal(out.errors, undefined);
  const read = out.data.deckBridge.operations.docker.get;
  assert.equal(read.status, 'NEEDS_ATTENTION');
  assert.equal(read.stage, 'COMMITTED');
  assert.equal(read.imageUpdateResult, 'IMAGE_UPDATED');
  assert.equal(read.containerId, 'replacement');
  assert.equal(read.error.code, 'BACKUP_CLEANUP_FAILED');
});

test('task result and contract probe require each domain READ before any Core IO', async (t) => {
  const { run, requests } = await harness(t, {
    operations: new Map(domains.map(([domain]) => [domain, operation(domain)])),
  });
  for (const [domain, , resource] of domains)
    for (const user of [
      undefined,
      subject(resource, 'UPDATE_ANY'),
      subject(resource, 'CREATE_ANY'),
      subject('ME'),
    ]) {
      for (const query of [
        getQuery(domain),
        byRequestQuery(domain),
        byRequestQuery(domain, 'bridge-image-update-contract'),
      ]) {
        const out = await run(query, user);
        assert.ok(out.errors?.length);
        assert.equal(requests.length, 0);
      }
    }
});

test('pure image preparation and existing EDIT submission retain only Docker UPDATE permission', async (t) => {
  const { run, requests } = await harness(t, {
    operations: new Map([
      [
        'docker',
        operation('docker', {
          status: 'QUEUED',
          stage: 'QUEUED',
          imageUpdate: true,
        }),
      ],
    ]),
  });
  const prepared = await run(prepareQuery, subject('DOCKER', 'UPDATE_ANY'), {
    input: configuration,
  });
  assert.equal(prepared.errors, undefined);
  assert.equal(prepared.data.deckBridge.docker.prepareEdit.kind, 'EDIT');
  assert.equal(prepared.data.deckBridge.docker.prepareEdit.updateImage, true);
  assert.deepEqual(
    requests.map((x) => x.path),
    ['/info', '/docker/preview'],
  );
  assert.equal(requests.at(-1).body.containerId, 'original');
  assert.equal(requests.at(-1).body.updateImage, true);
  assert.deepEqual(requests.at(-1).body.config, configuration);
  requests.length = 0;
  const submitted = await run(editQuery, subject('DOCKER', 'UPDATE_ANY'));
  assert.equal(submitted.errors, undefined);
  assert.equal(submitted.data.deckBridge.docker.edit.imageUpdate, true);
  assert.equal(submitted.data.deckBridge.docker.edit.imageUpdateResult, null);
  assert.equal(submitted.data.deckBridge.docker.edit.configurationResult, null);
  assert.equal(submitted.data.deckBridge.docker.edit.startResult, null);
  assert.deepEqual(
    requests.map((x) => x.path),
    ['/info', '/docker/submit/edit'],
  );
  assert.deepEqual(requests.at(-1).body, {
    planId: 'plan',
    requestId: 'image-request',
  });
  for (const user of [
    undefined,
    subject(),
    subject('DOCKER', 'CREATE_ANY'),
    subject('ME', 'UPDATE_ANY'),
  ])
    for (const query of [prepareQuery, editQuery]) {
      requests.length = 0;
      assert.ok(
        (await run(query, user, { input: configuration })).errors?.length,
      );
      assert.equal(requests.length, 0);
    }
});

test('install receipt is readable with CREATE permission without adding READ or UPDATE', async (t) => {
  const { run, requests } = await harness(t);
  const submitted = await run(installQuery, subject('DOCKER', 'CREATE_ANY'));
  assert.equal(submitted.errors, undefined);
  assert.equal(submitted.data.deckBridge.docker.install.kind, 'INSTALL');
  assert.equal(submitted.data.deckBridge.docker.install.imageUpdate, false);
  assert.equal(
    submitted.data.deckBridge.docker.install.imageUpdateResult,
    null,
  );
  assert.equal(
    submitted.data.deckBridge.docker.install.configurationResult,
    'NOT_APPLIED',
  );
  assert.equal(
    submitted.data.deckBridge.docker.install.startResult,
    'NOT_REQUESTED',
  );
  assert.deepEqual(
    requests.map((x) => x.path),
    ['/info', '/docker/submit/install'],
  );
  assert.deepEqual(requests.at(-1).body, {
    planId: 'plan',
    requestId: 'install-request',
  });
  for (const user of [
    undefined,
    subject(),
    subject('DOCKER', 'UPDATE_ANY'),
    subject('ME', 'CREATE_ANY'),
  ]) {
    requests.length = 0;
    assert.ok((await run(installQuery, user)).errors?.length);
    assert.equal(requests.length, 0);
  }
});

test('Bridge info forwards declared write capabilities without inventing them for an older Core', async (t) => {
  const capabilities = ['docker.edit', 'docker.fullConfiguration'];
  const { run } = await harness(t, { capabilities });
  const query = '{deckBridge{info{coreOnline compatible capabilities}}}';
  let out = await run(query, subject('ME'));
  assert.equal(out.errors, undefined);
  assert.deepEqual(out.data.deckBridge.info.capabilities, capabilities);
  for (const capability of [
    'docker.imageUpdate',
    'docker.configurationFeedback',
  ])
    assert.ok(!out.data.deckBridge.info.capabilities.includes(capability));
  capabilities.push('docker.imageUpdate', 'docker.configurationFeedback');
  out = await run(query, subject('ME'));
  assert.equal(out.errors, undefined);
  assert.deepEqual(out.data.deckBridge.info.capabilities, capabilities);
});

test('mismatched Core cannot advertise enhanced image-update capability', async (t) => {
  const { run } = await harness(t, { version: '0.5.0' });
  const out = await run(
    '{deckBridge{info{compatible capabilities reason}}}',
    subject('ME'),
  );
  assert.equal(out.errors, undefined);
  assert.equal(out.data.deckBridge.info.compatible, false);
  assert.deepEqual(out.data.deckBridge.info.capabilities, []);
  assert.equal(out.data.deckBridge.info.reason, 'CORE_VERSION_MISMATCH');
});

test('audited host capability policy strips enhanced Docker writes on Docker drift and unknown OS', () => {
  const dependencies = compatibilityMatrix.api['4.36.1'].dependencies,
    known = compatibilityMatrix.os['7.3.2'];
  const capabilities = [
    'operations.events',
    'docker.read',
    'docker.restart',
    'docker.edit',
    'docker.fullConfiguration',
    'docker.imageUpdate',
    'docker.configurationFeedback',
  ];
  const matching = resolveCompatibility(
    '7.3.2',
    '4.36.1',
    'x64',
    dependencies,
    known.dockerFiles,
  );
  assert.deepEqual(filterCapabilities(matching, capabilities), capabilities);
  const drift = resolveCompatibility(
    '7.3.2',
    '4.36.1',
    'x64',
    dependencies,
    {},
  );
  assert.equal(drift.dockerWriteSupported, false);
  assert.deepEqual(filterCapabilities(drift, capabilities), [
    'operations.events',
    'docker.read',
    'docker.restart',
  ]);
  const unknown = resolveCompatibility(
    '7.3.20',
    '4.36.1',
    'x64',
    dependencies,
    known.dockerFiles,
  );
  assert.equal(unknown.hostWriteSupported, false);
  assert.deepEqual(filterCapabilities(unknown, capabilities), [
    'operations.events',
  ]);
  assert.deepEqual(
    filterCapabilities(matching, ['docker.edit', 'docker.fullConfiguration']),
    ['docker.edit', 'docker.fullConfiguration'],
  );
});

for (const [osVersion, expected] of [
  ['7.3.2', ['operations.events', 'docker.read', 'docker.restart']],
  ['7.3.20', ['operations.events']],
])
  test(
    'real GraphQL info strips enhanced Docker writes for unaudited host ' +
      osVersion,
    async (t) => {
      const capabilities = [
        'operations.events',
        'docker.read',
        'docker.restart',
        'docker.edit',
        'docker.fullConfiguration',
        'docker.imageUpdate',
        'docker.configurationFeedback',
      ];
      const { run } = await harness(t, { capabilities });
      // Supply only local host-file fixtures to production assertSupportedHost.
      // Known OS gets mismatched Docker files; unknown OS gets no write profile.
      const arch = Object.getOwnPropertyDescriptor(process, 'arch');
      Object.defineProperty(process, 'arch', { ...arch, value: 'x64' });
      t.after(() => Object.defineProperty(process, 'arch', arch));
      const files = new Map([
        ['/etc/unraid-version', `version="${osVersion}"\n`],
        [
          '/usr/local/unraid-api/package.json',
          JSON.stringify({ version: '4.36.1' }),
        ],
      ]);
      for (const [name, version] of Object.entries(
        compatibilityMatrix.api['4.36.1'].dependencies,
      )) {
        files.set(
          path.join('/usr/local/unraid-api/node_modules', name, 'package.json'),
          JSON.stringify({ version }),
        );
      }
      for (const file of Object.keys(
        compatibilityMatrix.os['7.3.2'].dockerFiles,
      ))
        files.set(file, Buffer.from('unaudited Docker Manager fixture'));
      const exists = fs.existsSync.bind(fs),
        read = fs.readFileSync.bind(fs);
      t.mock.method(
        fs,
        'existsSync',
        (file) => files.has(file) || exists(file),
      );
      t.mock.method(fs, 'readFileSync', (file, ...args) =>
        files.has(file) ? files.get(file) : read(file, ...args),
      );
      const out = await run(
        '{deckBridge{info{compatible capabilities compatibility}}}',
        subject('ME'),
      );
      assert.equal(out.errors, undefined);
      assert.equal(out.data.deckBridge.info.compatible, true);
      assert.deepEqual(out.data.deckBridge.info.capabilities, expected);
      assert.equal(
        out.data.deckBridge.info.compatibility.dockerWriteSupported,
        false,
      );
    },
  );
