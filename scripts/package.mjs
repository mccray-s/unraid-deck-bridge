#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import tar from 'tar-stream';
import {
  DOMImplementation,
  DOMParser,
  XMLSerializer,
  onWarningStopParsing,
} from '@xmldom/xmldom';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
// Reject partial matches, including a trailing newline accepted by JavaScript's $.
const matches = (pattern, value) =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;
const statIfPresent = (file) => {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};
function regularBytes(file) {
  if (!statIfPresent(file)?.isFile())
    throw new Error(`Release input must be a regular file: ${file}`);
  return fs.readFileSync(file);
}
function loadCoreInput(core) {
  const directory = path.dirname(core);
  const files = {
    data: core,
    license: path.join(directory, 'LICENSE'),
    thirdParty: path.join(directory, 'THIRD_PARTY.md'),
  };
  const missing = Object.values(files).filter(
    (file) => !statIfPresent(file)?.isFile(),
  );
  if (missing.length)
    throw new Error('Missing Core inputs: ' + missing.join(', '));
  const input = Object.fromEntries(
    Object.entries(files).map(([name, file]) => [name, regularBytes(file)]),
  );
  for (const [name, file] of Object.entries(files)) {
    const bytes = input[name];
    if (!bytes.length || (name !== 'data' && !bytes.toString('utf8').trim()))
      throw new Error(`Core input must be nonempty: ${file}`);
  }
  validateCoreELF(input.data);
  // Snapshot validated inputs once for archive assembly.
  return {
    ...input,
    compatibilityBytes: regularBytes(
      path.join(repo, 'contracts/compatibility.json'),
    ),
  };
}
function validateCoreELF(data) {
  if (
    data.length < 64 ||
    !data.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]))
  )
    throw new Error('Core must be a complete little-endian ELF64 executable');
  if (
    data.readUInt16LE(16) !== 2 ||
    data.readUInt16LE(18) !== 62 ||
    data.readUInt32LE(20) !== 1 ||
    data.readUInt16LE(52) !== 64 ||
    data.readUInt16LE(54) !== 56
  )
    throw new Error('Core must be a static Linux x86_64 ET_EXEC ELF');
  const entry = data.readBigUInt64LE(24),
    phoff = data.readBigUInt64LE(32),
    count = data.readUInt16LE(56);
  // Preserve exact ELF bounds above Number.MAX_SAFE_INTEGER.
  const size = BigInt(data.length);
  if (
    !count ||
    count === 0xffff ||
    phoff < 64n ||
    phoff + BigInt(count) * 56n > size
  )
    throw new Error('Core ELF program headers are truncated or invalid');
  let executable = false;
  for (let index = 0; index < count; index++) {
    const at = Number(phoff) + index * 56;
    const type = data.readUInt32LE(at),
      flags = data.readUInt32LE(at + 4);
    const offset = data.readBigUInt64LE(at + 8),
      address = data.readBigUInt64LE(at + 16);
    const filesz = data.readBigUInt64LE(at + 32),
      memsz = data.readBigUInt64LE(at + 40),
      align = data.readBigUInt64LE(at + 48);
    if (type === 3) throw new Error('Core ELF must not require PT_INTERP');
    if (offset > size || filesz > size - offset)
      throw new Error('Core ELF segment exceeds file bounds');
    if (type === 1) {
      if (
        filesz > memsz ||
        address + memsz > 1n << 64n ||
        (align !== 0n &&
          align !== 1n &&
          ((align & (align - 1n)) !== 0n || offset % align !== address % align))
      )
        throw new Error('Core ELF PT_LOAD is invalid');
      if (flags & 1 && filesz && address <= entry && entry < address + filesz)
        executable = true;
    }
  }
  if (!executable)
    throw new Error(
      'Core ELF requires an executable PT_LOAD containing its entry',
    );
}

const adapterFiles = [
  'index.js',
  'runtime.types.js',
  'configuration-feedback.js',
  'core-client.js',
  'check-host.js',
  'compatibility.json',
  'package.json',
];
const packagingFiles = [
  'install.sh',
  'plg-capture.mjs',
  'post-install.mjs',
  'activate.sh',
  'manager.mjs',
  'rc.unraid-deck-bridge',
  'health.sh',
  'repair.sh',
  'remove.sh',
];
function validatePluginVersion(value) {
  if (!matches(/^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{4}$/, value))
    throw new Error('Plugin version must be YYYY.MM.DD.NNNN');
  const [year, month, day, sequence] = value.split('.').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    year < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error('Plugin version requires a valid date');
  if (sequence < 1 || sequence > 9999)
    throw new Error('Plugin version sequence must be 0001–9999');
  return value;
}
async function buildArchive(coreInput, pkg) {
  const selected = new Map();
  for (const name of adapterFiles)
    selected.set(`adapter/${name}`, path.join(repo, 'dist', name));
  for (const name of packagingFiles)
    selected.set(name, path.join(repo, 'packaging', name));
  selected.set(
    'assets/unraid-deck-bridge.png',
    path.join(repo, 'assets/unraid-deck-bridge.png'),
  );
  selected.set('LICENSE', path.join(repo, 'LICENSE'));
  const members = new Map(
    [...selected].map(([name, file]) => [name, regularBytes(file)]),
  );
  if (
    !members
      .get('adapter/compatibility.json')
      .equals(coreInput.compatibilityBytes)
  )
    throw new Error(
      'Built adapter compatibility does not match the verified contract; rebuild the adapter',
    );
  const adapterPackage = JSON.parse(members.get('adapter/package.json'));
  const expectedPackage = {
    name: pkg.name,
    version: pkg.version,
    type: 'module',
    main: 'index.js',
    license: pkg.license,
  };
  if (!isDeepStrictEqual(adapterPackage, expectedPackage))
    throw new Error(
      'Built adapter package metadata does not match package.json; rebuild the adapter',
    );
  members.set('deck-bridge-core', coreInput.data);
  members.set('licenses/core/LICENSE', coreInput.license);
  members.set('licenses/core/THIRD_PARTY.md', coreInput.thirdParty);
  const sums = [...members.keys()]
    .sort()
    .map((name) => `${sha256(members.get(name))}  ${name}\n`)
    .join('');
  members.set('SHA256SUMS', Buffer.from(sums));
  const pack = tar.pack();
  const collecting = (async () => {
    const chunks = [];
    for await (const chunk of pack) chunks.push(chunk);
    return Buffer.concat(chunks);
  })();
  try {
    for (const name of [...members.keys()].sort()) {
      const data = members.get(name);
      await new Promise((resolve, reject) =>
        pack.entry(
          {
            name,
            type: 'file',
            size: data.length,
            mode:
              name === 'deck-bridge-core' ||
              name.endsWith('.sh') ||
              name === 'rc.unraid-deck-bridge'
                ? 0o755
                : 0o644,
            uid: 0,
            gid: 0,
            mtime: new Date(0),
            uname: '',
            gname: '',
          },
          data,
          (error) => (error ? reject(error) : resolve()),
        ),
      );
    }
    pack.finalize();
    const compressed = gzipSync(await collecting, { level: 9 });
    // Keep gzip metadata independent of the build host.
    compressed[9] = 255;
    // Embed the exact helper bytes archived, even if sources change later.
    return {
      data: compressed,
      removeScript: members.get('remove.sh'),
      captureScript: members.get('plg-capture.mjs'),
    };
  } catch (error) {
    pack.destroy(error);
    await collecting.catch(() => {});
    throw error;
  }
}
function validateArchiveOutput(file, data) {
  const stat = statIfPresent(file);
  if (stat && !stat.isFile())
    throw new Error(`Output must be a regular file: ${file}`);
  if (stat && !fs.readFileSync(file).equals(data))
    throw new Error(
      `Archive already exists with different content; increment plugin version: ${file}`,
    );
}
function buildPlugin(
  repository,
  branch,
  version,
  minimumOS,
  archiveName,
  build,
  digest,
  removeScript,
  captureScript,
) {
  const doc = new DOMImplementation().createDocument(null, 'PLUGIN');
  const plugin = doc.documentElement;
  for (const [name, value] of Object.entries({
    name: 'unraid-deck-bridge',
    author: 'mccray',
    version,
    min: minimumOS,
    icon: `releases/${build}/assets/unraid-deck-bridge.png`,
    pluginURL: `https://raw.githubusercontent.com/${repository}/${branch}/unraid-deck-bridge.plg`,
    support: `https://github.com/${repository}/issues`,
    project: `https://github.com/${repository}`,
  }))
    plugin.setAttribute(name, value);
  function element(parent, name, attributes = {}, text) {
    const child = doc.createElement(name);
    for (const [key, value] of Object.entries(attributes))
      child.setAttribute(key, value);
    if (text !== undefined) child.appendChild(doc.createTextNode(text));
    parent.appendChild(child);
    return child;
  }
  element(
    plugin,
    'CHANGES',
    {},
    `${version}: Reduce installer size while retaining offline cleanup and safe activation.`,
  );
  const preflight = element(plugin, 'FILE', { Run: '/bin/bash' });
  element(
    preflight,
    'INLINE',
    {},
    `set -euo pipefail
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'Bridge requires Linux x86_64 (Unraid)' >&2
  exit 1
fi
[ -f /etc/unraid-version ] || { echo 'Bridge requires Unraid: /etc/unraid-version is missing' >&2; exit 1; }
for dependency in node unraid-api tar sha256sum flock mktemp install curl mv; do
  command -v "$dependency" >/dev/null || { echo "Bridge requires dependency: $dependency" >&2; exit 1; }
done
node -e 'if(process.arch!=="x64")process.exit(1)' || { echo 'Bridge requires Node x64 on Linux x86_64' >&2; exit 1; }
node --input-type=module - '${version}' <<'BRIDGE_CAPTURE_PLG'
${captureScript.toString('utf8')}
try {
  capture(process.argv.slice(2));
} catch (error) {
  const safe = [
    'CAPTURE_ARGUMENTS', 'CAPTURE_SOURCE', 'SNAPSHOT_VERSION',
    'SNAPSHOT_OWNER', 'SNAPSHOT_INVALID', 'SNAPSHOT_DIGEST',
    'NATIVE_MANAGER_REQUIRED',
  ];
  const code = safe.includes(error.message)
    ? error.message
    : typeof error.code === 'string' && /^E[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'CAPTURE_FAILED';
  console.error('Plugin preparation failed (' + code + ').');
  process.exitCode = 1;
}
BRIDGE_CAPTURE_PLG
`,
  );
  const cache = `/boot/config/plugins/unraid-deck-bridge/packages/${build}.tar.gz`;
  const resource = element(plugin, 'FILE', { Name: cache, Mode: '0600' });
  element(
    resource,
    'URL',
    {},
    `https://github.com/${repository}/releases/download/v${version}/${archiveName}`,
  );
  element(resource, 'SHA256', {}, digest);
  element(
    element(plugin, 'FILE', { Run: '/bin/bash' }),
    'INLINE',
    {},
    `set -euo pipefail
echo '${digest}  ${cache}' | sha256sum -c -
runtime=/usr/local/emhttp/plugins/unraid-deck-bridge
node --input-type=module - <<'BRIDGE_PREPARE_LOCK'
import fs from 'node:fs';
const run = '/var/run/unraid-deck-bridge';
for (const file of [run, run + '/install.lock']) {
  let prefix = '';
  for (const part of file.split('/').filter(Boolean)) {
    prefix += '/' + part;
    const stat = fs.lstatSync(prefix, {throwIfNoEntry:false});
    if (stat?.isSymbolicLink() && !(prefix === '/var/run' && fs.realpathSync(prefix) === '/run'))
      throw new Error('Unsafe preparation lock path');
  }
}
const lock = fs.lstatSync(run + '/install.lock', {throwIfNoEntry:false});
if(lock && !lock.isFile()) throw new Error('Invalid preparation lock');
fs.mkdirSync(run, {recursive:true,mode:0o700});
fs.chmodSync(run,0o700);
BRIDGE_PREPARE_LOCK
exec 9>/var/run/unraid-deck-bridge/install.lock
flock -n 9 || { echo 'Another Bridge lifecycle operation is running' >&2; exit 1; }
node --input-type=module - <<'BRIDGE_PREPARE_LOCK'
import fs from 'node:fs';
const held=fs.fstatSync(9), file=fs.lstatSync('/var/run/unraid-deck-bridge/install.lock');
if(!file.isFile() || held.dev!==file.dev || held.ino!==file.ino) throw new Error('Preparation lock was replaced');
const runtime='/usr/local/emhttp/plugins/unraid-deck-bridge';
for (const part of [runtime, runtime + '/releases']) {
  let prefix='';
  for(const name of part.split('/').filter(Boolean)) {
    prefix+='/'+name;
    const stat=fs.lstatSync(prefix,{throwIfNoEntry:false});
    if(stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Unsafe preparation runtime path');
  }
}
BRIDGE_PREPARE_LOCK
mkdir -p "$runtime/releases"
stage=$(mktemp -d "$runtime/releases/.staging-XXXXXX")
trap 'if [ -d "$stage" ]; then rm -rf -- "$stage"; fi' EXIT
tar -xzf '${cache}' -C "$stage"
bash "$stage/install.sh" "$stage" '${build}' '${version}'
echo 'Package prepared; runtime/API activation pending native plugin registration.'
`,
  );
  element(
    element(plugin, 'FILE', { Run: '/bin/bash', Method: 'remove' }),
    'INLINE',
    {},
    removeScript.toString('utf8'),
  );
  return Buffer.from(
    '<?xml version="1.0" encoding="utf-8"?>\n' +
      new XMLSerializer().serializeToString(doc) +
      '\n',
  );
}
function validatePluginOutput(file, version, digest) {
  if (path.basename(file) !== 'unraid-deck-bridge.plg')
    throw new Error('PLG basename must remain unraid-deck-bridge.plg');
  const stat = statIfPresent(file);
  if (stat && !stat.isFile())
    throw new Error(`PLG output must be a regular file: ${file}`);
  if (!stat) return;
  const xml = fs.readFileSync(file, 'utf8');
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error('Existing PLG must not declare DTDs or entities');
  const previous = new DOMParser({
    onError: onWarningStopParsing,
  }).parseFromString(xml, 'application/xml').documentElement;
  const children = (parent, name) =>
    Array.from(parent.childNodes).filter(
      (child) => child.nodeType === 1 && child.tagName === name,
    );
  const resources = children(previous, 'FILE').filter((node) =>
    node.hasAttribute('Name'),
  );
  const text = (parent, name) => children(parent, name)[0]?.textContent;
  const oldVersion = previous.getAttribute('version');
  if (
    previous.tagName !== 'PLUGIN' ||
    previous.getAttribute('name') !== 'unraid-deck-bridge' ||
    ['version', 'author', 'min', 'pluginURL'].some(
      (name) => !previous.getAttribute(name),
    ) ||
    resources.length !== 1 ||
    !text(resources[0], 'URL') ||
    !matches(/^[0-9a-f]{64}$/, text(resources[0], 'SHA256'))
  )
    throw new Error(`Existing PLG is missing release fields: ${file}`);
  validatePluginVersion(oldVersion);
  if (version < oldVersion)
    throw new Error('Plugin version must increase lexicographically');
  if (version === oldVersion && text(resources[0], 'SHA256') !== digest)
    throw new Error(
      'Same plugin version has different archive SHA256; increment plugin version',
    );
}
function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    '.release-' + randomBytes(12).toString('hex'),
  );
  let fd;
  let created = false;
  try {
    fd = fs.openSync(temporary, 'wx', 0o644);
    created = true;
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, 0o644);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (created) fs.rmSync(temporary, { force: true });
  }
}
async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      core: { type: 'string' },
      out: { type: 'string' },
      'plugin-version': { type: 'string' },
      repository: { type: 'string' },
      branch: { type: 'string' },
      'plg-out': { type: 'string' },
    },
  });
  if (values.help) {
    console.log(`Usage: node scripts/package.mjs --out DIR [options]

Build a verified Bridge release archive and optional static PLG.

Options:
  --out DIR                 Required archive and SHA256SUMS output directory.
  --core PATH               Released Core executable; LICENSE and THIRD_PARTY.md
                            must be in the same directory.
                            Default: core-bin/linux-amd64/deck-bridge-core
                            relative to the repository root.
  --plugin-version VERSION  Plugin version (YYYY.MM.DD.NNNN).
                            Default: package.json bridge.pluginVersion.
  --repository OWNER/REPO    Public GitHub repository; enables static PLG output.
                            Default: archive only, without writing a PLG.
  --branch BRANCH           Single branch segment for the PLG update URL.
                            Default: main; requires --repository.
  --plg-out PATH            Static PLG output; basename must be
                            unraid-deck-bridge.plg. Default: repository-root
                            unraid-deck-bridge.plg; requires --repository.
  -h, --help                Show this help.`);
    return;
  }
  if (values.out === undefined) throw new Error('--out is required');
  if (
    values.repository === undefined &&
    (values.branch !== undefined || values['plg-out'] !== undefined)
  )
    throw new Error('--branch/--plg-out require --repository');
  if (
    values.repository !== undefined &&
    (!matches(
      /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
      values.repository,
    ) ||
      values.repository.toLowerCase().endsWith('.git'))
  )
    throw new Error('--repository must be OWNER/REPO without a .git suffix');
  const branch = values.branch ?? 'main';
  if (!matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, branch))
    throw new Error('--branch must be a single nonempty branch segment');
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json')));
  if (!matches(/^[0-9]+\.[0-9]+\.[0-9]+$/, pkg.version))
    throw new Error('Package version must be MAJOR.MINOR.PATCH');
  const pluginVersion = validatePluginVersion(
    values['plugin-version'] ?? pkg.bridge.pluginVersion,
  );
  const core = path.resolve(
    values.core ?? path.join(repo, 'core-bin/linux-amd64/deck-bridge-core'),
  );
  const coreInput = loadCoreInput(core);
  const { data, removeScript, captureScript } = await buildArchive(
      coreInput,
      pkg,
    ),
    digest = sha256(data),
    build = `${pkg.version}-${digest.slice(0, 12)}`;
  const out = path.resolve(values.out),
    archive = path.join(
      out,
      `unraid-deck-bridge-${pluginVersion}-linux-amd64.tar.gz`,
    ),
    sums = path.join(out, 'SHA256SUMS');
  validateArchiveOutput(archive, data);
  const sumsStat = statIfPresent(sums);
  if (sumsStat && !sumsStat.isFile())
    throw new Error(`Output must be a regular file: ${sums}`);
  let plugin = null,
    pluginData;
  if (values.repository !== undefined) {
    plugin = path.resolve(
      values['plg-out'] ?? path.join(repo, 'unraid-deck-bridge.plg'),
    );
    const minimumOS = JSON.parse(coreInput.compatibilityBytes).minimumOSVersion;
    if (typeof minimumOS !== 'string' || !minimumOS)
      throw new Error('Compatibility manifest is missing minimumOSVersion');
    pluginData = buildPlugin(
      values.repository,
      branch,
      pluginVersion,
      minimumOS,
      path.basename(archive),
      build,
      digest,
      removeScript,
      captureScript,
    );
    validatePluginOutput(plugin, pluginVersion, digest);
  }
  atomicWrite(archive, data);
  atomicWrite(sums, Buffer.from(`${digest}  ${path.basename(archive)}\n`));
  if (plugin !== null) atomicWrite(plugin, pluginData);
  console.log(JSON.stringify({ build, archive, plugin, sha256: digest }));
}
try {
  await main();
} catch (error) {
  console.error('Release failed: ' + error.message);
  process.exitCode = 1;
}
