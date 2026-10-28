import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
export const compatibilityMatrix = JSON.parse(
  fs.readFileSync(new URL('./compatibility.json', import.meta.url), 'utf8'),
);
export type HostReport = {
  osVersion: string;
  apiVersion: string;
  apiProfile: string;
  runtimeProfile: string;
  dockerProfile: string;
  templateProfile?: string;
  hostWriteSupported: boolean;
  dockerWriteSupported: boolean;
  verification: string;
  verificationScope: string;
  osEvidence: string;
  reasons: string[];
};
export function stableVersion(input: string): string | undefined {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      input,
    );
  return match && match[0] === input
    ? `${match[1]}.${match[2]}.${match[3]}`
    : undefined;
}
function meetsMinimumOS(version: string): boolean {
  const actual = version.split('.').map(BigInt),
    minimum = compatibilityMatrix.minimumOSVersion.split('.').map(BigInt);
  for (let i = 0; i < 3; i++)
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  return true;
}
const readOnlyCapabilities = [
  'operations.events',
  'docker.updateCheck',
  'docker.templateManagementRead',
  'docker.templateFieldsRead',
  'system.read',
  'plugins.read',
  'array.read',
  'array.parity.read',
];
const dockerWriteCapabilities = [
  'docker.install',
  'docker.edit',
  'docker.cancel',
  'docker.imageUpdate',
  'docker.engineImageUpdate',
  'docker.imageUpdateBatch',
  'docker.engineEdit',
  'docker.template',
  'docker.templateDrafts',
  'docker.customCreate',
  'docker.fullConfiguration',
  'docker.templateReplace',
  'docker.templateAdopt',
  'docker.templateFields',
  'docker.configurationFeedback',
];
export function filterCapabilities(
  host: HostReport | undefined,
  capabilities: string[],
): string[] {
  if (host?.hostWriteSupported === false)
    return capabilities.filter((x) => readOnlyCapabilities.includes(x));
  if (host?.dockerWriteSupported === false)
    return capabilities.filter((x) => !dockerWriteCapabilities.includes(x));
  return capabilities;
}
export function resolveCompatibility(
  osInput: string,
  apiInput: string,
  arch: string,
  dependencies: Record<string, string>,
  fingerprints: Record<string, string>,
): HostReport {
  const osVersion = stableVersion(osInput),
    apiVersion = stableVersion(apiInput);
  if (!osVersion || !apiVersion || arch !== 'x64')
    throw new Error('Unsupported or invalid host version/architecture');
  const os = compatibilityMatrix.os[osVersion],
    api = compatibilityMatrix.api[apiVersion];
  if (!meetsMinimumOS(osVersion) || !api)
    throw new Error('Host version is outside the supported OS/API contract');
  for (const [name, version] of Object.entries(api.dependencies))
    if (dependencies[name] !== version)
      throw new Error(`Unverified host dependency: ${name}`);
  if (!os)
    return {
      osVersion,
      apiVersion,
      apiProfile: api.authProfile,
      runtimeProfile: api.runtimeProfile,
      dockerProfile: 'UNVERIFIED',
      hostWriteSupported: false,
      dockerWriteSupported: false,
      osEvidence: 'UNVERIFIED_OS_PROFILE',
      verificationScope:
        'Audited API contract and read-only runtime observation; host write operations are not verified',
      verification: 'API_CONTRACT_ONLY',
      reasons: ['OS_PROFILE_UNVERIFIED'],
    };
  const reasons: string[] = [];
  for (const [file, digest] of Object.entries(os.dockerFiles))
    if (fingerprints[file] !== digest)
      reasons.push(`DOCKER_MANAGER_MISMATCH:${path.basename(file)}`);
  return {
    osVersion,
    apiVersion,
    apiProfile: api.authProfile,
    runtimeProfile: api.runtimeProfile,
    dockerProfile: os.dockerProfile,
    templateProfile: os.templateProfile,
    hostWriteSupported: true,
    dockerWriteSupported: reasons.length === 0,
    osEvidence: os.sourceKind,
    verificationScope:
      'Live validation excludes array/power execution; Docker support is the ordinary-container subset',
    verification:
      osVersion === '7.3.2' && apiVersion === '4.36.1'
        ? 'LIVE_TESTED_SCOPE'
        : 'SOURCE_AND_CONTRACT',
    reasons,
  };
}
export function assertSupportedHost(
  paths = {
    osVersion: '/etc/unraid-version',
    apiPackage: '/usr/local/unraid-api/package.json',
    arch: process.arch as string,
  },
): HostReport | undefined {
  // Independent local tests have no Unraid OS file. The production installer always requires it.
  if (!fs.existsSync(paths.osVersion)) return;
  const os =
    fs
      .readFileSync(paths.osVersion, 'utf8')
      .match(/^version="([^"]+)"$/m)?.[1] ?? '';
  const api = JSON.parse(fs.readFileSync(paths.apiPackage, 'utf8')).version;
  const profile = compatibilityMatrix.api[stableVersion(api) ?? ''];
  const dependencies: Record<string, string> = {};
  if (profile)
    for (const name of Object.keys(profile.dependencies)) {
      try {
        dependencies[name] = JSON.parse(
          fs.readFileSync(
            path.join(
              path.dirname(paths.apiPackage),
              'node_modules',
              name,
              'package.json',
            ),
            'utf8',
          ),
        ).version;
      } catch {
        throw new Error(`Host dependency is unavailable: ${name}`);
      }
    }
  const fingerprints: Record<string, string> = {};
  const osProfile = compatibilityMatrix.os[stableVersion(os) ?? ''];
  if (osProfile)
    for (const file of Object.keys(osProfile.dockerFiles)) {
      try {
        fingerprints[file] = createHash('sha256')
          .update(fs.readFileSync(file))
          .digest('hex');
      } catch {}
    }
  return resolveCompatibility(os, api, paths.arch, dependencies, fingerprints);
}
