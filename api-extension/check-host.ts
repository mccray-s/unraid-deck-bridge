import fs from 'node:fs';
import path from 'node:path';
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
function meetsMinimumVersion(version: string, minimum: string): boolean {
  const actual = version.split('.').map(BigInt),
    floor = minimum.split('.').map(BigInt);
  for (let i = 0; i < 3; i++)
    if (actual[i] !== floor[i]) return actual[i] > floor[i];
  return true;
}
export function resolveCompatibility(
  osInput: string,
  apiInput: string,
  arch: string,
  dependencies: Record<string, string>,
): HostReport {
  const osVersion = stableVersion(osInput),
    apiVersion = stableVersion(apiInput);
  if (!osVersion || !apiVersion || arch !== 'x64')
    throw new Error('Unsupported or invalid host version/architecture');
  if (!meetsMinimumVersion(osVersion, compatibilityMatrix.minimumOSVersion))
    throw new Error(
      `Unraid OS ${osVersion} requires ${compatibilityMatrix.minimumOSVersion} or newer`,
    );
  if (!meetsMinimumVersion(apiVersion, compatibilityMatrix.minimumAPIVersion))
    throw new Error(
      `Unraid API ${apiVersion} requires ${compatibilityMatrix.minimumAPIVersion} or newer`,
    );
  for (const [name, minimum] of Object.entries<string>(
    compatibilityMatrix.minimumDependencies,
  )) {
    const version = stableVersion(dependencies[name]);
    if (!version || !meetsMinimumVersion(version, minimum))
      throw new Error(`Host dependency requires ${name} ${minimum} or newer`);
  }
  // These are serialization dialect boundaries, not a list of admitted OS versions.
  let templateProfile: string | undefined;
  let selectedMinimum: string | undefined;
  for (const profile of compatibilityMatrix.templateProfiles) {
    if (
      meetsMinimumVersion(osVersion, profile.minimumOSVersion) &&
      (!selectedMinimum ||
        meetsMinimumVersion(profile.minimumOSVersion, selectedMinimum))
    ) {
      templateProfile = profile.templateProfile;
      selectedMinimum = profile.minimumOSVersion;
    }
  }
  if (!templateProfile)
    throw new Error('DockerManager template dialect is unavailable');
  return {
    osVersion,
    apiVersion,
    apiProfile: 'HOST_RUNTIME',
    runtimeProfile: 'MINIMUM_DEPENDENCIES',
    dockerProfile: 'ORDINARY_CONTAINER_SUBSET',
    templateProfile,
    hostWriteSupported: true,
    dockerWriteSupported: true,
    osEvidence: 'MINIMUM_VERSION_COMPATIBLE',
    verificationScope:
      'Minimum OS/API and dependency versions; operations validate live interfaces and inputs. Not every host combination is live-tested',
    verification: 'MINIMUM_VERSION_AND_RUNTIME_CHECKED',
    reasons: [],
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
  const dependencies: Record<string, string> = {};
  for (const name of Object.keys(compatibilityMatrix.minimumDependencies)) {
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
  return resolveCompatibility(os, api, paths.arch, dependencies);
}
