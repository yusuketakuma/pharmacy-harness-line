import type { Manifest, ReleaseEntry } from './types.js';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function requireStrings(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`invalid customer source ${field}`);
  }
}

/** Validate the optional commercial-fork release authority at every trust boundary. */
export function validateReleaseEntry(
  release: ReleaseEntry,
  previous?: ReleaseEntry,
): void {
  const source = release.customer_source_update;
  if (!source) return;

  if (!REPOSITORY_PATTERN.test(source.repository)) {
    throw new Error('invalid customer source repository');
  }
  if (source.tag !== `pharmacy-v${release.version}`) {
    throw new Error('customer source tag must match release version');
  }
  if (source.release_id !== `${source.repository}@${source.tag}`) {
    throw new Error('customer source release_id must bind repository and tag');
  }
  if (!SHA_PATTERN.test(source.commit) || !SHA_PATTERN.test(source.previous_commit)) {
    throw new Error('customer source commit and previous_commit must be exact SHAs');
  }
  if (!Number.isInteger(source.release_sequence) || source.release_sequence < 1) {
    throw new Error('customer source release_sequence must be a positive integer');
  }
  if (source.update_class !== 'compatible' && source.update_class !== 'manual') {
    throw new Error('invalid customer source update_class');
  }
  requireStrings(source.manual_reasons, 'manual_reasons');
  requireStrings(source.required_configuration, 'required_configuration');
  requireStrings(source.privileged_paths, 'privileged_paths');
  requireStrings(source.new_migrations, 'new_migrations');
  if (!SEMVER_PATTERN.test(source.minimum_client_version)) {
    throw new Error('invalid customer source minimum_client_version');
  }
  if (!SEMVER_PATTERN.test(source.rollback_compatible_from)) {
    throw new Error('invalid customer source rollback_compatible_from');
  }
  if (typeof source.revoked !== 'boolean') {
    throw new Error('invalid customer source revoked flag');
  }
  if (!source.migration_digests || Array.isArray(source.migration_digests)) {
    throw new Error('invalid customer source migration_digests');
  }
  const digestNames = Object.keys(source.migration_digests).sort();
  const migrationNames = [...release.migrations].sort();
  if (
    digestNames.length !== migrationNames.length ||
    digestNames.some((name, index) => name !== migrationNames[index]) ||
    Object.values(source.migration_digests).some((digest) => !DIGEST_PATTERN.test(digest))
  ) {
    throw new Error('customer source migration digests must match release migrations');
  }
  if (source.new_migrations.some((name) => !release.migrations.includes(name))) {
    throw new Error('customer source new_migrations must be present in release migrations');
  }

  if (source.update_class === 'compatible') {
    const incompatible =
      source.manual_reasons.length > 0 ||
      source.required_configuration.length > 0 ||
      source.privileged_paths.length > 0 ||
      source.new_migrations.length > 0 ||
      release.new_required_secrets.length > 0 ||
      source.revoked;
    if (incompatible) {
      throw new Error('compatible customer release cannot change privileged contracts');
    }
  } else if (source.manual_reasons.length === 0) {
    throw new Error('manual customer release requires at least one reason');
  }

  const previousSource = previous?.customer_source_update;
  if (previousSource && previousSource.repository === source.repository) {
    if (source.release_sequence <= previousSource.release_sequence) {
      throw new Error('customer source release sequence must strictly increase');
    }
    if (source.previous_commit !== previousSource.commit) {
      throw new Error('customer source previous_commit must match prior release');
    }
  }
}

/** Validate release-manifest.json before any consumer trusts its contents. */
export function validateManifest(value: unknown): asserts value is Manifest {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid release manifest');
  }
  const body = value as Manifest;
  if (body.schema_version !== 1) {
    throw new Error(`unsupported manifest schema_version ${body.schema_version}`);
  }
  if (!Array.isArray(body.releases)) {
    throw new Error('invalid release manifest: releases must be an array');
  }
  if (
    body.revoked_release_ids !== undefined &&
    (!Array.isArray(body.revoked_release_ids) ||
      body.revoked_release_ids.some((id) => typeof id !== 'string'))
  ) {
    throw new Error('invalid release manifest: revoked_release_ids must be strings');
  }
  for (let index = 0; index < body.releases.length; index += 1) {
    validateReleaseEntry(body.releases[index], body.releases[index + 1]);
  }
}

/**
 * Fetch the release manifest from the given URL.
 *
 * Uses `cache: 'no-store'` so that the update engine never serves a stale
 * manifest from a CDN/edge cache. Throws if the response is non-2xx or if the
 * manifest's `schema_version` is not supported by this engine.
 */
export async function fetchManifest(url: string): Promise<Manifest> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(
      `failed to fetch manifest from ${url}: HTTP ${res.status}`,
    );
  }

  const body: unknown = await res.json();
  validateManifest(body);
  return body;
}

/** Find a release entry by exact version match. */
export function findRelease(
  manifest: Manifest,
  version: string,
): ReleaseEntry | undefined {
  return manifest.releases.find((r) => r.version === version);
}

/**
 * Return the latest release entry if it is strictly newer than `current`,
 * otherwise `null` (i.e. nothing to upgrade to).
 */
export function findLatestUpgrade(
  manifest: Manifest,
  current: string,
): ReleaseEntry | null {
  if (compareSemver(manifest.latest, current) <= 0) {
    return null;
  }
  return findRelease(manifest, manifest.latest) ?? null;
}

/**
 * Compare two `X.Y.Z` semver strings.
 *
 * Returns a negative number if `a < b`, `0` if equal, positive if `a > b`.
 * Pre-release suffixes are not supported in v1 of the manifest schema; any
 * non-numeric segment will be parsed as `NaN` and treated as `0`.
 */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const diff = pa[i] - pb[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseSemver(v: string): [number, number, number] {
  const parts = v.split('.').map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
