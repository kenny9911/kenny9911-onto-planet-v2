import assert from 'node:assert/strict';
import test from 'node:test';
import type { OntologyBundle } from '../../contracts/src/index.js';
import { createReleaseManifest } from '../../ontology-kernel/src/index.js';
import { createOntologyMcpHttpAdapter, createOntologyToolRegistry, type ToolContext } from '../src/index.js';

const bundle: OntologyBundle = {
  schemaVersion: '2.0', id: 'acme.stock', namespace: 'acme.stock', version: '1.0.0', name: 'Stock',
  sources: [], values: [{ id: 'value.sku', name: 'SKU', kind: 'string' }],
  sharedProperties: [], objects: [{ id: 'object.stockItem', name: 'Stock item', primaryKey: 'sku',
    properties: [{ id: 'sku', valueTypeId: 'value.sku', required: true }] }],
  relations: [], interfaces: [], rules: [], events: [], policies: [], functions: [],
  actions: [{ id: 'action.reserve', name: 'Reserve stock', input: [{ id: 'sku', valueTypeId: 'value.sku', required: true }],
    targetObjectTypeId: 'object.stockItem', objectIdParameterId: 'sku',
    approval: 'always', risk: 'medium' }],
};
const release = createReleaseManifest(bundle, '2026-09-26T00:00:00.000Z');
const context: ToolContext = {
  tenantId: 'acme', actorId: 'alice', releaseId: release.releaseId,
  scopes: ['inventory:write'], grants: [{ capabilityId: 'action.reserve', scopes: ['inventory:write'] }],
};
let previews = 0;
const registry = createOntologyToolRegistry({ getPublishedSnapshot: () => ({
  tenantId: 'acme', bundle, release, capabilities: [{ id: 'action.reserve', kind: 'action', scopes: ['inventory:write'] }],
}) }, {
  async queryFunction() { throw new Error('no query published'); },
  async previewAction(_context, _definition, input, key, boundRelease) {
    previews += 1;
    return { actionId: 'action.reserve', input, idempotencyKey: key, bundleHash: boundRelease.bundleHash };
  },
}, { getStatus: () => ({ tenantId: 'acme', releaseId: release.releaseId,
  bundleHash: release.bundleHash, state: 'active' }) });
const adapter = createOntologyMcpHttpAdapter(registry, {
  allowedHosts: ['localhost'], allowedOriginHostnames: ['localhost'],
});

async function rpcBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text.split('\n').find((line) => line.startsWith('data: '));
    if (!data) throw new Error(`MCP response has no SSE data: ${text}`);
    return JSON.parse(data.slice(6)) as Record<string, unknown>;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function rpc(method: string, params: Record<string, unknown> = {}, origin = 'http://localhost:3000'): Request {
  const headers: Record<string, string> = {
    host: 'localhost:3000', origin, 'content-type': 'application/json',
    accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
  };
  if (method === 'tools/call') headers['Mcp-Name'] = String(params.name);
  return new Request('http://localhost:3000/mcp', {
    method: 'POST', headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'gateway-test', version: '1.0.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
}

test('SDK Streamable HTTP adapter lists scoped tools and serves only action preview', async () => {
  const listed = await adapter.fetch(rpc('tools/list'), context);
  assert.equal(listed.status, 200);
  const listBody = await rpcBody(listed) as { result: { tools: { name: string; inputSchema: unknown }[] } };
  assert.equal(listBody.result.tools.length, 1);
  const tool = listBody.result.tools[0]!;
  assert.equal(tool.name.startsWith('ontology.preview.'), true);
  assert.ok(tool.inputSchema);

  const called = await adapter.fetch(rpc('tools/call', {
    name: tool.name, arguments: { input: { sku: 'S-1' }, idempotencyKey: 'request-1' },
  }), context);
  assert.equal(called.status, 200);
  const callBody = await rpcBody(called) as { result: { isError?: boolean; structuredContent?: { bundleHash: string } } };
  assert.equal(callBody.result.isError ?? false, false);
  assert.equal(callBody.result.structuredContent?.bundleHash, release.bundleHash);
  assert.equal(previews, 1);

  const forbidden = await adapter.fetch(rpc('tools/list'), { ...context, grants: [] });
  const forbiddenBody = await rpcBody(forbidden) as { result: { tools: unknown[] } };
  assert.deepEqual(forbiddenBody.result.tools, []);
  const rejectedOrigin = await adapter.fetch(rpc('tools/list', {}, 'https://evil.example'), context);
  assert.equal(rejectedOrigin.status, 403);
  const missingContext = await adapter.fetch(rpc('tools/list'), undefined as unknown as ToolContext);
  assert.equal(missingContext.status, 401);
});
