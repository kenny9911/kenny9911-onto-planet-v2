import type { OntologyBundle } from '../../contracts/src/index.js';

export const resourceKinds = ['ontologies', 'knowledge', 'objects', 'connectors', 'contextProfiles', 'agents', 'skills', 'plugins', 'applications', 'evaluations', 'releases', 'runs', 'proposals'] as const;
export type ResourceKind = typeof resourceKinds[number];
export type Role = 'admin' | 'builder' | 'operator' | 'viewer';
export interface Principal { tenantId: string; actorId: string; name: string; email: string; role: Role; scopes: string[] }
export interface EntityRecord<T = Record<string, unknown>> {
  id: string; tenantId: string; kind: ResourceKind; name: string; state: string; revision: number;
  data: T; createdAt: string; updatedAt: string; createdBy: string;
}
export interface AuditRecord { id: string; tenantId: string; actorId: string; kind: string; subjectId: string; at: string; details: Record<string, unknown> }
export interface JobRecord { id: string; tenantId: string; actorId: string; kind: string; state: 'queued' | 'running' | 'completed' | 'failed'; payload: Record<string, unknown>; attempt: number; leaseToken?: string; error?: string; createdAt: string }
/** Every operation is tenant-scoped. Revision checks must be atomic in storage. */
export interface PlatformStore {
  list(tenantId: string, kind: ResourceKind): Promise<EntityRecord[]>;
  get(tenantId: string, kind: ResourceKind, id: string): Promise<EntityRecord | undefined>;
  create(principal: Principal, kind: ResourceKind, input: {id?: string; name: string; state?: string; data: Record<string, unknown>}): Promise<EntityRecord>;
  update(principal: Principal, kind: ResourceKind, id: string, expectedRevision: number, patch: {name?: string; state?: string; data?: Record<string, unknown>}): Promise<EntityRecord>;
  remove(principal: Principal, kind: ResourceKind, id: string, expectedRevision: number): Promise<void>;
  audit(principal: Principal, kind: string, subjectId: string, details?: Record<string, unknown>): Promise<void>;
  auditLog(tenantId: string, limit?: number): Promise<AuditRecord[]>;
  enqueue(principal: Principal, kind: string, payload: Record<string, unknown>): Promise<JobRecord>;
  /** Atomically verify this immutable manifest/revision and replace the tenant's active release. */
  activateRelease?(principal: Principal, id: string, expectedRevision: number, manifestHash: string): Promise<EntityRecord>;
}
export interface SessionInfo { user: Principal; csrfToken: string; authMode: 'local' | 'oidc'; tenant: {id: string; name: string} }
export interface BootstrapResponse {
  session: SessionInfo;
  resources: Record<ResourceKind, EntityRecord[]>;
  activeBundle: OntologyBundle | null;
  audit: AuditRecord[];
  approvals: Array<{id: string; name: string; state: string; actorId: string; intentHash: string; summary: string; effects: string[]; idempotencyKey: string; runId?: string; createdAt: string}>;
  health: {database: string; worker: string; model: string; version: string; environment: string};
}
export class PlatformError extends Error { constructor(public status: number, public code: string, message: string) { super(message); this.name = 'PlatformError'; } }
export const roleScopes: Record<Role, string[]> = {
  admin: ['read', 'build', 'operate', 'approve', 'release', 'admin', 'order:read', 'order:write'],
  builder: ['read', 'build', 'order:read'], operator: ['read', 'operate', 'approve', 'order:read', 'order:write'], viewer: ['read', 'order:read'],
};
export function requireScope(principal: Principal, scope: string): void { if (!principal.scopes.includes(scope)) throw new PlatformError(403, 'forbidden', `This operation requires ${scope} permission`); }
