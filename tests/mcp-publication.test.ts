import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../apps/api/src/mcp.js';
import type { OntologyBundle } from '../packages/contracts/src/index.js';
import { createReleaseManifest } from '../packages/ontology-kernel/src/index.js';
import { projectPublishedOntologyCapabilities, type PublishedCapability } from '../packages/mcp-gateway/src/index.js';
import { createSeedData, type PlatformServices } from '../packages/platform-services/src/index.js';
import type { PlatformRuntime } from '../packages/platform-runtime/src/index.js';
import { roleScopes, type EntityRecord, type PlatformStore, type Principal } from '../packages/platform-contracts/src/index.js';

const principal:Principal={tenantId:'publication-test',actorId:'reader',name:'Reader',email:'reader@example.test',role:'viewer',scopes:roleScopes.viewer};
const bundle=createSeedData(principal,new Date('2026-09-26T00:00:00.000Z')).find(item=>item.kind==='ontologies')!.data.bundle as OntologyBundle;
const ontologyRelease=createReleaseManifest(bundle,'2026-09-26T00:00:00.000Z');
const publications:PublishedCapability[]=[{id:'lookupOrder',kind:'function',scopes:['read']}];
const toolName=projectPublishedOntologyCapabilities({tenantId:principal.tenantId,bundle,release:ontologyRelease,capabilities:publications})[0]!.definition.name;
const release:EntityRecord={id:'cross-asset-release-1',tenantId:principal.tenantId,kind:'releases',name:'Published procurement',state:'active',revision:2,createdAt:'2026-09-26T00:00:00.000Z',updatedAt:'2026-09-26T00:00:00.000Z',createdBy:'owner',data:{manifestHash:'cross-asset-hash-1',manifest:{ontology:{release:ontologyRelease,mcpCapabilities:publications}}}};

function callRequest(){return new Request('http://localhost:4100/mcp',{method:'POST',headers:{host:'localhost:4100',origin:'http://localhost:4100','content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call','Mcp-Name':toolName},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:toolName,arguments:{orderId:'PO-2026-001'},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'publication-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}})});}

for(const change of ['unchanged','id','manifestHash'] as const)test(`MCP execution rechecks exact cross-asset publication ${change}`,async()=>{
  let checks=0,queries=0;
  // The fifth status check is immediately before execution, after SDK discovery and argument validation.
  const store={async list(){checks++;return [checks>=5&&change!=='unchanged'?{...release,...(change==='id'?{id:'cross-asset-release-2'}:{}),data:{...release.data,...(change==='manifestHash'?{manifestHash:'cross-asset-hash-2'}:{})}}:release];}} as unknown as PlatformStore;
  const services={async activeOntology(){return {bundle,release};},async queryObjects(){queries++;return [{id:'PO-2026-001'}];}} as unknown as PlatformServices;
  const response=await handleMcp(callRequest(),{principal,store,services,runtime:{} as PlatformRuntime,allowedHosts:['localhost']});
  assert.equal(response.status,200);
  const raw=await response.text();
  const value=JSON.parse(response.headers.get('content-type')?.includes('text/event-stream')?raw.split('\n').find(line=>line.startsWith('data: '))!.slice(6):raw) as {error?:unknown;result?:{isError?:boolean}};
  assert.ok(checks>=5);
  assert.equal(queries,change==='unchanged'?1:0);
  if(change==='unchanged')assert.equal(value.result?.isError??false,false);
  else assert.ok(value.error||value.result?.isError,raw);
});
