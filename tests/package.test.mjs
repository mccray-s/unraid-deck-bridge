import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import tar from 'tar-stream';
import {
  releaseFixture,
  elf,
  sha256,
  parsePlugin,
  setReleaseVersion,
} from './helpers/release.mjs';
import { execFileSync, spawnSync } from 'node:child_process';

for (const [name, change] of Object.entries({
  'missing canonical metadata': (root) =>
    fs.unlinkSync(path.join(root, 'release.json')),
  'malformed canonical metadata': (root) =>
    fs.writeFileSync(path.join(root, 'release.json'), '{'),
  'extra release field': (root) =>
    fs.writeFileSync(
      path.join(root, 'release.json'),
      '{"version":"2026.10.29a","npmVersion":"1.0.0"}',
    ),
  'stale root npm metadata': (root) => {
    const file = path.join(root, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(file));
    metadata.version = '0.1.1';
    fs.writeFileSync(file, JSON.stringify(metadata));
  },
  'independent plugin version': (root) => {
    const file = path.join(root, 'package.json');
    const metadata = JSON.parse(fs.readFileSync(file));
    metadata.bridge = { pluginVersion: '2026.10.29a' };
    fs.writeFileSync(file, JSON.stringify(metadata));
  },
  'stale adapter release': (root) =>
    fs.writeFileSync(
      path.join(root, 'dist/release.json'),
      '{"version":"2026.10.29"}',
    ),
  'stale adapter helper': (root) =>
    fs.appendFileSync(
      path.join(root, 'dist/release-version.mjs'),
      '\n// stale',
    ),
  'missing adapter helper': (root) =>
    fs.unlinkSync(path.join(root, 'dist/release-version.mjs')),
})) {
  test(`publisher rejects ${name} before creating release outputs`, (t) => {
    const f = releaseFixture(t);
    change(f.root);
    assert.notEqual(f.run('--repository', 'test/repo').status, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'out')), false);
    assert.equal(
      fs.existsSync(path.join(f.root, 'unraid-deck-bridge.plg')),
      false,
    );
  });
}

for (const history of [
  '',
  '###2026.10.29\n- Stale latest release\n',
  '###2026.10.29a\n- Current\n###2026.10.29a\n- Duplicate\n',
  '###2026.10.29a\n- Current\n###2026.10.30\n- Future\n',
  '###2026.10.29a\n- Current\n###2026.02.30\n- Invalid date\n',
  '###2026.10.29a\n###2026.10.29\n- Missing current notes\n',
  '###2026.10.29a\n- Current\n###2026.10.29\n',
  '###2026.10.29a\nUnstructured entry\n',
]) {
  test(`publisher rejects inconsistent changelog history ${JSON.stringify(history)}`, (t) => {
    const f = releaseFixture(t);
    fs.writeFileSync(path.join(f.root, 'CHANGELOG.md'), history);
    assert.notEqual(f.run('--repository', 'test/repo').status, 0);
    assert.equal(fs.existsSync(path.join(f.root, 'out')), false);
    assert.equal(
      fs.existsSync(path.join(f.root, 'unraid-deck-bridge.plg')),
      false,
    );
  });
}

test('removed plugin-version override cannot bypass canonical metadata', (t) => {
  const f = releaseFixture(t);
  assert.notEqual(f.run('--plugin-version', '2026.10.30').status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'out')), false);
});

test('same-version native history cannot overwrite a published PLG', (t) => {
  const f = releaseFixture(t);
  const initial = f.run('--repository', 'test/repo');
  assert.equal(initial.status, 0, initial.stderr);
  const release = JSON.parse(initial.stdout);
  const original = fs.readFileSync(release.plugin);
  fs.appendFileSync(
    path.join(f.root, 'CHANGELOG.md'),
    '- Changed historical note\n',
  );
  const out = path.join(f.root, 'rejected');
  assert.notEqual(f.run('--repository', 'test/repo', '--out', out).status, 0);
  assert.deepEqual(fs.readFileSync(release.plugin), original);
  assert.equal(fs.existsSync(out), false);
});

test('same-version archive cannot overwrite previously packaged bytes', (t) => {
  const f = releaseFixture(t);
  const initial = f.run();
  assert.equal(initial.status, 0, initial.stderr);
  const release = JSON.parse(initial.stdout);
  const original = fs.readFileSync(release.archive);
  const sums = fs.readFileSync(path.join(f.root, 'out/SHA256SUMS'));
  fs.appendFileSync(
    path.join(f.root, 'dist/index.js'),
    '\n// changed payload\n',
  );
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(fs.readFileSync(release.archive), original);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'out/SHA256SUMS')), sums);
});

test('static Core binary and notices suffice without producer metadata', (t) => {
  const f = releaseFixture(t);
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).build.split('-')[0], '2026.10.29a');
});

for (const [name, change] of Object.entries({
  'empty Core': (f) => fs.writeFileSync(f.core, ''),
  'Mach-O': (f) => fs.writeFileSync(f.core, Buffer.from('cffaedfe', 'hex')),
  PE: (f) => fs.writeFileSync(f.core, 'MZ'),
  'ARM ELF': (f, b) => {
    b.writeUInt16LE(183, 18);
    fs.writeFileSync(f.core, b);
  },
  '32-bit ELF': (f, b) => {
    b[4] = 1;
    fs.writeFileSync(f.core, b);
  },
  'big endian ELF': (f, b) => {
    b[5] = 2;
    fs.writeFileSync(f.core, b);
  },
  'shared ELF': (f, b) => {
    b.writeUInt16LE(3, 16);
    fs.writeFileSync(f.core, b);
  },
  'truncated header': (f, b) => fs.writeFileSync(f.core, b.subarray(0, 30)),
  'truncated program headers': (f, b) => {
    b.writeUInt16LE(2, 56);
    fs.writeFileSync(f.core, b);
  },
  'out-of-bounds segment': (f, b) => {
    b.writeBigUInt64LE(500n, 96);
    fs.writeFileSync(f.core, b);
  },
  'program header offset beyond exact Number range': (f, b) => {
    b.writeBigUInt64LE(2n ** 53n + 1n, 32);
    fs.writeFileSync(f.core, b);
  },
  'program header offset at uint64 maximum': (f, b) => {
    b.writeBigUInt64LE(2n ** 64n - 1n, 32);
    fs.writeFileSync(f.core, b);
  },
  'segment extent beyond exact Number range': (f, b) => {
    b.writeBigUInt64LE(2n ** 53n + 1n, 96);
    fs.writeFileSync(f.core, b);
  },
  'segment extent overflowing uint64 arithmetic': (f, b) => {
    b.writeBigUInt64LE(2n ** 64n - 1n, 72);
    b.writeBigUInt64LE(2n, 96);
    fs.writeFileSync(f.core, b);
  },
  'non-executable load': (f, b) => {
    b.writeUInt32LE(4, 68);
    fs.writeFileSync(f.core, b);
  },
  'dynamic loader': (f, b) => {
    b.writeUInt32LE(3, 64);
    fs.writeFileSync(f.core, b);
  },
})) {
  test(`publisher rejects ${name} before writing outputs`, (t) => {
    const f = releaseFixture(t);
    change(f, elf());
    const r = f.run();
    assert.notEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(f.root, 'out')));
  });
}
for (const name of ['deck-bridge-core', 'LICENSE', 'THIRD_PARTY.md']) {
  test(`publisher rejects missing ${name}`, (t) => {
    const f = releaseFixture(t);
    fs.unlinkSync(path.join(path.dirname(f.core), name));
    const r = f.run();
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(name));
    assert.ok(!fs.existsSync(path.join(f.root, 'out')));
  });
}
for (const name of ['LICENSE', 'THIRD_PARTY.md']) {
  for (const content of ['', ' \n\t']) {
    test(`publisher rejects empty Core ${name} (${JSON.stringify(content)})`, (t) => {
      const f = releaseFixture(t);
      fs.writeFileSync(path.join(path.dirname(f.core), name), content);
      assert.notEqual(f.run().status, 0);
      assert.equal(fs.existsSync(path.join(f.root, 'out')), false);
    });
  }
}

for (const name of ['deck-bridge-core', 'LICENSE', 'THIRD_PARTY.md']) {
  for (const kind of ['directory', 'symlink']) {
    test(`publisher rejects ${kind} Core input ${name}`, (t) => {
      const f = releaseFixture(t);
      const file = path.join(path.dirname(f.core), name);
      const bytes = fs.readFileSync(file);
      fs.unlinkSync(file);
      if (kind === 'directory') fs.mkdirSync(file);
      else {
        const target = path.join(f.root, `external-${name}`);
        fs.writeFileSync(target, bytes);
        fs.symlinkSync(target, file);
      }
      assert.notEqual(f.run().status, 0);
      assert.equal(fs.existsSync(path.join(f.root, 'out')), false);
    });
  }
}

test('stale built adapter compatibility is rejected before publishing files', (t) => {
  const f = releaseFixture(t);
  fs.writeFileSync(
    path.join(f.root, 'dist/compatibility.json'),
    '{"minimumOSVersion":"stale"}\n',
  );
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'out')), false);
});

test('stale built package version is rejected before publishing files', (t) => {
  const f = releaseFixture(t);
  const file = path.join(f.root, 'dist/package.json');
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  metadata.version = '0.5.9';
  fs.writeFileSync(file, JSON.stringify(metadata));
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'out')), false);
});

test('development package fields cannot leak into the runtime manifest', (t) => {
  const f = releaseFixture(t);
  const file = path.join(f.root, 'dist/package.json');
  const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
  metadata.devDependencies = { 'development-only': '1.0.0' };
  fs.writeFileSync(file, JSON.stringify(metadata));
  assert.notEqual(f.run().status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'out')), false);
});

test('archive has only authenticated release members and deterministic metadata', async (t) => {
  const f = releaseFixture(t);
  fs.writeFileSync(
    path.join(f.root, 'packaging/do-not-release.txt'),
    'private',
  );
  const r = f.run();
  assert.equal(r.status, 0, r.stderr);
  const release = JSON.parse(r.stdout);
  assert.equal(release.plugin, null);
  assert.equal(
    path.basename(release.archive),
    'unraid-deck-bridge-2026.10.29a-linux-amd64.tar.gz',
  );
  assert.equal(sha256(fs.readFileSync(release.archive)), release.sha256);
  assert.equal(release.build, '2026.10.29a-' + release.sha256.slice(0, 12));
  assert.equal(
    fs.readFileSync(path.join(f.root, 'out/SHA256SUMS'), 'utf8'),
    `${release.sha256}  ${path.basename(release.archive)}\n`,
  );
  const compressed = fs.readFileSync(release.archive);
  assert.equal(compressed.readUInt32LE(4), 0, 'gzip timestamp is fixed');
  assert.equal(compressed[3] & 0x08, 0, 'gzip has no local filename');
  const extract = tar.extract();
  extract.end(gunzipSync(compressed));
  const members = [];
  for await (const entry of extract) {
    const chunks = [];
    for await (const chunk of entry) chunks.push(chunk);
    members.push({ header: entry.header, data: Buffer.concat(chunks) });
  }
  const expected = [
    ...[
      'index.js',
      'runtime.types.js',
      'configuration-feedback.js',
      'core-client.js',
      'check-host.js',
      'compatibility.json',
      'package.json',
      'release.json',
      'release-version.mjs',
    ].map((name) => `adapter/${name}`),
    'assets/unraid-deck-bridge.png',
    'deck-bridge-core',
    'install.sh',
    'post-install.mjs',
    'plg-capture.mjs',
    'activate.sh',
    'api-runtime.mjs',
    'lifecycle-log.mjs',
    'manager.mjs',
    'rc.unraid-deck-bridge',
    'health.sh',
    'repair.sh',
    'remove.sh',
    'LICENSE',
    'licenses/core/LICENSE',
    'licenses/core/THIRD_PARTY.md',
    'SHA256SUMS',
  ].sort();
  const names = members.map(({ header }) => header.name);
  assert.deepEqual(names, expected);
  assert.equal(new Set(names).size, names.length);
  for (const { header, data } of members) {
    assert.equal(header.type, 'file');
    assert.equal(path.posix.isAbsolute(header.name), false);
    assert.equal(header.name.split('/').includes('..'), false);
    assert.equal(header.size, data.length);
    assert.deepEqual(
      [
        header.uid,
        header.gid,
        header.mtime.getTime(),
        header.uname,
        header.gname,
      ],
      [0, 0, 0, '', ''],
    );
    const executable =
      header.name === 'deck-bridge-core' ||
      header.name.endsWith('.sh') ||
      header.name === 'rc.unraid-deck-bridge';
    assert.equal(header.mode, executable ? 0o755 : 0o644);
  }
  const data = Object.fromEntries(
    members.map((member) => [member.header.name, member.data]),
  );
  const sumLines = data.SHA256SUMS.toString('utf8').trimEnd().split('\n');
  const sums = sumLines.map((line) => {
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    assert.ok(match, `invalid checksum line: ${line}`);
    return [match[2], match[1]];
  });
  assert.deepEqual(
    sums.map(([name]) => name).sort(),
    names.filter((name) => name !== 'SHA256SUMS'),
  );
  for (const [name, digest] of sums) assert.equal(sha256(data[name]), digest);
  assert.deepEqual(data['deck-bridge-core'], fs.readFileSync(f.core));
  assert.deepEqual(
    data['adapter/compatibility.json'],
    fs.readFileSync(path.join(f.root, 'contracts/compatibility.json')),
  );
  assert.equal(
    JSON.parse(data['adapter/package.json']).license,
    'GPL-2.0-or-later',
  );
  assert.deepEqual(JSON.parse(data['adapter/release.json']), {
    version: '2026.10.29a',
  });
  assert.equal(
    JSON.parse(data['adapter/package.json']).version,
    '2026.10.2901',
  );
  assert.deepEqual(
    data['adapter/release-version.mjs'],
    fs.readFileSync(path.join(f.root, 'api-extension/release-version.mjs')),
  );
  assert.notDeepEqual(data.LICENSE, data['licenses/core/LICENSE']);
  assert.deepEqual(
    execFileSync('tar', ['-tzf', release.archive], { encoding: 'utf8' })
      .trimEnd()
      .split('\n'),
    expected,
  );
  const before = fs.readFileSync(release.archive);
  fs.chmodSync(f.core, 0o600);
  fs.utimesSync(f.core, new Date(10000), new Date(20000));
  const second = f.run('--out', path.join(f.root, 'other'));
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(fs.readFileSync(JSON.parse(second.stdout).archive), before);
  assert.equal(f.run().status, 0);
  fs.appendFileSync(path.join(f.root, 'dist/index.js'), '// change');
  assert.notEqual(f.run().status, 0);
  assert.deepEqual(fs.readFileSync(release.archive), before);
});

test('archive keeps the validated Core snapshot when its source changes during publication', async (t) => {
  const f = releaseFixture(t);
  const original = fs.readFileSync(f.core);
  const preload = path.join(f.root, 'replace-core-after-read.mjs');
  // Replace the input after validation without changing the captured bytes.
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const data = readFileSync.call(this, file, ...args);
  if (file === ${JSON.stringify(f.core)}) {
    fs.readFileSync = readFileSync;
    fs.writeFileSync(file, 'replaced Core');
  }
  return data;
};
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      preload,
      path.join(f.root, 'scripts/package.mjs'),
      '--out',
      path.join(f.root, 'out'),
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.core, 'utf8'), 'replaced Core');
  const release = JSON.parse(result.stdout);
  const extract = tar.extract();
  extract.end(gunzipSync(fs.readFileSync(release.archive)));
  const members = new Map();
  for await (const entry of extract) {
    const chunks = [];
    for await (const chunk of entry) chunks.push(chunk);
    members.set(entry.header.name, Buffer.concat(chunks));
  }
  assert.deepEqual(members.get('deck-bridge-core'), original);
  const sums = members.get('SHA256SUMS').toString('utf8');
  assert.ok(sums.split('\n').includes(`${sha256(original)}  deck-bridge-core`));
  assert.equal(sha256(fs.readFileSync(release.archive)), release.sha256);
});

test('archive and PLG retain the Bridge compatibility snapshot if its source changes', async (t) => {
  const f = releaseFixture(t);
  const compatibility = path.join(f.root, 'contracts/compatibility.json');
  const original = fs.readFileSync(compatibility);
  const replacement = '{"minimumOSVersion":"changed after read"}\n';
  const preload = path.join(f.root, 'replace-compatibility-after-read.mjs');
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const data = readFileSync.call(this, file, ...args);
  if (file === ${JSON.stringify(compatibility)}) {
    fs.readFileSync = readFileSync;
    fs.writeFileSync(file, ${JSON.stringify(replacement)});
  }
  return data;
};
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      preload,
      path.join(f.root, 'scripts/package.mjs'),
      '--out',
      path.join(f.root, 'out'),
      '--repository',
      'test/repo',
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(compatibility, 'utf8'), replacement);
  const release = JSON.parse(result.stdout);
  assert.equal(
    parsePlugin(release.plugin).attributes.min,
    JSON.parse(original).minimumOSVersion,
  );
  const extract = tar.extract();
  extract.end(gunzipSync(fs.readFileSync(release.archive)));
  const members = new Map();
  for await (const entry of extract) {
    const chunks = [];
    for await (const chunk of entry) chunks.push(chunk);
    members.set(entry.header.name, Buffer.concat(chunks));
  }
  assert.deepEqual(members.get('adapter/compatibility.json'), original);
  assert.ok(
    members
      .get('SHA256SUMS')
      .toString('utf8')
      .split('\n')
      .includes(`${sha256(original)}  adapter/compatibility.json`),
  );
});

test('archive and executable PLG removal retain one script snapshot during publication', async (t) => {
  const f = releaseFixture(t);
  const script = path.join(f.root, 'packaging/remove.sh');
  const original = fs.readFileSync(script);
  const replacement = '#!/bin/bash\nexit 97\n';
  const preload = path.join(f.root, 'replace-remove-after-read.mjs');
  fs.writeFileSync(
    preload,
    `import fs from 'node:fs';
const readFileSync = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  const data = readFileSync.call(this, file, ...args);
  if (file === ${JSON.stringify(script)}) {
    fs.readFileSync = readFileSync;
    fs.writeFileSync(file, ${JSON.stringify(replacement)});
  }
  return data;
};
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      preload,
      path.join(f.root, 'scripts/package.mjs'),
      '--out',
      path.join(f.root, 'out'),
      '--repository',
      'test/repo',
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(script, 'utf8'), replacement);
  const release = JSON.parse(result.stdout);
  const extract = tar.extract();
  extract.end(gunzipSync(fs.readFileSync(release.archive)));
  const members = new Map();
  for await (const entry of extract) {
    const chunks = [];
    for await (const chunk of entry) chunks.push(chunk);
    members.set(entry.header.name, Buffer.concat(chunks));
  }
  const removal = parsePlugin(release.plugin).files.find(
    (file) => file.attributes.Method === 'remove',
  );
  assert.deepEqual(members.get('remove.sh'), original);
  assert.deepEqual(Buffer.from(removal.INLINE), original);
  assert.ok(
    members
      .get('SHA256SUMS')
      .toString('utf8')
      .split('\n')
      .includes(`${sha256(original)}  remove.sh`),
  );
  assert.equal(sha256(fs.readFileSync(release.archive)), release.sha256);
});

test('default Core path works and archive-only build preserves an existing root PLG', (t) => {
  const f = releaseFixture(t);
  const plugin = path.join(f.root, 'unraid-deck-bridge.plg');
  fs.writeFileSync(plugin, 'existing user file');
  const r = spawnSync(
    process.execPath,
    [
      path.join(f.root, 'scripts/package.mjs'),
      '--out',
      path.join(f.root, 'out'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).plugin, null);
  assert.equal(fs.readFileSync(plugin, 'utf8'), 'existing user file');
});

for (const version of [
  '',
  '2026.10.24b58',
  '2026.02.30',
  '2026.02.29',
  '1900.02.29',
  '2100.02.29',
  '2026.10.26.0001',
  '2026.10.26.0000',
  '2026.10.26.10000',
  '2026.1.26',
  '../2026.10.26',
]) {
  test(`invalid release version ${JSON.stringify(version)} leaves no output`, (t) => {
    const f = releaseFixture(t);
    fs.writeFileSync(
      path.join(f.root, 'release.json'),
      JSON.stringify({ version }),
    );
    assert.notEqual(f.run().status, 0);
    assert.ok(!fs.existsSync(path.join(f.root, 'out')));
  });
}

for (const version of ['2000.02.29', '2024.02.29']) {
  test(`valid leap-day plugin version ${version} is preserved`, (t) => {
    const f = releaseFixture(t);
    setReleaseVersion(f.root, version);
    fs.writeFileSync(
      path.join(f.root, 'CHANGELOG.md'),
      `###${version}\n- Leap release\n`,
    );
    const result = f.run('--repository', 'test/repo');
    assert.equal(result.status, 0, result.stderr);
    const release = JSON.parse(result.stdout);
    assert.equal(parsePlugin(release.plugin).attributes.version, version);
    assert.equal(
      path.basename(release.archive),
      `unraid-deck-bridge-${version}-linux-amd64.tar.gz`,
    );
  });
}

test('symlinked release inputs are not followed into the archive', (t) => {
  const f = releaseFixture(t);
  const file = path.join(f.root, 'dist/index.js');
  fs.unlinkSync(file);
  fs.symlinkSync(f.core, file);
  assert.notEqual(f.run().status, 0);
  assert.ok(!fs.existsSync(path.join(f.root, 'out')));
});

for (const args of [
  ['--repository', ''],
  ['--repository', 'https://github.com/a/b'],
  ['--repository', 'owner/repo.git'],
  ['--repository', 'a/b/c'],
  ['--repository', '-a/repo'],
  ['--repository', 'a/b\n'],
  ['--branch', 'main'],
  ['--plg-out', 'unraid-deck-bridge.plg'],
  ...['', 'feature/topic', 'https://example.com', 'main\n', '.hidden'].map(
    (branch) => ['--repository', 'owner/repo', '--branch', branch],
  ),
]) {
  test(`invalid publishing address ${JSON.stringify(args)} writes nothing`, (t) => {
    const f = releaseFixture(t);
    const r = f.run(...args);
    assert.notEqual(r.status, 0);
    assert.ok(!fs.existsSync(path.join(f.root, 'out')));
    assert.ok(!fs.existsSync(path.join(f.root, 'unraid-deck-bridge.plg')));
  });
}

test('online PLG binds a fixed release archive and a separate canonical update URL', (t) => {
  const f = releaseFixture(t);
  const r = f.run('--repository', 'test-owner/test.repo');
  assert.equal(r.status, 0, r.stderr);
  const release = JSON.parse(r.stdout);
  assert.equal(release.plugin, path.join(f.root, 'unraid-deck-bridge.plg'));
  const p = parsePlugin(release.plugin);
  assert.equal(p.attributes.version, '2026.10.29a');
  assert.equal(p.attributes.min, '6.12.0');
  assert.equal(p.attributes.max, undefined);
  assert.equal(
    p.changes,
    fs.readFileSync(path.join(f.root, 'CHANGELOG.md'), 'utf8').trim(),
  );
  assert.equal(
    p.attributes.pluginURL,
    'https://raw.githubusercontent.com/test-owner/test.repo/main/unraid-deck-bridge.plg',
  );
  assert.equal(p.files.length, 4);
  assert.deepEqual(p.files[0].attributes, { Run: '/bin/bash' });
  assert.deepEqual(p.files[1].attributes, {
    Name: `/boot/config/plugins/unraid-deck-bridge/packages/${release.build}.tar.gz`,
    Mode: '0600',
  });
  assert.equal(p.files[1].SHA256, sha256(fs.readFileSync(release.archive)));
  assert.equal(
    p.files[1].URL,
    `https://github.com/test-owner/test.repo/releases/download/v2026.10.29a/${path.basename(release.archive)}`,
  );
  assert.deepEqual(p.files[2].attributes, { Run: '/bin/bash' });
  assert.deepEqual(p.files[3].attributes, {
    Run: '/bin/bash',
    Method: 'remove',
  });
  assert.equal(f.run('--repository', 'test-owner/test.repo').status, 0);
  const custom = path.join(f.root, 'custom/unraid-deck-bridge.plg');
  const customRun = f.run(
    '--repository',
    'test-owner/test.repo',
    '--branch',
    'release-1',
    '--plg-out',
    custom,
  );
  assert.equal(customRun.status, 0, customRun.stderr);
  assert.equal(
    parsePlugin(custom).attributes.pluginURL,
    'https://raw.githubusercontent.com/test-owner/test.repo/release-1/unraid-deck-bridge.plg',
  );
});

test('PLG release progression rejects old versions and changed same-version archives without publishing outputs', (t) => {
  const f = releaseFixture(t);
  const initial = f.run('--repository', 'test/repo');
  assert.equal(initial.status, 0, initial.stderr);
  const release = JSON.parse(initial.stdout);
  const originalArchive = fs.readFileSync(release.archive);
  const sums = path.join(f.root, 'out/SHA256SUMS');
  const originalSums = fs.readFileSync(sums);
  const file = path.join(f.root, 'unraid-deck-bridge.plg');
  const original = fs.readFileSync(file);
  const other = path.join(f.root, 'other');
  fs.appendFileSync(path.join(f.root, 'dist/index.js'), '// changed');
  assert.notEqual(f.run('--repository', 'test/repo', '--out', other).status, 0);
  assert.ok(!fs.existsSync(other));
  assert.deepEqual(fs.readFileSync(file), original);
  setReleaseVersion(f.root, '2026.10.29');
  fs.writeFileSync(
    path.join(f.root, 'CHANGELOG.md'),
    '###2026.10.29\n- Old release\n',
  );
  assert.notEqual(f.run('--repository', 'test/repo', '--out', other).status, 0);
  assert.ok(!fs.existsSync(other));
  assert.deepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readFileSync(release.archive), originalArchive);
  assert.deepEqual(fs.readFileSync(sums), originalSums);
  setReleaseVersion(f.root, '2026.10.29b');
  fs.writeFileSync(
    path.join(f.root, 'CHANGELOG.md'),
    '###2026.10.29b\n- New revision\n\n###2026.10.29a\n- Previous revision\n',
  );
  assert.equal(f.run('--repository', 'test/repo', '--out', other).status, 0);
  assert.equal(parsePlugin(file).attributes.version, '2026.10.29b');
  assert.deepEqual(fs.readFileSync(release.archive), originalArchive);
  assert.deepEqual(fs.readFileSync(sums), originalSums);
});

for (const existing of [
  'broken <XML',
  '<PLUGIN/>',
  '<PLUGIN name=\"unraid-deck-bridge\" version=\"2026.10.25\"/>',
]) {
  test('unrecognized existing PLG is not overwritten', (t) => {
    const f = releaseFixture(t);
    const file = path.join(f.root, 'unraid-deck-bridge.plg');
    fs.writeFileSync(file, existing);
    assert.notEqual(f.run('--repository', 'test/repo').status, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), existing);
    assert.ok(!fs.existsSync(path.join(f.root, 'out')));
  });
}

for (const replacement of [
  (xml) => xml.replace('</PLUGIN>', ''),
  (xml) => xml.replace('<PLUGIN ', '<PLUGIN duplicate="one" duplicate="two" '),
  (xml) => xml.replace('name="unraid-deck-bridge"', 'name=unraid-deck-bridge'),
  (xml) =>
    xml.replace('version="2026.10.29a"', 'version="2026.10.29a &unknown;"'),
  (xml) => `<!DOCTYPE PLUGIN [<!ENTITY injected "value">]>\n${xml}`,
  (xml) => `<!DOCTYPE PLUGIN SYSTEM "file:///never-read-this-fixture">\n${xml}`,
]) {
  test('malformed or DTD-bearing existing PLG is rejected atomically', (t) => {
    const f = releaseFixture(t);
    const initial = f.run('--repository', 'test/repo');
    assert.equal(initial.status, 0, initial.stderr);
    const release = JSON.parse(initial.stdout);
    const damaged = replacement(fs.readFileSync(release.plugin, 'utf8'));
    fs.writeFileSync(release.plugin, damaged);
    assert.throws(() => parsePlugin(release.plugin));
    const out = path.join(f.root, 'rejected-output');
    const result = f.run('--repository', 'test/repo', '--out', out);
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(release.plugin, 'utf8'), damaged);
    assert.equal(fs.existsSync(out), false);
    assert.equal(sha256(fs.readFileSync(release.archive)), release.sha256);
  });
}

test('PLG attributes round-trip XML escaping through generation and existing-file parsing', (t) => {
  const f = releaseFixture(t);
  const minimumOSVersion = '6.12.0 & "quoted" <minimum> \'single\'';
  const compatibility = path.join(f.root, 'contracts/compatibility.json');
  fs.writeFileSync(compatibility, JSON.stringify({ minimumOSVersion }));
  fs.copyFileSync(compatibility, path.join(f.root, 'dist/compatibility.json'));
  const result = f.run('--repository', 'test/repo');
  assert.equal(result.status, 0, result.stderr);
  const release = JSON.parse(result.stdout);
  assert.equal(parsePlugin(release.plugin).attributes.min, minimumOSVersion);
  const original = fs.readFileSync(release.plugin);
  const repeat = f.run('--repository', 'test/repo');
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.deepEqual(fs.readFileSync(release.plugin), original);
});
