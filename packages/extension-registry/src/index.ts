import { createPublicKey, verify as verifySignature } from 'node:crypto';
import * as z from 'zod/v4';

const identifier = z.string().min(3).max(128).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
const capabilityId = z.string().min(1).max(128).regex(/^[a-zA-Z0-9]+(?:[._:-][a-zA-Z0-9]+)*$/);
const scope = z.string().min(1).max(128).regex(/^[a-zA-Z0-9]+(?:[._:-][a-zA-Z0-9]+)*$/);
const packageSpecifier = /^(?:@[a-z0-9-]+\/)?[a-z0-9-]+(?:\/[a-zA-Z0-9._-]+)*$/;
function isModuleSpecifier(value: string): boolean {
  if (packageSpecifier.test(value)) return true;
  if (!value.startsWith('./')) return false;
  const segments = value.slice(2).split('/');
  return segments.every((segment) => segment !== '.' && segment !== '..' && /^[a-zA-Z0-9._-]+$/.test(segment)) &&
    /\.(?:js|mjs)$/.test(segments.at(-1) ?? '');
}
const version = z.string().refine((value) => {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return false;
  const prerelease = match[4];
  const build = match[5];
  return (!prerelease || prerelease.split('.').every((part) =>
    part.length > 0 && (!/^\d+$/.test(part) || part === '0' || !part.startsWith('0')))) &&
    (!build || build.split('.').every((part) => part.length > 0));
}, 'expected a semantic version');
const manifestHeader = z.object({
  apiVersion: z.literal('ontoplanet.io/v1'),
  metadata: z.object({
    id: identifier,
    version,
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
  }).strict(),
});

/** Instructions are reusable content. A Skill manifest cannot grant execution authority. */
export const skillManifestSchema = manifestHeader.extend({
  kind: z.literal('Skill'),
  spec: z.object({
    instructionFile: z.string().min(1).max(256).regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/),
    suggestedCapabilities: z.array(capabilityId).max(100).default([]),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (new Set(value.spec.suggestedCapabilities).size !== value.spec.suggestedCapabilities.length) {
    context.addIssue({ code: 'custom', path: ['spec', 'suggestedCapabilities'], message: 'duplicate capability' });
  }
});

const requestSchema = z.object({
  capabilityId,
  scopes: z.array(scope).min(1).max(100),
}).strict().superRefine((value, context) => {
  if (new Set(value.scopes).size !== value.scopes.length) {
    context.addIssue({ code: 'custom', path: ['scopes'], message: 'duplicate scope' });
  }
});

export const pluginManifestSchema = manifestHeader.extend({
  kind: z.literal('Plugin'),
  signature: z.object({
    format: z.literal('ontoplanet-json-v1'),
    algorithm: z.literal('Ed25519'),
    keyId: identifier,
    value: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  }).strict().optional(),
  spec: z.object({
    runtime: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('mcp-http'), endpoint: z.url().refine((value) => value.startsWith('https://'), 'HTTPS is required') }).strict(),
      z.object({ kind: z.literal('in-process'), module: z.string().min(1).max(256)
        .refine(isModuleSpecifier, 'expected a package name or safe relative JavaScript module') }).strict(),
    ]),
    requestedCapabilities: z.array(requestSchema).max(100).default([]),
    skillRefs: z.array(z.object({ id: identifier, version }).strict()).max(100).default([]),
  }).strict(),
}).strict().superRefine((value, context) => {
  const requests = value.spec.requestedCapabilities.map((item) => item.capabilityId);
  if (new Set(requests).size !== requests.length) {
    context.addIssue({ code: 'custom', path: ['spec', 'requestedCapabilities'], message: 'duplicate capability request' });
  }
  const skillRefs = value.spec.skillRefs.map((item) => `${item.id}@${item.version}`);
  if (new Set(skillRefs).size !== skillRefs.length) {
    context.addIssue({ code: 'custom', path: ['spec', 'skillRefs'], message: 'duplicate skill reference' });
  }
});

export type SkillManifest = z.infer<typeof skillManifestSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type ExtensionManifest = SkillManifest | PluginManifest;

export function parseSkillManifest(input: unknown): SkillManifest {
  return skillManifestSchema.parse(input);
}

export function parsePluginManifest(input: unknown): PluginManifest {
  return pluginManifestSchema.parse(input);
}

function canonicalPluginJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalPluginJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalPluginJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  throw new TypeError('plugin signing payload must be JSON data');
}

/** Deterministic v1 payload for a detached Ed25519 example signature. */
export function pluginSigningPayload(input: unknown): string {
  const { signature: _signature, ...unsigned } = parsePluginManifest(input);
  return canonicalPluginJson(unsigned);
}

/** The caller supplies trusted keys; a manifest's key ID is never trusted by itself. */
export function verifyPluginManifestSignature(input: unknown, trustedKeys: Readonly<Record<string, string>>): boolean {
  try {
    const manifest = parsePluginManifest(input);
    if (!manifest.signature || !Object.hasOwn(trustedKeys, manifest.signature.keyId)) return false;
    const publicKey = createPublicKey(trustedKeys[manifest.signature.keyId]!);
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    return verifySignature(null, Buffer.from(pluginSigningPayload(manifest), 'utf8'), publicKey,
      Buffer.from(manifest.signature.value, 'base64url'));
  } catch {
    return false;
  }
}

export function parseExtensionManifest(input: unknown): ExtensionManifest {
  const kind = input && typeof input === 'object' && 'kind' in input ? input.kind : undefined;
  if (kind === 'Skill') return parseSkillManifest(input);
  if (kind === 'Plugin') return parsePluginManifest(input);
  throw new TypeError('extension kind must be Skill or Plugin');
}

/** Stores exact immutable versions; a different version is a separate catalog entry. */
export class ExtensionCatalog {
  private readonly entries = new Map<string, ExtensionManifest>();

  register(input: unknown): ExtensionManifest {
    const parsed = parseExtensionManifest(input);
    const key = `${parsed.kind}:${parsed.metadata.id}@${parsed.metadata.version}`;
    if (this.entries.has(key)) throw new Error(`extension version already registered: ${key}`);
    const stored = structuredClone(parsed);
    this.entries.set(key, stored);
    return structuredClone(stored);
  }

  get(kind: ExtensionManifest['kind'], id: string, version: string): ExtensionManifest | undefined {
    const result = this.entries.get(`${kind}:${id}@${version}`);
    return result ? structuredClone(result) : undefined;
  }

  list(kind?: ExtensionManifest['kind']): ExtensionManifest[] {
    return [...this.entries.values()]
      .filter((entry) => !kind || entry.kind === kind)
      .sort((a, b) => `${a.kind}:${a.metadata.id}@${a.metadata.version}`.localeCompare(`${b.kind}:${b.metadata.id}@${b.metadata.version}`))
      .map((entry) => structuredClone(entry));
  }
}

export interface CapabilityScopeSet {
  capabilityId: string;
  scopes: readonly string[];
}

export interface CapabilityGrant extends CapabilityScopeSet {}

/** Exact, deny-by-default intersection. Skills are intentionally absent from this API. */
export function resolveCapabilityGrants(input: {
  plugin: PluginManifest;
  published: readonly CapabilityScopeSet[];
  policy: readonly CapabilityScopeSet[];
}): CapabilityGrant[] {
  const parsedPlugin = parsePluginManifest(input.plugin);
  const scopeSets = z.array(requestSchema);
  const publishedList = scopeSets.parse(input.published);
  const policyList = scopeSets.parse(input.policy);
  for (const [label, list] of [['published', publishedList], ['policy', policyList]] as const) {
    if (new Set(list.map((item) => item.capabilityId)).size !== list.length) {
      throw new TypeError(`duplicate ${label} capability`);
    }
  }
  const published = new Map(publishedList.map((item) => [item.capabilityId, new Set(item.scopes)]));
  const policy = new Map(policyList.map((item) => [item.capabilityId, new Set(item.scopes)]));
  return parsedPlugin.spec.requestedCapabilities.flatMap((request) => {
    const publishedScopes = published.get(request.capabilityId);
    const policyScopes = policy.get(request.capabilityId);
    if (!publishedScopes || !policyScopes) return [];
    const scopes = request.scopes.filter((item) => publishedScopes.has(item) && policyScopes.has(item)).sort();
    return scopes.length ? [{ capabilityId: request.capabilityId, scopes }] : [];
  }).sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
}
