export const TESTED_PI_VERSION = '0.99.2';
export const MIN_SUPPORTED_PI_VERSION = TESTED_PI_VERSION;
export const MAX_EXCLUSIVE_PI_VERSION = '0.100.0';
export const SUPPORTED_PI_RANGE = `>=${MIN_SUPPORTED_PI_VERSION} <${MAX_EXCLUSIVE_PI_VERSION}`;

const VERSION_PATTERN = /(?:^|[^0-9A-Za-z.+-])v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?=$|[^0-9A-Za-z.+-])/g;

function parseVersion(output) {
  const matches = [...output.matchAll(VERSION_PATTERN)];
  if (matches.length !== 1) return null;

  const [, core, prerelease, build] = matches[0];
  const normalizedVersion = `${core}${prerelease ?? ''}${build ?? ''}`;
  const [major, minor, patch] = core.split('.').map(BigInt);
  return {
    normalizedVersion,
    prerelease: prerelease !== undefined,
    components: [major, minor, patch],
  };
}

const MIN_SUPPORTED_COMPONENTS = parseVersion(MIN_SUPPORTED_PI_VERSION).components;
const MAX_EXCLUSIVE_COMPONENTS = parseVersion(MAX_EXCLUSIVE_PI_VERSION).components;

function compare(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

export function evaluatePiCompatibility(versionOutput) {
  const rawOutput = versionOutput == null ? null : String(versionOutput).trim();
  if (rawOutput === null) {
    return { status: 'MISSING', installedVersion: null, normalizedVersion: null, supported: false, rawOutput };
  }

  const parsed = parseVersion(rawOutput);
  if (!parsed) {
    return { status: 'UNPARSEABLE', installedVersion: rawOutput, normalizedVersion: null, supported: false, rawOutput };
  }

  const result = {
    installedVersion: rawOutput,
    normalizedVersion: parsed.normalizedVersion,
    supported: false,
    rawOutput,
  };

  // Only validated stable releases are supported, even when a prerelease has an
  // otherwise in-range numeric version.
  if (parsed.prerelease) return { ...result, status: 'UNVERIFIED' };
  if (compare(parsed.components, MIN_SUPPORTED_COMPONENTS) < 0) return { ...result, status: 'TOO_OLD' };
  if (compare(parsed.components, MAX_EXCLUSIVE_COMPONENTS) >= 0) return { ...result, status: 'TOO_NEW_OR_UNVALIDATED' };
  return { ...result, status: 'SUPPORTED', supported: true };
}

export function describePiCompatibility(result) {
  if (result.status === 'SUPPORTED') {
    return `${result.normalizedVersion} supported (${SUPPORTED_PI_RANGE})`;
  }
  if (result.status === 'TOO_OLD') {
    return `${result.normalizedVersion} is below supported range ${SUPPORTED_PI_RANGE}`;
  }
  if (result.status === 'TOO_NEW_OR_UNVALIDATED') {
    return `${result.normalizedVersion} is outside validated range ${SUPPORTED_PI_RANGE}`;
  }
  if (result.status === 'UNVERIFIED') {
    return `${result.normalizedVersion} is a prerelease outside the validated release set ${SUPPORTED_PI_RANGE}`;
  }
  if (result.status === 'MISSING') return `Pi is missing; compatibility range is ${SUPPORTED_PI_RANGE}`;
  return `could not parse Pi version output ${JSON.stringify(result.rawOutput)}; compatibility range is ${SUPPORTED_PI_RANGE}`;
}

export function piCompatibilityLabel(result) {
  if (result.status === 'SUPPORTED') return 'OK';
  if (result.status === 'TOO_OLD' || result.status === 'TOO_NEW_OR_UNVALIDATED') return 'UNSUPPORTED';
  if (result.status === 'MISSING') return 'MISSING';
  return 'UNVERIFIED';
}
