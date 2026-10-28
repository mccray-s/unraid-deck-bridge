import test from 'node:test';
import assert from 'node:assert/strict';
import bridgePackage from '../dist/package.json' with { type: 'json' };
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

const templateId = 'lt_' + 'a'.repeat(64),
  revision = 'b'.repeat(64);
const templates = [
  {
    id: templateId,
    kind: 'USER',
    revision,
    name: 'Saved application',
    image: 'nginx:alpine',
    iconUrl: 'https://example.com/xml-icon.png',
    containerExists: true,
    containerId: 'container-fixture',
    issueCode: null,
  },
  {
    id: 'lt_' + 'c'.repeat(64),
    kind: 'DEFAULT',
    revision,
    name: 'Unavailable',
    image: null,
    iconUrl: null,
    containerExists: null,
    containerId: null,
    issueCode: 'INVALID_TEMPLATE',
  },
];
const list =
  '{deckBridge{docker{localTemplates{id kind revision name image iconUrl containerExists containerId issueCode}}}}';
const mutation =
  'mutation($input:DeckBridgeTemplateImportInput!){deckBridge{docker{importTemplate(input:$input){id source sourceUrl name image}}}}';
const subject = (action = 'READ_ANY', resource = 'DOCKER') => ({
  id: 'template-principal',
  resource,
  action,
});

async function harness(t) {
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
  const service = new api.DeckBridgeService();
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
      'DeckBridgeMutations',
      'docker',
      new api.DeckBridgeMutationsResolver(),
      'docker',
      () => [],
    ],
    [
      'DeckBridgeDockerQueries',
      'localTemplates',
      new api.DeckBridgeDockerQueriesResolver(service),
      'localTemplates',
      (_a, c) => [c],
    ],
    [
      'DeckBridgeDockerMutations',
      'importTemplate',
      new api.DeckBridgeDockerMutationsResolver(service),
      'importTemplate',
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
      return handler.apply(instance, args(input, context));
    };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-local-templates-')),
    socket = path.join(dir, 'core.sock'),
    requests = [];
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    requests.push({
      method: req.method,
      path: req.url,
      actor: req.headers['x-bridge-actor'],
      body: text ? JSON.parse(text) : undefined,
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/info')
      res.end(
        JSON.stringify({
          version: bridgePackage.version,
          accepting: true,
          dockerAvailable: true,
          capabilities: [
            'docker.templateDrafts',
            'docker.templateManagementRead',
            'docker.templateFieldsRead',
          ],
        }),
      );
    else if (req.method === 'GET' && req.url === '/docker/templates')
      res.end(
        JSON.stringify(
          templates.map((row) => ({
            ...row,
            metadata: {
              iconUrl: row.iconUrl,
              webUi: 'https://private.example.com',
              shell: 'bash',
            },
            xml: '<Container>fixture-secret</Container>',
            configuration: { TOKEN: 'fixture-secret' },
          })),
        ),
      );
    else if (req.method === 'POST' && req.url === '/docker/drafts')
      res.end(
        JSON.stringify({
          id: 'fixture-draft',
          source: 'UNRAID_TEMPLATE',
          sourceUrl: '',
          name: 'Saved application',
          image: 'nginx:alpine',
        }),
      );
    else {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: 'Unexpected fixture request' },
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

test('Docker READ lists complete sanitized rows through Unix without ME or CREATE', async (t) => {
  const { run, requests, schema } = await harness(t);
  const out = await run(list, subject());
  assert.equal(out.errors, undefined);
  assert.deepEqual(
    JSON.parse(JSON.stringify(out.data.deckBridge.docker.localTemplates)),
    templates,
  );
  assert.deepEqual(requests, [
    {
      method: 'GET',
      path: '/info',
      actor: 'template-principal',
      body: undefined,
    },
    {
      method: 'GET',
      path: '/docker/templates',
      actor: 'template-principal',
      body: undefined,
    },
  ]);
  assert.equal(
    String(
      schema.getType('DeckBridgeDockerQueries').getFields().localTemplates.type,
    ),
    '[DeckBridgeLocalTemplate!]!',
  );
  assert.equal(
    String(schema.getType('DeckBridgePlan').getFields().templateReuse.type),
    'Boolean!',
  );
  for (const user of [
    undefined,
    subject('CREATE_ANY'),
    subject('READ_ANY', 'ME'),
  ]) {
    requests.length = 0;
    assert.ok((await run(list, user)).errors?.length);
    assert.equal(requests.length, 0);
  }
});

test('CREATE imports each explicit source; READ and unauthorized identities never reach Core', async (t) => {
  const { run, requests, schema } = await harness(t);
  const inputs = [
    { source: 'URL', url: 'https://example.com/template.xml' },
    { source: 'XML', xml: '<Container/>' },
    { source: 'LOCAL', templateId, revision },
  ];
  for (const input of inputs) {
    requests.length = 0;
    const out = await run(mutation, subject('CREATE_ANY'), { input });
    assert.equal(out.errors, undefined);
    assert.equal(out.data.deckBridge.docker.importTemplate.id, 'fixture-draft');
    assert.deepEqual(
      requests.map((r) => [r.method, r.path]),
      [
        ['GET', '/info'],
        ['POST', '/docker/drafts'],
      ],
    );
    assert.deepEqual(requests[1].body, input);
    assert.equal(requests[1].actor, 'template-principal');
  }
  const field = schema
    .getType('DeckBridgeDockerMutations')
    .getFields().importTemplate;
  assert.deepEqual(
    field.args.map((a) => [a.name, String(a.type)]),
    [['input', 'DeckBridgeTemplateImportInput!']],
  );
  for (const user of [
    undefined,
    subject(),
    subject('UPDATE_ANY'),
    subject('CREATE_ANY', 'ME'),
  ]) {
    requests.length = 0;
    assert.ok((await run(mutation, user, { input: inputs[2] })).errors?.length);
    assert.equal(requests.length, 0);
  }
});

test('source-specific invalid fields fail before compatibility, fetch, draft or Engine requests', async (t) => {
  const { run, requests } = await harness(t);
  const invalid = [
    { source: 'URL' },
    { source: 'URL', url: ' \t\n' },
    { source: 'XML' },
    { source: 'XML', xml: ' \n' },
    { source: 'LOCAL' },
    { source: 'LOCAL', templateId, revision: ' ' },
    { source: 'LOCAL', templateId: ' ', revision },
  ];
  for (const source of ['URL', 'XML', 'LOCAL']) {
    const base =
      source === 'URL'
        ? { source, url: 'https://example.com/template.xml' }
        : source === 'XML'
          ? { source, xml: '<Container/>' }
          : { source, templateId, revision };
    for (const field of ['url', 'xml', 'templateId', 'revision'])
      if (!(field in base))
        invalid.push(
          { ...base, [field]: 'unexpected' },
          { ...base, [field]: ' ' },
        );
  }
  for (const input of invalid) {
    requests.length = 0;
    const out = await run(mutation, subject('CREATE_ANY'), { input });
    assert.equal(
      out.errors?.[0].extensions.code,
      'INVALID_INPUT',
      JSON.stringify(input),
    );
    assert.equal(requests.length, 0);
  }
  for (const input of [
    {
      source: 'XML',
      xml: '<Container/>',
      url: '',
      templateId: null,
      revision: '',
    },
    { source: 'LOCAL', templateId, revision, url: null, xml: '' },
  ]) {
    requests.length = 0;
    const out = await run(mutation, subject('CREATE_ANY'), { input });
    assert.equal(out.errors, undefined);
    assert.deepEqual(requests.at(-1).body, input);
  }
  for (const input of [
    { xml: '<Container/>' },
    { source: 'OTHER', xml: '<Container/>' },
    { source: 'XML', xml: 1 },
  ]) {
    requests.length = 0;
    assert.ok(
      (await run(mutation, subject('CREATE_ANY'), { input })).errors?.length,
    );
    assert.equal(requests.length, 0);
  }
});

test('wire and GraphQL agree on closed local rows and explicit import selectors', async (t) => {
  const { schema } = await harness(t);
  const contract = JSON.parse(
      fs.readFileSync(
        new URL('../contracts/openapi.json', import.meta.url),
        'utf8',
      ),
    ),
    s = contract.components.schemas;
  assert.deepEqual(s.TemplateImportSource.enum, ['URL', 'XML', 'LOCAL']);
  assert.deepEqual(s.LocalTemplateKind.enum, ['USER', 'DEFAULT']);
  assert.deepEqual(
    schema
      .getType('DeckBridgeTemplateImportSource')
      .getValues()
      .map((v) => v.name),
    s.TemplateImportSource.enum,
  );
  assert.deepEqual(
    schema
      .getType('DeckBridgeLocalTemplateKind')
      .getValues()
      .map((v) => v.name),
    s.LocalTemplateKind.enum,
  );
  const fields = schema.getType('DeckBridgeLocalTemplate').getFields();
  assert.deepEqual(Object.keys(fields), [
    'id',
    'kind',
    'revision',
    'name',
    'image',
    'iconUrl',
    'containerExists',
    'containerId',
    'issueCode',
  ]);
  for (const [name, type] of Object.entries({
    id: 'String!',
    kind: 'DeckBridgeLocalTemplateKind!',
    revision: 'String!',
    name: 'String!',
    image: 'String',
    iconUrl: 'String',
    containerExists: 'Boolean',
    containerId: 'String',
    issueCode: 'String',
  }))
    assert.equal(String(fields[name].type), type);
  assert.equal(s.LocalTemplate.additionalProperties, false);
  assert.deepEqual(s.LocalTemplate.required, Object.keys(fields));
  assert.deepEqual(s.LocalTemplate.properties.containerExists.type, [
    'boolean',
    'null',
  ]);
  assert.deepEqual(s.LocalTemplate.properties.iconUrl.type, ['string', 'null']);
  assert.deepEqual(
    contract.paths['/docker/templates'].get.responses['200'].content[
      'application/json'
    ].schema,
    { type: 'array', items: { $ref: '#/components/schemas/LocalTemplate' } },
  );
  assert.ok(s.Plan.required.includes('templateReuse'));
  assert.equal(s.Plan.properties.templateReuse.type, 'boolean');
  assert.equal(s.DraftImport.additionalProperties, false);
  assert.deepEqual(s.DraftImport.required, ['source']);
  const importFields = schema
    .getType('DeckBridgeTemplateImportInput')
    .getFields();
  assert.equal(
    String(importFields.source.type),
    'DeckBridgeTemplateImportSource!',
  );
  for (const name of ['url', 'xml', 'templateId', 'revision'])
    assert.equal(String(importFields[name].type), 'String');
  for (const branch of s.DraftImport.oneOf) {
    const source = branch.properties.source.const,
      required =
        source === 'URL'
          ? ['url']
          : source === 'XML'
            ? ['xml']
            : ['templateId', 'revision'];
    assert.deepEqual(branch.required, required);
    for (const name of ['url', 'xml', 'templateId', 'revision']) {
      if (required.includes(name)) {
        assert.equal(branch.properties[name].type, 'string');
        assert.ok(branch.properties[name].pattern);
      } else assert.deepEqual(branch.properties[name].enum, ['', null]);
    }
  }
});
