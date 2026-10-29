import fs from 'node:fs';
import { parseReleaseVersion } from '../api-extension/release-version.mjs';

const root = new URL('../', import.meta.url);
const release = JSON.parse(
  fs.readFileSync(new URL('release.json', root), 'utf8'),
);
const { npmVersion } = parseReleaseVersion(release?.version);
const packagePath = new URL('package.json', root);
const lockPath = new URL('package-lock.json', root);
const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
if (!lock.packages?.['']) {
  throw new Error('package-lock.json must contain root package metadata');
}

if (pkg.version !== npmVersion) {
  pkg.version = npmVersion;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
}
if (lock.version !== npmVersion || lock.packages[''].version !== npmVersion) {
  lock.version = npmVersion;
  lock.packages[''].version = npmVersion;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
}
