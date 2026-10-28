import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';

export const repo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export function write(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}
// Minimal complete static ELF64: one executable PT_LOAD and an entry byte.
// This is data for the publisher, never executed as a host program.
export function elf() {
  const data = Buffer.alloc(121);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(data);
  data.writeUInt16LE(2, 16);
  data.writeUInt16LE(62, 18);
  data.writeUInt32LE(1, 20);
  data.writeBigUInt64LE(0x400078n, 24);
  data.writeBigUInt64LE(64n, 32);
  data.writeUInt16LE(64, 52);
  data.writeUInt16LE(56, 54);
  data.writeUInt16LE(1, 56);
  data.writeUInt32LE(1, 64);
  data.writeUInt32LE(5, 68);
  data.writeBigUInt64LE(0x400000n, 80);
  data.writeBigUInt64LE(BigInt(data.length), 96);
  data.writeBigUInt64LE(BigInt(data.length), 104);
  data.writeBigUInt64LE(4096n, 112);
  data[120] = 0xc3;
  return data;
}
export function releaseFixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-release-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(
    path.join(root, 'scripts/package.mjs'),
    fs.readFileSync(path.join(repo, 'scripts/package.mjs')),
  );
  fs.symlinkSync(
    path.join(repo, 'node_modules'),
    path.join(root, 'node_modules'),
    'dir',
  );
  write(
    path.join(root, 'package.json'),
    JSON.stringify({
      name: 'unraid-deck-bridge',
      type: 'module',
      license: 'GPL-2.0-or-later',
      version: '0.6.0',
      bridge: { pluginVersion: '2026.10.26.0001' },
    }),
  );
  write(
    path.join(root, 'contracts/compatibility.json'),
    '{"minimumOSVersion":"6.12.0"}\n',
  );
  for (const name of [
    'index.js',
    'runtime.types.js',
    'configuration-feedback.js',
    'core-client.js',
    'check-host.js',
  ])
    write(path.join(root, 'dist', name), `// fixture ${name}\n`);
  fs.copyFileSync(
    path.join(root, 'contracts/compatibility.json'),
    path.join(root, 'dist/compatibility.json'),
  );
  write(
    path.join(root, 'dist/package.json'),
    JSON.stringify({
      name: 'unraid-deck-bridge',
      version: '0.6.0',
      type: 'module',
      main: 'index.js',
      license: 'GPL-2.0-or-later',
    }) + '\n',
  );
  fs.cpSync(path.join(repo, 'packaging'), path.join(root, 'packaging'), {
    recursive: true,
  });
  fs.cpSync(path.join(repo, 'assets'), path.join(root, 'assets'), {
    recursive: true,
  });
  write(path.join(root, 'LICENSE'), 'Bridge fixture LICENSE\n');
  const core = path.join(root, 'core-bin/linux-amd64/deck-bridge-core');
  write(core, elf(), 0o755);
  for (const name of ['LICENSE', 'THIRD_PARTY.md'])
    write(path.join(path.dirname(core), name), `Core fixture ${name}\n`);
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [
        path.join(root, 'scripts/package.mjs'),
        '--core',
        core,
        '--out',
        path.join(root, 'out'),
        ...args,
      ],
      { encoding: 'utf8', timeout: 30000 },
    );
  return { root, core, run };
}

export function parsePlugin(file) {
  const xml = fs.readFileSync(file, 'utf8');
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error('DTD and entity declarations are not permitted');
  }
  const document = new DOMParser({
    onError: (level, message) => {
      throw new Error(`Invalid plugin XML (${level}): ${message}`);
    },
  }).parseFromString(xml, 'application/xml');
  const plugin = document.documentElement;
  if (!plugin || plugin.tagName !== 'PLUGIN') {
    throw new Error('Expected PLUGIN document element');
  }
  const attributes = (element) =>
    Object.fromEntries(
      Array.from(element.attributes, (attribute) => [
        attribute.name,
        attribute.value,
      ]),
    );
  const children = (element) =>
    Array.from(element.childNodes).filter((child) => child.nodeType === 1);
  const elements = children(plugin);
  return {
    attributes: attributes(plugin),
    changes:
      elements.find((child) => child.tagName === 'CHANGES')?.textContent ??
      null,
    files: elements
      .filter((child) => child.tagName === 'FILE')
      .map((file) => ({
        attributes: attributes(file),
        ...Object.fromEntries(
          children(file).map((child) => [child.tagName, child.textContent]),
        ),
      })),
  };
}
