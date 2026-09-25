import assert from 'node:assert/strict';
import test from 'node:test';
import type { OntologyBundle } from '../../contracts/src/index.js';
import { createReleaseManifest } from '../../ontology-kernel/src/index.js';
import {
  createOntologyToolRegistry, projectPublishedOntologyCapabilities,
  ToolUnavailableError, UnpublishedOntologyError,
  type PublishedOntologySnapshot, type ToolContext, type TrustedReleaseStatus,
} from '../src/index.js';

const bundle: OntologyBundle = {
  schemaVersion: '2.0', id: 'acme.ops', namespace: 'acme.ops', version: '1.0.0', name: 'Operations',
  sources: [], values: [{ id: 'value.sku', name: 'SKU', kind: 'string' }],
  sharedProperties: [], objects: [{ id: 'object.stockItem', name: 'Stock item', primaryKey: 'sku',
    properties: [{ id: 'sku', valueTypeId: 'value.sku', required: true }] }],
  relations: [], interfaces: [], rules: [], events: [], policies: [],
  actions: [{ id: 'action.reserve', name: 'Reserve stock', input: [{ id: 'sku', valueTypeId: 'value.sku', required: true }],
    targetObjectTypeId: 'object.stockItem', objectIdParameterId: 'sku',
    approval: 'always', risk: 'medium' }],
  functions: [
    { id: 'function.lookup', name: 'Find stock', input: [{ id: 'sku', valueTypeId: 'value.sku', required: true }],
      execution: { kind: 'service', ref: 'inventory.lookup' }, sideEffect: 'pure' },
    { id: 'function.mutate', name: 'Mutating function', input: [],
      execution: { kind: 'service', ref: 'inventory.mutate' }, sideEffect: 'effectful' },
  ],
};
const release = createReleaseManifest(bundle, '2026-09-26T00:00:00.000Z');
const snapshot: PublishedOntologySnapshot = {
  tenantId: 'tenant-a', bundle, release,
  capabilities: [
    { id: 'action.reserve', kind: 'action', scopes: ['inventory:write'] },
    { id: 'function.lookup', kind: 'function', scopes: ['inventory:read'] },
  ],
};
const context: ToolContext = {
  tenantId: 'tenant-a', actorId: 'alice', runId: 'run-1', releaseId: release.releaseId,
  scopes: ['inventory:read', 'inventory:write'],
  grants: [
    { capabilityId: 'action.reserve', scopes: ['inventory:write'] },
    { capabilityId: 'function.lookup', scopes: ['inventory:read'] },
  ],
};

test('projection requires a bound release and explicit pure capability publication', () => {
  const tools = projectPublishedOntologyCapabilities(snapshot);
  assert.equal(tools.length, 2);
  assert.equal(tools[0]!.definition.name < tools[1]!.definition.name, true);
  assert.equal(tools.find((tool) => tool.definition.kind === 'action-preview')?.definition.annotations.readOnlyHint, true);
  assert.throws(() => projectPublishedOntologyCapabilities({ ...snapshot, release: { ...release, bundleHash: `sha256:${'0'.repeat(64)}` } }), UnpublishedOntologyError);
  assert.throws(() => projectPublishedOntologyCapabilities({ ...snapshot, capabilities: [
    { id: 'function.mutate', kind: 'function', scopes: ['inventory:write'] },
  ] }), /effectful function/);
  assert.deepEqual(projectPublishedOntologyCapabilities({ ...snapshot, capabilities: [] }), []);
});

test('discovery and invocation both enforce caller scopes and effective grants', async () => {
  let queries = 0;
  let previews = 0;
  const activeStatus: TrustedReleaseStatus = { tenantId: 'tenant-a', releaseId: release.releaseId,
    bundleHash: release.bundleHash, state: 'active' };
  const registry = createOntologyToolRegistry({ getPublishedSnapshot: () => snapshot }, {
    async queryFunction(_context, _definition, input) { queries += 1; return { sku: input.sku, available: 7 }; },
    async previewAction(_context, _definition, input, key) { previews += 1; return { sku: input.sku, idempotencyKey: key, approval: 'required' }; },
  }, { getStatus: () => activeStatus });
  const tools = await registry.listTools(context);
  const query = tools.find((tool) => tool.kind === 'query')!;
  const preview = tools.find((tool) => tool.kind === 'action-preview')!;
  assert.equal(tools.length, 2);
  assert.deepEqual((await registry.callTool(context, query.name, { sku: 'S-1' })).structuredContent, { sku: 'S-1', available: 7 });
  assert.deepEqual((await registry.callTool(context, preview.name, { input: { sku: 'S-1' }, idempotencyKey: 'request-1' })).structuredContent,
    { sku: 'S-1', idempotencyKey: 'request-1', approval: 'required' });
  assert.equal(queries, 1);
  assert.equal(previews, 1);
  assert.equal((await registry.callTool(context, query.name, { sku: 1 })).isError, true);
  assert.equal(queries, 1);

  const restricted = { ...context, grants: [{ capabilityId: 'function.lookup', scopes: ['inventory:read'] }] };
  assert.deepEqual((await registry.listTools(restricted)).map((tool) => tool.kind), ['query']);
  await assert.rejects(registry.callTool(restricted, preview.name, { input: { sku: 'S-1' }, idempotencyKey: 'request-2' }), ToolUnavailableError);
  assert.equal(previews, 1);
  await assert.rejects(registry.listTools({ ...context, releaseId: 'draft' }), UnpublishedOntologyError);
  await assert.rejects(registry.listTools({ ...context, tenantId: 'tenant-b' }), UnpublishedOntologyError);
});

test('trusted release activation gates discovery and invocation after revocation', async () => {
  let status: TrustedReleaseStatus | undefined = { tenantId: 'tenant-a', releaseId: release.releaseId,
    bundleHash: release.bundleHash, state: 'active' };
  let previews = 0;
  const registry = createOntologyToolRegistry({ getPublishedSnapshot: () => snapshot }, {
    async queryFunction() { return {}; },
    async previewAction() { previews += 1; return {}; },
  }, { getStatus: () => status });
  const preview = (await registry.listTools(context)).find((tool) => tool.kind === 'action-preview')!;
  status = { ...status!, state: 'revoked' };
  await assert.rejects(registry.listTools(context), UnpublishedOntologyError);
  await assert.rejects(registry.callTool(context, preview.name, { input: { sku: 'S-1' }, idempotencyKey: 'request-3' }), UnpublishedOntologyError);
  assert.equal(previews, 0);
  status = { ...status, state: 'inactive' };
  await assert.rejects(registry.listTools(context), UnpublishedOntologyError);
  status = { ...status, state: 'active', bundleHash: `sha256:${'f'.repeat(64)}` };
  await assert.rejects(registry.listTools(context), UnpublishedOntologyError);
  status = { ...status, bundleHash: release.bundleHash, tenantId: 'other-tenant' };
  await assert.rejects(registry.listTools(context), UnpublishedOntologyError);
  status = undefined;
  await assert.rejects(registry.listTools(context), UnpublishedOntologyError);

  let checks = 0;
  const changing = createOntologyToolRegistry({ getPublishedSnapshot: () => snapshot }, {
    async queryFunction() { return {}; },
    async previewAction() { previews += 1; return {}; },
  }, { getStatus: () => ({ tenantId: 'tenant-a', releaseId: release.releaseId,
    bundleHash: release.bundleHash, state: ++checks < 3 ? 'active' : 'revoked' }) });
  await assert.rejects(changing.callTool(context, preview.name, { input: { sku: 'S-1' }, idempotencyKey: 'request-4' }), UnpublishedOntologyError);
  assert.equal(checks, 3);
  assert.equal(previews, 0);
});
