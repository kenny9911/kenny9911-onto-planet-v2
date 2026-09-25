import { createHash } from "node:crypto";
import type { DefinitionCounts, OntologyBundle, ReleaseManifest } from "../../contracts/src/index.js";
import { assertValidBundle, validateBundle } from "./validate.js";

/** Stable JSON: sorted object keys, original array order, and no implicit coercion. */
export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  const normalize = (current: unknown): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("Canonical JSON requires finite numbers");
      return current;
    }
    if (typeof current !== "object") throw new TypeError(`Canonical JSON cannot encode ${typeof current}`);
    if (ancestors.has(current)) throw new TypeError("Canonical JSON cannot encode cycles");
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (Array.from({ length: current.length }).some((_, index) => !Object.hasOwn(current, index))) {
          throw new TypeError("Canonical JSON cannot encode sparse arrays");
        }
        return current.map(normalize);
      }
      if (Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) {
        throw new TypeError("Canonical JSON requires plain objects");
      }
      if (Object.getOwnPropertySymbols(current).length > 0) throw new TypeError("Canonical JSON cannot encode symbol keys");
      const output: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(current).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("Canonical JSON cannot encode accessors");
        output[key] = normalize(descriptor.value);
      }
      return output;
    } finally {
      ancestors.delete(current);
    }
  };
  const canonical = JSON.stringify(normalize(value));
  if (canonical === undefined) throw new TypeError("Canonical JSON cannot encode this value");
  return canonical;
}

export function hashBundle(bundle: OntologyBundle): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalize(bundle), "utf8").digest("hex")}`;
}

function counts(bundle: OntologyBundle): DefinitionCounts {
  return {
    sources: bundle.sources.length,
    values: bundle.values.length,
    sharedProperties: bundle.sharedProperties.length,
    objects: bundle.objects.length,
    relations: bundle.relations.length,
    interfaces: bundle.interfaces.length,
    rules: bundle.rules.length,
    actions: bundle.actions.length,
    functions: bundle.functions.length,
    events: bundle.events.length,
    policies: bundle.policies.length,
  };
}

function isCanonicalUtcTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export function createReleaseManifest(bundle: OntologyBundle, releasedAt: string): Readonly<ReleaseManifest> {
  assertValidBundle(bundle);
  if (!isCanonicalUtcTimestamp(releasedAt)) throw new TypeError("releasedAt must be a canonical UTC timestamp, such as 2026-09-26T00:00:00.000Z");
  const bundleHash = hashBundle(bundle);
  const manifest: ReleaseManifest = {
    schemaVersion: bundle.schemaVersion,
    releaseId: `${bundle.id}@${bundle.version}+${bundleHash.slice(7)}`,
    bundleId: bundle.id,
    bundleVersion: bundle.version,
    bundleHash,
    releasedAt,
    definitionCounts: Object.freeze(counts(bundle)),
  };
  return Object.freeze(manifest);
}

export function verifyReleaseManifest(bundle: OntologyBundle, manifest: ReleaseManifest): boolean {
  try {
    if (validateBundle(bundle).length > 0 || !manifest || !isCanonicalUtcTimestamp(manifest.releasedAt)) return false;
    const expected = createReleaseManifest(bundle, manifest.releasedAt);
    return canonicalize(expected) === canonicalize(manifest);
  } catch {
    return false;
  }
}
