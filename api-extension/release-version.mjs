const releasePattern = /^(\d{4})\.(\d{2})\.(\d{2})([a-z]?)(?![\s\S])/;
const stablePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?![\s\S])/;

export function parseReleaseVersion(value) {
  const match = typeof value === 'string' ? releasePattern.exec(value) : null;
  if (!match) {
    throw new TypeError(
      'Release version must be YYYY.MM.DD with an optional lowercase revision',
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const revision = match[4];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days[month - 1]
  ) {
    throw new TypeError('Release version must contain a valid calendar date');
  }
  const ordinal = revision ? revision.charCodeAt(0) - 96 : 0;
  return {
    version: value,
    year,
    month,
    day,
    revision,
    npmVersion: `${year}.${month}.${day * 100 + ordinal}`,
  };
}

export function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left).version;
  const b = parseReleaseVersion(right).version;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isObservedReleaseVersion(value) {
  try {
    parseReleaseVersion(value);
    return true;
  } catch {
    // A malformed date release must not be reinterpreted as legacy SemVer.
    return (
      typeof value === 'string' &&
      !/^\d{4}\./.test(value) &&
      stablePattern.test(value)
    );
  }
}
