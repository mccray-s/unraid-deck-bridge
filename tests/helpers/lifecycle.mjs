import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { repo, sha256, write } from './release.mjs';

export const build = '0.6.0-123456abcdef';
export const pluginVersion = '2026.10.27';
export function rewriteHostPaths(source, root) {
  const replacements = {
    '/boot/config/plugins': path.join(root, 'boot/plugins'),
    '/usr/local/emhttp/plugins/unraid-deck-bridge': path.join(root, 'runtime'),
    '/usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/unraid-deck-bridge-install':
      path.join(root, 'post-hooks/unraid-deck-bridge-install'),
    '/usr/local/emhttp/plugins/dynamix.plugin.manager/post-hooks/unraid-deck-bridge-remove':
      path.join(root, 'post-hooks/unraid-deck-bridge-remove'),
    '/usr/local/sbin/plugin': path.join(root, 'native-plugin'),
    '/tmp/unraid-deck-bridge': path.join(root, 'temporary'),
    '/tmp/plugins/unraid-deck-bridge.plg': path.join(
      root,
      'downloads/unraid-deck-bridge.plg',
    ),
    '/tmp/plugins/pluginPending/unraid-deck-bridge.plg': path.join(
      root,
      'pending/unraid-deck-bridge.plg',
    ),
    '/tmp/plugins': path.join(root, 'downloads'),
    '/var/run/unraid-deck-bridge': path.join(root, 'run'),
    '/var/run/unraid-api.sock': path.join(root, 'api.sock'),
    '/var/run': path.join(root, 'standard-var-run'),
    '/usr/local/etc/rc.d': path.join(root, 'standard-rc'),
    '/etc/rc.d': path.join(root, 'rc'),
    '/var/log/plugins': path.join(root, 'log/plugins'),
    '/var/log/unraid-deck-bridge.log': path.join(root, 'service.log'),
    '/usr/local/unraid-api': path.join(root, 'api'),
    '/etc/unraid-version': path.join(root, 'unraid-version'),
    '/proc/': path.join(root, 'process-table') + '/',
  };
  for (const [from, to] of Object.entries(replacements))
    source = source.replaceAll(from, to);
  source = source.replace(
    /(['"])\/run\1/g,
    JSON.stringify(path.join(root, 'standard-run')),
  );
  assert.ok(
    !/\/(boot\/config|usr\/local|var\/run|etc\/rc\.d|var\/log|etc\/unraid-version|proc\/|tmp\/plugins\b|tmp\/unraid-deck-bridge)/.test(
      source,
    ),
    'no host system paths may remain',
  );
  return source;
}
export function executable(name) {
  for (const dir of [
    ...process.env.PATH.split(path.delimiter),
    '/usr/bin',
    '/bin',
  ]) {
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.realpathSync(file);
    } catch {}
  }
  throw new Error(`Missing test prerequisite: ${name}`);
}
export function lifecycle(t, { previous = false, fail = '' } = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lifecycle-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Bind external command boundaries absolutely: Bash may reset PATH on Unraid.
  const rewrite = (source) => {
    const mapped = rewriteHostPaths(source, root);
    if (!/^(#!\/bin\/(?:ba)?sh|set -)/.test(source)) return mapped;
    let heredoc;
    return mapped
      .split('\n')
      .map((line) => {
        if (heredoc) {
          if (line === heredoc) heredoc = undefined;
          return line;
        }
        heredoc = line.match(/<<'([A-Z_]+)'/)?.[1];
        return line.replace(
          /(?<![\w/.'"-])(node|unraid-api|flock|sleep|bash)(?= )/g,
          (_, command) => JSON.stringify(path.join(root, 'bin', command)),
        );
      })
      .join('\n');
  };
  const runtime = path.join(root, 'runtime');
  const stage = path.join(runtime, 'releases/.staging-fixture');
  const candidate = path.join(runtime, 'releases', build);
  const service = path.join(root, 'rc/rc.unraid-deck-bridge');
  const moduleFile = path.join(root, 'api/module');
  const apiState = path.join(root, 'api-state');
  const log = path.join(root, 'events');
  const coreState = path.join(root, 'core-state');
  write(coreState, previous ? 'old\n' : 'stopped\n');
  const bin = path.join(root, 'bin');
  write(log, '');
  write(path.join(root, 'unraid-version'), 'version="7.3.2"\n');
  write(moduleFile, 'official-old\n');
  write(apiState, 'running\n');
  write(
    path.join(root, 'install.sh'),
    rewrite(fs.readFileSync(path.join(repo, 'packaging/install.sh'), 'utf8')),
  );
  write(
    path.join(stage, 'adapter/package.json'),
    JSON.stringify({ version: '0.6.0' }),
  );
  write(path.join(stage, 'manager.mjs'), '// stubbed command boundary\n');
  write(
    path.join(stage, 'post-install.mjs'),
    '// isolated external scheduling boundary\n',
  );
  write(
    path.join(stage, 'plg-capture.mjs'),
    rewrite(
      fs.readFileSync(path.join(repo, 'packaging/plg-capture.mjs'), 'utf8'),
    ),
  );
  write(
    path.join(stage, 'activate.sh'),
    rewrite(fs.readFileSync(path.join(repo, 'packaging/activate.sh'), 'utf8')),
  );
  write(path.join(stage, 'deck-bridge-core'), 'new core bytes\n', 0o755);
  write(
    path.join(stage, 'rc.unraid-deck-bridge'),
    '#!/bin/sh\necho "newcore $1" >> "$EVENTS"\n[ ! -e /dev/fd/9 ] || exit 91\n[ "$1:$FAIL_AT" != start:core-start ] || exit 9\nif [ "$1" = start ]; then printf "new\\n" > "$CORE_STATE"; fi\n',
    0o755,
  );
  write(
    path.join(stage, 'remove.sh'),
    '#!/bin/sh\n[ "$#" = 1 ] && [ "$1" = --stop-only ] || exit 2\nstate=$(cat "$CORE_STATE")\necho "stop-only $state" >> "$EVENTS"\nif [ "$state" = old ] && [ "$FAIL_AT" = core-stop ]; then exit 9; fi\nif [ "$state" = new ] && [ "$FAIL_CORE_STOP" = 1 ]; then exit 9; fi\nprintf "stopped\\n" > "$CORE_STATE"\n',
    0o755,
  );
  write(
    path.join(stage, 'health.sh'),
    '#!/bin/sh\n[ "$(cat "$CORE_STATE")" = new ] || exit 9\nif [ "$1" = --core-only ]; then [ "$FAIL_AT" != core-health ] && [ "$(cat "$MODULE_FILE")" = official-old ]; else [ "$FAIL_AT" != health ]; fi\n',
  );
  fs.mkdirSync(path.dirname(service), { recursive: true });
  if (previous) {
    write(
      path.join(runtime, 'releases/previous/deck-bridge-core'),
      'old core bytes\n',
    );
    fs.symlinkSync(
      path.join(runtime, 'releases/previous'),
      path.join(runtime, 'current'),
    );
    write(
      service,
      '#!/bin/sh\necho "oldcore $1" >> "$EVENTS"\n[ ! -e /dev/fd/9 ] || exit 91\nif [ "$1" = start ]; then printf "old\\n" > "$CORE_STATE"; fi\n',
      0o755,
    );
  }
  fs.mkdirSync(bin, { recursive: true });
  for (const name of [
    'mkdir',
    'cat',
    'chmod',
    'readlink',
    'dirname',
    'date',
    'cp',
    'ln',
    'rm',
    'install',
    'seq',
    'touch',
    'mv',
    'cmp',
    'find',
    'sort',
    'tar',
    'gzip',
    'mktemp',
    'curl',
    'bash',
    'sha256sum',
  ])
    fs.symlinkSync(executable(name), path.join(bin, name));
  // A real advisory lock on inherited descriptor 9, not an always-successful mock.
  if (process.platform === 'linux') {
    fs.symlinkSync(executable('flock'), path.join(bin, 'flock'));
  } else {
    write(
      path.join(bin, 'flock'),
      `#!${process.execPath}\nconst { tryLock } = require(${JSON.stringify(path.join(repo, 'node_modules/fs-native-extensions'))});\nprocess.exitCode = tryLock(Number(process.argv.at(-1))) ? 0 : 1;\n`,
      0o755,
    );
  }
  write(path.join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', 0o755);
  write(
    path.join(bin, 'uname'),
    '#!/bin/sh\nif [ "$1" = -s ]; then echo "$TEST_OS"; else echo "$TEST_ARCH"; fi\n',
    0o755,
  );
  write(
    path.join(bin, 'node'),
    `#!/bin/sh
if [ "$1" = -p ]; then exec "$REAL_NODE" "$@"; fi
if [ "$1" = --input-type=module ] && [ "$2" = - ]; then exec "$REAL_NODE" "$@"; fi
if [ "$1" = -e ] && [ "$REAL_HEALTH_NODE" = 1 ]; then exec "$REAL_NODE" "$@"; fi
if [ "$1" = -e ]; then [ "$TEST_NODE_ARCH" = x64 ]; exit $?; fi
if [ "$1" = --input-type=module ]; then echo import >> "$EVENTS"; [ "$FAIL_AT" != import ]; exit $?; fi
if [ "$2" = schedule ]; then echo schedule >> "$EVENTS"; [ "$FAIL_AT" != schedule ]; exit $?; fi
mode="$2"
echo "manager $mode" >> "$EVENTS"
[ "$FAIL_AT" != "$mode" ] || exit 8
if [ "$mode" = preflight ] && [ -n "$HOLD_FILE" ]; then
  touch "$READY_FILE"
  while [ -e "$HOLD_FILE" ]; do "$REAL_SLEEP" 0.02; done
fi
if [ "$mode" = backup ]; then mkdir -p "$3"; cp "$MODULE_FILE" "$3/module"; fi
if [ "$mode" = register ]; then echo official-new > "$MODULE_FILE"; fi
if [ "$mode" = restore ]; then cp "$3/module" "$MODULE_FILE"; fi
`,
    0o755,
  );
  write(
    path.join(bin, 'unraid-api'),
    `#!/bin/sh
[ ! -e /dev/fd/9 ] || exit 91
echo "api $*" >> "$EVENTS"
if [ "$1" = plugins ] && [ "$FAIL_AT" = plugins ]; then exit 9; fi
if [ "$1" = stop ]; then printf 'stopped\\n' > "$API_STATE"; fi
if [ "$1" = stop ] && [ -n "$API_FLUSH_VALUE" ]; then printf '%s\\n' "$API_FLUSH_VALUE" > "$MODULE_FILE"; fi
if [ "$1" = stop ] && [ "$FAIL_AT" = api-stop ]; then exit 9; fi
if [ "$1" = start ] && [ "$FAIL_AT" = start-once ] && [ ! -e "$START_FAILED" ]; then touch "$START_FAILED"; exit 9; fi
if [ "$1" = start ]; then printf 'running\\n' > "$API_STATE"; fi
`,
    0o755,
  );
  const env = {
    ...process.env,
    PATH: bin,
    EVENTS: log,
    FAIL_AT: fail,
    START_FAILED: path.join(root, 'start-failed'),
    REAL_NODE: process.execPath,
    REAL_SLEEP: executable('sleep'),
    MODULE_FILE: moduleFile,
    API_STATE: apiState,
    CORE_STATE: coreState,
    TEST_OS: 'Linux',
    TEST_ARCH: 'x86_64',
    TEST_NODE_ARCH: 'x64',
    REAL_HEALTH_NODE: '',
    HOLD_FILE: '',
    API_FLUSH_VALUE: '',
    FAIL_CORE_STOP: '',
  };
  const sums = (dir = stage) => {
    const files = fs
      .readdirSync(dir, { recursive: true })
      .filter(
        (name) =>
          name !== 'SHA256SUMS' && fs.statSync(path.join(dir, name)).isFile(),
      )
      .sort();
    write(
      path.join(dir, 'SHA256SUMS'),
      files
        .map(
          (name) =>
            `${sha256(fs.readFileSync(path.join(dir, name)))}  ${name}\n`,
        )
        .join(''),
    );
  };
  sums();
  const args = [path.join(root, 'install.sh'), stage, build, pluginVersion];
  const run = (argv = args, extraEnv = {}) => {
    const result = spawnSync('/bin/bash', argv, {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...env, ...extraEnv },
    });
    assert.ifError(result.error);
    return result;
  };
  const events = () =>
    fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  const commit = () => {
    const persisted = path.join(root, 'boot/plugins/unraid-deck-bridge.plg');
    write(
      persisted,
      `<PLUGIN name="unraid-deck-bridge" version="${pluginVersion}"></PLUGIN>`,
    );
    const registered = path.join(root, 'log/plugins/unraid-deck-bridge.plg');
    fs.mkdirSync(path.dirname(registered), { recursive: true });
    fs.symlinkSync(persisted, registered);
  };
  const activationArgs = (selected = candidate) => {
    const backups = path.join(root, 'boot/plugins/unraid-deck-bridge/backups');
    const backup = path.join(backups, fs.readdirSync(backups)[0]);
    const previousPath = path.join(runtime, 'releases/previous');
    const previous = fs.existsSync(previousPath) ? previousPath : '';
    return [
      '-c',
      `exec 9>"$1"; ${JSON.stringify(path.join(bin, 'flock'))} -n 9 || exit 1; shift; exec /bin/bash "$@"`,
      'activation',
      path.join(root, 'run/install.lock'),
      path.join(selected, 'activate.sh'),
      selected,
      backup,
      previous,
      pluginVersion,
    ];
  };
  const activate = (extraEnv = {}) => run(activationArgs(), extraEnv);
  return {
    root,
    runtime,
    stage,
    candidate,
    service,
    moduleFile,
    apiState,
    coreState,
    bin,
    log,
    env,
    args,
    run,
    events,
    rewrite,
    sums,
    commit,
    activate,
    activationArgs,
  };
}

// Only HTTP peers and the official CLI boundary are fixtures: install.sh and
// health.sh retain their real checksum, lock, JSON parsing and rollback logic.
export async function versionedHealth(t, f, { coreVersion }) {
  const coreState = path.join(f.root, 'core-service-state');
  const apiState = path.join(f.root, 'api-service-state');
  write(coreState, 'start\n');
  write(apiState, 'start\n');
  for (const [file, state] of [
    [f.service, coreState],
    [path.join(f.stage, 'rc.unraid-deck-bridge'), coreState],
    [path.join(f.bin, 'unraid-api'), apiState],
  ]) {
    fs.appendFileSync(
      file,
      `
status=$?
if [ "$status" -eq 0 ]; then
  case "$1" in start|stop) printf '%s\\n' "$1" > ${JSON.stringify(state)} ;; esac
fi
exit "$status"
`,
    );
  }
  write(
    path.join(f.stage, 'health.sh'),
    f.rewrite(fs.readFileSync(path.join(repo, 'packaging/health.sh'), 'utf8')),
  );
  f.sums();
  const requestsFile = path.join(f.root, 'health-requests.jsonl');
  write(requestsFile, '');
  fs.mkdirSync(path.join(f.root, 'run'), { recursive: true });
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import fs from 'node:fs';
import http from 'node:http';
const [root, version, requestsFile] = process.argv.slice(1);
function serve(socket, kind) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        fs.appendFileSync(requestsFile, JSON.stringify({
          kind, url: request.url, method: request.method, body,
          actor: request.headers['x-bridge-actor'],
          current: fs.readlinkSync(root + '/runtime/current'),
          module: fs.readFileSync(root + '/api/module', 'utf8'),
        }) + '\\n');
        response.setHeader('content-type', 'application/json');
        if (kind === 'core' && request.url === '/info') {
          response.end(JSON.stringify({ version, accepting: true }));
        } else if (kind === 'api' && request.url === '/graphql') {
          response.end(JSON.stringify({ data: { deckBridge: { info: { version } } } }));
        } else {
          response.statusCode = 404;
          response.end('{}');
        }
      });
    });
    server.once('error', reject);
    server.listen(socket, resolve);
  });
}
await Promise.all([
  serve(root + '/run/core.sock', 'core'),
  serve(root + '/api.sock', 'api'),
]);
process.send('ready');
`,
      f.root,
      coreVersion,
      requestsFile,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let serverErrors = '';
  child.stderr.on('data', (data) => {
    serverErrors += data;
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
  });
  const [ready] = await once(child, 'message', {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(ready, 'ready', serverErrors);
  return {
    serviceState: () => ({
      core: fs.readFileSync(coreState, 'utf8'),
      api: fs.readFileSync(apiState, 'utf8'),
    }),
    requests: () =>
      fs
        .readFileSync(requestsFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    async install() {
      const run = async (args) => {
        const installer = spawn('/bin/bash', args, {
          env: { ...f.env, REAL_HEALTH_NODE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 60000,
        });
        let stdout = '';
        let stderr = '';
        installer.stdout.on('data', (data) => {
          stdout += data;
        });
        installer.stderr.on('data', (data) => {
          stderr += data;
        });
        const [status] = await once(installer, 'close');
        return { status, stdout, stderr };
      };
      const prepared = await run(f.args);
      if (prepared.status !== 0) return prepared;
      f.commit();
      const selected = path.join(f.runtime, 'releases', f.args[2]);
      const activated = await run(f.activationArgs(selected));
      return {
        ...activated,
        stdout: prepared.stdout + activated.stdout,
        stderr: prepared.stderr + activated.stderr,
      };
    },
  };
}
