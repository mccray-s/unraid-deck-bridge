export interface ReleaseVersion {
  version: string;
  year: number;
  month: number;
  day: number;
  revision: string;
  npmVersion: string;
}

export function parseReleaseVersion(value: unknown): ReleaseVersion;
export function compareReleaseVersions(left: string, right: string): -1 | 0 | 1;
export function isObservedReleaseVersion(value: unknown): boolean;
