import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const releaseVersion = JSON.parse(
  fs.readFileSync(path.join(root, 'release.json'), 'utf8'),
).version;

function fixture(t, metadata) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-version-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.cpSync(path.join(root, 'dist'), path.join(dir, 'adapter'), {
    recursive: true,
  });
  fs.symlinkSync(
    path.join(root, 'node_modules'),
    path.join(dir, 'node_modules'),
    'dir',
  );
  // A parent package is deliberately present: runtime identity must come only
  // from the adapter's sibling metadata, never from a repository ancestor.
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ type: 'module', version: '9.9.9' }),
  );
  const releasePath = path.join(dir, 'adapter/release.json');
  fs.rmSync(releasePath, { force: true });
  if (metadata !== undefined) fs.writeFileSync(releasePath, metadata);
  return { dir, entry: pathToFileURL(path.join(dir, 'adapter/index.js')).href };
}

const behavior = String.raw`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
const [entry, dir, expected] = process.argv.slice(1);
const differentVersion = '2027.01.01';
const api = await import(entry);
// Metadata is a module-load snapshot, not filesystem IO on each request.
fs.writeFileSync(new URL('./release.json', entry), JSON.stringify({ version: '2028.01.01' }));
const service = new api.DeckBridgeService();
const context = { req: { user: { id: 'version-principal' } } };
let coreVersion = expected;
let offline = false;
const requests = [];
const operationId = 'a'.repeat(32);
const server = http.createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const input = text ? JSON.parse(text) : undefined;
  requests.push({ path: req.url, input });
  assert.equal(req.headers['x-bridge-actor'], 'version-principal');
  res.setHeader('content-type', 'application/json');
  if (req.url === '/info') {
    if (offline) { res.destroy(); return; }
    res.end(JSON.stringify({ version: coreVersion, accepting: true, dockerAvailable: true, capabilities: ['system.read', 'docker.cancel'] }));
  } else if (req.url.startsWith('/docker/cancel/')) {
    if (input.coreVersion !== coreVersion) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: { code: 'CORE_VERSION_MISMATCH' } }));
    } else {
      res.end(JSON.stringify({ id: operationId, status: 'CANCELLED', cancelRequested: true }));
    }
  } else {
    res.end(JSON.stringify({ id: 'accepted-plan', accepted: true }));
  }
});
const socket = path.join(dir, 'core.sock');
await new Promise((resolve) => server.listen(socket, resolve));
const request = http.request.bind(http);
http.request = (options) => request({ ...options, socketPath: socket });
const writes = [
  () => service.write(context, '/docker/submit/install', {}),
  () => service.write(context, '/docker/submit/edit', {}, true),
  () => new api.DeckBridgeSystemMutationsResolver().prepare({ action: 'SHUTDOWN' }, context),
  () => new api.DeckBridgePluginMutationsResolver().prepareUninstall('example.plg', context),
  () => new api.DeckBridgeArrayMutationsResolver().prepare({ action: 'START' }, context),
];
try {
  const info = await service.info(context);
  assert.equal(info.version, expected);
  assert.equal(info.compatible, true);
  assert.ok(info.capabilities.includes('system.read'));
  for (const write of writes) assert.equal((await write()).accepted, true);
  const [year, month, date] = expected.split('.');
  const day = Number(date.slice(0, 2));
  const revision = date.slice(2);
  const npmVersion = Number(year) + '.' + Number(month) + '.' + (day * 100 + (revision ? revision.charCodeAt(0) - 96 : 0));
  for (const incompatibleVersion of [differentVersion, npmVersion, '0.1.1']) {
    coreVersion = incompatibleVersion;
    const mismatch = await service.info(context);
    assert.equal(mismatch.version, expected);
    assert.equal(mismatch.compatible, false);
    assert.equal(mismatch.reason, 'CORE_VERSION_MISMATCH');
    assert.deepEqual(mismatch.capabilities, []);
    for (const write of writes) {
      requests.length = 0;
      await assert.rejects(write, (error) => error.extensions.code === 'CORE_VERSION_MISMATCH');
      assert.deepEqual(requests.map((request) => request.path), ['/info']);
    }
  }
  // Both cancellation transports carry the local runtime version, with no
  // preliminary /info even when the daemon's /info endpoint is unavailable.
  for (const action of ['install', 'edit']) {
    offline = true;
    coreVersion = expected;
    requests.length = 0;
    const result = await service.cancel(context, operationId, action);
    assert.equal(result.status, 'CANCELLED');
    assert.deepEqual(requests, [{ path: '/docker/cancel/' + action, input: { operationId, coreVersion: expected } }]);
    coreVersion = differentVersion;
    requests.length = 0;
    await assert.rejects(() => service.cancel(context, operationId, action), (error) => error.extensions.code === 'CORE_VERSION_MISMATCH');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/docker/cancel/' + action);
  }
  const unavailable = await service.info(context);
  assert.equal(unavailable.version, expected);
  assert.equal(unavailable.reason, 'CORE_UNAVAILABLE');
} finally {
  http.request = request;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
`;

for (const version of [releaseVersion, '2026.10.30']) {
  test(`canonical adapter metadata ${version} controls info, strict domain matching and cancellation`, async (t) => {
    const { dir, entry } = fixture(t, JSON.stringify({ version }));
    await exec(
      process.execPath,
      ['--input-type=module', '-e', behavior, entry, dir, version],
      { timeout: 30000 },
    );
  });
}

for (const [label, metadata] of [
  ['missing file', undefined],
  ['malformed JSON', '{'],
  ['missing version', JSON.stringify({ type: 'module' })],
  ['non-string version', JSON.stringify({ type: 'module', version: 6 })],
  ['null version', JSON.stringify({ type: 'module', version: null })],
  ['empty version', JSON.stringify({ type: 'module', version: '' })],
  ['invalid version', JSON.stringify({ version: '0.7' })],
  ['legacy version', JSON.stringify({ version: '0.1.1' })],
  ['npm version', JSON.stringify({ version: '2026.10.2901' })],
  ['invalid date', JSON.stringify({ version: '2026.02.29' })],
  ['trailing-newline version', JSON.stringify({ version: '2026.10.29a\n' })],
]) {
  test(`adapter import rejects ${label} without falling back to parent package`, async (t) => {
    const { entry } = fixture(t, metadata);
    await assert.rejects(
      exec(process.execPath, [
        '--input-type=module',
        '-e',
        'await import(process.argv[1])',
        entry,
      ]),
      (error) => error.code !== 0 && /release\.json/i.test(error.stderr),
    );
  });
}
