import test from 'node:test';
import assert from 'node:assert/strict';
import bridgePackage from '../dist/package.json' with { type: 'json' };
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  GqlExecutionContext,
} from '@nestjs/graphql';
import { graphql, subscribe, parse, validate } from 'graphql';
import * as api from '../dist/index.js';
import {
  filterCapabilities,
  compatibilityMatrix,
  resolveCompatibility,
} from '../dist/check-host.js';

// Run the pinned official authorization guard; only its external App accessors
// are replaced. Schema, resolvers, principal extraction and socket client are real.
const require = createRequire(import.meta.url);
const officialGuard = fs.readFileSync(
  new URL('../vendor/unraid-authorization-4.37.4.ts', import.meta.url),
  'utf8',
);
const source = officialGuard
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
const compiled = ts
  .transpileModule(source, {
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
  'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
);
const user = (action = 'READ_ANY', resource = 'DOCKER', id = 'reader') => ({
  id,
  resource,
  action,
});
const target = {
  checkId: 'check',
  containerId: 'server:container',
  currentImageId: 'sha256:old',
  revision: 2,
};
const item = (fields = {}) => ({
  containerId: 'container',
  name: 'fixture',
  currentImageId: 'sha256:old',
  imageReference: 'example/image:latest',
  platform: { os: 'linux', architecture: 'amd64' },
  source: 'ENGINE_INSPECT',
  state: 'COMPLETED',
  availability: 'AVAILABLE',
  canUpdate: true,
  checkedAt: '2026-10-18T00:00:00Z',
  expiresAt: '2026-10-18T00:15:00Z',
  fromCache: false,
  revision: 2,
  remoteImageId: 'sha256:new',
  ...fields,
});
const check = (fields = {}) => ({
  id: 'check',
  status: 'RUNNING',
  revision: 2,
  eventSequence: 2,
  total: 2,
  completed: 1,
  available: 1,
  skipped: 0,
  failed: 0,
  created: '2026-10-18T00:00:00Z',
  updated: '2026-10-18T00:00:01Z',
  items: [
    item(),
    item({
      containerId: 'slow',
      state: 'PENDING',
      availability: 'UNKNOWN',
      canUpdate: false,
      revision: 0,
    }),
  ],
  ...fields,
});
const operation = (fields = {}) => ({
  id: 'parent',
  domain: 'docker',
  kind: 'IMAGE_UPDATE_BATCH',
  status: 'RUNNING',
  stage: 'QUEUED',
  canCancel: true,
  cancelRequested: false,
  created: '2026-10-18T00:00:00Z',
  updated: '2026-10-18T00:00:01Z',
  name: 'fixture',
  imageUpdate: false,
  events: [],
  ...fields,
});
const batchItem = (fields = {}) => ({
  index: 0,
  revision: 1,
  sourceContainerId: 'container',
  currentImageId: 'sha256:old',
  status: 'RUNNING',
  operationId: 'child',
  ...fields,
});
const batch = (fields = {}) => ({
  id: 'parent',
  status: 'RUNNING',
  revision: 2,
  eventSequence: 2,
  canCancel: true,
  cancelRequested: false,
  total: 2,
  completed: 0,
  updated: 0,
  unchanged: 0,
  failed: 0,
  skipped: 0,
  needsAttention: 0,
  cancelled: 0,
  items: [batchItem()],
  activeOperation: operation({
    id: 'child',
    kind: 'ENGINE_IMAGE_UPDATE',
    imageUpdate: true,
    stage: 'PULL',
    pullProgress: {
      revision: 1,
      finished: false,
      layers: [
        { id: 'abcdef123456', phase: 'DOWNLOADING', current: 2, total: 10 },
      ],
    },
  }),
  ...fields,
});
const itemFields =
  'containerId name currentImageId imageReference platform{os architecture variant} source state availability canUpdate reasonCode checkedAt expiresAt fromCache revision remoteImageId';
const checkFields = `id status revision eventSequence total completed available skipped failed created updated nextRefreshAt items{${itemFields}} nextOffset error{code message}`;
const batchFields =
  'id status revision eventSequence total completed updated unchanged failed skipped needsAttention nextOffset items{index revision sourceContainerId currentImageId operationId status resultContainerId reasonCode imageUpdateResult} activeOperation{id kind stage status imageUpdate imageUpdateResult error{code message} pullProgress{revision finished layers{id phase current total}}}';
const accessQuery =
  '{deckBridge{docker{updateAccess{principalId coreOnline dockerAvailable capabilities reason}}}}';
const readQuery = `{deckBridge{docker{updateCheck{${checkFields}}}}}`;
const batchQuery = `{deckBridge{operations{docker{imageUpdateBatch(id:"parent"){${batchFields}}}}}}`;
const startMutation = `mutation{deckBridge{docker{checkUpdates(requestId:"check-request"){${checkFields}}}}}`;
const prepareMutation =
  'mutation($input:DeckBridgeImageUpdateTargetInput!){deckBridge{docker{prepareImageUpdate(input:$input){id kind source updateImage changeSummary{field} directoriesToCreate warnings}}}}';
const batchMutation =
  'mutation($input:DeckBridgeImageUpdateBatchInput!){deckBridge{docker{updateContainers(input:$input){id kind status imageUpdate}}}}';
const checkSubscription =
  'subscription{deckBridgeDockerUpdateCheckEvents(id:"check",after:2){sequence kind status completed total item{containerId state availability revision}}}';
const batchSubscription =
  'subscription{deckBridgeDockerImageUpdateBatchEvents(id:"parent",after:2){sequence kind status completed total item{index revision status} activeOperation{id stage status pullProgress{revision layers{id phase current total}}}}}';

async function harness(t, { respond } = {}) {
  const app = await NestFactory.createApplicationContext(
    GraphQLSchemaBuilderModule,
    { logger: false },
  );
  t.after(() => app.close());
  const schema = await app.get(GraphQLSchemaFactory).create(api.resolvers);
  const guard = new AuthorizationGuard(
    new Reflector(),
    { enforce: async (u, r, a) => u?.resource === r && u?.action === a },
    {
      enablePossession: false,
      userFromContext: (ctx) =>
        GqlExecutionContext.create(ctx).getContext().req.user,
      resourceFromContext: (_ctx, p) => p.resource,
    },
  );
  const namespace = new api.DeckBridgeNamespaceGuard(),
    service = new api.DeckBridgeService();
  const queries = new api.DeckBridgeDockerQueriesResolver(service),
    mutations = new api.DeckBridgeDockerMutationsResolver(service),
    events = new api.DeckBridgeDockerEventsResolver(),
    operations = new api.DeckBridgeDockerOperationsResolver();
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
      'docker',
      new api.DeckBridgeQueriesResolver(service),
      'docker',
      () => [],
    ],
    [
      'DeckBridgeQueries',
      'operations',
      new api.DeckBridgeQueriesResolver(service),
      'operations',
      () => [],
    ],
    [
      'DeckBridgeMutations',
      'docker',
      new api.DeckBridgeMutationsResolver(),
      'docker',
      () => [],
    ],
    [
      'DeckBridgeOperationsQueries',
      'docker',
      new api.DeckBridgeOperationsResolver(),
      'docker',
      () => [],
    ],
    [
      'DeckBridgeDockerQueries',
      'updateAccess',
      queries,
      'updateAccess',
      (_a, c) => [c],
    ],
    [
      'DeckBridgeDockerQueries',
      'updateCheck',
      queries,
      'updateCheck',
      (a, c) => [a.id, a.offset, a.limit, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'checkUpdates',
      mutations,
      'checkUpdates',
      (a, c) => [a.requestId, a.force, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'prepareImageUpdate',
      mutations,
      'prepareImageUpdate',
      (a, c) => [a.input, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'updateContainers',
      mutations,
      'updateContainers',
      (a, c) => [a.input, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'cancelInstall',
      mutations,
      'cancelInstall',
      (a, c) => [a.operationId, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'cancelEdit',
      mutations,
      'cancelEdit',
      (a, c) => [a.operationId, c],
    ],
    ...[
      'imageUpdate',
      'imageUpdateResult',
      'configurationResult',
      'startResult',
      'canCancel',
      'cancelRequested',
    ].map((name) => [
      'DeckBridgeOperation',
      name,
      new api.DeckBridgeOperationResolver(),
      name,
      (_a, _c, source) => [source],
    ]),
    [
      'DeckBridgeDockerOperations',
      'imageUpdateBatch',
      operations,
      'imageUpdateBatch',
      (a, c) => [a.id, a.offset, a.limit, c],
    ],
    [
      'Subscription',
      'deckBridgeDockerUpdateCheckEvents',
      events,
      'deckBridgeDockerUpdateCheckEvents',
      (a, c) => [a.id, a.after, c],
    ],
    [
      'Subscription',
      'deckBridgeDockerImageUpdateBatchEvents',
      events,
      'deckBridgeDockerImageUpdateBatchEvents',
      (a, c) => [a.id, a.after, c],
    ],
  ];
  for (const [type, name, instance, method, args] of bindings) {
    const field = schema.getType(type).getFields()[name];
    const resolve = async (source, input, context, info) => {
      const handler = instance[method],
        ec = {
          getType: () => 'graphql',
          getHandler: () => handler,
          getClass: () => instance.constructor,
          getArgs: () => [source, input, context, info],
        };
      for (const entry of Reflect.getMetadata('__guards__', handler) ?? []) {
        assert.equal(entry, api.DeckBridgeNamespaceGuard);
        namespace.canActivate(ec);
      }
      if (!(await guard.canActivate(ec))) throw new ForbiddenException();
      return handler.apply(instance, args(input, context, source));
    };
    if (type === 'Subscription') {
      field.subscribe = resolve;
      field.resolve = (event) => event;
    } else field.resolve = resolve;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-updates-')),
    socket = path.join(dir, 'core.sock'),
    requests = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined,
      url = new URL(req.url, 'http://localhost');
    requests.push({
      path: req.url,
      method: req.method,
      actor: req.headers['x-bridge-actor'],
      headers: req.headers,
      body,
    });
    res.setHeader('Content-Type', 'application/json');
    if (respond && (await respond({ req, res, url, body }))) return;
    let value;
    if (url.pathname === '/info')
      value = {
        version: bridgePackage.version,
        accepting: true,
        dockerAvailable: true,
        capabilities: ['docker.templateManagementRead'],
      };
    else if (url.pathname === '/docker/update-access')
      value = {
        principalId: 'creator-not-reader',
        coreOnline: true,
        dockerAvailable: true,
        capabilities: [
          'docker.updateCheck',
          'docker.engineImageUpdate',
          'docker.imageUpdateBatch',
        ],
      };
    else if (url.pathname === '/docker/update-checks') value = check();
    else if (url.pathname === '/docker/image-update-batches')
      value = req.method === 'POST' ? operation() : batch();
    else if (url.pathname === '/docker/image-updates/preview')
      value = {
        id: 'plan',
        kind: 'ENGINE_IMAGE_UPDATE',
        source: 'ENGINE_INSPECT',
        sourceAfter: 'ENGINE_INSPECT',
        targetContainerId: body.containerId,
        updateImage: true,
        changeSummary: [],
        directoriesToCreate: [],
        warnings: [],
      };
    else if (url.pathname.endsWith('/events')) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.end(
        JSON.stringify({
          sequence: 3,
          kind: 'COMPLETED',
          status: url.pathname.includes('update-checks')
            ? 'COMPLETED'
            : 'SUCCEEDED',
          completed: 2,
          total: 2,
          canCancel: false,
          cancelRequested: false,
        }) + '\n',
      );
      return;
    } else {
      res.statusCode = 404;
      value = { error: { code: 'NOT_FOUND', message: 'Not found' } };
    }
    res.end(JSON.stringify(value));
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
  const contextValue = (u) => ({
    req: {
      user: u,
      headers: { 'x-bridge-actor': 'spoofed', 'x-api-key': 'private-api-key' },
    },
  });
  return {
    schema,
    requests,
    run: (source, u = user(), variableValues) =>
      graphql({
        schema,
        source,
        contextValue: contextValue(u),
        variableValues,
      }),
    stream: (source, u = user()) =>
      subscribe({
        schema,
        document: parse(source),
        contextValue: contextValue(u),
      }),
  };
}

test('complete update contract uses typed enums, nullable evidence, Int counters and nonnull lists', async (t) => {
  const { schema } = await harness(t);
  for (const document of [
    accessQuery,
    readQuery,
    batchQuery,
    startMutation,
    prepareMutation,
    batchMutation,
    checkSubscription,
    batchSubscription,
  ])
    assert.deepEqual(validate(schema, parse(document)), []);
  const shapes = {
    DeckBridgeDockerUpdateAccess: {
      principalId: 'String!',
      coreOnline: 'Boolean!',
      dockerAvailable: 'Boolean!',
      capabilities: '[String!]!',
      reason: 'String',
    },
    DeckBridgeUpdateCheck: {
      id: 'String!',
      status: 'DeckBridgeUpdateCheckStatus!',
      revision: 'Int!',
      eventSequence: 'Int!',
      total: 'Int!',
      completed: 'Int!',
      available: 'Int!',
      skipped: 'Int!',
      failed: 'Int!',
      created: 'String!',
      updated: 'String!',
      nextRefreshAt: 'String',
      items: '[DeckBridgeUpdateCheckItem!]!',
      nextOffset: 'Int',
      error: 'DeckBridgeError',
    },
    DeckBridgeUpdateCheckItem: {
      containerId: 'String!',
      name: 'String!',
      currentImageId: 'String',
      imageReference: 'String',
      platform: 'DeckBridgeImagePlatform',
      source: 'DeckBridgeDockerConfigurationSource',
      state: 'DeckBridgeUpdateCheckItemState!',
      availability: 'DeckBridgeImageUpdateAvailability!',
      canUpdate: 'Boolean!',
      reasonCode: 'String',
      checkedAt: 'String',
      expiresAt: 'String',
      fromCache: 'Boolean!',
      revision: 'Int!',
      remoteImageId: 'String',
    },
    DeckBridgeImagePlatform: {
      os: 'String!',
      architecture: 'String!',
      variant: 'String',
    },
    DeckBridgeUpdateCheckEvent: {
      sequence: 'Int!',
      kind: 'DeckBridgeUpdateCheckEventKind!',
      item: 'DeckBridgeUpdateCheckItem',
      status: 'DeckBridgeUpdateCheckStatus!',
      completed: 'Int!',
      total: 'Int!',
    },
    DeckBridgeImageUpdateTargetInput: {
      checkId: 'String!',
      containerId: 'String!',
      currentImageId: 'String!',
      revision: 'Int!',
      allowMissingTemplate: 'Boolean!',
    },
    DeckBridgeImageUpdateBatchInput: {
      requestId: 'String!',
      targets: '[DeckBridgeImageUpdateTargetInput!]!',
    },
    DeckBridgeImageUpdateBatch: {
      id: 'String!',
      status: 'String!',
      revision: 'Int!',
      eventSequence: 'Int!',
      canCancel: 'Boolean!',
      cancelRequested: 'Boolean!',
      total: 'Int!',
      completed: 'Int!',
      updated: 'Int!',
      unchanged: 'Int!',
      failed: 'Int!',
      skipped: 'Int!',
      needsAttention: 'Int!',
      cancelled: 'Int!',
      activeOperation: 'DeckBridgeOperation',
      items: '[DeckBridgeImageUpdateBatchItem!]!',
      nextOffset: 'Int',
    },
    DeckBridgeImageUpdateBatchItem: {
      index: 'Int!',
      revision: 'Int!',
      sourceContainerId: 'String!',
      currentImageId: 'String!',
      operationId: 'String',
      status: 'DeckBridgeImageUpdateBatchItemStatus!',
      resultContainerId: 'String',
      reasonCode: 'String',
      imageUpdateResult: 'DeckBridgeImageUpdateResult',
    },
    DeckBridgeImageUpdateBatchEvent: {
      sequence: 'Int!',
      kind: 'DeckBridgeImageUpdateBatchEventKind!',
      item: 'DeckBridgeImageUpdateBatchItem',
      activeOperation: 'DeckBridgeOperation',
      status: 'String!',
      completed: 'Int!',
      total: 'Int!',
      canCancel: 'Boolean!',
      cancelRequested: 'Boolean!',
    },
  };
  for (const [name, expected] of Object.entries(shapes))
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(schema.getType(name).getFields()).map(
          ([name, field]) => [name, String(field.type)],
        ),
      ),
      expected,
    );
  assert.equal(
    schema.getType('DeckBridgeImageUpdateTargetInput').getFields()
      .allowMissingTemplate.defaultValue,
    false,
  );
  const contract = JSON.parse(
    fs.readFileSync(
      new URL('../contracts/openapi.json', import.meta.url),
      'utf8',
    ),
  );
  for (const path of [
    '/docker/update-access',
    '/docker/update-checks',
    '/docker/update-checks/events',
    '/docker/image-updates/preview',
    '/docker/image-update-batches',
    '/docker/image-update-batches/events',
  ])
    assert.ok(contract.paths[path]);
  assert.equal(
    contract.components.schemas.ImageUpdateBatch.properties.updated.type,
    'integer',
  );
  assert.ok(
    contract.components.schemas.Operation.properties.kind.enum.includes(
      'IMAGE_UPDATE_BATCH',
    ),
  );
  assert.ok(
    contract.components.schemas.Plan.properties.kind.enum.includes(
      'ENGINE_IMAGE_UPDATE',
    ),
  );
  for (const name of Object.keys(shapes))
    assert.equal(schema.getType(name).getFields().targetFingerprint, undefined);
});

test('Docker READ-only checks and recovery use current reader identity, never ME, task creator or input headers', async (t) => {
  const { run, requests } = await harness(t);
  const access = await run(
    accessQuery,
    user('READ_ANY', 'DOCKER', 'current-reader'),
  );
  assert.equal(access.errors, undefined);
  assert.equal(
    access.data.deckBridge.docker.updateAccess.principalId,
    'current-reader',
  );
  for (const query of [readQuery, batchQuery, startMutation])
    assert.equal((await run(query)).errors, undefined);
  assert.deepEqual(
    requests.map((r) => [r.path, r.method]),
    [
      ['/docker/update-access', 'GET'],
      ['/docker/update-checks?offset=0&limit=100', 'GET'],
      ['/docker/image-update-batches?id=parent&offset=0&limit=100', 'GET'],
      ['/docker/update-checks', 'POST'],
    ],
  );
  assert.deepEqual(requests.at(-1).body, {
    requestId: 'check-request',
    force: false,
  });
  for (const req of requests) {
    assert.notEqual(req.actor, 'creator-not-reader');
    assert.notEqual(req.actor, 'spoofed');
    assert.equal(req.headers['x-api-key'], undefined);
    assert.equal(req.headers['x-bridge-protocol'], undefined);
  }
});

// The audited fixed commits share this exact official guard; bind each behavioral
// run to its matrix fingerprint rather than assuming nearby releases are equivalent.
for (const version of ['4.37.4', '4.37.5', '4.37.6'])
  test(`${version} official guard rejects wrong permissions and anonymous callers before all update Core IO`, async (t) => {
    const profile = compatibilityMatrix.api[version];
    assert.equal(
      profile.sources['api/src/unraid-api/auth/authorization.guard.ts'],
      createHash('sha256').update(officialGuard).digest('hex'),
    );
    const report = resolveCompatibility(
      '7.3.2',
      version,
      'x64',
      profile.dependencies,
      compatibilityMatrix.os['7.3.2'].dockerFiles,
    );
    assert.equal(report.apiProfile, 'EXPLICIT_NAMESPACE');
    const { run, stream, requests } = await harness(t);
    for (const query of [accessQuery, readQuery, batchQuery, startMutation])
      for (const identity of [
        null,
        user('UPDATE_ANY'),
        user('CREATE_ANY'),
        user('READ_ANY', 'ME'),
      ])
        assert.ok((await run(query, identity)).errors?.length);
    for (const query of [prepareMutation, batchMutation])
      for (const identity of [
        null,
        user(),
        user('CREATE_ANY'),
        user('UPDATE_ANY', 'ME'),
      ])
        assert.ok(
          (
            await run(query, identity, {
              input:
                query === prepareMutation
                  ? target
                  : { requestId: 'batch-request', targets: [target] },
            })
          ).errors?.length,
        );
    for (const query of [checkSubscription, batchSubscription])
      for (const identity of [null, user('UPDATE_ANY'), user('READ_ANY', 'ME')])
        assert.ok((await stream(query, identity)).errors?.length);
    assert.equal(requests.length, 0);
  });

test('UPDATE-only prepares frozen server candidate and submits ordered batch without caller mutation', async (t) => {
  const { run, requests } = await harness(t);
  let result = await run(prepareMutation, user('UPDATE_ANY'), {
    input: target,
  });
  assert.equal(result.errors, undefined);
  assert.equal(
    result.data.deckBridge.docker.prepareImageUpdate.kind,
    'ENGINE_IMAGE_UPDATE',
  );
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/info', '/docker/image-updates/preview'],
  );
  assert.equal(target.containerId, 'server:container');
  requests.length = 0;
  const targets = [
    target,
    { ...target, containerId: 'server:second', revision: 3 },
  ];
  result = await run(batchMutation, user('UPDATE_ANY'), {
    input: { requestId: 'batch-request', targets },
  });
  assert.equal(result.errors, undefined);
  assert.equal(
    result.data.deckBridge.docker.updateContainers.imageUpdate,
    false,
  );
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/info', '/docker/image-update-batches'],
  );
  requests.length = 0;
  for (const targets of [
    [],
    [target, { ...target, containerId: 'container' }],
  ]) {
    result = await run(batchMutation, user('UPDATE_ANY'), {
      input: { requestId: 'batch-request', targets },
    });
    assert.equal(result.errors?.[0].extensions.code, 'INVALID_INPUT');
  }
  assert.equal(requests.length, 0);
});

test('page boundaries and mutation request identifiers reject before IO, page reads preserve explicit task id', async (t) => {
  const { run, requests } = await harness(t);
  for (const field of [
    'docker{updateCheck',
    'operations{docker{imageUpdateBatch',
  ])
    for (const args of ['offset:-1', 'limit:0', 'limit:101']) {
      const query = field.startsWith('operations')
        ? `{deckBridge{operations{docker{imageUpdateBatch(id:"parent",${args}){id}}}}}`
        : `{deckBridge{docker{updateCheck(${args}){id}}}}`;
      assert.equal(
        (await run(query)).errors?.[0].extensions.code,
        'INVALID_INPUT',
      );
    }
  assert.equal(
    (
      await run(
        'mutation{deckBridge{docker{checkUpdates(requestId:"short"){id}}}}',
      )
    ).errors?.[0].extensions.code,
    'INVALID_INPUT',
  );
  assert.equal(requests.length, 0);
  assert.equal(
    (
      await run(
        '{deckBridge{docker{updateCheck(id:"fixed/check",offset:1,limit:1){id eventSequence nextOffset}}}}',
      )
    ).errors,
    undefined,
  );
  assert.equal(
    requests[0].path,
    '/docker/update-checks?id=fixed%2Fcheck&offset=1&limit=1',
  );
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
  await assert.rejects(
    pipe.transform(
      { requestId: 'batch-request', targets: [{ ...target, canUpdate: true }] },
      { type: 'body', metatype: api.DeckBridgeImageUpdateBatchInput },
    ),
  );
  await assert.rejects(
    pipe.transform(
      { requestId: 'batch-request', targets: [] },
      { type: 'body', metatype: api.DeckBridgeImageUpdateBatchInput },
    ),
  );
});

test('snapshot exposes available item before slow item and reuses real active-operation pull progress', async (t) => {
  const { run } = await harness(t);
  const result = await run(readQuery);
  assert.equal(result.errors, undefined);
  const value = result.data.deckBridge.docker.updateCheck;
  assert.equal(value.status, 'RUNNING');
  assert.equal(value.completed, 1);
  assert.equal(value.items[0].canUpdate, true);
  assert.equal(value.items[1].state, 'PENDING');
  const parent = await run(batchQuery);
  assert.equal(parent.errors, undefined);
  assert.equal(
    parent.data.deckBridge.operations.docker.imageUpdateBatch.activeOperation
      .pullProgress.layers[0].current,
    2,
  );
});

test('checks NDJSON yields fast item before completion and normal EOF preserves cursor for continuation', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { stream, requests } = await harness(t, {
    respond: async ({ url, res }) => {
      if (!url.pathname.endsWith('/events')) return false;
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.write(
        JSON.stringify({
          sequence: 3,
          kind: 'ITEM_CHANGED',
          status: 'RUNNING',
          completed: 1,
          total: 2,
          item: item(),
        }) + '\n',
      );
      await gate;
      res.end(
        JSON.stringify({
          sequence: 4,
          kind: 'COMPLETED',
          status: 'COMPLETED',
          completed: 2,
          total: 2,
        }) + '\n',
      );
      return true;
    },
  });
  t.after(() => release());
  const iterator = await stream(checkSubscription);
  assert.equal(iterator.errors, undefined);
  const first = await iterator.next();
  assert.equal(first.value.errors, undefined);
  assert.equal(
    first.value.data.deckBridgeDockerUpdateCheckEvents.kind,
    'ITEM_CHANGED',
  );
  assert.equal(
    first.value.data.deckBridgeDockerUpdateCheckEvents.status,
    'RUNNING',
  );
  release();
  const last = await iterator.next();
  assert.equal(last.value.data.deckBridgeDockerUpdateCheckEvents.sequence, 4);
  assert.equal((await iterator.next()).done, true);
  assert.equal(
    requests[0].path,
    '/docker/update-checks/events?id=check&after=2',
  );
  assert.equal(requests[0].actor, 'reader');
  const resumed = await stream(checkSubscription.replace('after:2', 'after:4'));
  await resumed.next();
  await resumed.return();
  assert.equal(
    requests[1].path,
    '/docker/update-checks/events?id=check&after=4',
  );
});

test('batch NDJSON carries active child and independent stage transitions without relying on pull revision', async (t) => {
  const { stream, requests } = await harness(t, {
    respond: async ({ url, res }) => {
      if (!url.pathname.endsWith('/events')) return false;
      for (const [sequence, stage] of [
        [3, 'PULL'],
        [4, 'CREATE'],
        [5, 'COMMITTED'],
      ])
        res.write(
          JSON.stringify({
            sequence,
            kind: 'ACTIVE_PROGRESS',
            status: 'RUNNING',
            completed: 0,
            total: 2,
            activeOperation: operation({
              id: 'same-child',
              stage,
              pullProgress: {
                revision: 1,
                finished: stage !== 'PULL',
                layers: [],
              },
            }),
          }) + '\n',
        );
      res.end();
      return true;
    },
  });
  const iterator = await stream(batchSubscription),
    stages = [];
  for await (const event of iterator) {
    assert.equal(event.errors, undefined);
    stages.push(
      event.data.deckBridgeDockerImageUpdateBatchEvents.activeOperation.stage,
    );
  }
  assert.deepEqual(stages, ['PULL', 'CREATE', 'COMMITTED']);
  assert.equal(
    requests[0].path,
    '/docker/image-update-batches/events?id=parent&after=2',
  );
});

for (const streamed of [false, true])
  test(
    'safe error conversion preserves CURSOR_EXPIRED for ' +
      (streamed ? 'NDJSON' : 'HTTP'),
    async (t) => {
      const { run, stream } = await harness(t, {
        respond: async ({ url, res }) => {
          if (url.pathname === '/info') return false;
          const error = {
            code: 'CURSOR_EXPIRED',
            message: 'private-registry-token=https://secret.example/password',
          };
          if (streamed) {
            res.setHeader('Content-Type', 'application/x-ndjson');
            res.end(JSON.stringify({ error }) + '\n');
          } else {
            res.statusCode = 409;
            res.end(JSON.stringify({ error }));
          }
          return true;
        },
      });
      if (streamed) {
        const iterator = await stream(checkSubscription);
        await assert.rejects(
          iterator.next(),
          (error) =>
            error.extensions.code === 'CURSOR_EXPIRED' &&
            !error.message.includes('private-registry-token') &&
            !error.message.includes('secret.example'),
        );
      } else {
        const result = await run(readQuery);
        assert.equal(result.errors[0].extensions.code, 'CURSOR_EXPIRED');
        assert.ok(!JSON.stringify(result).includes('private-registry-token'));
        assert.ok(!JSON.stringify(result).includes('secret.example'));
      }
    },
  );

test('HTTP stream errors retain safe code and malformed/oversized NDJSON fails closed', async (t) => {
  let mode = 'status';
  const { stream } = await harness(t, {
    respond: async ({ url, res }) => {
      if (!url.pathname.endsWith('/events')) return false;
      if (mode === 'status') {
        res.statusCode = 410;
        res.end(
          JSON.stringify({
            error: { code: 'CHECK_EXPIRED', message: 'secret' },
          }),
        );
      } else if (mode === 'malformed') res.end('{private-registry-token\n');
      else res.end('x'.repeat(256 * 1024 + 1));
      return true;
    },
  });
  for (const [next, code] of [
    ['status', 'CHECK_EXPIRED'],
    ['malformed', 'CORE_RESPONSE_INVALID'],
    ['oversized', 'CORE_RESPONSE_INVALID'],
  ]) {
    mode = next;
    const iterator = await stream(checkSubscription);
    await assert.rejects(
      iterator.next(),
      (error) =>
        error.extensions.code === code &&
        !error.message.includes('private-registry-token'),
    );
  }
});

test('only explicit CORE_UNAVAILABLE becomes offline access; auth and invalid Core replies remain errors', async (t) => {
  let code = 'CORE_UNAVAILABLE';
  const { run } = await harness(t, {
    respond: async ({ res }) => {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: { code, message: 'private error' } }));
      return true;
    },
  });
  const offline = await run(accessQuery);
  assert.equal(offline.errors, undefined);
  assert.equal(offline.data.deckBridge.docker.updateAccess.coreOnline, false);
  assert.equal(
    offline.data.deckBridge.docker.updateAccess.reason,
    'CORE_UNAVAILABLE',
  );
  for (const next of [
    'FORBIDDEN',
    'UNAUTHENTICATED',
    'CORE_RESPONSE_INVALID',
  ]) {
    code = next;
    const result = await run(accessQuery);
    assert.equal(result.errors[0].extensions.code, next);
    assert.ok(!JSON.stringify(result).includes('private error'));
  }
});

test('embedded check and child failures redact untrusted messages, retain UNKNOWN and domain reasons', async (t) => {
  const { run } = await harness(t, {
    respond: async ({ url, res }) => {
      const error = {
        code: 'REGISTRY_AUTH_REQUIRED',
        message: 'private-registry-token',
      };
      if (url.pathname === '/docker/update-checks')
        res.end(
          JSON.stringify(
            check({
              status: 'FAILED',
              items: [
                item({
                  state: 'FAILED',
                  availability: 'UNKNOWN',
                  canUpdate: false,
                  reasonCode: 'REGISTRY_AUTH_REQUIRED',
                }),
              ],
              error,
            }),
          ),
        );
      else if (url.pathname === '/docker/image-update-batches')
        res.end(
          JSON.stringify(
            batch({ activeOperation: operation({ id: 'child', error }) }),
          ),
        );
      else return false;
      return true;
    },
  });
  for (const query of [readQuery, batchQuery]) {
    const result = await run(query);
    assert.equal(result.errors, undefined);
    assert.ok(!JSON.stringify(result).includes('private-registry-token'));
  }
  const result = await run(readQuery);
  assert.equal(
    result.data.deckBridge.docker.updateCheck.items[0].availability,
    'UNKNOWN',
  );
  assert.equal(
    result.data.deckBridge.docker.updateCheck.error.code,
    'REGISTRY_AUTH_REQUIRED',
  );
});

test('host filtering preserves read checks but never advertises unsupported Engine or batch writes', () => {
  const capabilities = [
    'docker.updateCheck',
    'docker.cancel',
    'docker.engineImageUpdate',
    'docker.imageUpdateBatch',
  ];
  assert.deepEqual(
    filterCapabilities(
      { hostWriteSupported: false, dockerWriteSupported: false },
      capabilities,
    ),
    ['docker.updateCheck'],
  );
  assert.deepEqual(
    filterCapabilities(
      { hostWriteSupported: true, dockerWriteSupported: false },
      capabilities,
    ),
    ['docker.updateCheck'],
  );
});

test('official guard independently authorizes cancel receipts with CREATE-only or UPDATE-only and no Core preflight', async (t) => {
  const id = 'a'.repeat(32);
  const { run, requests } = await harness(t, {
    respond: async ({ url, res, body }) => {
      assert.ok(
        url.pathname.startsWith('/docker/cancel/'),
        'cancel must not probe info, Docker or submit another task',
      );
      res.end(
        JSON.stringify(
          operation({
            id: body.operationId,
            kind: url.pathname.endsWith('/install')
              ? 'INSTALL'
              : 'IMAGE_UPDATE_BATCH',
            canCancel: false,
            cancelRequested: true,
            configurationResult: 'NOT_APPLIED',
            startResult: 'NOT_REQUESTED',
          }),
        ),
      );
      return true;
    },
  });
  for (const [field, action, route] of [
    ['cancelInstall', 'CREATE_ANY', 'install'],
    ['cancelEdit', 'UPDATE_ANY', 'edit'],
  ]) {
    const source = `mutation($id:String!){deckBridge{docker{${field}(operationId:$id){id kind status canCancel cancelRequested imageUpdate configurationResult startResult}}}}`;
    for (const identity of [
      null,
      user(),
      user(action === 'CREATE_ANY' ? 'UPDATE_ANY' : 'CREATE_ANY'),
      user(action, 'ME'),
    ]) {
      assert.ok((await run(source, identity, { id })).errors?.length);
    }
    assert.equal(requests.length, 0);
    const result = await run(source, user(action, 'DOCKER', 'task-owner'), {
      id,
    });
    assert.equal(result.errors, undefined);
    const receipt = result.data.deckBridge.docker[field];
    assert.equal(receipt.id, id);
    assert.equal(receipt.status, 'RUNNING');
    assert.equal(receipt.canCancel, false);
    assert.equal(receipt.cancelRequested, true);
    assert.deepEqual(
      requests.map((r) => [r.path, r.method, r.actor, r.body]),
      [
        [
          `/docker/cancel/${route}`,
          'POST',
          'task-owner',
          { operationId: id, coreVersion: bridgePackage.version },
        ],
      ],
    );
    requests.length = 0;
    for (const invalid of [
      '',
      id.toUpperCase(),
      'a'.repeat(31),
      'a'.repeat(33),
      '../task',
    ]) {
      assert.equal(
        (await run(source, user(action), { id: invalid })).errors?.[0]
          .extensions.code,
        'INVALID_INPUT',
      );
    }
    assert.equal(requests.length, 0);
  }
});

test('edit cancellation redacts embedded Core errors and preserves stable rejection codes without retry', async (t) => {
  let code;
  const { run, requests } = await harness(t, {
    respond: async ({ res }) => {
      if (code) {
        res.statusCode = 409;
        res.end(
          JSON.stringify({
            error: { code, message: 'private-registry-token' },
          }),
        );
      } else
        res.end(
          JSON.stringify(
            operation({
              canCancel: false,
              cancelRequested: false,
              error: {
                code: 'IMAGE_PULL_FAILED',
                message: 'private-registry-token',
              },
            }),
          ),
        );
      return true;
    },
  });
  const source = `mutation{deckBridge{docker{cancelEdit(operationId:"${'a'.repeat(32)}"){status canCancel cancelRequested error{code message}}}}}`;
  const receipt = await run(source, user('UPDATE_ANY'));
  assert.equal(receipt.errors, undefined);
  assert.ok(!JSON.stringify(receipt).includes('private-registry-token'));
  for (const rejection of [
    'FORBIDDEN',
    'NOT_FOUND',
    'NOT_CANCELLABLE',
    'CORE_VERSION_MISMATCH',
    'JOURNAL_FAILED',
  ]) {
    code = rejection;
    const result = await run(source, user('UPDATE_ANY'));
    assert.equal(result.errors?.[0].extensions.code, rejection);
    assert.ok(!JSON.stringify(result).includes('private-registry-token'));
  }
  assert.equal(requests.length, 6);
  assert.ok(requests.every((r) => r.path === '/docker/cancel/edit'));
});
