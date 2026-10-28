import { ValidationPipe } from '@nestjs/common';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import {
  GraphQLSchemaBuilderModule,
  GraphQLSchemaFactory,
} from '@nestjs/graphql';
import { printSchema, parse, validate } from 'graphql';
import {
  DeckBridgeDockerConfigurationInput,
  DeckBridgeSubmitInput,
  adapter,
} from '../dist/index.js';
import {
  resolvers,
  DeckBridgeRootResolver,
  DeckBridgeQueriesResolver,
  DeckBridgeMutationsResolver,
  DeckBridgeDockerQueriesResolver,
  DeckBridgeDockerMutationsResolver,
  DeckBridgeOperationsResolver,
  DeckBridgeNamespaceGuard,
} from '../dist/index.js';
import { principal } from '../dist/core-client.js';
test('only grouped roots are published and no deprecated plugin fields remain', async () => {
  assert.equal(adapter, 'nestjs');
  const app = await NestFactory.createApplicationContext(
    GraphQLSchemaBuilderModule,
    { logger: false },
  );
  try {
    const schema = await app.get(GraphQLSchemaFactory).create(resolvers);
    assert.deepEqual(Object.keys(schema.getQueryType().getFields()), [
      'deckBridge',
    ]);
    assert.deepEqual(Object.keys(schema.getMutationType().getFields()), [
      'deckBridge',
    ]);
    assert.ok(!printSchema(schema).includes('@deprecated'));
    assert.ok(!printSchema(schema).includes('editorVersion'));
    assert.equal(
      schema.getType('DeckBridgeInfo').getFields().protocol,
      undefined,
    );
    assert.equal(
      schema.getType('DeckBridgeQueries').getFields().storage,
      undefined,
    );
    for (const name of [
      'DeckBridgeStorageQueries',
      'DeckBridgePool',
      'DeckBridgePoolMember',
      'DeckBridgePoolVdev',
      'DeckBridgePoolProfile',
      'DeckBridgePoolScan',
      'DeckBridgePoolCapacity',
      'DeckBridgePoolErrorCounter',
    ])
      assert.equal(schema.getType(name), undefined);
    assert.equal(
      String(schema.getType('DeckBridgePlan').getFields().updateImage.type),
      'Boolean!',
    );
    assert.equal(
      String(schema.getType('DeckBridgeRecovery').getFields().volumes.type),
      '[DeckBridgeRecoveryVolume!]',
    );
    assert.equal(
      String(
        schema.getType('DeckBridgeRecoveryVolume').getFields().created.type,
      ),
      'Boolean!',
    );
    assert.equal(
      String(
        schema.getType('DeckBridgeRecoveryVolume').getFields().exists.type,
      ),
      'Boolean',
    );
    assert.deepEqual(
      validate(
        schema,
        parse(
          '{deckBridge{operations{docker{get(id:"task"){recovery{volumes{name target created exists owned}}}}}}}',
        ),
      ),
      [],
    );
    for (const name of [
      'DeckBridgePreviewInput',
      'DeckBridgeDraftPreviewInput',
      'DeckBridgeCustomCreateInput',
      'DeckBridgeFullConfigurationInput',
    ])
      assert.equal(schema.getType(name), undefined);
  } finally {
    await app.close();
  }
});
test('identity never trusts input headers or anonymous defaults', () => {
  assert.throws(() =>
    principal({ req: { headers: { 'x-bridge-actor': 'root' } } }),
  );
  assert.equal(
    principal({ req: { user: { id: 'official-id' } } }),
    'official-id',
  );
});

test('inputs pass the official global whitelist validation', async () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const submit = await pipe.transform(
    { planId: 'plan', requestId: 'request-123' },
    { type: 'body', metatype: DeckBridgeSubmitInput },
  );
  assert.equal(submit.requestId, 'request-123');
  await assert.rejects(
    pipe.transform(
      { requestId: 'short' },
      { type: 'body', metatype: DeckBridgeSubmitInput },
    ),
  );
  await assert.rejects(
    pipe.transform(
      { requestId: 'request-123', shell: 'unexpected' },
      { type: 'body', metatype: DeckBridgeSubmitInput },
    ),
  );
});

test('namespaces preserve per-action permissions and separate query from mutation', async () => {
  const namespaces = [
    [DeckBridgeRootResolver, ['query', 'mutation']],
    [DeckBridgeQueriesResolver, ['docker', 'operations']],
    [DeckBridgeMutationsResolver, ['docker']],
  ];
  for (const [type, names] of namespaces)
    for (const name of names) {
      assert.deepEqual(
        Reflect.getMetadata('__guards__', type.prototype[name]),
        [DeckBridgeNamespaceGuard],
      );
      assert.equal(
        Reflect.getMetadata('__PERMISSIONS__', type.prototype[name]),
        undefined,
      );
    }
  for (const [type, name, resource, action] of [
    [DeckBridgeQueriesResolver, 'info', 'ME', 'READ_ANY'],
    [DeckBridgeDockerQueriesResolver, 'config', 'DOCKER', 'READ_ANY'],
    ...['prepareInstall', 'install'].map((name) => [
      DeckBridgeDockerMutationsResolver,
      name,
      'DOCKER',
      'CREATE_ANY',
    ]),
    ...['prepareEdit', 'prepareTemplateReplacement', 'edit', 'restart'].map(
      (name) => [
        DeckBridgeDockerMutationsResolver,
        name,
        'DOCKER',
        'UPDATE_ANY',
      ],
    ),
  ]) {
    const permission = Reflect.getMetadata(
      '__PERMISSIONS__',
      type.prototype[name],
    );
    assert.equal(permission?.[0]?.resource, resource);
    assert.equal(permission?.[0]?.action, action);
  }
  const app = await NestFactory.createApplicationContext(
    GraphQLSchemaBuilderModule,
    { logger: false },
  );
  try {
    const schema = await app.get(GraphQLSchemaFactory).create(resolvers);
    for (const query of [
      '{deckBridge{info{version} docker{config(containerId:"id"){id}} operations{docker{get(id:"id"){id} byRequestId(requestId:"request-id"){id}}}}}',
      'mutation($input:DeckBridgeSubmitInput!){deckBridge{docker{restart(input:$input){id}}}}',
      'subscription{deckBridgeDockerOperationEvents(id:"id"){sequence}}',
    ])
      assert.deepEqual(validate(schema, parse(query)), []);
    assert.ok(
      validate(
        schema,
        parse(
          '{deckBridge{docker{restart(input:{containerId:"id",requestId:"request-id"}){id}}}}',
        ),
      ).length > 0,
    );
    for (const root of [schema.getQueryType(), schema.getMutationType()])
      for (const [name, field] of Object.entries(root.getFields())) {
        assert.equal(name, 'deckBridge');
        assert.equal(field.deprecationReason, undefined);
      }
  } finally {
    await app.close();
  }
});
test('namespace guards reject missing identity and grouped handlers retain caller and input', () => {
  const guard = new DeckBridgeNamespaceGuard();
  const execution = (context) => ({
    getType: () => 'graphql',
    getArgs: () => [{}, {}, context, {}],
    getClass: () => DeckBridgeRootResolver,
    getHandler: () => DeckBridgeRootResolver.prototype.query,
  });
  assert.throws(
    () =>
      guard.canActivate(
        execution({ req: { headers: { 'x-bridge-actor': 'spoof' } } }),
      ),
    (error) => error.extensions?.code === 'UNAUTHENTICATED',
  );
  const context = { req: { user: { id: 'official-id' } } };
  assert.equal(guard.canActivate(execution(context)), true);
  const input = { containerId: 'id', requestId: 'request-id' };
  const handlers = {
    write: (actor, path, actual) => {
      assert.deepEqual(actual, input);
      assert.equal(actor, context);
      assert.equal(path, '/docker/submit/restart');
      return { id: 'operation-id' };
    },
  };
  assert.deepEqual(
    new DeckBridgeDockerMutationsResolver(handlers).restart(input, context),
    { id: 'operation-id' },
  );
});

test('host fields and domain task fields have matching official permissions', async () => {
  const api = await import('../dist/index.js');
  for (const [label, resource] of [
    ['System', 'OS'],
    ['Plugin', 'CONFIG'],
    ['Array', 'ARRAY'],
    ['Docker', 'DOCKER'],
  ]) {
    const tasks = api['DeckBridge' + label + 'OperationsResolver'];
    for (const name of ['get', 'byRequestId']) {
      const permission = Reflect.getMetadata(
        '__PERMISSIONS__',
        tasks.prototype[name],
      );
      assert.equal(permission[0].resource, resource);
      assert.equal(permission[0].action, 'READ_ANY');
    }
    const events = api['DeckBridge' + label + 'EventsResolver'];
    const permission = Reflect.getMetadata(
      '__PERMISSIONS__',
      events.prototype['deckBridge' + label + 'OperationEvents'],
    );
    assert.equal(permission[0].resource, resource);
    assert.equal(permission[0].action, 'READ_ANY');
    if (label === 'Docker') continue;
    const read = api['DeckBridge' + label + 'QueriesResolver'];
    assert.equal(
      Reflect.getMetadata(
        '__PERMISSIONS__',
        read.prototype[label === 'Plugin' ? 'installed' : 'status'],
      )[0].resource,
      resource,
    );
    const write = api['DeckBridge' + label + 'MutationsResolver'];
    for (const name of label === 'System'
      ? ['prepare', 'shutdown', 'reboot']
      : label === 'Plugin'
        ? ['prepareUninstall', 'uninstall']
        : [
            'prepare',
            'start',
            'stop',
            'prepareParity',
            'startParity',
            'pauseParity',
            'resumeParity',
            'cancelParity',
          ]) {
      const p = Reflect.getMetadata('__PERMISSIONS__', write.prototype[name]);
      assert.equal(p[0].resource, resource);
      assert.equal(
        p[0].action,
        label === 'Plugin' ? 'DELETE_ANY' : 'UPDATE_ANY',
      );
    }
  }
  const app = await NestFactory.createApplicationContext(
    GraphQLSchemaBuilderModule,
    { logger: false },
  );
  try {
    const schema = await app.get(GraphQLSchemaFactory).create(resolvers);
    assert.deepEqual(
      validate(
        schema,
        parse(
          '{deckBridge{system{status{bootId}} plugins{installed{id uninstallable}} array{status{state canStart canStop}} operations{system{get(id:"id"){domain}} plugins{byRequestId(requestId:"request-id"){id}} array{get(id:"id"){id}} docker{get(id:"id"){id}}}}}',
        ),
      ),
      [],
    );
    assert.deepEqual(
      validate(
        schema,
        parse(
          'mutation($input:DeckBridgeSubmitInput!){deckBridge{system{shutdown(input:$input){id}} plugins{uninstall(input:$input){id}} array{start(input:$input){id}}}}',
        ),
      ),
      [],
    );
  } finally {
    await app.close();
  }
});

test('custom creation uses typed nested values and Docker CREATE permission', async () => {
  const { DeckBridgeDockerConfigurationInput } = await import(
    '../dist/index.js'
  );
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const raw = {
    name: 'deck-bridge-test-custom',
    image: 'nginx:alpine',
    network: 'bridge',
    privileged: true,
    start: false,
    autoStart: false,
    ports: [{ hostPort: 18888, containerPort: 80, protocol: 'tcp' }],
    mounts: [
      { source: '/mnt/cache/apps/test', target: '/config', readOnly: true },
    ],
    environment: [{ name: 'TOKEN', value: 'fixture-only', sensitive: true }],
    labels: [],
  };
  const out = await pipe.transform(raw, {
    type: 'body',
    metatype: DeckBridgeDockerConfigurationInput,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), raw);
  const permission = Reflect.getMetadata(
    '__PERMISSIONS__',
    DeckBridgeDockerMutationsResolver.prototype.prepareInstall,
  )[0];
  assert.equal(permission.resource, 'DOCKER');
  assert.equal(permission.action, 'CREATE_ANY');
  await assert.rejects(
    pipe.transform(
      { ...raw, ports: [{ ...raw.ports[0], hostPort: 70000 }] },
      { type: 'body', metatype: DeckBridgeDockerConfigurationInput },
    ),
  );
});

test('advanced runtime remains typed and permissions separate create, edit, and device discovery', async () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const raw = {
    name: 'fixture',
    image: 'mysql',
    network: 'bridge',
    privileged: false,
    start: true,
    autoStart: false,
    ports: [],
    mounts: [],
    environment: [],
    labels: [],
    runtime: {
      user: '99:100',
      memory: 2147483648,
      restartPolicy: 'unless-stopped',
      healthcheck: { test: ['CMD-SHELL', 'true'], interval: 5000000000 },
    },
    networks: [{ name: 'fixture', ipv4: '172.30.0.2' }],
  };
  const out = await pipe.transform(raw, {
    type: 'body',
    metatype: DeckBridgeDockerConfigurationInput,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), raw);
  await assert.rejects(
    pipe.transform(
      { ...raw, runtime: { shell: 'id' } },
      { type: 'body', metatype: DeckBridgeDockerConfigurationInput },
    ),
  );
  for (const [type, name, resource, action] of [
    [
      DeckBridgeDockerMutationsResolver,
      'prepareInstall',
      'DOCKER',
      'CREATE_ANY',
    ],
    [DeckBridgeDockerMutationsResolver, 'prepareEdit', 'DOCKER', 'UPDATE_ANY'],
    [DeckBridgeDockerQueriesResolver, 'devices', 'OS', 'READ_ANY'],
  ]) {
    const p = Reflect.getMetadata('__PERMISSIONS__', type.prototype[name])[0];
    assert.equal(p.resource, resource);
    assert.equal(p.action, action);
  }
});

test('official PrefixedID is normalized for edit and restart without mutating caller input', () => {
  const context = { req: { user: { id: 'principal' } } };
  const calls = [];
  const resolver = new DeckBridgeDockerMutationsResolver({
    write: (actor, path, input) => {
      calls.push({ actor, path, input });
      return input;
    },
  });
  for (const id of ['container-id', 'server-id:container-id']) {
    const config = { name: 'fixture' };
    resolver.prepareEdit(id, config, true, false, context);
    assert.deepEqual(calls.at(-1), {
      actor: context,
      path: '/docker/preview',
      input: {
        containerId: 'container-id',
        config,
        updateImage: true,
        adoptTemplate: false,
      },
    });
    const input = { containerId: id, requestId: 'request-id' };
    resolver.restart(input, context);
    assert.equal(calls.at(-1).input.containerId, 'container-id');
    assert.equal(input.containerId, id);
  }
});

test('metadata is typed on drafts and plans with nullable patch input', async () => {
  const app = await NestFactory.createApplicationContext(
    GraphQLSchemaBuilderModule,
    { logger: false },
  );
  try {
    const schema = await app.get(GraphQLSchemaFactory).create(resolvers);
    for (const name of ['DeckBridgeTemplateDraft', 'DeckBridgePlan'])
      assert.equal(
        String(schema.getType(name).getFields().metadata.type),
        'DeckBridgeDockerMetadata!',
      );
    const output = schema.getType('DeckBridgeDockerMetadata').getFields();
    assert.deepEqual(Object.keys(output), ['iconUrl', 'webUi', 'shell']);
    for (const field of Object.values(output))
      assert.equal(String(field.type), 'String!');
    assert.equal(
      String(
        schema.getType('DeckBridgeDockerConfigurationInput').getFields()
          .metadata.type,
      ),
      'DeckBridgeDockerMetadataInput',
    );
    for (const field of Object.values(
      schema.getType('DeckBridgeDockerMetadataInput').getFields(),
    ))
      assert.equal(String(field.type), 'String');
    assert.deepEqual(
      validate(
        schema,
        parse(
          '{deckBridge{docker{config(containerId:"id"){metadata{iconUrl webUi shell}}}}}',
        ),
      ),
      [],
    );
    assert.deepEqual(
      validate(
        schema,
        parse(
          'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareEdit(containerId:"id",input:$input){metadata{iconUrl webUi shell}}}}}',
        ),
      ),
      [],
    );
    const schemas = JSON.parse(
      readFileSync(
        new URL('../contracts/openapi.json', import.meta.url),
        'utf8',
      ),
    ).components.schemas;
    for (const name of ['TemplateDraft', 'Plan', 'Spec']) {
      assert.equal(
        schemas[name].properties.metadata.$ref,
        '#/components/schemas/DockerMetadata',
      );
      assert.ok(schemas[name].required.includes('metadata'));
    }
    assert.equal(schemas.Spec.properties.icon, undefined);
    assert.equal(schemas.Spec.properties.webui, undefined);
    assert.equal(schemas.DockerMetadataInput.nullable, true);
    for (const field of Object.values(schemas.DockerMetadataInput.properties))
      assert.equal(field.nullable, true);
  } finally {
    await app.close();
  }
});

test('metadata patch preserves missing, null and empty members through validation and forwarding', async () => {
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const base = {
    name: 'fixture',
    image: 'nginx:alpine',
    network: 'bridge',
    privileged: false,
    start: false,
    autoStart: false,
    ports: [],
    mounts: [],
    environment: [],
    labels: [],
  };
  const context = { req: { user: { id: 'principal' } } };
  const calls = [];
  const resolver = new DeckBridgeDockerMutationsResolver({
    write: (actor, path, input) => {
      calls.push({ actor, path, input });
      return input;
    },
  });
  for (const patch of [
    {},
    { metadata: null },
    { metadata: {} },
    { metadata: { iconUrl: null, webUi: null, shell: null } },
    { metadata: { iconUrl: '', webUi: '', shell: '' } },
    {
      metadata: {
        iconUrl: 'https://example.test/icon.png',
        webUi: 'http://[IP]:[PORT:80]/',
        shell: 'bash',
      },
    },
  ]) {
    const raw = { ...base, ...patch };
    const out = await pipe.transform(raw, {
      type: 'body',
      metatype: DeckBridgeDockerConfigurationInput,
    });
    assert.deepEqual(JSON.parse(JSON.stringify(out)), raw);
    resolver.prepareInstall(out, context);
    assert.equal(calls.at(-1).input.config, out);
    assert.equal(calls.at(-1).path, '/docker/preview');
    assert.equal(calls.at(-1).input.updateImage, false);
    resolver.prepareEdit('server:container', out, false, false, context);
    assert.equal(calls.at(-1).input.config, out);
    assert.equal(calls.at(-1).input.containerId, 'container');
  }
  for (const metadata of [
    { command: 'id' },
    { shell: 'bash -c id' },
    { iconUrl: 'x'.repeat(4097) },
    { webUi: 'x'.repeat(4097) },
  ])
    await assert.rejects(
      pipe.transform(
        { ...base, metadata },
        { type: 'body', metatype: DeckBridgeDockerConfigurationInput },
      ),
    );
});

test('template field patches preserve raw metadata, optional semantics and strict nested whitelist', async () => {
  const { DeckBridgeDockerConfigurationInput } = await import(
    '../dist/index.js'
  );
  const pipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
  const base = {
    name: 'fixture',
    image: 'nginx',
    network: 'bridge',
    privileged: false,
    start: false,
    autoStart: false,
    ports: [],
    mounts: [],
    environment: [{ name: 'MODE', value: 'production', sensitive: false }],
    labels: [],
  };
  const transform = (templateFields) =>
    pipe.transform(
      { ...base, templateFields },
      { type: 'body', metatype: DeckBridgeDockerConfigurationInput },
    );
  const patch = {
    type: 'variable',
    index: 0,
    draftFieldId: 'source-id',
    displayName: '业务模式',
    defaultValue: 'production|staging',
    description: '<b>说明</b>\nraw',
  };
  const value = await transform([patch]);
  assert.deepEqual(JSON.parse(JSON.stringify(value.templateFields)), [patch]);
  assert.equal(value.environment[0].name, 'MODE');
  for (const optional of [
    {},
    { displayName: null, defaultValue: null, description: null },
    { displayName: '', defaultValue: '', description: '' },
  ]) {
    const result = await transform([
      { type: 'variable', index: 0, ...optional },
    ]);
    assert.deepEqual(JSON.parse(JSON.stringify(result.templateFields)), [
      { type: 'variable', index: 0, ...optional },
    ]);
  }
  for (const invalid of [
    { type: 'unknown', index: 0 },
    { type: 'variable' },
    { type: 'variable', index: -1 },
    { type: 'variable', index: 0.5 },
    { ...patch, Name: 'injected' },
    { ...patch, displayName: 'x'.repeat(513) },
    { ...patch, description: 'x'.repeat(65537) },
    { ...patch, defaultValue: 'x'.repeat(65537) },
    { ...patch, draftFieldId: 'x'.repeat(33) },
    { ...patch, description: 'raw\0text' },
  ])
    await assert.rejects(transform([invalid]));
  await assert.rejects(
    transform(
      Array.from({ length: 1281 }, () => ({ type: 'variable', index: 0 })),
    ),
  );
  const unicode = await transform([
    { type: 'variable', index: 0, displayName: '😀'.repeat(512) },
  ]);
  assert.equal(unicode.templateFields[0].displayName, '😀'.repeat(512));
});
