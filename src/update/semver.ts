/**
 * Semantic Version Comparison
 *
 * Implements SemVer comparison without external dependencies.
 * Supports major.minor.patch and prerelease versions.
 */

/** Parsed semantic version */
export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: string[];
  readonly build: string[];
  readonly original: string;
}

/**
 * Parses a semantic version string.
 *
 * @param version - Version string (e.g., "1.2.3", "1.2.3-beta.1", "1.2.3+build.1")
 * @returns Parsed version or null if invalid
 */
export function parseVersion(version: string): ParsedVersion | null {
  // Remove leading 'v' if present
  const cleanVersion = version.trim().replace(/^v/, "");

  // Match: major.minor.patch[-prerelease][+build]
  const match = cleanVersion.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/
  );

  if (!match) {
    return null;
  }

  const [, major, minor, patch, prerelease, build] = match;

  return {
    major: parseInt(major!, 10),
    minor: parseInt(minor!, 10),
    patch: parseInt(patch!, 10),
    prerelease: prerelease ? prerelease.split(".") : [],
    build: build ? build.split(".") : [],
    original: version,
  };
}

/**
 * Compares two semantic versions.
 *
 * @param a - First version
 * @param b - Second version
 * @returns -1 if a < b, 0 if a === b, 1 if a > b, null if invalid
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | null {
  const parsedA = parseVersion(a);
  const parsedB = parseVersion(b);

  if (!parsedA || !parsedB) {
    return null;
  }

  // Compare major
  if (parsedA.major !== parsedB.major) {
    return parsedA.major > parsedB.major ? 1 : -1;
  }

  // Compare minor
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor > parsedB.minor ? 1 : -1;
  }

  // Compare patch
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch > parsedB.patch ? 1 : -1;
  }

  // Compare prerelease
  // No prerelease (stable) > prerelease
  if (parsedA.prerelease.length === 0 && parsedB.prerelease.length > 0) {
    return 1;
  }
  if (parsedA.prerelease.length > 0 && parsedB.prerelease.length === 0) {
    return -1;
  }

  // Both have prerelease - compare parts
  const maxLength = Math.max(parsedA.prerelease.length, parsedB.prerelease.length);
  for (let i = 0; i < maxLength; i++) {
    const partA = parsedA.prerelease[i];
    const partB = parsedB.prerelease[i];

    if (partA === undefined) return -1;
    if (partB === undefined) return 1;

    // Numeric comparison if both are numbers
    const numA = parseInt(partA, 10);
    const numB = parseInt(partB, 10);

    if (!isNaN(numA) && !isNaN(numB)) {
      if (numA !== numB) {
        return numA > numB ? 1 : -1;
      }
    } else {
      // String comparison
      if (partA !== partB) {
        return partA > partB ? 1 : -1;
      }
    }
  }

  // Versions are equal
  return 0;
}

/**
 * Checks if version A is greater than version B.
 */
export function isGreaterThan(a: string, b: string): boolean {
  return compareVersions(a, b) === 1;
}

/**
 * Checks if version A is less than version B.
 */
export function isLessThan(a: string, b: string): boolean {
  return compareVersions(a, b) === -1;
}

/**
 * Checks if versions are equal.
 */
export function isEqual(a: string, b: string): boolean {
  return compareVersions(a, b) === 0;
}

/**
 * Checks if version is a prerelease.
 */
export function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version);
  return parsed ? parsed.prerelease.length > 0 : false;
}

/**
 * Determines the update type between two versions.
 */
export function getUpdateType(from: string, to: string): "major" | "minor" | "patch" | "prerelease" | "none" | null {
  const parsedFrom = parseVersion(from);
  const parsedTo = parseVersion(to);

  if (!parsedFrom || !parsedTo) {
    return null;
  }

  const comparison = compareVersions(from, to);
  if (comparison === 0) return "none";
  if (comparison === 1) return null; // Downgrade, not an update

  if (parsedTo.major > parsedFrom.major) return "major";
  if (parsedTo.minor > parsedFrom.minor) return "minor";
  if (parsedTo.patch > parsedFrom.patch) return "patch";
  if (parsedTo.prerelease.length > 0) return "prerelease";

  return "none";
}
