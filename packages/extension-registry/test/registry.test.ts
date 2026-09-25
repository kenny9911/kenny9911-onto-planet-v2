import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ExtensionCatalog, parsePluginManifest, parseSkillManifest, resolveCapabilityGrants,
  verifyPluginManifestSignature } from '../src/index.js';

const metadata = { id: 'acme.workflow', version: '1.2.3', name: 'Workflow' };
const skill = {
  apiVersion: 'ontoplanet.io/v1', kind: 'Skill', metadata,
  spec: { instructionFile: 'SKILL.md', suggestedCapabilities: ['orders.read'] },
};
const plugin = {
  apiVersion: 'ontoplanet.io/v1', kind: 'Plugin', metadata,
  spec: {
    runtime: { kind: 'in-process', module: '@acme/workflow' },
    requestedCapabilities: [{ capabilityId: 'orders.read', scopes: ['orders:read', 'orders:write'] }],
    skillRefs: [{ id: 'acme.workflow', version: '1.2.3' }],
  },
};

test('manifest validation is versioned, strict, and rejects path traversal', () => {
  assert.equal(parseSkillManifest(skill).metadata.version, '1.2.3');
  assert.throws(() => parseSkillManifest({ ...skill, spec: { ...skill.spec, instructionFile: '../secret' } }));
  assert.throws(() => parseSkillManifest({ ...skill, metadata: { ...metadata, version: 'latest' } }));
  assert.throws(() => parseSkillManifest({ ...skill, metadata: { ...metadata, version: '1.2.3-alpha..1' } }));
  assert.throws(() => parseSkillManifest({ ...skill, spec: { ...skill.spec, authority: ['orders:write'] } }));
  assert.throws(() => parsePluginManifest({ ...plugin, spec: { ...plugin.spec, requestedCapabilities: [
    plugin.spec.requestedCapabilities[0], plugin.spec.requestedCapabilities[0],
  ] } }));
  assert.throws(() => parsePluginManifest({ ...plugin, spec: { ...plugin.spec, runtime: { kind: 'in-process', module: '../secret' } } }));
  for (const module of ['@acme/workflow/../../secret', 'workflow/../secret', '@acme/workflow/./entry']) {
    assert.throws(() => parsePluginManifest({ ...plugin, spec: { ...plugin.spec, runtime: { kind: 'in-process', module } } }));
  }
});

test('bundled reusable skill manifests validate and request no authority', () => {
  for (const directory of ['ontology-modeler', 'enterprise-operator']) {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'skills', directory, 'manifest.json'), 'utf8')) as unknown;
    const parsed = parseSkillManifest(manifest);
    assert.deepEqual(parsed.spec.suggestedCapabilities, []);
    assert.ok(readFileSync(join(process.cwd(), 'skills', directory, parsed.spec.instructionFile), 'utf8').length > 0);
  }
});

test('catalog stores exact versions and isolates its stored manifests', () => {
  const catalog = new ExtensionCatalog();
  const registered = catalog.register(skill);
  registered.metadata.name = 'mutated';
  assert.equal(catalog.get('Skill', metadata.id, metadata.version)?.metadata.name, 'Workflow');
  assert.throws(() => catalog.register(skill), /already registered/);
  catalog.register({ ...skill, metadata: { ...metadata, version: '1.3.0' } });
  assert.equal(catalog.list('Skill').length, 2);
});

test('plugin grant is limited by publication and policy; skill has no grant surface', () => {
  const grants = resolveCapabilityGrants({
    plugin: parsePluginManifest(plugin),
    published: [{ capabilityId: 'orders.read', scopes: ['orders:read'] }],
    policy: [{ capabilityId: 'orders.read', scopes: ['orders:read', 'orders:write'] }],
  });
  assert.deepEqual(grants, [{ capabilityId: 'orders.read', scopes: ['orders:read'] }]);
  assert.deepEqual(resolveCapabilityGrants({ plugin: parsePluginManifest(plugin), published: [], policy: [] }), []);
  assert.throws(() => resolveCapabilityGrants({ plugin: parsePluginManifest(plugin), published: [
    { capabilityId: 'orders.read', scopes: ['orders:read'] },
    { capabilityId: 'orders.read', scopes: ['orders:write'] },
  ], policy: [] }), /duplicate published capability/);
  assert.equal('requestedCapabilities' in parseSkillManifest(skill).spec, false);
});

test('signed mock ERP manifest verifies and its adapter only previews local effects', async () => {
  const directory = join(process.cwd(), 'plugins', 'mock-erp');
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as unknown;
  const parsed = parsePluginManifest(manifest);
  const publicKey = readFileSync(join(directory, 'public-key.pem'), 'utf8');
  assert.equal(verifyPluginManifestSignature(parsed, { 'ontoplanet.example-key': publicKey }), true);
  assert.equal(verifyPluginManifestSignature(parsed, {}), false);
  assert.equal(verifyPluginManifestSignature({ ...parsed, metadata: { ...parsed.metadata, version: '0.1.1' } },
    { 'ontoplanet.example-key': publicKey }), false);
  assert.deepEqual(parsed.spec.skillRefs.map((item) => item.id).sort(),
    ['ontoplanet.enterprise-operator', 'ontoplanet.ontology-modeler']);
  assert.deepEqual(resolveCapabilityGrants({ plugin: parsed,
    published: [{ capabilityId: 'function.lookup', scopes: ['inventory:read'] },
      { capabilityId: 'action.reserve', scopes: ['inventory:write'] }],
    policy: [{ capabilityId: 'function.lookup', scopes: ['inventory:read'] }],
  }), [{ capabilityId: 'function.lookup', scopes: ['inventory:read'] }]);

  assert.equal(parsed.spec.runtime.kind, 'in-process');
  if (parsed.spec.runtime.kind !== 'in-process') throw new Error('expected in-process example');
  const adapterModule = await import(pathToFileURL(join(directory, parsed.spec.runtime.module)).href) as {
    createMockErpAdapter: (stock: Record<string, number>) => {
      lookupStock: (input: { sku: string }) => { available: number };
      previewReserve: (input: { sku: string; quantity: number }, key: string) => { canApply: boolean };
    };
  };
  const adapter = adapterModule.createMockErpAdapter({ 'S-1': 5 });
  assert.equal(adapter.previewReserve({ sku: 'S-1', quantity: 2 }, 'request-1').canApply, true);
  assert.equal(adapter.lookupStock({ sku: 'S-1' }).available, 5);
  assert.equal(adapter.previewReserve({ sku: 'S-1', quantity: 6 }, 'request-2').canApply, false);
  assert.equal('execute' in adapter, false);
});
