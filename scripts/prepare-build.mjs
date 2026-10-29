import fs from 'node:fs';
import { parseReleaseVersion } from '../api-extension/release-version.mjs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
const release = JSON.parse(
  fs.readFileSync(new URL('release.json', root), 'utf8'),
);
const { npmVersion } = parseReleaseVersion(release?.version);
if (
  pkg.version !== npmVersion ||
  typeof pkg.name !== 'string' ||
  !pkg.name.trim() ||
  typeof pkg.license !== 'string' ||
  !pkg.license.trim()
) {
  throw new Error(
    'package.json must define a name, license and synchronized npm release version',
  );
}

const adapterPackage = {
  name: pkg.name,
  version: pkg.version,
  type: 'module',
  main: 'index.js',
  license: pkg.license,
};
fs.mkdirSync(new URL('dist/', root), { recursive: true });
fs.copyFileSync(
  new URL('contracts/compatibility.json', root),
  new URL('dist/compatibility.json', root),
);
fs.copyFileSync(
  new URL('release.json', root),
  new URL('dist/release.json', root),
);
fs.copyFileSync(
  new URL('api-extension/release-version.mjs', root),
  new URL('dist/release-version.mjs', root),
);
fs.writeFileSync(
  new URL('dist/package.json', root),
  JSON.stringify(adapterPackage, null, 2) + '\n',
);
