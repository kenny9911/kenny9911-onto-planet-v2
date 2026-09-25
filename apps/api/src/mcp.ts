import {createOntologyMcpHttpAdapter,createOntologyToolRegistry,type PublishedCapability} from '../../../packages/mcp-gateway/src/index.js';
import type {PlatformRuntime} from '../../../packages/platform-runtime/src/index.js';
import type {PlatformServices,PlatformReleaseManifest} from '../../../packages/platform-services/src/index.js';
import {PlatformError,requireScope,type PlatformStore,type Principal} from '../../../packages/platform-contracts/src/index.js';
import type {JsonValue} from '../../../packages/action-gateway/src/index.js';

export async function handleMcp(request:Request,options:{principal:Principal;store:PlatformStore;services:PlatformServices;runtime:PlatformRuntime;allowedHosts:string[]}):Promise<Response>{
 const {principal,services,store,runtime}=options;
 const active=await services.activeOntology(principal);if(!active.release)throw new PlatformError(409,'release_required','Activate a reviewed release before connecting an MCP client');
 const publicationReleaseId=active.release.id,publicationManifestHash=active.release.data.manifestHash;
 const manifest=active.release.data.manifest as unknown as PlatformReleaseManifest;
 const publications=((manifest.ontology as unknown as {mcpCapabilities?:PublishedCapability[]}).mcpCapabilities??[]);
 const registry=createOntologyToolRegistry({getPublishedSnapshot:()=>({tenantId:principal.tenantId,bundle:active.bundle,release:manifest.ontology.release,capabilities:publications})},{
  queryFunction:async(context,definition,input)=>{
   if(context.actorId!==principal.actorId||context.tenantId!==principal.tenantId)throw new PlatformError(403,'identity_mismatch','MCP identity changed');
   if(definition.execution.ref==='object-service.lookupOrder'){requireScope(principal,'order:read');return services.queryObjects(principal,{objectTypeId:'PurchaseOrder',filters:[{property:'id',op:'eq',value:String(input.orderId??'')}],limit:1});}
   if(definition.execution.ref==='object-service.query')return services.queryObjects(principal,{...(typeof input.objectTypeId==='string'?{objectTypeId:input.objectTypeId}:{}),...(typeof input.search==='string'?{search:input.search}:{}),limit:100});
   if(definition.execution.ref==='context-service.inspect')return services.inspectContext(principal,{prompt:String(input.prompt??'')});
   throw new PlatformError(422,'function_unregistered','This ontology function has no registered server implementation');
  },
  previewAction:async(_context,definition,input,key)=>{const record=await runtime.previewAction(principal,{actionId:definition.id,args:input as JsonValue,requestId:key});return {intentId:record.intent.id,state:record.state,intentHash:record.intent.intentHash,summary:record.preview?.summary,effects:record.preview?.effects};},
 },{getStatus:async(tenantId,releaseId)=>{const current=(await store.list(tenantId,'releases')).find(r=>r.state==='active');const currentManifest=current?.data.manifest as PlatformReleaseManifest|undefined;return current?.id===publicationReleaseId&&current.data.manifestHash===publicationManifestHash&&currentManifest?.ontology.release.releaseId===releaseId?{tenantId,releaseId,bundleHash:currentManifest.ontology.release.bundleHash,state:'active'}:undefined;}});
 const context={tenantId:principal.tenantId,actorId:principal.actorId,releaseId:manifest.ontology.release.releaseId,scopes:principal.scopes,grants:publications.filter(p=>p.scopes.every(s=>principal.scopes.includes(s))).map(p=>({capabilityId:p.id,scopes:p.scopes}))};
 return createOntologyMcpHttpAdapter(registry,{allowedHosts:options.allowedHosts,allowedOriginHostnames:options.allowedHosts}).fetch(request,context);
}
