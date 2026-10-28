import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { callCore, coreEvents, coreUpdateEvents } from '../dist/core-client.js';

test('failed operations are data, transport errors remain GraphQL errors', async (t) => {
  const dir = fs.mkdtempSync('/tmp/bridge-client-');
  const socket = path.join(dir, 'core.sock');
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-bridge-actor'], 'official-principal');
    assert.equal(req.headers['x-bridge-protocol'], undefined);
    assert.equal(req.headers['x-api-key'], undefined);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/operations'))
      res.end(
        JSON.stringify({
          id: 'operation',
          status: 'FAILED',
          error: { code: 'START_FAILED', message: 'Start failed' },
          events: [],
        }),
      );
    else {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: { code: 'INVALID_INPUT', message: 'Invalid request' },
        }),
      );
    }
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = http.request.bind(http);
  t.mock.method(http, 'request', (options) =>
    request({ ...options, socketPath: socket }),
  );
  const operation = await callCore(
    'official-principal',
    '/operations?domain=docker&id=operation',
  );
  assert.equal(operation.status, 'FAILED');
  assert.equal(operation.error.code, 'START_FAILED');
  await assert.rejects(
    callCore('official-principal', '/docker/preview', {}),
    (e) => e.extensions.code === 'INVALID_INPUT',
  );
});

test('canonical internal contract is unversioned and always domain explicit', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL('../contracts/openapi.json', import.meta.url),
      'utf8',
    ),
  );
  assert.ok(Object.keys(schema.paths).every((p) => !/^\/v\d+(?:\/|$)/.test(p)));
  assert.ok(schema.paths['/docker/submit/install']);
  assert.ok(schema.paths['/system/status']);
  assert.ok(
    !Object.keys(schema.paths).some((path) => path.startsWith('/storage/')),
  );
  for (const name of [
    'Pool',
    'PoolMember',
    'PoolProfile',
    'PoolVdev',
    'PoolScan',
    'PoolCapacity',
    'PoolErrorCounter',
  ])
    assert.equal(schema.components.schemas[name], undefined);
  assert.equal(schema.components.schemas.Info.properties.protocol, undefined);
  for (const item of Object.values(schema.paths))
    for (const operation of Object.values(item)) {
      if (operation.parameters)
        assert.ok(
          operation.parameters.every(
            (p) => p.name?.toLowerCase() !== 'x-bridge-protocol',
          ),
        );
    }
  for (const path of ['/operations', '/operations/by-request', '/events']) {
    const domain = schema.paths[path].get.parameters.find(
      (p) => p.name === 'domain',
    );
    assert.equal(domain.required, true);
    assert.equal(domain.schema.default, undefined);
  }
});

test('operation events preserve split UTF-8 and a final unterminated line', async (t) => {
  const dir = fs.mkdtempSync('/tmp/bridge-events-');
  const socket = path.join(dir, 'core.sock');
  const event = { sequence: 1, kind: 'PROGRESS', message: '业务模式' };
  const bytes = Buffer.from(JSON.stringify(event));
  const split = bytes.indexOf(Buffer.from('业')) + 1;
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.write(bytes.subarray(0, split));
    setTimeout(() => res.end(bytes.subarray(split)), 20);
  });
  t.after(() => {
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(socket, resolve));
  const request = http.request.bind(http);
  t.mock.method(http, 'request', (options) =>
    request({ ...options, socketPath: socket }),
  );
  const events = [];
  for await (const value of coreEvents('actor', 'operation', 0, 'docker'))
    events.push(value);
  assert.deepEqual(events, [event]);
});

for (const stream of ['operations', 'checks', 'batches']) {
  test(
    `${stream} unsubscribe interrupts a pending event read`,
    { timeout: 3000 },
    async (t) => {
      const dir = fs.mkdtempSync('/tmp/bridge-cancel-');
      const socket = path.join(dir, 'core.sock');
      let connected;
      const ready = new Promise((resolve) => {
        connected = resolve;
      });
      let disconnected;
      const closed = new Promise((resolve) => {
        disconnected = resolve;
      });
      const server = http.createServer((_req, res) => {
        res.writeHead(200);
        res.flushHeaders();
        res.on('close', disconnected);
        connected();
      });
      t.after(() => {
        server.closeAllConnections();
        server.close();
        fs.rmSync(dir, { recursive: true, force: true });
      });
      await new Promise((resolve) => server.listen(socket, resolve));
      const request = http.request.bind(http);
      t.mock.method(http, 'request', (options) =>
        request({ ...options, socketPath: socket }),
      );
      const events =
        stream === 'operations'
          ? coreEvents('actor', 'operation', 0, 'docker')
          : coreUpdateEvents('actor', 'operation', 0, stream);
      const pending = events.next();
      await ready;
      const completion = events.return();
      assert.equal((await pending).done, true);
      assert.equal((await completion).done, true);
      await closed;
    },
  );
}
