import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve,extname } from 'node:path';
import { z,ZodError } from 'zod';
import { IdentityService } from '../../../packages/identity/src/index.js';
import { PostgresStore,PgIntentStore,PgCheckpointStore,pg } from '../../../packages/persistence/src/index.js';
import { PlatformServices,seedPlatform,canRead,visibleObject,type PlatformReleaseManifest } from '../../../packages/platform-services/src/index.js';
import { PlatformRuntime } from '../../../packages/platform-runtime/src/index.js';
import { PlatformError,requireScope,resourceKinds,type BootstrapResponse,type EntityRecord,type PlatformStore,type Principal,type ResourceKind } from '../../../packages/platform-contracts/src/index.js';
import { handleMcp } from './mcp.js';
import { HttpOntologyGenerationPort } from './ontology-model.js';
import type {AppConfig} from './config.js';

const name=z.string().trim().min(1).max(160),revision=z.number().int().positive(),data=z.record(z.string(),z.unknown());
const protectedKinds=new Set<ResourceKind>(['runs','releases','evaluations']);
const adminKinds=new Set<ResourceKind>(['connectors','plugins']);
function json(value:unknown,status=200,headers:Record<string,string>={}){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8',...headers}});}
async function body<T>(request:Request,schema:z.ZodType<T>):Promise<T>{if(!request.headers.get('content-type')?.includes('application/json'))throw new PlatformError(415,'json_required','Send an application/json request');let value:unknown;try{const text=await request.text();if(Buffer.byteLength(text)>1_048_576)throw new PlatformError(413,'body_too_large','Request body exceeds 1 MB');value=JSON.parse(text);}catch(error){if(error instanceof PlatformError)throw error;throw new PlatformError(400,'invalid_json','Request body is not valid JSON');}return schema.parse(value);}
function safeResourceData(value:unknown,depth=0){if(depth>30)throw new PlatformError(400,'data_depth','Resource data is nested too deeply');if(value&&typeof value==='object'){for(const [k,v] of Object.entries(value)){if(/^(password|apiKey|accessToken|refreshToken|clientSecret|privateKey)$/i.test(k))throw new PlatformError(400,'secret_reference_required','Use a server-configured secret reference instead of storing credentials');if(['__proto__','constructor','prototype'].includes(k))throw new PlatformError(400,'unsafe_key','Resource contains a reserved property');safeResourceData(v,depth+1);}}}
function isBuilder(p:Principal){return p.scopes.includes('build')||p.scopes.includes('admin');}
async function releasedAssetsVisible(principal:Principal,manifest:PlatformReleaseManifest|undefined,store:PlatformStore):Promise<boolean>{
 if(!manifest?.ontology?.id||!Array.isArray(manifest.resources))return false;
 const ontology=await store.get(principal.tenantId,'ontologies',manifest.ontology.id);
 if(!ontology||!canRead(principal,ontology))return false;
 const visible=await Promise.all(manifest.resources.map(async asset=>{
  if(!resourceKinds.includes(asset.kind)||['objects','ontologies','runs','releases','evaluations','proposals'].includes(asset.kind))return false;
  const current=await store.get(principal.tenantId,asset.kind,asset.id);
  return !!current&&canRead(principal,current)&&canRead(principal,{...current,data:asset.data});
 }));
 return visible.every(Boolean);
}
async function resourceVisible(principal:Principal,item:EntityRecord,store:PlatformStore):Promise<EntityRecord|undefined> {
 if(!canRead(principal,item))return undefined;
 if(item.kind==='objects')return visibleObject(principal,item);
 if(item.kind==='runs'&&item.createdBy!==principal.actorId&&!principal.scopes.includes('admin'))return undefined;
 if(item.kind==='runs'){
  const release=typeof item.data.releaseId==='string'?await store.get(principal.tenantId,'releases',item.data.releaseId):undefined;
  if(!release||!canRead(principal,release)||!await releasedAssetsVisible(principal,release.data.manifest as PlatformReleaseManifest|undefined,store))return {...item,data:{agentId:item.data.agentId,releaseId:item.data.releaseId,actorId:item.data.actorId,redacted:true}};
 }
 if(item.kind==='connectors'&&!isBuilder(principal))return {...item,data:{type:item.data.type,status:item.state,system:item.data.system}};
 if(item.kind==='evaluations'){
  const ontology=typeof item.data.ontologyId==='string'?await store.get(principal.tenantId,'ontologies',item.data.ontologyId):undefined;
  if(!ontology||!canRead(principal,ontology))return undefined;
 }
 if(item.kind==='releases'){
  const manifest=item.data.manifest as PlatformReleaseManifest|undefined;
  if(!manifest?.ontology?.id||!Array.isArray(manifest.resources))return undefined;
  const ontology=await store.get(principal.tenantId,'ontologies',manifest.ontology.id);
  if(!ontology||!canRead(principal,ontology))return undefined;
  const summary={...item,data:{manifestHash:item.data.manifestHash,gates:item.data.gates,sampleOnly:item.data.sampleOnly}};
  if(!isBuilder(principal))return summary;
  // Immutable snapshots retain historical ACLs. Also honor current ACL revocation.
  if(!await releasedAssetsVisible(principal,manifest,store))return summary;
 }
 return item;
}

export async function createPlatformApp(config:AppConfig,pool=new pg.Pool({connectionString:config.databaseUrl,max:16})) {
 const store=new PostgresStore(pool);await store.migrate();
 const identity=new IdentityService(store,{secureCookies:config.appOrigin.startsWith('https:'),setupToken:config.setupToken,oidc:config.oidc});
 const services=new PlatformServices(store,{ontologyModel:config.model.mode==='sandbox'?undefined:new HttpOntologyGenerationPort(config.model)});
 const intents=new PgIntentStore(pool);
 const runtime=new PlatformRuntime({store,intents,auditEvidence:(tenantId,id)=>store.auditEvidence(tenantId,id),checkpoints:new PgCheckpointStore(pool),principalLookup:(tenantId,actorId)=>store.principal(tenantId,actorId),operator:{allowedOrigins:config.operatorOrigins,allowLocalSandbox:config.allowLocalSandbox,allowedPrivateOrigins:config.operatorPrivateOrigins,secret:(ref:string)=>{const match=/^(?:env:|secret:\/\/env\/)([A-Z][A-Z0-9_]+)$/.exec(ref);return match?process.env[match[1]!]:undefined;}},model:config.model,context:async(principal,prompt,maxBytes,released)=>{if(!released)return [];const pack=await services.inspectReleasedContext(principal,{prompt,...released});let size=0;return pack.items.filter(item=>{size+=Buffer.byteLength(item.text);return size<=maxBytes;}).map(item=>({tenantId:principal.tenantId,id:item.id,version:item.sourceRevision,text:item.text,provenance:JSON.stringify(item.source)}));}});
 const allowedOrigins=new Set([config.appOrigin,...(!config.production?['http://localhost:5173','http://127.0.0.1:5173','http://localhost:4100','http://127.0.0.1:4100']:[])]);
 const allowedHosts=new Set([...allowedOrigins].map(o=>new URL(o).hostname));
 async function list(principal:Principal,kind:ResourceKind){return (await Promise.all((await store.list(principal.tenantId,kind)).map(item=>resourceVisible(principal,item,store)))).filter((item):item is EntityRecord=>!!item);}
 async function fetch(request:Request):Promise<Response>{
  const requestId=randomUUID();let response:Response;
  try{
   const url=new URL(request.url),path=url.pathname,method=request.method;
   if(!allowedHosts.has(url.hostname))throw new PlatformError(403,'host_denied','Request host is not configured for this installation');
   const origin=request.headers.get('origin');if(origin&&!allowedOrigins.has(origin))throw new PlatformError(403,'origin_denied','Request origin is not configured for this installation');
   if(method==='OPTIONS')return new Response(null,{status:204,headers:{...(origin?{'access-control-allow-origin':origin,'access-control-allow-credentials':'true'}:{}),'access-control-allow-headers':'Content-Type, X-CSRF-Token, Authorization, MCP-Protocol-Version','access-control-allow-methods':'GET, POST, PUT, DELETE, OPTIONS'}});
   if(path==='/health'){await pool.query('SELECT 1');response=json({status:'ok',database:'connected',version:'0.2.0'});}
   else if(path==='/api/setup'&&method==='GET')response=json({required:await identity.setupRequired(),oidcEnabled:identity.oidcEnabled(),setupTokenRequired:!!config.setupToken});
   else if(path==='/api/setup'&&method==='POST'){
    await identity.checkRateLimit('setup');const input=await body(request,z.object({name,email:z.string(),password:z.string(),workspace:name,setupToken:z.string().optional()}).strict());const result=await identity.setup(input);await seedPlatform(store,result.session.user);response=json(result.session,201);result.cookies.forEach(cookie=>response.headers.append('set-cookie',cookie));
   }
   else if(path==='/api/login'&&method==='POST'){
    const input=await body(request,z.object({email:z.string().max(254),password:z.string().max(256)}).strict());await identity.checkRateLimit(`login:${input.email.toLowerCase()}`);const result=await identity.login(input.email,input.password);response=json(result.session);result.cookies.forEach(cookie=>response.headers.append('set-cookie',cookie));
   }
   else if(path==='/api/auth/oidc/start'&&method==='GET'){const start=await identity.oidcStart();response=new Response(null,{status:302,headers:{location:start.url,'set-cookie':start.cookie}});}
   else if(path==='/api/auth/oidc/callback'&&method==='GET'){const result=await identity.oidcCallback(request);response=new Response(null,{status:302,headers:{location:'/'}});result.cookies.forEach(cookie=>response.headers.append('set-cookie',cookie));}
   else if(path.startsWith('/api/')||path==='/mcp'){
    const auth=await identity.authenticate(request);if(!auth)throw new PlatformError(401,'authentication_required','Sign in to access this workspace');const principal=auth.principal;requireScope(principal,'read');
    if(!['GET','HEAD'].includes(method)&&path!=='/mcp')identity.assertCsrf(request,auth);
    if(path==='/api/session'&&method==='GET')response=json(auth.session??await identity.sessionInfo(principal));
    else if(path==='/api/logout'&&method==='POST'){response=json({ok:true});(await identity.logout(auth)).forEach(cookie=>response.headers.append('set-cookie',cookie));}
    else if(path==='/mcp'){if(!auth.bearer)throw new PlatformError(401,'mcp_token_required','Use a scoped API token for MCP');response=await handleMcp(request,{principal,store,services,runtime,allowedHosts:[...allowedHosts]});}
    else if(path==='/api/bootstrap'&&method==='GET'){
     const resources=Object.fromEntries(await Promise.all(resourceKinds.map(async kind=>[kind,await list(principal,kind)]))) as BootstrapResponse['resources'];
     let activeBundle=null;try{activeBundle=(await services.activeOntology(principal)).bundle;}catch(e){if(!(e instanceof PlatformError&&e.status===404))throw e;}
     const result:BootstrapResponse={session:auth.session??await identity.sessionInfo(principal),resources,activeBundle,audit:principal.scopes.includes('admin')?await store.auditLog(principal.tenantId):[],approvals:await runtime.listApprovals(principal),health:{database:'connected',worker:await store.workerHealthy()?'online':'offline',model:config.model.mode,version:'0.2.0',environment:'sandbox'}};response=json(result);
    }
    else if(path==='/api/ontology/validate'&&method==='POST'){requireScope(principal,'build');const input=await body(request,z.object({bundle:z.unknown()}).strict());response=json(services.validateOntology(input.bundle));}
    else if(path==='/api/ontology/propose'&&method==='POST'){response=json(await services.proposeOntology(principal,await body(request,z.object({name,text:z.string().min(1).max(500000)}).strict())),201);}
    else if(path==='/api/knowledge/transform'&&method==='POST'){response=json(await services.transformKnowledge(principal,await body(request,z.object({name,text:z.string().min(1).max(500000),source:z.unknown()}).strict())),201);}
    else if(path==='/api/context/inspect'&&method==='POST'){response=json(await services.inspectContext(principal,await body(request,z.object({prompt:z.string().min(1).max(16000),profileId:z.string().optional()}).strict())));}
    else if(path==='/api/policy/simulate'&&method==='POST'){response=json(await services.simulatePolicy(principal,await body(request,z.object({actionId:z.string(),args:z.unknown(),objectId:z.string().optional(),ontologyId:z.string().optional()}).strict())));}
    else if(path==='/api/evaluations/run'&&method==='POST'){response=json(await services.runEvaluations(principal,await body(request,z.object({ontologyId:z.string().optional(),revision:revision.optional()}).strict())),201);}
    else if(path==='/api/releases'&&method==='POST'){response=json(await services.createRelease(principal,await body(request,z.object({ontologyId:z.string(),revision}).strict())),201);}
    else if(/^\/api\/releases\/[^/]+\/activate$/.test(path)&&method==='POST'){await body(request,z.object({}).strict());response=json(await services.activateRelease(principal,decodeURIComponent(path.split('/')[3]!)));}
    else if(/^\/api\/ontology\/[^/]+\/review$/.test(path)&&method==='POST'){
     requireScope(principal,'release');const input=await body(request,z.object({revision,reason:z.string().trim().min(8).max(2000),acknowledgedGaps:z.array(z.string())}).strict());const id=decodeURIComponent(path.split('/')[3]!);const record=await store.get(principal.tenantId,'ontologies',id);if(!record||!canRead(principal,record))throw new PlatformError(404,'not_found','Ontology not found');const gaps=Array.isArray(record.data.reviewGaps)?record.data.reviewGaps as string[]:[];if(gaps.some(gap=>!input.acknowledgedGaps.includes(gap)))throw new PlatformError(422,'review_gaps','Acknowledge every unresolved proposal gap before approval');if(!services.validateOntology(record.data.bundle).valid)throw new PlatformError(422,'invalid_ontology','Fix validation errors before owner review');response=json(await store.update(principal,'ontologies',id,input.revision,{state:'approved',data:{...record.data,reviewGaps:[],review:{status:'approved',actorId:principal.actorId,reason:input.reason,acknowledgedGaps:gaps,at:new Date().toISOString()}}}));
    }
    else if(path==='/api/runs'&&method==='POST'){response=json(await resourceVisible(principal,await runtime.enqueueRun(principal,await body(request,z.object({agentId:z.string(),prompt:z.string().trim().min(1).max(16000)}).strict())),store),202);}
    else if(/^\/api\/runs\/[^/]+\/(resume|cancel)$/.test(path)&&method==='POST'){await body(request,z.object({}).strict());const id=decodeURIComponent(path.split('/')[3]!);response=json(await resourceVisible(principal,path.endsWith('/resume')?await runtime.resumeRun(principal,id):await runtime.cancelRun(principal,id),store),202);}
    else if(/^\/api\/approvals\/[^/]+$/.test(path)&&method==='POST'){response=json(await runtime.decideApproval(principal,decodeURIComponent(path.split('/')[3]!),await body(request,z.object({decision:z.enum(['approved','rejected']),reason:z.string().max(2000).optional()}).strict())));}
    else if(/^\/api\/intents\/[^/]+\/reconcile$/.test(path)&&method==='POST'){await body(request,z.object({}).strict());response=json(await runtime.reconcile(principal,decodeURIComponent(path.split('/')[3]!)));}
    else if(/^\/api\/connectors\/[^/]+\/test$/.test(path)&&method==='POST'){await body(request,z.object({}).strict());requireScope(principal,'admin');response=json(await runtime.testConnector(principal,decodeURIComponent(path.split('/')[3]!)));}
    else if(/^\/api\/connectors\/[^/]+\/sync$/.test(path)&&method==='POST'){await body(request,z.object({}).strict());requireScope(principal,'build');response=json(await runtime.syncConnector(principal,decodeURIComponent(path.split('/')[3]!)));}
    else if(path==='/api/tokens'&&method==='GET')response=json(await identity.tokens(principal));
    else if(path==='/api/tokens'&&method==='POST')response=json(await identity.createToken(principal,await body(request,z.object({name,scopes:z.array(z.string()).min(1)}).strict())),201);
    else if(/^\/api\/tokens\/[^/]+$/.test(path)&&method==='DELETE'){await identity.revokeToken(principal,decodeURIComponent(path.split('/')[3]!));response=json({ok:true});}
    else if(path==='/api/users'&&method==='GET')response=json(await identity.users(principal));
    else if(path==='/api/users'&&method==='POST')response=json(await identity.createUser(principal,await body(request,z.object({name,email:z.string(),password:z.string().optional(),role:z.enum(['admin','builder','operator','viewer'])}).strict())),201);
    else if(/^\/api\/users\/[^/]+$/.test(path)&&method==='PUT')response=json(await identity.updateUser(principal,decodeURIComponent(path.split('/')[3]!),await body(request,z.object({role:z.enum(['admin','builder','operator','viewer']).optional(),active:z.boolean().optional()}).strict())));
    else if(path==='/api/objects/query'&&method==='POST')response=json(await services.queryObjects(principal,await body(request,z.object({objectTypeId:z.string().optional(),search:z.string().max(500).optional(),limit:z.number().int().min(1).max(1000).optional(),filters:z.array(z.object({property:z.string(),op:z.enum(['eq','neq','gt','gte','lt','lte','contains']),value:z.union([z.string(),z.number(),z.boolean(),z.null()])})).optional()}).strict())));
    else if(path==='/api/objects/aggregate'&&method==='POST')response=json(await services.aggregateObjects(principal,await body(request,z.object({objectTypeId:z.string().optional(),search:z.string().max(500).optional(),limit:z.number().int().min(1).max(1000).optional(),filters:z.array(z.object({property:z.string(),op:z.enum(['eq','neq','gt','gte','lt','lte','contains']),value:z.union([z.string(),z.number(),z.boolean(),z.null()])})).optional(),operation:z.enum(['count','sum','average','min','max']),property:z.string().optional(),groupBy:z.string().optional()}).strict())));
    else if(/^\/api\/objects\/[^/]+\/relations$/.test(path)&&method==='GET'){response=json(await services.traverseObjects(principal,{objectId:decodeURIComponent(path.split('/')[3]!),...(url.searchParams.get('relationId')?{relationId:url.searchParams.get('relationId')!}:{}),direction:url.searchParams.get('direction')==='incoming'?'incoming':'outgoing'}));}
    else if(path.startsWith('/api/resources/')){
     const parts=path.split('/'),kind=parts[3] as ResourceKind,id=parts[4]?decodeURIComponent(parts[4]):undefined;if(!resourceKinds.includes(kind)||parts.length>5)throw new PlatformError(404,'not_found','Resource endpoint not found');
     if(method==='GET'){if(id){const item=await store.get(principal.tenantId,kind,id);const visible=item&&await resourceVisible(principal,item,store);if(!visible)throw new PlatformError(404,'not_found','Resource not found');response=json(visible);}else response=json(await list(principal,kind));}
     else{
      requireScope(principal,adminKinds.has(kind)?'admin':'build');if(protectedKinds.has(kind))throw new PlatformError(403,'managed_resource','Use the governed operation to change this resource');
      if(method==='POST'&&!id){const input=await body(request,z.object({name,state:z.string().max(40).optional(),data}).strict());safeResourceData(input.data);if(kind==='objects'&&(input.data.source as {system?:string})?.system!=='onto')throw new PlatformError(403,'source_owned','External objects can only be changed through a governed action');if(kind==='ontologies'){input.state='draft';input.data.review={status:'pending'};}response=json(await store.create(principal,kind,input),201);}
      else if(method==='PUT'&&id){const input=await body(request,z.object({revision,name:name.optional(),state:z.string().max(40).optional(),data:data.optional()}).strict());safeResourceData(input.data);const current=await store.get(principal.tenantId,kind,id);if(!current||!canRead(principal,current))throw new PlatformError(404,'not_found','Resource not found');if(kind==='objects'&&((current.data.source as {system?:string})?.system!=='onto'||input.data&&(input.data.source as {system?:string})?.system!=='onto'))throw new PlatformError(403,'source_owned','Object source identity is immutable; external objects change only through governed actions');if(kind==='objects'&&input.data){const readable=visibleObject(principal,current)!;const properties=current.data.properties;if(properties&&typeof properties==='object'&&!Array.isArray(properties)&&Object.keys(properties).some(key=>!Object.hasOwn(readable.data.properties as object,key)))throw new PlatformError(403,'masked_fields','Replacing object data requires access to every existing property');}if(kind==='ontologies'&&input.data?.bundle)response=json(await services.saveOntologyDraft(principal,{id,revision:input.revision,bundle:input.data.bundle,name:input.name}));else{if(kind==='ontologies')throw new PlatformError(400,'bundle_required','Save an ontology bundle or use the owner review operation');response=json(await resourceVisible(principal,await store.update(principal,kind,id,input.revision,input),store));}}
      else if(method==='DELETE'&&id){const input=await body(request,z.object({revision}).strict());const current=await store.get(principal.tenantId,kind,id);if(!current||!canRead(principal,current))throw new PlatformError(404,'not_found','Resource not found');if(kind==='objects'&&(current.data.source as {system?:string})?.system!=='onto')throw new PlatformError(403,'source_owned','External objects can only be changed through a governed action');const releases=await store.list(principal.tenantId,'releases');if(releases.some(r=>r.state==='active'&&(JSON.stringify(r.data.manifest).includes(`"id":"${id}"`))))throw new PlatformError(409,'active_dependency','Retire the active release before deleting its dependencies');await store.remove(principal,kind,id,input.revision);response=json({ok:true});}
      else throw new PlatformError(405,'method_not_allowed','Method not allowed');
     }
    }
    else throw new PlatformError(404,'not_found','API endpoint not found');
   }
   else if(method==='GET')response=await staticFile(path);
   else throw new PlatformError(404,'not_found','Endpoint not found');
  }catch(error){if(error instanceof ZodError)response=json({error:{code:'invalid_request',message:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; ')},requestId},400);else if(error instanceof PlatformError)response=json({error:{code:error.code,message:error.message},requestId},error.status);else {console.error(JSON.stringify({level:'error',requestId,message:error instanceof Error?error.message:String(error)}));response=json({error:{code:'internal_error',message:'The request could not be completed. Check the server log using the request ID.'},requestId},500);}}
  response.headers.set('x-request-id',requestId);response.headers.set('x-content-type-options','nosniff');response.headers.set('referrer-policy','same-origin');response.headers.set('x-frame-options','DENY');response.headers.set('cache-control','no-store');response.headers.set('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");const origin=request.headers.get('origin');if(origin&&allowedOrigins.has(origin)){response.headers.set('access-control-allow-origin',origin);response.headers.set('access-control-allow-credentials','true');response.headers.set('vary','Origin');}return response;
 }
 return {fetch,store,services,identity,runtime,intents,pool,close:()=>pool.end()};
}
async function staticFile(path:string):Promise<Response>{const root=resolve(process.cwd(),'apps/studio/dist');const decoded=decodeURIComponent(path);const file=resolve(root,`.${decoded}`);if(file!==root&&!file.startsWith(`${root}/`))throw new PlatformError(404,'not_found','File not found');const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};try{const actual=extname(file)?file:resolve(root,'index.html');return new Response(await readFile(actual),{headers:{'content-type':mime[extname(actual)]??'application/octet-stream'}});}catch{try{return new Response(await readFile(resolve(root,'index.html')),{headers:{'content-type':'text/html; charset=utf-8'}});}catch{return new Response('Studio is not built. Run pnpm build, or use the Vite development server on port 5173.',{status:503});}}}
