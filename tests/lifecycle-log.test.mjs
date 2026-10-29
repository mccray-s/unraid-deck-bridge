import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { repo, write } from './helpers/release.mjs';

const linux = process.platform === 'linux';
const limit = 256 * 1024;
function fixture(t, present = true) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-lifecycle-log-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'plugin');
  const module = path.join(root, 'release/lifecycle-log.mjs');
  write(
    module,
    fs
      .readFileSync(path.join(repo, 'packaging/lifecycle-log.mjs'), 'utf8')
      .replace(
        "const BASE = '/boot/config/plugins/unraid-deck-bridge';",
        `const BASE = ${JSON.stringify(base)};`,
      )
      .replace('const OWNER = 0;', `const OWNER = ${process.getuid()};`)
      .replace(
        'stat.uid !== OWNER ||',
        '(stat.uid !== OWNER && stat.uid !== 0) ||',
      ),
  );
  const entry = path.join(root, 'current.mjs');
  fs.symlinkSync(module, entry);
  write(
    path.join(root, 'release/adapter/release.json'),
    JSON.stringify({ version: '2026.10.29a' }),
  );
  write(
    path.join(root, 'release/adapter/release-version.mjs'),
    fs.readFileSync(
      path.join(repo, 'api-extension/release-version.mjs'),
      'utf8',
    ),
  );
  if (present) fs.mkdirSync(base, { mode: 0o700 });
  const directory = path.join(base, 'logs');
  const current = path.join(directory, 'lifecycle.log');
  const previous = current + '.1';
  return {
    root,
    base,
    module,
    directory,
    current,
    previous,
    run(event = 'activation-ready', code = 'READY') {
      return spawnSync(process.execPath, [entry, event, code], {
        encoding: 'utf8',
        cwd: root,
      });
    },
    records() {
      return fs
        .readFileSync(current, 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
    },
  };
}

test(
  'import has no flash effects; CLI records safe reboot and version identity',
  { skip: !linux },
  (t) => {
    const f = fixture(t);
    const imported = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `await import(${JSON.stringify(f.module)})`,
    ]);
    assert.equal(imported.status, 0);
    assert.equal(fs.existsSync(f.directory), false);
    assert.equal(f.run().status, 0);
    const [entry] = f.records();
    assert.equal(entry.event, 'activation-ready');
    assert.equal(entry.code, 'READY');
    assert.equal(entry.programVersion, '2026.10.29a');
    assert.equal(entry.expectedVersion, '2026.10.29a');
    assert.equal(
      entry.boot,
      fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    );
    assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
    assert.ok(entry.pid > 0);
    assert.equal(fs.statSync(f.current).mode & 0o777, 0o600);
    assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(f.root, '9')), false);
  },
);

test(
  'rotation preserves one bounded previous file and concurrent writers stay bounded',
  { skip: !linux },
  async (t) => {
    const f = fixture(t);
    fs.mkdirSync(f.directory);
    write(f.current, 'a'.repeat(limit - 1));
    write(f.previous, 'obsolete');
    assert.equal(f.run().status, 0);
    assert.equal(fs.statSync(f.previous).size, limit - 1);
    assert.equal(f.records().length, 1);
    write(f.current, 'b'.repeat(limit - 100));
    const children = Array.from({ length: 12 }, () =>
      spawn(process.execPath, [f.module, 'api-wait-ready', 'ADAPTER_CURRENT'], {
        stdio: 'ignore',
      }),
    );
    await Promise.all(children.map((child) => once(child, 'exit')));
    assert.ok(fs.statSync(f.current).size <= limit);
    assert.ok(fs.statSync(f.previous).size <= limit);
    assert.deepEqual(fs.readdirSync(f.directory).sort(), [
      'lifecycle.lock',
      'lifecycle.log',
      'lifecycle.log.1',
    ]);
  },
);

test(
  'missing plugin base never gets recreated and failure is sanitized and nonfatal',
  { skip: !linux },
  (t) => {
    const f = fixture(t, false);
    const result = f.run(
      'activation-failed',
      'SECRET http://user:password@192.0.2.1/token',
    );
    assert.equal(result.status, 0);
    assert.equal(fs.existsSync(f.base), false);
    assert.match(result.stderr, /^bridge lifecycle log: [A-Z_]+\n$/);
    assert.doesNotMatch(
      result.stderr,
      /SECRET|password|192\.0\.2|token|bridge-lifecycle-log-/,
    );
  },
);

for (const entry of [
  'logs',
  'lifecycle.log',
  'lifecycle.log.1',
  'lifecycle.lock',
]) {
  for (const kind of ['symlink', 'directory', 'hardlink']) {
    if (entry === 'logs' && kind !== 'symlink') continue;
    test(
      `rejects unsafe ${entry} ${kind} without touching foreign bytes`,
      { skip: !linux },
      (t) => {
        const f = fixture(t);
        const protectedFile = path.join(f.root, 'protected');
        write(protectedFile, 'private bytes');
        if (entry !== 'logs') fs.mkdirSync(f.directory);
        const target =
          entry === 'logs' ? f.directory : path.join(f.directory, entry);
        if (kind === 'symlink') fs.symlinkSync(protectedFile, target);
        if (kind === 'hardlink') fs.linkSync(protectedFile, target);
        if (kind === 'directory')
          write(path.join(target, 'keep'), 'unknown content');
        const result = f.run();
        assert.equal(result.status, 0);
        assert.match(result.stderr, /bridge lifecycle log:/);
        assert.equal(fs.readFileSync(protectedFile, 'utf8'), 'private bytes');
        if (kind === 'directory')
          assert.equal(
            fs.readFileSync(path.join(target, 'keep'), 'utf8'),
            'unknown content',
          );
        assert.equal(fs.existsSync(f.current), entry === 'lifecycle.log');
      },
    );
  }
}

test(
  'detail allowlist drops credentials, arbitrary output, invalid codes and address identities',
  { skip: !linux },
  (t) => {
    const f = fixture(t);
    const details = {
      code: 'ADAPTER_CURRENT',
      identity: '12:34/56:78',
      loadedVersion: '0.1.1',
      expectedVersion: '2026.10.29a',
      coreOnline: true,
      compatible: false,
      job: 'post-install-ABC123',
      raw: 'SECRET',
      headers: 'Bearer SECRET',
      address: '192.0.2.1',
      phase: 'https://user:SECRET@host',
    };
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const {logLifecycle} = await import(${JSON.stringify(f.module)}); if (!logLifecycle('api-detected', ${JSON.stringify(details)})) process.exitCode=1;`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const [entry] = f.records();
    assert.equal(entry.identity, '12:34/56:78');
    assert.equal(entry.loadedVersion, '0.1.1');
    assert.equal(entry.coreOnline, true);
    assert.equal(entry.compatible, false);
    assert.doesNotMatch(
      JSON.stringify(entry),
      /SECRET|192\.0\.2|headers|address|phase/,
    );
  },
);

test(
  'oversized existing file is refused without deleting or truncating evidence',
  { skip: !linux },
  (t) => {
    const f = fixture(t);
    write(f.current, 'x'.repeat(limit + 1));
    const result = f.run();
    assert.equal(result.status, 0);
    assert.match(result.stderr, /OVERSIZED_ENTRY/);
    assert.equal(fs.statSync(f.current).size, limit + 1);
    assert.equal(fs.existsSync(f.previous), false);
  },
);

test(
  'foreign-owned log entries are preserved and refused',
  { skip: !linux || process.getuid() !== 0 },
  (t) => {
    const f = fixture(t);
    write(f.current, 'foreign evidence');
    fs.chownSync(f.current, 65534, 65534);
    const result = f.run();
    assert.equal(result.status, 0);
    assert.match(result.stderr, /UNSAFE_ENTRY/);
    assert.equal(fs.readFileSync(f.current, 'utf8'), 'foreign evidence');
    assert.equal(fs.statSync(f.current).uid, 65534);
  },
);
