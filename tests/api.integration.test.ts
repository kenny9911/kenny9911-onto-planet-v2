import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createPlatformApp } from '../apps/api/src/app.js';
import type { AppConfig } from '../apps/api/src/config.js';
import { pg } from '../packages/persistence/src/index.js';
import { roleScopes, type BootstrapResponse, type EntityRecord, type Principal, type SessionInfo } from '../packages/platform-contracts/src/index.js';

if(process.env.CI&&!process.env.DATABASE_URL)throw new Error('CI must provide DATABASE_URL for API integration tests');
const origin='http://localhost:4100';
type Login={session:SessionInfo;cookie:string};
const cookieHeader=(response:Response)=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
async function rpcBody(response:Response):Promise<any>{const text=await response.text();if(response.headers.get('content-type')?.includes('text/event-stream')){const lines=text.split('\n').filter(line=>line.startsWith('data: '));return JSON.parse(lines.at(-1)!.slice(6));}return JSON.parse(text);}

test('authenticated API and MCP enforce authority, source ownership, revisions, and tenant disclosure', {skip:!process.env.DATABASE_URL,timeout:90_000},async t=>{
  // Every suite uses a new schema in the dedicated test database; no existing rows are modified.
  const schema=`onto_test_${randomUUID().replaceAll('-','')}`;
  const adminPool=new pg.Pool({connectionString:process.env.DATABASE_URL});
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${schema}`,max:8});
  const config:AppConfig={databaseUrl:process.env.DATABASE_URL!,port:4100,host:'127.0.0.1',appOrigin:origin,production:false,embedWorker:false,setupToken:'test-setup-token',operatorOrigins:['http://127.0.0.1:4200'],allowLocalSandbox:true,model:{mode:'sandbox'}};
  const app=await createPlatformApp(config,pool);
  let admin:Login,viewer:Login,builder:Login;
  const request=(path:string,options:{method?:string;data?:unknown;login?:Login;csrf?:boolean;token?:string;origin?:string;headers?:Record<string,string>}={})=>app.fetch(new Request(`${origin}${path}`,{method:options.method??'GET',headers:{host:'localhost:4100',...(options.data===undefined?{}:{'content-type':'application/json'}),...(options.login?{cookie:options.login.cookie,...(options.csrf!==false?{'x-csrf-token':options.login.session.csrfToken}:{})}:{}),...(options.token?{authorization:`Bearer ${options.token}`}:{ }),origin:options.origin??origin,...options.headers},...(options.data===undefined?{}:{body:JSON.stringify(options.data)})}));
  const login=async(email:string,password:string)=>{const response=await request('/api/login',{method:'POST',data:{email,password}});assert.equal(response.status,200,await response.clone().text());return {session:await response.json() as SessionInfo,cookie:cookieHeader(response)};};
  try{
    await t.test('first administrator setup requires configured token, creates seed through real gates, and cannot repeat',async()=>{
      assert.equal((await (await request('/api/setup')).json() as {required:boolean}).required,true);
      const input={name:'API admin',email:'admin@example.test',password:'test-admin-password-42',workspace:'API test workspace'};
      assert.equal((await request('/api/setup',{method:'POST',data:input})).status,403);
      const response=await request('/api/setup',{method:'POST',data:{...input,setupToken:'test-setup-token'}});
      assert.equal(response.status,201,await response.clone().text());
      admin={session:await response.json() as SessionInfo,cookie:cookieHeader(response)};
      assert.equal(admin.session.user.role,'admin');
      assert.equal((await request('/api/setup',{method:'POST',data:{...input,setupToken:'test-setup-token'}})).status,409);
      assert.equal((await (await request('/api/setup')).json() as {required:boolean}).required,false);
      const bootstrap=await request('/api/bootstrap',{login:admin});assert.equal(bootstrap.status,200,await bootstrap.clone().text());
      const payload=await bootstrap.json() as BootstrapResponse;
      assert.equal(payload.resources.releases.filter(item=>item.state==='active').length,1);
      assert.equal(payload.activeBundle?.id,'procurement');
      assert.ok(payload.resources.evaluations.some(item=>item.state==='passed'));
    });
    await t.test('cookie mutations require CSRF and configured origin; unauthenticated requests fail',async()=>{
      assert.equal((await request('/api/bootstrap')).status,401);
      assert.equal((await request('/api/resources/knowledge',{method:'POST',login:admin,csrf:false,data:{name:'No CSRF',data:{}}})).status,403);
      assert.equal((await request('/api/resources/knowledge',{method:'POST',login:admin,origin:'https://untrusted.example',data:{name:'Wrong origin',data:{}}})).status,403);
      const signedIn=await login('admin@example.test','test-admin-password-42');assert.equal(signedIn.session.user.actorId,admin.session.user.actorId);
      const wrong=await request('/api/login',{method:'POST',data:{email:'admin@example.test',password:'incorrect-password'}});assert.equal(wrong.status,401);
    });
    await t.test('viewer and builder sessions cannot elevate roles or mutate protected system resources',async()=>{
      for(const role of ['viewer','builder'] as const){const response=await request('/api/users',{method:'POST',login:admin,data:{name:`Test ${role}`,email:`${role}@example.test`,password:`test-${role}-password-42`,role}});assert.equal(response.status,201,await response.clone().text());}
      viewer=await login('viewer@example.test','test-viewer-password-42');builder=await login('builder@example.test','test-builder-password-42');
      assert.equal((await request('/api/resources/knowledge',{method:'POST',login:viewer,data:{name:'Cannot write',data:{}}})).status,403);
      assert.equal((await request('/api/users',{method:'POST',login:viewer,data:{name:'Escalated',email:'elevated@example.test',password:'not-allowed-password',role:'admin'}})).status,403);
      for(const kind of ['runs','releases','evaluations'])assert.equal((await request(`/api/resources/${kind}`,{method:'POST',login:admin,data:{name:'Forged system record',state:'active',data:{}}})).status,403);
      assert.equal((await request('/api/resources/connectors',{method:'POST',login:builder,data:{name:'Privileged connector',data:{}}})).status,403);
    });
    await t.test('bootstrap and object reads apply tenant, row, and field isolation',async()=>{
      const tenant='foreign-tenant';await pool.query('INSERT INTO tenants(id,name) VALUES($1,$2)',[tenant,'Foreign']);
      const outsider:Principal={...admin.session.user,tenantId:tenant,actorId:'foreign-user',role:'admin',scopes:roleScopes.admin};
      await app.store.create(outsider,'knowledge',{id:'foreign-note',name:'Foreign confidential note',data:{markdown:'foreign tenant secret'}});
      const hidden=await app.store.get(admin.session.user.tenantId,'objects','PO-2026-006');
      await app.store.update(admin.session.user,'objects',hidden!.id,hidden!.revision,{data:{...hidden!.data,access:{roles:['admin']}}});
      const response=await request('/api/bootstrap',{login:viewer});assert.equal(response.status,200,await response.clone().text());
      const payload=await response.json() as BootstrapResponse;
      assert.ok(!payload.resources.knowledge.some(item=>item.id==='foreign-note'));
      assert.ok(!payload.resources.objects.some(item=>item.id==='PO-2026-006'));
      const order=payload.resources.objects.find(item=>item.id==='PO-2026-001')!;
      assert.ok(!Object.hasOwn(order.data.properties as object,'internalNotes'));
      assert.equal(payload.audit.length,0);
      assert.ok(payload.resources.releases.every(item=>!Object.hasOwn(item.data,'manifest')));
      assert.equal((await request('/api/resources/knowledge/foreign-note',{login:admin})).status,404);
      assert.equal((await request('/api/resources/objects/PO-2026-006',{login:viewer})).status,404);
      const aggregate=await request('/api/objects/aggregate',{method:'POST',login:viewer,data:{objectTypeId:'PurchaseOrder',operation:'count',groupBy:'internalNotes'}});
      assert.equal(aggregate.status,200);assert.deepEqual(await aggregate.json(),[]);
      const count=await request('/api/objects/aggregate',{method:'POST',login:viewer,data:{objectTypeId:'PurchaseOrder',operation:'count'}});
      assert.equal(count.status,200);assert.deepEqual(await count.json(),[{group:'all',value:5,count:5}]);
    });
    await t.test('resource revisions reject stale writes and source-owned projections cannot be edited or deleted',async()=>{
      const created=await request('/api/resources/knowledge',{method:'POST',login:builder,data:{name:'Draft note',data:{markdown:'first'}}});assert.equal(created.status,201);
      const item=await created.json() as EntityRecord;
      assert.equal((await request(`/api/resources/knowledge/${item.id}`,{method:'PUT',login:builder,data:{revision:1,name:'Changed'}})).status,200);
      assert.equal((await request(`/api/resources/knowledge/${item.id}`,{method:'PUT',login:builder,data:{revision:1,name:'Stale overwrite'}})).status,409);
      assert.equal((await request('/api/resources/knowledge',{method:'POST',login:admin,data:{name:'Secret',data:{apiKey:'must-not-store'}}})).status,400);
      assert.equal((await request('/api/resources/objects/PO-2026-001',{method:'PUT',login:builder,data:{revision:1,data:{properties:{status:'APPROVED'}}}})).status,403);
      assert.equal((await request('/api/resources/objects/PO-2026-001',{method:'DELETE',login:builder,data:{revision:1}})).status,403);
      const ownedResponse=await request('/api/resources/objects',{method:'POST',login:builder,data:{name:'Internal planning note',data:{objectTypeId:'PlanningNote',properties:{text:'Draft'},source:{system:'onto'}}}});
      assert.equal(ownedResponse.status,201);
      const owned=await ownedResponse.json() as EntityRecord;
      assert.equal((await request(`/api/resources/objects/${owned.id}`,{method:'PUT',login:builder,data:{revision:owned.revision,data:{objectTypeId:'PurchaseOrder',properties:{id:'FAKE-ERP-ORDER',status:'APPROVED'},source:{system:'sandbox-erp',resource:'orders'},sourceRevision:'forged'}}})).status,403);
    });
    await t.test('write scopes do not bypass record ACLs through mutation, owner review, or audit metadata',async()=>{
      const hidden=await app.store.create(admin.session.user,'knowledge',{name:'Restricted knowledge',data:{access:{roles:['admin']},markdown:'hidden-source-content'}});
      const path=`/api/resources/knowledge/${hidden.id}`;
      assert.equal((await request(path,{login:builder})).status,404);
      assert.equal((await request(path,{method:'PUT',login:builder,data:{revision:1,name:'Unauthorized rename'}})).status,404);
      assert.equal((await request(path,{method:'PUT',login:builder,data:{revision:1,data:{markdown:'Removed ACL'}}})).status,404);
      assert.equal((await request(path,{method:'DELETE',login:builder,data:{revision:1}})).status,404);
      assert.deepEqual(await app.store.get(admin.session.user.tenantId,'knowledge',hidden.id),hidden);
      const localObject=await app.store.create(admin.session.user,'objects',{name:'Local object with restricted fields',data:{objectTypeId:'PlanningNote',source:{system:'onto'},properties:{text:'Visible note',privateNotes:'hidden-field-sentinel'},access:{fieldRoles:{privateNotes:['admin']}}}});
      const renamed=await request(`/api/resources/objects/${localObject.id}`,{method:'PUT',login:builder,data:{revision:1,name:'Permitted rename'}});
      assert.equal(renamed.status,200);
      assert.equal((await renamed.text()).includes('hidden-field-sentinel'),false);
      const overwritten=await request(`/api/resources/objects/${localObject.id}`,{method:'PUT',login:builder,data:{revision:2,data:{objectTypeId:'PlanningNote',source:{system:'onto'},properties:{text:'Remove hidden fields and their policy'}}}});
      assert.equal(overwritten.status,403);
      const preserved=await app.store.get(admin.session.user.tenantId,'objects',localObject.id);
      assert.equal(preserved!.revision,2);
      assert.deepEqual(preserved!.data,localObject.data);
      assert.equal((await request(`/api/resources/objects/${localObject.id}`,{method:'PUT',login:admin,data:{revision:2,data:localObject.data}})).status,200);
      const source=await app.store.get(admin.session.user.tenantId,'ontologies','procurement');
      const ontology=await app.store.create(admin.session.user,'ontologies',{name:'Private reviewer ontology',data:{...source!.data,access:{actorIds:['different-reviewer']}}});
      const review=await request(`/api/ontology/${ontology.id}/review`,{method:'POST',login:admin,data:{revision:1,reason:'Attempt review with release scope alone',acknowledgedGaps:[]}});
      assert.equal(review.status,404);
      for(const endpoint of ['/api/evaluations/run','/api/releases'])assert.equal((await request(endpoint,{method:'POST',login:admin,data:{ontologyId:ontology.id,revision:1}})).status,404);
      assert.equal((await request('/api/policy/simulate',{method:'POST',login:admin,data:{ontologyId:ontology.id,actionId:'approveOrder',args:{orderId:'PO-2026-001'}}})).status,404);
      const bootstrap=await (await request('/api/bootstrap',{login:builder})).json() as BootstrapResponse;
      assert.deepEqual(bootstrap.audit,[]);
      assert.ok(!bootstrap.resources.knowledge.some(item=>item.id===hidden.id));
    });
    await t.test('release assembly stores immutable evidence and activation rejects changed pinned resources',async()=>{
      const created=await request('/api/releases',{method:'POST',login:admin,data:{ontologyId:'procurement',revision:1}});assert.equal(created.status,201,await created.clone().text());
      const release=await created.json() as EntityRecord;assert.equal(release.state,'ready');
      assert.equal((await request(`/api/resources/releases/${release.id}`,{method:'PUT',login:admin,data:{revision:release.revision,data:{manifestHash:'forged'}}})).status,403);
      assert.equal((await request(`/api/releases/${release.id}/activate`,{method:'POST',login:viewer,data:{}})).status,403);
      const profile=await app.store.get(admin.session.user.tenantId,'contextProfiles','procurement-context');
      await app.store.update(admin.session.user,'contextProfiles',profile!.id,profile!.revision,{name:'Changed since candidate review'});
      const activated=await request(`/api/releases/${release.id}/activate`,{method:'POST',login:admin,data:{}});assert.equal(activated.status,409,await activated.clone().text());
    });
    await t.test('scoped bearer tokens cannot elevate and MCP filters both discovery and invocation',async()=>{
      const escalated=await request('/api/tokens',{method:'POST',login:viewer,data:{name:'Escalation attempt',scopes:['read','admin']}});assert.equal(escalated.status,403);
      const tokenResponse=await request('/api/tokens',{method:'POST',login:viewer,data:{name:'MCP reader',scopes:['read','order:read']}});assert.equal(tokenResponse.status,201);
      const token=await tokenResponse.json() as {token:string;id:string};
      assert.equal((await request('/api/users',{token:token.token})).status,403);
      assert.equal((await request('/api/resources/knowledge',{method:'POST',token:token.token,data:{name:'Token write',data:{}}})).status,403);
      const rpc=async(method:string,params:Record<string,unknown>={},bearer=token.token)=>{
        const response=await request('/mcp',{method:'POST',token:bearer,headers:{accept:'application/json, text/event-stream','MCP-Protocol-Version':'2026-07-28','Mcp-Method':method,...(method==='tools/call'?{'Mcp-Name':String(params.name)}:{})},data:{jsonrpc:'2.0',id:1,method,params:{...params,_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientInfo':{name:'api-test',version:'1'},'io.modelcontextprotocol/clientCapabilities':{}}}}});assert.equal(response.status,200,await response.clone().text());return rpcBody(response);
      };
      const listed=await rpc('tools/list');assert.equal(listed.result.tools.length,1);assert.ok(!listed.result.tools[0].name.startsWith('ontology.preview.'));
      const called=await rpc('tools/call',{name:listed.result.tools[0].name,arguments:{orderId:'PO-2026-001'}});
      assert.equal(called.result.isError??false,false);assert.equal(called.result.structuredContent[0].id,'PO-2026-001');assert.equal(called.result.structuredContent[0].data.properties.internalNotes,undefined);
      const powerful=await request('/api/tokens',{method:'POST',login:admin,data:{name:'MCP operator',scopes:['read','order:read','order:write','operate']}});const fullToken=(await powerful.json() as {token:string}).token;
      const fullList=await rpc('tools/list',{},fullToken);const action=fullList.result.tools.find((tool:{name:string})=>tool.name.startsWith('ontology.preview.'));assert.ok(action);
      const denied=await rpc('tools/call',{name:action.name,arguments:{input:{orderId:'PO-2026-001'},idempotencyKey:'not-authorized'}});assert.ok(denied.result?.isError===true||denied.error?.code===-32602,JSON.stringify(denied));
      assert.equal((await request('/mcp',{method:'POST',login:viewer,data:{}})).status,401);
      assert.equal((await request(`/api/tokens/${token.id}`,{method:'DELETE',login:viewer})).status,200);
      assert.equal((await request('/api/session',{token:token.token})).status,401);
    });
    await t.test('release snapshots honor current dependency and ontology access restrictions',async()=>{
      const releases=await app.store.list(admin.session.user.tenantId,'releases');
      const active=releases.find(item=>item.state==='active')!;
      const path=`/api/resources/releases/${active.id}`;
      assert.ok((await (await request(path,{login:builder})).json() as EntityRecord).data.manifest);
      const run=await app.store.create(builder.session.user,'runs',{name:'Historical run',state:'approval_required',data:{agentId:'procurement-agent',releaseId:active.id,actorId:builder.session.user.actorId,invocationScopes:[],procedures:[{text:'historical-sensitive-sentinel'}],result:{content:'historical-sensitive-sentinel'}}});
      const runPath=`/api/resources/runs/${run.id}`;
      assert.ok((await (await request(runPath,{login:builder})).text()).includes('historical-sensitive-sentinel'));
      const knowledge=await app.store.get(admin.session.user.tenantId,'knowledge','procurement-policy');
      await app.store.update(admin.session.user,'knowledge',knowledge!.id,knowledge!.revision,{data:{...knowledge!.data,access:{roles:['admin']}}});
      const restricted=await request(path,{login:builder});assert.equal(restricted.status,200);
      assert.equal((await restricted.json() as EntityRecord).data.manifest,undefined);
      const redacted=await (await request(runPath,{login:builder})).json() as EntityRecord;
      assert.equal(redacted.data.redacted,true);
      assert.equal(JSON.stringify(redacted).includes('historical-sensitive-sentinel'),false);
      assert.ok((await (await request(path,{login:admin})).json() as EntityRecord).data.manifest);
      const ontology=await app.store.get(admin.session.user.tenantId,'ontologies','procurement');
      await app.store.update(admin.session.user,'ontologies',ontology!.id,ontology!.revision,{data:{...ontology!.data,access:{roles:['admin']}}});
      assert.equal((await request(path,{login:builder})).status,404);
      const bootstrap=await (await request('/api/bootstrap',{login:builder})).json() as BootstrapResponse;
      assert.equal(bootstrap.activeBundle,null);
      assert.ok(!bootstrap.resources.releases.some(item=>item.id===active.id));
      assert.ok(!bootstrap.resources.evaluations.some(item=>item.data.ontologyId==='procurement'));
      const inaccessible=await app.store.get(admin.session.user.tenantId,'knowledge','procurement-policy');
      await app.store.update(admin.session.user,'knowledge',inaccessible!.id,inaccessible!.revision,{data:{...inaccessible!.data,access:{actorIds:['another-owner']}}});
      const adminRun=await app.store.create(admin.session.user,'runs',{name:'Admin historical run',state:'approval_required',data:{...run.data,actorId:admin.session.user.actorId}});
      for(const operation of ['resume','cancel']){
        const response=await request(`/api/runs/${adminRun.id}/${operation}`,{method:'POST',login:admin,data:{}});
        assert.equal(response.status,202,await response.clone().text());
        const result=await response.json() as EntityRecord;
        assert.equal(result.data.redacted,true);
        assert.equal(JSON.stringify(result).includes('historical-sensitive-sentinel'),false);
      }
    });
  }finally{await app.close();await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);await adminPool.end();}
});
