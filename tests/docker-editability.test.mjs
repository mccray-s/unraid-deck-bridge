import test from 'node:test';
import assert from 'node:assert/strict';
import bridgePackage from '../dist/package.json' with { type: 'json' };
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

async function harness(
  t,
  {
    coreOffline = false,
    source = 'ENGINE_INSPECT',
    editable = true,
    recovery,
    coreError,
    operationError,
    changeSummary = [],
    templateManagement = true,
    templateFieldsRead = true,
    templateFields = true,
    editLimitations,
  } = {},
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
  const validation = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: { enableImplicitConversion: true },
  });
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
      new api.DeckBridgeQueriesResolver(),
      'docker',
      () => [],
    ],
    [
      'DeckBridgeQueries',
      'info',
      new api.DeckBridgeQueriesResolver(new api.DeckBridgeService()),
      'info',
      (_, c) => [c],
    ],
    [
      'DeckBridgeMutations',
      'docker',
      new api.DeckBridgeMutationsResolver(),
      'docker',
      () => [],
    ],
    ...['editability', 'config'].map((n) => [
      'DeckBridgeDockerQueries',
      n,
      new api.DeckBridgeDockerQueriesResolver(new api.DeckBridgeService()),
      n,
      (a, c) => [a.containerId, c],
    ]),
    [
      'DeckBridgeDockerQueries',
      'templateAdoption',
      new api.DeckBridgeDockerQueriesResolver(new api.DeckBridgeService()),
      'templateAdoption',
      (a, c) => [a.containerId, c],
    ],
    [
      'DeckBridgeDockerQueries',
      'localTemplates',
      new api.DeckBridgeDockerQueriesResolver(new api.DeckBridgeService()),
      'localTemplates',
      (_a, c) => [c],
    ],
    [
      'DeckBridgeDockerMutations',
      'prepareEdit',
      new api.DeckBridgeDockerMutationsResolver(new api.DeckBridgeService()),
      'prepareEdit',
      (a, c) => [a.containerId, a.input, a.updateImage, a.adoptTemplate, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'prepareTemplateReplacement',
      new api.DeckBridgeDockerMutationsResolver(new api.DeckBridgeService()),
      'prepareTemplateReplacement',
      (a, c) => [a.containerId, a.input, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'importTemplate',
      new api.DeckBridgeDockerMutationsResolver(new api.DeckBridgeService()),
      'importTemplate',
      (a, c) => [a.input, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'prepareInstall',
      new api.DeckBridgeDockerMutationsResolver(new api.DeckBridgeService()),
      'prepareInstall',
      (a, c) => [a.input, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'prepareImageUpdate',
      new api.DeckBridgeDockerMutationsResolver(new api.DeckBridgeService()),
      'prepareImageUpdate',
      (a, c) => [a.input, c],
    ],
    [
      'DeckBridgeDockerMutations',
      'edit',
      new api.DeckBridgeDockerMutationsResolver(new api.DeckBridgeService()),
      'edit',
      (a, c) => [a.input, c],
    ],
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
      if (
        [
          'prepareEdit',
          'prepareInstall',
          'prepareTemplateReplacement',
        ].includes(name)
      )
        input.input = await validation.transform(input.input, {
          type: 'body',
          metatype: api.DeckBridgeDockerConfigurationInput,
        });
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
    if (coreError && req.url !== '/info') {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: coreError }));
      return;
    }
    if (coreOffline) {
      res.statusCode = 503;
      res.end(
        JSON.stringify({
          error: { code: 'CORE_UNAVAILABLE', message: 'Core unavailable' },
        }),
      );
      return;
    }
    const limitations =
      editLimitations ??
      (source === 'ENGINE_INSPECT'
        ? [{ code: 'IMAGE_FIXED', field: 'image', blocking: false }]
        : []);
    if (req.url === '/info')
      res.end(
        JSON.stringify({
          version: bridgePackage.version,
          accepting: true,
          dockerAvailable: true,
          capabilities: [
            'docker.engineEdit',
            ...(templateManagement ? ['docker.templateManagementRead'] : []),
            ...(templateFieldsRead ? ['docker.templateFieldsRead'] : []),
            ...(templateFields ? ['docker.templateFields'] : []),
          ],
        }),
      );
    else if (
      req.url.startsWith('/docker/editability?') ||
      req.url.startsWith('/docker/template-adoption?')
    )
      res.end(
        JSON.stringify({
          editable,
          source: editable ? source : null,
          reasonCode: editable ? null : 'EXTERNAL_MANAGER',
          limitations,
        }),
      );
    else if (req.url === '/docker/templates') res.end('[]');
    else if (req.url.startsWith('/docker/config?'))
      res.end(JSON.stringify({ id: 'draft', source, limitations }));
    else if (req.url === '/docker/drafts')
      res.end(JSON.stringify({ id: 'draft' }));
    else if (
      [
        '/docker/preview',
        '/docker/preview/template-replacement',
        '/docker/image-updates/preview',
      ].includes(req.url)
    )
      res.end(
        JSON.stringify({
          id: 'plan',
          source,
          sourceAfter: body.adoptTemplate ? 'UNRAID_TEMPLATE' : source,
          targetContainerId: body.containerId ?? null,
          limitations,
          changeSummary,
          kind: req.url.endsWith('template-replacement')
            ? 'TEMPLATE_REPLACE'
            : body.adoptTemplate
              ? 'TEMPLATE_ADOPT'
              : source === 'ENGINE_INSPECT'
                ? 'ENGINE_EDIT'
                : 'EDIT',
          updateImage: body.updateImage,
        }),
      );
    else if (req.url === '/docker/submit/edit')
      res.end(
        JSON.stringify({
          id: 'operation',
          kind: source === 'ENGINE_INSPECT' ? 'ENGINE_EDIT' : 'EDIT',
          recovery,
          error: operationError,
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

const subject = (action = 'READ_ANY', resource = 'DOCKER') => ({
  id: 'docker-principal',
  action,
  resource,
});
const query =
  '{deckBridge{docker{editability(containerId:"server:container"){editable source reasonCode limitations{code field blocking}}}}}';
const input = {
  name: 'fixture',
  image: 'fixed',
  network: 'bridge',
  privileged: false,
  start: true,
  autoStart: true,
  ports: [],
  mounts: [],
  environment: [],
  labels: [],
};
test('standalone editability needs Docker READ only and allocates no draft or plan', async (t) => {
  const { run, requests } = await harness(t);
  const out = await run(query, subject());
  assert.equal(out.errors, undefined);
  assert.equal(out.data.deckBridge.docker.editability.source, 'ENGINE_INSPECT');
  assert.equal(out.data.deckBridge.docker.editability.reasonCode, null);
  assert.deepEqual(requests, [
    {
      path: '/docker/editability?containerId=container',
      actor: 'docker-principal',
      body: undefined,
    },
  ]);
  for (const user of [
    undefined,
    subject('UPDATE_ANY'),
    subject('READ_ANY', 'ME'),
  ]) {
    requests.length = 0;
    assert.ok((await run(query, user)).errors?.length);
    assert.equal(requests.length, 0);
  }
  assert.ok(
    (await run('{deckBridge{info{principalId}}}', subject())).errors?.length,
  );
});
test('ineligible result preserves nullable source and structured limitations', async (t) => {
  const { run } = await harness(t, { editable: false });
  const out = await run(query, subject());
  assert.equal(out.errors, undefined);
  assert.equal(out.data.deckBridge.docker.editability.source, null);
  assert.equal(
    out.data.deckBridge.docker.editability.reasonCode,
    'EXTERNAL_MANAGER',
  );
});
for (const source of ['UNRAID_TEMPLATE', 'ENGINE_INSPECT'])
  test(
    source +
      ' draft preview and existing edit endpoint keep source and update permissions',
    async (t) => {
      const { run, requests } = await harness(t, { source });
      const draft = await run(
        '{deckBridge{docker{config(containerId:"server:container"){id source limitations{code field blocking}}}}}',
        subject(),
      );
      assert.equal(draft.errors, undefined);
      assert.equal(draft.data.deckBridge.docker.config.source, source);
      const prepare =
        'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareEdit(containerId:"server:container",input:$input){id kind source updateImage limitations{code field blocking}}}}}';
      requests.length = 0;
      const out = await run(prepare, subject('UPDATE_ANY'), { input });
      assert.equal(out.errors, undefined);
      assert.equal(out.data.deckBridge.docker.prepareEdit.source, source);
      assert.equal(
        out.data.deckBridge.docker.prepareEdit.kind,
        source === 'ENGINE_INSPECT' ? 'ENGINE_EDIT' : 'EDIT',
      );
      assert.equal(out.data.deckBridge.docker.prepareEdit.updateImage, false);
      assert.deepEqual(
        requests.map((x) => x.path),
        ['/info', '/docker/preview'],
      );
      assert.equal(requests.at(-1).body.config.autoStart, true);
      const submit =
        'mutation{deckBridge{docker{edit(input:{planId:"plan",requestId:"request-fixture"}){id kind}}}}';
      const operation = await run(submit, subject('UPDATE_ANY'));
      assert.equal(operation.errors, undefined);
      assert.equal(
        operation.data.deckBridge.docker.edit.kind,
        source === 'ENGINE_INSPECT' ? 'ENGINE_EDIT' : 'EDIT',
      );
      for (const user of [
        undefined,
        subject(),
        subject('CREATE_ANY'),
        subject('UPDATE_ANY', 'ME'),
      ])
        for (const q of [prepare, submit]) {
          requests.length = 0;
          assert.ok((await run(q, user, { input })).errors?.length);
          assert.equal(requests.length, 0);
        }
    },
  );
test('optional template lookup limitation remains nonblocking across eligibility draft and ordinary preview', async (t) => {
  const limitations = [
    { code: 'TEMPLATE_LOOKUP_INCOMPLETE', field: null, blocking: false },
  ];
  const { run, requests } = await harness(t, { editLimitations: limitations });
  const eligibility = await run(query, subject());
  assert.equal(eligibility.errors, undefined);
  assert.equal(eligibility.data.deckBridge.docker.editability.editable, true);
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        eligibility.data.deckBridge.docker.editability.limitations,
      ),
    ),
    limitations,
  );
  const draft = await run(
    '{deckBridge{docker{config(containerId:"server:container"){source limitations{code field blocking}}}}}',
    subject(),
  );
  assert.equal(draft.errors, undefined);
  assert.equal(draft.data.deckBridge.docker.config.source, 'ENGINE_INSPECT');
  assert.deepEqual(
    JSON.parse(JSON.stringify(draft.data.deckBridge.docker.config.limitations)),
    limitations,
  );
  requests.length = 0;
  const preview = await run(
    'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareEdit(containerId:"server:container",input:$input){kind source sourceAfter limitations{code field blocking}}}}}',
    subject('UPDATE_ANY'),
    { input },
  );
  assert.equal(preview.errors, undefined);
  assert.deepEqual(
    JSON.parse(JSON.stringify(preview.data.deckBridge.docker.prepareEdit)),
    {
      kind: 'ENGINE_EDIT',
      source: 'ENGINE_INSPECT',
      sourceAfter: 'ENGINE_INSPECT',
      limitations,
    },
  );
  assert.equal(requests.at(-1).body.adoptTemplate, false);
});
test('engine capability follows existing host and Docker write compatibility', () => {
  assert.deepEqual(
    filterCapabilities({ hostWriteSupported: false }, ['docker.engineEdit']),
    [],
  );
  assert.deepEqual(
    filterCapabilities(
      { hostWriteSupported: true, dockerWriteSupported: false },
      ['docker.engineEdit'],
    ),
    [],
  );
  assert.deepEqual(
    filterCapabilities(
      { hostWriteSupported: true, dockerWriteSupported: true },
      ['docker.engineEdit'],
    ),
    ['docker.engineEdit'],
  );
});

test('OpenAPI and GraphQL freeze sources, limitations, nullability and new operation kind', async (t) => {
  const d = JSON.parse(
      fs.readFileSync(
        new URL('../contracts/openapi.json', import.meta.url),
        'utf8',
      ),
    ),
    s = d.components.schemas;
  assert.deepEqual(s.DockerConfigurationSource.enum, [
    'UNRAID_TEMPLATE',
    'ENGINE_INSPECT',
  ]);
  assert.deepEqual(s.DockerEditability.properties.source.anyOf, [
    { $ref: '#/components/schemas/DockerConfigurationSource' },
    { type: 'null' },
  ]);
  assert.deepEqual(s.DockerEditability.properties.reasonCode.type, [
    'string',
    'null',
  ]);
  assert.deepEqual(s.DockerEditLimitation.properties.field.type, [
    'string',
    'null',
  ]);
  for (const name of ['Plan', 'TemplateDraft'])
    for (const field of ['source', 'limitations'])
      assert.ok(s[name].required.includes(field));
  for (const name of ['Plan', 'Operation'])
    assert.ok(s[name].properties.kind.enum.includes('ENGINE_EDIT'));
  assert.equal(s.Operation.properties.source, undefined);
  assert.equal(s.DockerConfiguration.properties.source, undefined);
  const { schema } = await harness(t);
  for (const name of ['DeckBridgePlan', 'DeckBridgeTemplateDraft']) {
    const f = schema.getType(name).getFields();
    assert.equal(String(f.source.type), 'DeckBridgeDockerConfigurationSource!');
    assert.equal(
      String(f.limitations.type),
      '[DeckBridgeDockerEditLimitation!]!',
    );
  }
});

for (const observed of [true, false, null, undefined])
  test(
    'Engine recovery observation survives Unix and GraphQL with value ' +
      String(observed),
    async (t) => {
      const recovery = {
        checkedAt: '2026-10-04T00:00:00Z',
        reason: 'Observation',
      };
      if (observed !== undefined)
        recovery.engineConfigurationMatches = observed;
      const { run, schema } = await harness(t, { recovery });
      const out = await run(
        'mutation{deckBridge{docker{edit(input:{planId:"plan",requestId:"request-fixture"}){kind recovery{checkedAt reason engineConfigurationMatches}}}}}',
        subject('UPDATE_ANY'),
      );
      assert.equal(out.errors, undefined);
      assert.equal(
        out.data.deckBridge.docker.edit.recovery.engineConfigurationMatches,
        observed ?? null,
      );
      assert.equal(
        String(
          schema.getType('DeckBridgeRecovery').getFields()
            .engineConfigurationMatches.type,
        ),
        'Boolean',
      );
      const contract = JSON.parse(
        fs.readFileSync(
          new URL('../contracts/openapi.json', import.meta.url),
          'utf8',
        ),
      ).components.schemas.Recovery;
      assert.equal(contract.additionalProperties, false);
      assert.deepEqual(contract.properties.engineConfigurationMatches.type, [
        'boolean',
        'null',
      ]);
      assert.ok(!contract.required.includes('engineConfigurationMatches'));
      // Model closed-object contract enforcement against the actual transport fixture.
      for (const key of Object.keys(recovery))
        assert.ok(Object.hasOwn(contract.properties, key), key);
    },
  );

test('structured issues cross real GraphQL errors and operation errors without unknown payload', async (t) => {
  const issue = {
    field: 'mounts',
    target: '/data',
    index: 0,
    hostPath: '/private/secret',
    value: 'secret',
  };
  const { run } = await harness(t, {
    coreError: {
      code: 'MOUNT_SOURCE_MISSING',
      message: 'Mount unavailable',
      issue,
      secret: 'raw',
    },
  });
  const out = await run(query, subject());
  assert.equal(out.errors[0].extensions.code, 'MOUNT_SOURCE_MISSING');
  assert.deepEqual(out.errors[0].extensions.deckBridgeIssue, {
    field: 'mounts',
    target: '/data',
    index: 0,
  });
  assert.ok(!JSON.stringify(out).includes('secret'));
});
for (const issue of [
  { field: 'unknown', target: '/secret' },
  { field: 'mounts', index: -1 },
  { field: 'mounts', index: 0.5 },
  { field: 'mounts', target: { secret: true } },
  { field: 'image', target: '/host/secret' },
])
  test(
    'invalid structured issue is omitted ' + JSON.stringify(issue),
    async (t) => {
      const { run } = await harness(t, {
        coreError: {
          code: 'INVALID_INPUT',
          message: 'Invalid configuration',
          issue,
        },
      });
      const out = await run(query, subject());
      assert.equal(out.errors[0].extensions.code, 'INVALID_INPUT');
      assert.equal(out.errors[0].extensions.deckBridgeIssue, undefined);
    },
  );
test('typed operation issue keeps approved structure', async (t) => {
  const { run } = await harness(t, {
    operationError: {
      code: 'MOUNT_SOURCE_UNREADABLE',
      message: 'Mount unavailable',
      issue: { field: 'mounts', target: '/data', index: 0, raw: 'secret' },
    },
  });
  const out = await run(
    'mutation{deckBridge{docker{edit(input:{planId:"plan",requestId:"request-fixture"}){error{code issue{field target index}}}}}}',
    subject('UPDATE_ANY'),
  );
  assert.equal(out.errors, undefined);
  assert.deepEqual(
    JSON.parse(JSON.stringify(out.data.deckBridge.docker.edit.error.issue)),
    { field: 'mounts', target: '/data', index: 0 },
  );
  assert.ok(!JSON.stringify(out).includes('secret'));
});
test('plan summary redacts sensitive before/after and strips unknown diagnostics', async (t) => {
  const { run } = await harness(t, {
    changeSummary: [
      {
        field: 'environment',
        kind: 'MODIFIED',
        target: 'PASSWORD',
        before: 'oldsecret',
        after: 'newsecret',
        sensitive: true,
        raw: 'secret',
      },
      {
        field: 'autoStart',
        kind: 'MODIFIED',
        before: 'false',
        after: 'true',
        sensitive: false,
      },
    ],
  });
  const out = await run(
    'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareEdit(containerId:"id",input:$input){changeSummary{field kind target before after sensitive}}}}}',
    subject('UPDATE_ANY'),
    { input },
  );
  assert.equal(out.errors, undefined);
  const changes = out.data.deckBridge.docker.prepareEdit.changeSummary;
  assert.equal(changes[0].before, null);
  assert.equal(changes[0].after, null);
  assert.equal(changes[1].after, 'true');
  assert.ok(!JSON.stringify(out).includes('secret'));
});
test('invalid summary is a protocol error instead of silent data loss', async (t) => {
  const { run } = await harness(t, {
    changeSummary: [{ field: 'unknown', kind: 'MODIFIED', sensitive: false }],
  });
  const out = await run(
    'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareEdit(containerId:"id",input:$input){changeSummary{field}}}}}',
    subject('UPDATE_ANY'),
    { input },
  );
  assert.equal(out.errors[0].extensions.code, 'CORE_RESPONSE_INVALID');
});

const adoptionQuery =
  '{deckBridge{docker{templateAdoption(containerId:"server:container"){editable source reasonCode limitations{code field blocking}}}}}';
const adoptionPreview =
  'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareEdit(containerId:"server:container",input:$input,adoptTemplate:true){id kind source sourceAfter targetContainerId}}}}';
const replacementPreview =
  'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareTemplateReplacement(containerId:"server:container",input:$input){id kind source sourceAfter targetContainerId}}}}';
test('adoption eligibility is read-only Docker READ and never requires ME', async (t) => {
  const { run, requests } = await harness(t);
  const out = await run(adoptionQuery, subject());
  assert.equal(out.errors, undefined);
  assert.equal(
    out.data.deckBridge.docker.templateAdoption.source,
    'ENGINE_INSPECT',
  );
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/info', '/docker/template-adoption?containerId=container'],
  );
  assert.ok(
    requests.every(
      (r) => r.actor === 'docker-principal' && r.body === undefined,
    ),
  );
  for (const user of [
    undefined,
    subject('CREATE_ANY'),
    subject('UPDATE_ANY'),
    subject('READ_ANY', 'ME'),
  ]) {
    requests.length = 0;
    assert.ok((await run(adoptionQuery, user)).errors?.length);
    assert.equal(requests.length, 0);
  }
});
for (const [document, source, kind, path] of [
  [adoptionPreview, 'ENGINE_INSPECT', 'TEMPLATE_ADOPT', '/docker/preview'],
  [
    replacementPreview,
    'UNRAID_TEMPLATE',
    'TEMPLATE_REPLACE',
    '/docker/preview/template-replacement',
  ],
])
  test(
    kind + ' requires UPDATE only and freezes the explicit intent and ID',
    async (t) => {
      const { run, requests } = await harness(t, { source });
      for (const user of [
        undefined,
        subject(),
        subject('CREATE_ANY'),
        subject('UPDATE_ANY', 'ME'),
      ]) {
        assert.ok((await run(document, user, { input })).errors?.length);
        assert.equal(requests.length, 0);
      }
      const out = await run(document, subject('UPDATE_ANY'), { input });
      assert.equal(out.errors, undefined);
      const plan =
        out.data.deckBridge.docker[
          kind === 'TEMPLATE_ADOPT'
            ? 'prepareEdit'
            : 'prepareTemplateReplacement'
        ];
      assert.deepEqual(JSON.parse(JSON.stringify(plan)), {
        id: 'plan',
        kind,
        source,
        sourceAfter: 'UNRAID_TEMPLATE',
        targetContainerId: 'container',
      });
      assert.deepEqual(
        requests.map((r) => r.path),
        ['/info', path],
      );
      assert.deepEqual(requests[1].body, {
        containerId: 'container',
        config: input,
        updateImage: false,
        adoptTemplate: kind === 'TEMPLATE_ADOPT',
      });
    },
  );
for (const [document, action, variables] of [
  [adoptionQuery, 'READ_ANY', undefined],
  [
    '{deckBridge{docker{localTemplates{id containerId}}}}',
    'READ_ANY',
    undefined,
  ],
  [adoptionPreview, 'UPDATE_ANY', { input }],
  [replacementPreview, 'UPDATE_ANY', { input }],
  [
    'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareInstall(input:$input){id}}}}',
    'CREATE_ANY',
    { input },
  ],
  [
    'mutation{deckBridge{docker{prepareImageUpdate(input:{containerId:"container",currentImageId:"sha256:image",checkId:"check",revision:1}){id}}}}',
    'UPDATE_ANY',
    undefined,
  ],
])
  test(
    'old Core protocol blocks only new reads/plans: ' + document,
    async (t) => {
      const { run, requests } = await harness(t, { templateManagement: false });
      const out = await run(document, subject(action), variables);
      assert.equal(
        out.errors?.[0]?.extensions.code,
        'TEMPLATE_MANAGEMENT_UPGRADE_REQUIRED',
      );
      assert.deepEqual(
        requests.map((r) => r.path),
        ['/info'],
      );
    },
  );
test('old Core edit submission remains available for recovery', async (t) => {
  const { run, requests } = await harness(t, { templateManagement: false });
  const out = await run(
    'mutation{deckBridge{docker{edit(input:{planId:"plan",requestId:"request-fixture"}){id}}}}',
    subject('UPDATE_ANY'),
  );
  assert.equal(out.errors, undefined);
  assert.equal(out.data.deckBridge.docker.edit.id, 'operation');
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/info', '/docker/submit/edit'],
  );
});
test('protocol gate never relabels transport or business errors as upgrade', async (t) => {
  const { run, requests } = await harness(t, { coreOffline: true });
  const out = await run(adoptionQuery, subject());
  assert.equal(out.errors?.[0]?.extensions.code, 'CORE_UNAVAILABLE');
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/info'],
  );
});
test('new capabilities obey host filters while the read protocol marker survives', () => {
  const capabilities = [
    'docker.templateManagementRead',
    'docker.templateFieldsRead',
    'docker.templateFields',
    'docker.templateAdopt',
    'docker.templateReplace',
  ];
  for (const host of [
    { hostWriteSupported: false },
    { hostWriteSupported: true, dockerWriteSupported: false },
  ])
    assert.deepEqual(filterCapabilities(host, capabilities), [
      'docker.templateManagementRead',
      'docker.templateFieldsRead',
    ]);
  assert.deepEqual(
    filterCapabilities(
      { hostWriteSupported: true, dockerWriteSupported: true },
      capabilities,
    ),
    capabilities,
  );
});
test('template management remains closed to client kind/source/overwrite switches', async (t) => {
  const { run, requests } = await harness(t);
  for (const extra of [
    { kind: 'TEMPLATE_ADOPT' },
    { source: 'ENGINE_INSPECT' },
    { overwrite: true },
    { adoptTemplate: true },
  ]) {
    const out = await run(replacementPreview, subject('UPDATE_ANY'), {
      input: { ...input, ...extra },
    });
    assert.ok(out.errors?.length);
    assert.equal(requests.length, 0);
  }
  const contract = JSON.parse(
      fs.readFileSync(
        new URL('../contracts/openapi.json', import.meta.url),
        'utf8',
      ),
    ),
    s = contract.components.schemas;
  assert.equal(s.DockerPreview.additionalProperties, false);
  assert.equal(s.DockerConfiguration.additionalProperties, false);
  assert.equal(s.DockerPreview.properties.adoptTemplate.default, false);
  for (const kind of ['TEMPLATE_ADOPT', 'TEMPLATE_REPLACE'])
    for (const name of ['Plan', 'Operation'])
      assert.ok(s[name].properties.kind.enum.includes(kind));
  for (const field of ['sourceAfter', 'targetContainerId'])
    assert.ok(s.Plan.required.includes(field));
  assert.ok(s.LocalTemplate.required.includes('containerId'));
});
test('ordinary install pins adoption off and cannot accept an adoption argument', async (t) => {
  const { run, requests } = await harness(t, { source: 'UNRAID_TEMPLATE' });
  const document =
    'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareInstall(input:$input){id source sourceAfter targetContainerId}}}}';
  const out = await run(document, subject('CREATE_ANY'), { input });
  assert.equal(out.errors, undefined);
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/info', '/docker/preview'],
  );
  assert.deepEqual(requests[1].body, {
    config: input,
    updateImage: false,
    adoptTemplate: false,
  });
  assert.equal(
    out.data.deckBridge.docker.prepareInstall.targetContainerId,
    null,
  );
  requests.length = 0;
  const invalid = await run(
    'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareInstall(input:$input,adoptTemplate:true){id}}}}',
    subject('CREATE_ANY'),
    { input },
  );
  assert.ok(invalid.errors?.length);
  assert.equal(requests.length, 0);
});
test('adoption domain refusal preserves its code instead of becoming an upgrade', async (t) => {
  const { run, requests } = await harness(t, {
    coreError: {
      code: 'TEMPLATE_DESTINATION_OCCUPIED',
      message: 'Template destination is occupied',
    },
  });
  const out = await run(adoptionQuery, subject());
  assert.equal(
    out.errors?.[0]?.extensions.code,
    'TEMPLATE_DESTINATION_OCCUPIED',
  );
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/info', '/docker/template-adoption?containerId=container'],
  );
});

const fieldsConfigQuery =
  '{deckBridge{docker{config(containerId:"server:container"){id}}}}';
const fieldsImport =
  'mutation{deckBridge{docker{importTemplate(input:{source:XML,xml:"<Container/>"}){id}}}}';
for (const [document, action] of [
  [fieldsConfigQuery, 'READ_ANY'],
  [fieldsImport, 'CREATE_ANY'],
])
  test('draft protocol requires fields-read marker: ' + action, async (t) => {
    const { run, requests } = await harness(t, { templateFieldsRead: false });
    const result = await run(document, subject(action));
    assert.equal(
      result.errors?.[0]?.extensions.code,
      'TEMPLATE_MANAGEMENT_UPGRADE_REQUIRED',
    );
    assert.deepEqual(
      requests.map((r) => r.path),
      ['/info'],
    );
  });
test('configuration read checks info once with the same Docker READ principal', async (t) => {
  const { run, requests } = await harness(t, { templateFields: false });
  const result = await run(fieldsConfigQuery, subject());
  assert.equal(result.errors, undefined);
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/info', '/docker/config?containerId=container'],
  );
  assert.ok(
    requests.every(
      (r) => r.actor === 'docker-principal' && r.body === undefined,
    ),
  );
  for (const user of [
    undefined,
    subject('UPDATE_ANY'),
    subject('READ_ANY', 'ME'),
  ]) {
    requests.length = 0;
    assert.ok((await run(fieldsConfigQuery, user)).errors?.length);
    assert.equal(requests.length, 0);
  }
});
for (const document of [
  adoptionPreview,
  replacementPreview,
  'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareInstall(input:$input){id}}}}',
])
  for (const capability of ['templateFieldsRead', 'templateFields'])
    test(
      'nonempty template metadata needs ' + capability + ' for ' + document,
      async (t) => {
        const { run, requests } = await harness(t, { [capability]: false });
        const action = document.includes('prepareInstall')
          ? 'CREATE_ANY'
          : 'UPDATE_ANY';
        const config = {
          ...input,
          environment: [
            { name: 'MODE', value: 'production', sensitive: false },
          ],
          templateFields: [
            { type: 'variable', index: 0, displayName: '业务模式' },
          ],
        };
        const result = await run(document, subject(action), { input: config });
        assert.equal(
          result.errors?.[0]?.extensions.code,
          'TEMPLATE_MANAGEMENT_UPGRADE_REQUIRED',
        );
        assert.deepEqual(
          requests.map((r) => r.path),
          ['/info'],
        );
        for (const templateFields of [undefined, [], null]) {
          requests.length = 0;
          const ordinary = await run(document, subject(action), {
            input: { ...input, templateFields },
          });
          assert.equal(ordinary.errors, undefined);
          assert.deepEqual(
            requests.map((r) => r.path),
            [
              '/info',
              document.includes('prepareTemplateReplacement')
                ? '/docker/preview/template-replacement'
                : '/docker/preview',
            ],
          );
        }
      },
    );
test('template metadata summary never exposes before/after even with incorrect sensitivity', async (t) => {
  const { run } = await harness(t, {
    changeSummary: [
      {
        field: 'templateFields',
        kind: 'CHANGED',
        target: 'variable:0',
        before: 'private-default',
        after: 'private-description',
        sensitive: false,
      },
    ],
  });
  const result = await run(
    'mutation($input:DeckBridgeDockerConfigurationInput!){deckBridge{docker{prepareEdit(containerId:"id",input:$input){changeSummary{field kind target before after sensitive}}}}}',
    subject('UPDATE_ANY'),
    { input },
  );
  assert.equal(result.errors, undefined);
  const [change] = result.data.deckBridge.docker.prepareEdit.changeSummary;
  assert.equal(change.kind, 'CHANGED');
  assert.equal(change.before, null);
  assert.equal(change.after, null);
  assert.ok(!JSON.stringify(result).includes('private-'));
});

test('invalid template field indexes and unknown properties cannot reach Core', async (t) => {
  const { run, requests } = await harness(t);
  for (const field of [
    { type: 'variable' },
    { type: 'variable', index: -1 },
    { type: 'variable', index: 0.5 },
    { type: 'invalid', index: 0 },
    { type: 'variable', index: 0, Name: 'injected' },
    { type: 'variable', index: 0, description: 'raw\0secret' },
  ]) {
    requests.length = 0;
    const result = await run(adoptionPreview, subject('UPDATE_ANY'), {
      input: { ...input, templateFields: [field] },
    });
    assert.ok(result.errors?.length);
    assert.equal(requests.length, 0);
  }
});
test('template default conflicts retain safe location and discard private diagnostics', async (t) => {
  const issue = {
    field: 'templateFields.defaultValue',
    index: 0,
    target: 'variable',
    defaultValue: 'private-default',
    description: 'private-description',
  };
  const { run } = await harness(t, {
    coreError: {
      code: 'TEMPLATE_DEFAULT_CONFLICT',
      message:
        'The template default cannot preserve an empty current value in Unraid WebUI',
      issue,
    },
  });
  const result = await run(adoptionPreview, subject('UPDATE_ANY'), {
    input: {
      ...input,
      environment: [{ name: 'MODE', value: '', sensitive: false }],
      templateFields: [
        { type: 'variable', index: 0, defaultValue: 'production' },
      ],
    },
  });
  assert.equal(
    result.errors?.[0]?.extensions.code,
    'TEMPLATE_DEFAULT_CONFLICT',
  );
  assert.deepEqual(result.errors[0].extensions.deckBridgeIssue, {
    field: 'templateFields.defaultValue',
    index: 0,
    target: 'variable',
  });
  assert.ok(!JSON.stringify(result).includes('private-'));
});
