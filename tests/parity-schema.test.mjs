import test from 'node:test';
import assert from 'node:assert/strict';
import bridgePackage from '../dist/release.json' with { type: 'json' };
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
  GqlExecutionContext,
} from '@nestjs/graphql';
import { AuthZGuard } from 'nest-authz';
import { graphql } from 'graphql';
import * as api from '../dist/index.js';
import { filterCapabilities } from '../dist/check-host.js';

const caps = [
  'array.read',
  'array.parity.read',
  'array.parity.control',
  'array.preview',
  'array.execute',
];
const snapshot = {
  state: 'Started',
  mdState: 'STARTED',
  fsState: 'Started',
  progress: '',
  canStart: false,
  canStop: false,
  liveExecutionVerified: false,
  bootId: 'boot-fixture',
  observedAt: '2026-10-04T01:02:03Z',
  parity: {
    lastResult: null,
    state: 'PAUSED',
    kind: 'PARITY_CHECK',
    correcting: false,
    positionBytes: '18446744073709551615',
    totalBytes: null,
    speedBytesPerSecond: null,
    elapsedSeconds: '180',
    errorCount: null,
    canStart: false,
    canPause: false,
    canResume: true,
    canCancel: true,
    reason: null,
  },
};
const subject = (action = 'READ_ANY', resource = 'ARRAY') => ({
  id: 'array-principal',
  action,
  resource,
});
const query =
  '{deckBridge{array{status{state mdState fsState progress canStart canStop liveExecutionVerified bootId observedAt parity{state kind correcting positionBytes totalBytes speedBytesPerSecond elapsedSeconds errorCount canStart canPause canResume canCancel reason lastResult{state startedAt finishedAt elapsedSeconds errorCount}}}}}}';
const prepare =
  'mutation($input:DeckBridgeParityPreviewInput!){deckBridge{array{prepareParity(input:$input){id action target correct bootId}}}}';
async function harness(
  t,
  { coreOffline = false, statusSnapshot = snapshot } = {},
) {
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
      'Mutation',
      'deckBridge',
      new api.DeckBridgeRootResolver(),
      'mutation',
      () => [],
    ],
    [
      'DeckBridgeQueries',
      'array',
      new api.DeckBridgeQueriesResolver(),
      'array',
      () => [],
    ],
    [
      'DeckBridgeQueries',
      'info',
      new api.DeckBridgeQueriesResolver(new api.DeckBridgeService()),
      'info',
      (_, ctx) => [ctx],
    ],
    [
      'DeckBridgeMutations',
      'array',
      new api.DeckBridgeMutationsResolver(),
      'array',
      () => [],
    ],
    [
      'DeckBridgeArrayQueries',
      'status',
      new api.DeckBridgeArrayQueriesResolver(),
      'status',
      (_, ctx) => [ctx],
    ],
    ...[
      'prepareParity',
      'startParity',
      'pauseParity',
      'resumeParity',
      'cancelParity',
    ].map((name) => [
      'DeckBridgeArrayMutations',
      name,
      new api.DeckBridgeArrayMutationsResolver(),
      name,
      (a, c) => [a.input, c],
    ]),
  ];
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-parity-')),
    socket = path.join(dir, 'core.sock'),
    requests = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    requests.push({
      path: req.url,
      actor: req.headers['x-bridge-actor'],
      body,
    });
    res.setHeader('Content-Type', 'application/json');
    if (coreOffline) {
      res.statusCode = 503;
      res.end(
        JSON.stringify({
          error: { code: 'CORE_UNAVAILABLE', message: 'Core unavailable' },
        }),
      );
      return;
    }
    if (req.url === '/info')
      res.end(
        JSON.stringify({
          version: bridgePackage.version,
          accepting: true,
          dockerAvailable: false,
          capabilities: caps,
        }),
      );
    else if (req.url === '/array/status')
      res.end(JSON.stringify(statusSnapshot));
    else if (req.url === '/array/preview')
      res.end(
        JSON.stringify({
          id: 'plan-fixture',
          action: body.action,
          correct: body.correct ?? null,
          target: '',
          bootId: 'boot-fixture',
        }),
      );
    else if (req.url.startsWith('/array/submit/parity_'))
      res.end(
        JSON.stringify({
          id: 'operation-fixture',
          domain: 'array',
          action: req.url.split('/').at(-1).toUpperCase(),
          status: 'RUNNING',
          stage: 'OBSERVING',
        }),
      );
    else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = http.request.bind(http);
  t.mock.method(http, 'request', (options) =>
    request({ ...options, socketPath: socket }),
  );
  return {
    requests,
    schema,
    run: (source, user, variableValues) =>
      graphql({
        schema,
        source,
        contextValue: { req: { user } },
        variableValues,
      }),
  };
}

test('parity snapshot keeps null/false and decimal precision with ARRAY-only read permission', async (t) => {
  const { run, requests } = await harness(t);
  const out = await run(query, subject());
  assert.equal(out.errors, undefined);
  assert.deepEqual(
    JSON.parse(JSON.stringify(out.data.deckBridge.array.status)),
    snapshot,
  );
  assert.deepEqual(requests, [
    { path: '/array/status', actor: 'array-principal', body: undefined },
  ]);
  for (const user of [
    undefined,
    subject('READ_ANY', 'DOCKER'),
    subject('UPDATE_ANY'),
  ]) {
    requests.length = 0;
    assert.ok((await run(query, user)).errors?.length);
    assert.equal(requests.length, 0);
  }
});

test('parity preview preserves false and rejects omitted/null START correct and irrelevant correct before Core', async (t) => {
  const { run, requests } = await harness(t);
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
  for (const correct of [false, true]) {
    const input = await pipe.transform(
      { action: 'START', correct },
      { type: 'body', metatype: api.DeckBridgeParityPreviewInput },
    );
    assert.deepEqual(api.parityPreview(input), {
      action: 'PARITY_START',
      correct,
    });
    const out = await run(prepare, subject('UPDATE_ANY'), { input });
    assert.equal(out.errors, undefined);
    assert.equal(out.data.deckBridge.array.prepareParity.correct, correct);
    assert.deepEqual(requests.at(-1), {
      path: '/array/preview',
      actor: 'array-principal',
      body: { action: 'PARITY_START', correct },
    });
  }
  for (const action of ['PAUSE', 'RESUME', 'CANCEL']) {
    const out = await run(prepare, subject('UPDATE_ANY'), {
      input: { action },
    });
    assert.equal(out.errors, undefined);
    assert.equal(out.data.deckBridge.array.prepareParity.correct, null);
    assert.deepEqual(requests.at(-1).body, { action: 'PARITY_' + action });
  }
  for (const input of [
    { action: 'START' },
    { action: 'START', correct: null },
    { action: 'START', correct: 'false' },
    { action: 'PAUSE', correct: false },
    { action: 'PAUSE', correct: null },
    { action: 'RESUME', correct: true },
    { action: 'CANCEL', correct: null },
    { action: 'RECON' },
    { action: 'START', correct: false, shell: 'id' },
  ]) {
    requests.length = 0;
    assert.ok(
      (await run(prepare, subject('UPDATE_ANY'), { input })).errors?.length,
      JSON.stringify(input),
    );
    assert.equal(requests.length, 0);
  }
  await assert.rejects(
    pipe.transform(
      { action: 'START', correct: false, extra: 'x' },
      { type: 'body', metatype: api.DeckBridgeParityPreviewInput },
    ),
  );
});

test('all parity writes require ARRAY UPDATE and forward one fixed action without Docker dependency', async (t) => {
  const { run, requests } = await harness(t);
  for (const name of [
    'startParity',
    'pauseParity',
    'resumeParity',
    'cancelParity',
  ]) {
    const source = `mutation($input:DeckBridgeSubmitInput!){deckBridge{array{${name}(input:$input){id domain status stage}}}}`,
      input = { planId: 'plan-fixture', requestId: 'request-fixture' };
    requests.length = 0;
    const out = await run(source, subject('UPDATE_ANY'), { input });
    assert.equal(out.errors, undefined);
    assert.deepEqual(
      requests.map((x) => x.path),
      ['/info', '/array/submit/parity_' + name.replace('Parity', '')],
    );
    assert.deepEqual(requests.at(-1).body, input);
    assert.equal(out.data.deckBridge.array[name].domain, 'array');
    for (const user of [
      undefined,
      subject(),
      subject('UPDATE_ANY', 'DOCKER'),
      subject('UPDATE_ANY', 'ME'),
    ]) {
      requests.length = 0;
      assert.ok((await run(source, user, { input })).errors?.length);
      assert.equal(requests.length, 0);
    }
  }
  for (const user of [undefined, subject(), subject('UPDATE_ANY', 'DOCKER')]) {
    requests.length = 0;
    assert.ok(
      (await run(prepare, user, { input: { action: 'START', correct: false } }))
        .errors?.length,
    );
    assert.equal(requests.length, 0);
  }
  const info = await run(
    '{deckBridge{info{coreOnline compatible dockerAvailable capabilities}}}',
    subject('READ_ANY', 'ME'),
  );
  assert.equal(info.errors, undefined);
  assert.deepEqual(info.data.deckBridge.info.capabilities, caps);
  assert.equal(info.data.deckBridge.info.dockerAvailable, false);
});

test('Core unavailable is not successful empty state or a control retry/fallback', async (t) => {
  const { run, requests } = await harness(t, { coreOffline: true });
  const status = await run(query, subject());
  assert.equal(status.errors?.[0].extensions.code, 'CORE_UNAVAILABLE');
  assert.equal(status.data, null);
  requests.length = 0;
  const out = await run(prepare, subject('UPDATE_ANY'), {
    input: { action: 'START', correct: false },
  });
  assert.equal(out.errors?.[0].extensions.code, 'CORE_UNAVAILABLE');
  assert.deepEqual(
    requests.map((x) => x.path),
    ['/info'],
  );
  const info = await run(
    '{deckBridge{info{coreOnline compatible capabilities reason}}}',
    subject('READ_ANY', 'ME'),
  );
  assert.equal(info.errors, undefined);
  assert.equal(info.data.deckBridge.info.coreOnline, false);
  assert.deepEqual(info.data.deckBridge.info.capabilities, []);
  assert.equal(info.data.deckBridge.info.reason, 'CORE_UNAVAILABLE');
});

test('capability filtering retains parity reads on unknown OS and control across Docker drift', () => {
  assert.deepEqual(filterCapabilities({ hostWriteSupported: false }, caps), [
    'array.read',
    'array.parity.read',
  ]);
  assert.deepEqual(
    filterCapabilities(
      { hostWriteSupported: true, dockerWriteSupported: false },
      caps,
    ),
    caps,
  );
});

test('last parity result is a separate nullable observation with exact wall-clock seconds', async (t) => {
  const lastResult = {
    state: 'CANCELLED',
    startedAt: '2026-10-01T10:00:00Z',
    finishedAt: '2026-10-01T10:03:00Z',
    elapsedSeconds: '180',
    errorCount: null,
  };
  const statusSnapshot = {
    ...snapshot,
    parity: {
      ...snapshot.parity,
      state: 'IDLE',
      elapsedSeconds: null,
      lastResult,
    },
  };
  const { run } = await harness(t, { statusSnapshot });
  const out = await run(query, subject());
  assert.equal(out.errors, undefined);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(out.data.deckBridge.array.status.parity.lastResult),
    ),
    lastResult,
  );
  assert.equal(out.data.deckBridge.array.status.parity.state, 'IDLE');
  assert.equal(out.data.deckBridge.array.status.parity.elapsedSeconds, null);
});
