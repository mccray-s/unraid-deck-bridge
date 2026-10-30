import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Keep the peer independent: removal runs synchronously in a Bash/Node child.
export function removalHTTP(t, root, { realProc = false, sessionPath } = {}) {
  const session = sessionPath ?? path.join(root, 'api-session/local-session');
  fs.mkdirSync(path.dirname(session), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(session), 0o700);
  fs.writeFileSync(session, randomBytes(32).toString('hex'), { mode: 0o600 });
  const requests = path.join(root, 'removal-http-requests.jsonl');
  fs.writeFileSync(requests, '');
  const ready = path.join(root, 'removal-http-ready');
  const script = path.join(root, 'api/dist/main.js');
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(
    script,
    `
const fs = require('node:fs');
const http = require('node:http');
const root = process.argv[2];
const session = process.env.PATHS_LOCAL_SESSION_FILE;
const socket = root + '/api.sock';
try { fs.unlinkSync(socket); } catch (e) { if(e.code !== 'ENOENT') throw e; }
const server = http.createServer((req,res) => {
  let body = '';
  req.on('data', b => body += b);
  req.on('end', () => {
    let query;
    try { query = JSON.parse(body).query; } catch { res.writeHead(400); return res.end('{}'); }
    let credential;
    try { credential = fs.readFileSync(session,'utf8').trim(); } catch {}
    const authenticated = !!credential && req.headers['x-local-session'] === credential;
    // Never persist headers or session bytes, including when authentication fails.
    fs.appendFileSync(root + '/removal-http-requests.jsonl', JSON.stringify({method:req.method,url:req.url,query,authenticated}) + '\\n');
    if(fs.existsSync(root + '/api-health-failure')) { res.writeHead(503); return res.end('{}'); }
    let state, config, mode = '';
    try {
      state = fs.readFileSync(root + '/api-state','utf8').trim();
      config = JSON.parse(fs.readFileSync(root + '/boot/plugins/dynamix.my.servers/configs/api.json','utf8'));
      if (fs.existsSync(root + '/api-graphql-mode')) mode = fs.readFileSync(root + '/api-graphql-mode','utf8').trim();
    } catch { res.writeHead(500); return res.end('{}'); }
    if(state !== 'running') { res.writeHead(503); return res.end('{}'); }
    res.setHeader('Content-Type','application/json');
    const error = (message, code = 'GRAPHQL_VALIDATION_FAILED') => ({message,extensions:{code}});
    const send = (value, status = 200) => { res.writeHead(status); res.end(JSON.stringify(value)); };
    if (/__schema|__type/.test(query)) return send({errors:[error('GraphQL introspection is not allowed.')]},400);
    if (!authenticated || mode === 'auth') return send({errors:[error('Unauthenticated','UNAUTHENTICATED')]},401);
    if (mode === 'forbidden') return send({errors:[error('Forbidden','FORBIDDEN')]},403);
    if (/\\bme\\s*\\{/.test(query)) {
      if (mode === 'replace-pid') {
        const stat = root + '/process-table/' + process.pid + '/stat';
        const before = fs.readFileSync(stat,'utf8');
        fs.writeFileSync(stat, before.includes('12345') ? before.replace('12345','54321') : before.replace('54321','12345'));
      }
      return send({data:{me:{name:'root'}}});
    }
    if (!/\\bdeckBridge\\s*\\{/.test(query)) return send({errors:[error('Unknown query')]},400);
    const missing = error('Cannot query field "deckBridge" on type "Query".');
    if (mode === 'rotate-session') fs.writeFileSync(session, credential === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64));
    if (mode === 'nested-root') return send({errors:[error('Cannot query field "deckBridge" on type "NestedQuery".')]},400);
    if (mode === 'mixed') return send({errors:[missing,error('Forbidden','FORBIDDEN')]},400);
    if (mode === 'child') return send({errors:[error('Cannot query field "info" on type "DeckBridge".')]},400);
    if (mode === 'unknown') return send({errors:[error('Validation failed without field details')]},400);
    if (mode === 'wrong-code') return send({errors:[error(missing.message,'INTERNAL_SERVER_ERROR')]},400);
    if (mode === 'malformed') { res.writeHead(200); return res.end('{'); }
    if (mode === 'empty-data') return send({data:{}});
    if (mode === 'invalid-info') return send({data:{deckBridge:{info:{version:42,coreOnline:'true',compatible:null}}}});
    if (mode === 'present' || config.plugins?.includes('unraid-deck-bridge'))
      return send({data:{deckBridge:{info:{version:'2026.10.30a',coreOnline:true,compatible:true}}}});
    return send({errors:[missing]}, mode === 'missing-200' ? 200 : 400);
  });
});
server.listen(socket, () => fs.writeFileSync(root + '/removal-http-ready','ready'));
`,
  );
  const child = spawn(process.execPath, [script, root], {
    env: { ...process.env, PATHS_LOCAL_SESSION_FILE: session },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const closed = once(child, 'close');
  let errors = '';
  child.stderr.on('data', (b) => (errors += b));
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
  });
  const barrier = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 200 && !fs.existsSync(ready); i++)
    Atomics.wait(barrier, 0, 0, 10);
  assert.ok(
    fs.existsSync(ready),
    'removal HTTP fixture failed to start: ' + errors,
  );
  const proc = path.join(root, 'process-table', String(child.pid));
  if (!realProc) {
    fs.mkdirSync(proc, { recursive: true });
    const fields = Array(20).fill('0');
    fields[0] = 'S';
    fields[1] = '1';
    fields[19] = '12345';
    fs.writeFileSync(
      path.join(proc, 'stat'),
      `${child.pid} (node) ${fields.join(' ')}\n`,
    );
    fs.writeFileSync(
      path.join(proc, 'cmdline'),
      [process.execPath, script, root, ''].join('\0'),
    );
    fs.writeFileSync(
      path.join(proc, 'environ'),
      sessionPath ? `PATHS_LOCAL_SESSION_FILE=${session}\0` : '',
    );
    fs.symlinkSync(process.execPath, path.join(proc, 'exe'));
  }
  return {
    session,
    proc,
    mode: (value) =>
      fs.writeFileSync(path.join(root, 'api-graphql-mode'), value),
    requests: () =>
      fs
        .readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
