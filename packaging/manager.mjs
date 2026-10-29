import fs from 'node:fs';
import path from 'node:path';
import { assertSupportedHost } from './adapter/check-host.js';
const api = '/usr/local/unraid-api';
const base = '/boot/config/plugins/unraid-deck-bridge';
const runtime = '/usr/local/emhttp/plugins/unraid-deck-bridge';
const config = '/boot/config/plugins/dynamix.my.servers/configs/api.json';
const name = 'unraid-deck-bridge';
const manifest = api + '/package.json';
const read = (p) => {
  const bytes = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(bytes);
  } catch {
    throw new Error('Invalid JSON in Bridge lifecycle metadata');
  }
};
const write = (p, v) => {
  const mode = fs.statSync(p).mode & 0o777;
  fs.writeFileSync(p + '.bridge-tmp', JSON.stringify(v, null, 2) + '\n', {
    mode,
  });
  fs.renameSync(p + '.bridge-tmp', p);
};
function adapterVersion(source) {
  const { version } = read(path.join(source, 'adapter', 'package.json'));
  if (
    typeof version !== 'string' ||
    /^[0-9]+\.[0-9]+\.[0-9]+$/.exec(version)?.[0] !== version
  )
    throw new Error('Invalid adapter package version');
  return version;
}
function preflight() {
  if (!fs.existsSync('/etc/unraid-version'))
    throw new Error('Unraid host required');
  return assertSupportedHost({
    osVersion: '/etc/unraid-version',
    apiPackage: manifest,
    arch: process.arch,
  });
}

function register(source) {
  preflight();
  const version = adapterVersion(source);
  const p = read(manifest);
  p.peerDependencies = { ...p.peerDependencies, [name]: version };
  write(manifest, p);
  const dest = api + '/node_modules/' + name;
  fs.mkdirSync(dest, { recursive: true });
  for (const file of [
    'index.js',
    'runtime.types.js',
    'configuration-feedback.js',
    'core-client.js',
    'check-host.js',
    'compatibility.json',
    'package.json',
  ])
    fs.copyFileSync(path.join(source, 'adapter', file), path.join(dest, file));
  // The API must be stopped so shutdown cannot overwrite these edits.
  const c = read(config);
  c.plugins = [...(c.plugins || []).filter((n) => n !== name), name];
  write(config, c);
}
function restore(backup) {
  const old = read(backup + '/package.json'),
    now = read(manifest);
  for (const section of ['dependencies', 'peerDependencies']) {
    for (const n of [name]) {
      if (now[section]) delete now[section][n];
      if (old[section]?.[n]) {
        now[section] ??= {};
        now[section][n] = old[section][n];
      }
    }
    if (now[section] && !Object.keys(now[section]).length && !old[section])
      delete now[section];
  }
  write(manifest, now);
  const oldConfig = read(backup + '/api.json'),
    nowConfig = read(config);
  nowConfig.plugins = [
    ...(nowConfig.plugins || []).filter((n) => n !== name),
    ...(oldConfig.plugins || []).filter((n) => n === name),
  ];
  write(config, nowConfig);
  fs.rmSync(api + '/node_modules/' + name, { recursive: true, force: true });
  if (fs.existsSync(backup + '/adapter'))
    fs.cpSync(backup + '/adapter', api + '/node_modules/' + name, {
      recursive: true,
    });
}
const cmd = process.argv[2];
if (cmd === 'template-profile') {
  try {
    const host = preflight();
    if (
      host?.dockerWriteSupported &&
      ['DOCKERMAN_CLASSIC_NETWORK', 'DOCKERMAN_ENDPOINT_NETWORK'].includes(
        host.templateProfile,
      )
    )
      process.stdout.write(host.templateProfile);
  } catch {}
} else if (cmd === 'preflight') preflight();
else if (cmd === 'register') register(process.argv[3]);
else if (cmd === 'backup') {
  const dest = process.argv[3];
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  fs.copyFileSync(manifest, dest + '/package.json');
  fs.copyFileSync(config, dest + '/api.json');
  fs.chmodSync(dest + '/api.json', 0o600);
  if (fs.existsSync(api + '/node_modules/' + name))
    fs.cpSync(api + '/node_modules/' + name, dest + '/adapter', {
      recursive: true,
    });
} else if (cmd === 'restore') restore(process.argv[3]);
else if (cmd === 'check') {
  preflight();
  const source = process.argv[3] || path.join(runtime, 'current');
  const version = adapterVersion(source);
  const c = read(config),
    p = read(manifest);
  if (
    !c.plugins?.includes(name) ||
    p.peerDependencies?.[name] !== version ||
    !fs.existsSync(api + '/node_modules/' + name + '/index.js')
  )
    process.exit(1);
  for (const file of [
    'index.js',
    'runtime.types.js',
    'configuration-feedback.js',
    'core-client.js',
    'check-host.js',
    'compatibility.json',
    'package.json',
  ])
    if (
      !fs
        .readFileSync(api + '/node_modules/' + name + '/' + file)
        .equals(fs.readFileSync(path.join(source, 'adapter', file)))
    )
      process.exit(1);
} else throw new Error('Unknown management action');
