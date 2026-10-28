import test from 'node:test';
import assert from 'node:assert/strict';
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
import { graphql, parse, validate } from 'graphql';
import * as api from '../dist/index.js';

const domains = [
  ['docker', 'Docker', 'DOCKER'],
  ['system', 'System', 'OS'],
  ['plugins', 'Plugin', 'CONFIG'],
  ['array', 'Array', 'ARRAY'],
];
const selection =
  'id domain status stage events{sequence time stage message} pullProgress{revision finished layers{id phase current total}}';
const subject = (resource = 'DOCKER', action = 'READ_ANY') => ({
  id: 'progress-principal',
  resource,
  action,
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const operation = (domain, pullProgress) => ({
  id: 'task',
  domain,
  kind:
    domain === 'docker'
      ? 'INSTALL'
      : domain === 'system'
        ? 'REBOOT'
        : domain === 'plugins'
          ? 'UNINSTALL'
          : 'START',
  status: 'RUNNING',
  stage: 'PULLING',
  created: '2026-10-10T00:00:00Z',
  updated: '2026-10-10T00:00:01Z',
  name: 'fixture',
  events: [],
  ...(pullProgress === undefined ? {} : { pullProgress }),
});

// Execute production namespace/task resolvers and official guards through the
// generated Nest schema, with only the Core transport endpoint isolated.
async function harness(t, operations) {
  const app = await NestFactory.createApplicationContext(
    GraphQLSchemaBuilderModule,
    { logger: false },
  );
  t.after(() => app.close());
  const schema = await app.get(GraphQLSchemaFactory).create(api.resolvers);
  const namespaces = new api.DeckBridgeNamespaceGuard();
  const permissions = new AuthZGuard(
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
  const bindings = [
    [
      'Query',
      'deckBridge',
      new api.DeckBridgeRootResolver(),
      'query',
      () => [],
    ],
    [
      'DeckBridgeQueries',
      'operations',
      new api.DeckBridgeQueriesResolver(),
      'operations',
      () => [],
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
      if (
        Reflect.getMetadata('__PERMISSIONS__', handler) &&
        !(await permissions.canActivate(ec))
      )
        throw new ForbiddenException();
      return handler.apply(instance, args(input, context));
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-pull-')),
    socket = path.join(dir, 'core.sock'),
    requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      path: req.url,
      method: req.method,
      actor: req.headers['x-bridge-actor'],
    });
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url, 'http://localhost'),
      value = operations.get(url.searchParams.get('domain'));
    if (
      !['/operations', '/operations/by-request'].includes(url.pathname) ||
      value === undefined
    ) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'Task unavailable' },
        }),
      );
      return;
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
  return {
    schema,
    requests,
    run: (source, user) =>
      graphql({ schema, source, contextValue: { req: { user } } }),
  };
}

const getQuery = (domain = 'docker', after = 0) =>
  `{deckBridge{operations{${domain}{get(id:"task",after:${after}){${selection}}}}}}`;

test('pull snapshot has typed nullable fields and a closed OpenAPI contract', async (t) => {
  const { schema } = await harness(t, new Map());
  const operationFields = schema.getType('DeckBridgeOperation').getFields();
  assert.equal(
    String(operationFields.pullProgress.type),
    'DeckBridgePullProgress',
  );
  const progress = schema.getType('DeckBridgePullProgress').getFields();
  assert.deepEqual(Object.keys(progress), ['revision', 'finished', 'layers']);
  assert.equal(String(progress.revision.type), 'Int!');
  assert.equal(String(progress.finished.type), 'Boolean!');
  assert.equal(String(progress.layers.type), '[DeckBridgePullLayerProgress!]!');
  const layer = schema.getType('DeckBridgePullLayerProgress').getFields();
  assert.deepEqual(Object.keys(layer), ['id', 'phase', 'current', 'total']);
  assert.equal(String(layer.id.type), 'String!');
  assert.equal(String(layer.phase.type), 'String!');
  for (const key of ['current', 'total'])
    assert.equal(String(layer[key].type), 'Float');
  assert.deepEqual(validate(schema, parse(getQuery())), []);
  assert.ok(
    validate(
      schema,
      parse(
        'subscription{deckBridgeDockerOperationEvents(id:"task"){pullProgress{revision}}}',
      ),
    ).length > 0,
  );
  const s = JSON.parse(
    fs.readFileSync(
      new URL('../contracts/openapi.json', import.meta.url),
      'utf8',
    ),
  ).components.schemas;
  for (const name of ['Operation', 'PullProgress', 'PullLayerProgress'])
    assert.equal(s[name].additionalProperties, false);
  assert.ok(!s.Operation.required.includes('pullProgress'));
  assert.deepEqual(s.Operation.properties.pullProgress.anyOf, [
    { $ref: '#/components/schemas/PullProgress' },
    { type: 'null' },
  ]);
  assert.deepEqual(s.PullProgress.required, ['revision', 'finished', 'layers']);
  assert.equal(s.PullProgress.properties.revision.type, 'integer');
  assert.equal(s.PullProgress.properties.revision.minimum, 0);
  assert.equal(s.PullProgress.properties.finished.type, 'boolean');
  assert.equal(s.PullProgress.properties.layers.type, 'array');
  assert.equal(
    s.PullProgress.properties.layers.items.$ref,
    '#/components/schemas/PullLayerProgress',
  );
  assert.deepEqual(s.PullLayerProgress.required, ['id', 'phase']);
  assert.equal(s.PullLayerProgress.properties.id.type, 'string');
  assert.equal(s.PullLayerProgress.properties.phase.type, 'string');
  assert.deepEqual(s.PullLayerProgress.properties.phase.enum, [
    'WAITING',
    'DOWNLOADING',
    'DOWNLOADED',
    'VERIFYING',
    'EXTRACTING',
    'COMPLETE',
    'EXISTS',
    'PROCESSING',
  ]);
  for (const key of ['current', 'total']) {
    assert.deepEqual(s.PullLayerProgress.properties[key].type, [
      'integer',
      'null',
    ]);
    assert.equal(s.PullLayerProgress.properties[key].minimum, 0);
  }
});

test('latest pull snapshot survives Unix transport and GraphQL beyond 32-bit bytes and event cursors', async (t) => {
  const snapshot = {
    revision: 7,
    finished: false,
    layers: [
      {
        id: 'abcdef0123456789-first-full-layer',
        phase: 'EXTRACTING',
        current: 8589934592,
        total: 17179869184,
      },
      {
        id: 'abcdef0123456789-second-full-layer',
        phase: 'DOWNLOADING',
        current: 4294967296,
        total: null,
      },
      { id: 'waiting-full-layer', phase: 'WAITING' },
    ],
  };
  const operations = new Map([['docker', operation('docker', snapshot)]]);
  const { run, requests } = await harness(t, operations);
  for (const after of [0, 900]) {
    const out = await run(getQuery('docker', after), subject());
    assert.equal(out.errors, undefined);
    const value = plain(out.data.deckBridge.operations.docker.get);
    assert.deepEqual(value.events, []);
    assert.deepEqual(value.pullProgress, {
      revision: 7,
      finished: false,
      layers: [
        {
          id: 'abcdef0123456789-first-full-layer',
          phase: 'EXTRACTING',
          current: 8589934592,
          total: 17179869184,
        },
        {
          id: 'abcdef0123456789-second-full-layer',
          phase: 'DOWNLOADING',
          current: 4294967296,
          total: null,
        },
        {
          id: 'waiting-full-layer',
          phase: 'WAITING',
          current: null,
          total: null,
        },
      ],
    });
  }
  assert.deepEqual(
    requests,
    [0, 900].map((after) => ({
      path: `/operations?domain=docker&id=task&after=${after}`,
      method: 'GET',
      actor: 'progress-principal',
    })),
  );
  const found = await run(
    `{deckBridge{operations{docker{byRequestId(requestId:"request-fixture"){${selection}}}}}}`,
    subject(),
  );
  assert.equal(found.errors, undefined);
  assert.deepEqual(
    plain(found.data.deckBridge.operations.docker.byRequestId.pullProgress),
    plain(
      (await run(getQuery(), subject())).data.deckBridge.operations.docker.get
        .pullProgress,
    ),
  );
  assert.equal(
    requests[2].path,
    '/operations/by-request?domain=docker&requestId=request-fixture',
  );
});

test('finished failed pull preserves observed phase and remains an operation error rather than a transport error', async (t) => {
  const value = operation('docker', {
    revision: 8,
    finished: true,
    layers: [{ id: 'full-layer', phase: 'EXTRACTING', current: 4294967296 }],
  });
  value.status = 'FAILED';
  value.stage = 'PULL_FAILED';
  value.error = { code: 'PULL_FAILED', message: 'Image preparation failed' };
  const { run } = await harness(t, new Map([['docker', value]]));
  const out = await run(
    '{deckBridge{operations{docker{get(id:"task"){status error{code message} pullProgress{revision finished layers{id phase current total}}}}}}}',
    subject(),
  );
  assert.equal(out.errors, undefined);
  assert.deepEqual(plain(out.data.deckBridge.operations.docker.get), {
    status: 'FAILED',
    error: { code: 'PULL_FAILED', message: 'Image preparation failed' },
    pullProgress: {
      revision: 8,
      finished: true,
      layers: [
        {
          id: 'full-layer',
          phase: 'EXTRACTING',
          current: 4294967296,
          total: null,
        },
      ],
    },
  });
});

test('initial empty snapshot stays available while unavailable snapshots remain null in every task domain', async (t) => {
  const operations = new Map([
    [
      'docker',
      operation('docker', { revision: 1, finished: false, layers: [] }),
    ],
  ]);
  const { run } = await harness(t, operations);
  const initial = await run(getQuery(), subject());
  assert.equal(initial.errors, undefined);
  assert.deepEqual(
    plain(initial.data.deckBridge.operations.docker.get.pullProgress),
    { revision: 1, finished: false, layers: [] },
  );
  for (const [domain, , resource] of domains)
    for (const snapshot of [undefined, null]) {
      operations.set(domain, operation(domain, snapshot));
      const out = await run(getQuery(domain), subject(resource));
      assert.equal(out.errors, undefined);
      const value = out.data.deckBridge.operations[domain].get;
      assert.equal(value.id, 'task');
      assert.equal(value.domain, domain);
      assert.equal(value.status, 'RUNNING');
      assert.deepEqual(value.events, []);
      assert.equal(value.pullProgress, null);
    }
});

test('snapshot reads keep namespace identity and per-domain READ permission before Core IO', async (t) => {
  const operations = new Map(
    domains.map(([domain]) => [domain, operation(domain)]),
  );
  const { run, requests } = await harness(t, operations);
  for (const [domain, , resource] of domains) {
    for (const user of [
      undefined,
      subject(resource, 'UPDATE_ANY'),
      subject('ME'),
    ]) {
      const out = await run(getQuery(domain), user);
      assert.ok(out.errors?.length);
      assert.equal(requests.length, 0);
    }
  }
});
