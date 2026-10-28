import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8'));
if (
  typeof pkg.version !== 'string' ||
  /^[0-9]+\.[0-9]+\.[0-9]+$/.exec(pkg.version)?.[0] !== pkg.version ||
  typeof pkg.name !== 'string' ||
  !pkg.name.trim() ||
  typeof pkg.license !== 'string' ||
  !pkg.license.trim()
) {
  throw new Error(
    'package.json must define a name, license and MAJOR.MINOR.PATCH version',
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
fs.writeFileSync(
  new URL('dist/package.json', root),
  JSON.stringify(adapterPackage, null, 2) + '\n',
);
