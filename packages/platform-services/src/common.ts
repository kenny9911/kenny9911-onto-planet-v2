import { createHash } from 'node:crypto';
import { canonicalize } from '../../ontology-kernel/src/index.js';
import { PlatformError, type EntityRecord, type Principal } from '../../platform-contracts/src/index.js';

export const hash = (value: unknown): `sha256:${string}` => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
export function nonempty(value: unknown, name: string, max = 1_000_000): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new PlatformError(400, 'invalid_input', `${name} must be nonempty text of at most ${max} bytes`);
  return value.trim();
}
export function canRead(principal: Principal, entity: EntityRecord): boolean {
  if (entity.tenantId !== principal.tenantId || !principal.scopes.includes('read')) return false;
  if (entity.data.access !== undefined && (!entity.data.access || typeof entity.data.access !== 'object' || Array.isArray(entity.data.access))) return false;
  const access = record(entity.data.access);
  if (access.roles !== undefined && !strings(access.roles).includes(principal.role)) return false;
  if (access.actorIds !== undefined && !strings(access.actorIds).includes(principal.actorId)) return false;
  if (access.requiredScopes !== undefined && (!Array.isArray(access.requiredScopes) || access.requiredScopes.some(scope=>typeof scope!=='string'||!principal.scopes.includes(scope)))) return false;
  return entity.kind !== 'objects' || entity.data.objectTypeId !== 'PurchaseOrder' || principal.scopes.includes('order:read');
}
export function visibleObject(principal: Principal, entity: EntityRecord): EntityRecord | undefined {
  if (!canRead(principal, entity)) return undefined;
  const result = structuredClone(entity);
  const properties = record(result.data.properties);
  const fieldRoles = record(record(result.data.access).fieldRoles);
  for (const [key, roles] of Object.entries(fieldRoles)) if (!strings(roles).includes(principal.role)) delete properties[key];
  result.data.properties = properties;
  // Access control metadata is not business context.
  delete result.data.access;
  return result;
}

export interface ResourceReference { kind: EntityRecord['kind']; id: string; revision: number }
export interface SemanticChange { path: string; kind: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }
export function semanticDiff(before: unknown, after: unknown, path = '$'): SemanticChange[] {
  if (canonicalize(before) === canonicalize(after)) return [];
  const left = record(before), right = record(after);
  if (Array.isArray(before) && Array.isArray(after) && [...before, ...after].every(item => typeof record(item).id === 'string')) {
    const a = new Map(before.map(item => [String(record(item).id), item]));
    const b = new Map(after.map(item => [String(record(item).id), item]));
    return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap(id => !a.has(id)
      ? [{path: `${path}[${id}]`, kind: 'added' as const, after: b.get(id)}]
      : !b.has(id) ? [{path: `${path}[${id}]`, kind: 'removed' as const, before: a.get(id)}]
      : semanticDiff(a.get(id), b.get(id), `${path}[${id}]`));
  }
  if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap(key => !Object.hasOwn(left, key)
      ? [{path: `${path}.${key}`, kind: 'added' as const, after: right[key]}]
      : !Object.hasOwn(right, key) ? [{path: `${path}.${key}`, kind: 'removed' as const, before: left[key]}]
      : semanticDiff(left[key], right[key], `${path}.${key}`));
  }
  return [{path, kind: 'changed', before, after}];
}
