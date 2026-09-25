import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PostgresStore,PgIntentStore,pg,tenantTransaction} from '../src/index.js';
import {roleScopes,type Principal} from '../../platform-contracts/src/index.js';
import {ActionGateway} from '../../action-gateway/src/index.js';

test('PostgreSQL isolates tenants, enforces revisions, persists intents and fences jobs', {skip:!process.env.DATABASE_URL}, async()=>{
 const isolatedSchema='onto_persistence_'+randomUUID().replaceAll('-','');const adminPool=new pg.Pool({connectionString:process.env.DATABASE_URL});await adminPool.query(`CREATE SCHEMA ${isolatedSchema}`);const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:`-c search_path=${isolatedSchema}`});const store=new PostgresStore(pool);await store.migrate();
 const suffix=randomUUID(),a=`test-a-${suffix}`,b=`test-b-${suffix}`;
 const p=(tenantId:string):Principal=>({tenantId,actorId:`user-${suffix}`,name:'Test',email:'test@example.com',role:'admin',scopes:roleScopes.admin});
 try{
  await pool.query('INSERT INTO tenants(id,name) VALUES($1,$1),($2,$2)',[a,b]);
  const r=await store.create(p(a),'knowledge',{id:'same-id',name:'Tenant A',data:{text:'private A'}});
  await store.create(p(b),'knowledge',{id:'same-id',name:'Tenant B',data:{text:'private B'}});
  assert.equal((await store.get(a,'knowledge','same-id'))?.name,'Tenant A');
  assert.equal((await store.list(b,'knowledge'))[0]?.name,'Tenant B');
  // The database policy blocks bypassing the application tenant WHERE clause.
  const escaped=await tenantTransaction(pool,a,async c=>(await c.query('SELECT * FROM resources WHERE tenant_id=$1',[b])).rows);
  assert.deepEqual(escaped,[]);
  const updates=await Promise.allSettled([store.update(p(a),'knowledge',r.id,r.revision,{name:'First'}),store.update(p(a),'knowledge',r.id,r.revision,{name:'Second'})]);
  assert.equal(updates.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(updates.filter(x=>x.status==='rejected').length,1);
  const intents=new PgIntentStore(pool);const gateway=new ActionGateway({store:intents,policy:{async evaluate(){return {decision:'deny',reason:'test policy',approval:'none',policyVersion:'v1'};}},approvalAuthority:{async verify(){return false;}},connector:{async preview(){throw Error('not reached');},async execute(){throw Error('not reached');},async verify(){throw Error('not reached');},async reconcile(){return {status:'unknown',reason:'test'};}}});
  const input={tenantId:a,actorId:p(a).actorId,ontologyRelease:'sha256:'+'a'.repeat(64),bindingHash:('sha256:'+'b'.repeat(64)) as `sha256:${string}`,actionId:'test',environment:'sandbox',target:{system:'test',operation:'read'},args:{},idempotencyKey:'one',deadlineAt:new Date(Date.now()+60000).toISOString()};
  const first=await gateway.createIntent(input);assert.equal((await new PgIntentStore(pool).get(a,'one'))?.intent.id,first.intent.id);assert.equal(await intents.get(b,'one'),undefined);
  await store.enqueue(p(a),'test',{runId:'run'});const one=await store.claimJob('worker-1',1000);assert.ok(one?.leaseToken);assert.equal(await store.claimJob('worker-2'),undefined);
  await assert.rejects(store.completeJob(one.id,'wrong-lease'),/expired lease/);
  await pool.query("UPDATE jobs SET lease_until=now()-interval '1 second' WHERE id=$1",[one.id]);
  const two=await store.claimJob('worker-2');assert.equal(two?.id,one.id);assert.notEqual(two?.leaseToken,one.leaseToken);await assert.rejects(store.completeJob(one.id,one.leaseToken),/expired lease/);await store.completeJob(two!.id,two!.leaseToken!);
  assert.ok((await store.auditLog(a)).some(e=>e.kind==='knowledge.created'));
 }finally{
  for(const t of [a,b])await tenantTransaction(pool,t,async c=>{await c.query('DELETE FROM action_intents WHERE tenant_id=$1',[t]);await c.query('DELETE FROM resources WHERE tenant_id=$1',[t]);await c.query('DELETE FROM audit_events WHERE tenant_id=$1',[t]);await c.query('DELETE FROM jobs WHERE tenant_id=$1',[t]);await c.query('DELETE FROM tenants WHERE id=$1',[t]);});
  await pool.end();await adminPool.query(`DROP SCHEMA ${isolatedSchema} CASCADE`);await adminPool.end();
 }
});
