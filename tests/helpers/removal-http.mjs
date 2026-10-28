import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

// Run the HTTP peer in another process: removal itself is a synchronous Bash/Node child.
export function removalHTTP(t, root) {
  const requests = path.join(root, 'removal-http-requests.jsonl');
  fs.writeFileSync(requests, '');
  const ready = path.join(root, 'removal-http-ready');
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import fs from 'node:fs';
import http from 'node:http';
const root = process.argv[1];
const socket = root + '/api.sock';
try { fs.unlinkSync(socket); } catch (e) { if(e.code !== 'ENOENT') throw e; }
const server = http.createServer((req,res) => {
  let body = '';
  req.on('data', b => body += b);
  req.on('end', () => {
    fs.appendFileSync(root + '/removal-http-requests.jsonl', JSON.stringify({method:req.method,url:req.url,body}) + '\\n');
    if(fs.existsSync(root + '/api-health-failure')) { res.writeHead(503); return res.end('{}'); }
    let state, config;
    try {
      state = fs.readFileSync(root + '/api-state','utf8').trim();
      config = JSON.parse(fs.readFileSync(root + '/boot/plugins/dynamix.my.servers/configs/api.json','utf8'));
      JSON.parse(body);
    } catch { res.writeHead(500); return res.end('{}'); }
    if(state !== 'running') { res.writeHead(503); return res.end('{}'); }
    const fields = [{name:'officialQuery'}];
    if(config.plugins?.includes('unraid-deck-bridge')) fields.push({name:'deckBridge'});
    res.setHeader('Content-Type','application/json');
    res.end(JSON.stringify({data:{__type:{name:'Query',fields},__schema:{queryType:{name:'Query',fields}}}}));
  });
});
server.listen(socket, () => fs.writeFileSync(root + '/removal-http-ready','ready'));
`,
      root,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
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
  return {
    requests: () =>
      fs
        .readFileSync(requests, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
