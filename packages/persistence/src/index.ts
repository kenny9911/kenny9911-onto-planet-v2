import { createHash, randomUUID } from 'node:crypto';
import pg, { type PoolClient } from 'pg';
import { PlatformError, roleScopes, type AuditRecord, type EntityRecord, type JobRecord, type PlatformStore, type Principal, type ResourceKind, type Role } from '../../platform-contracts/src/index.js';
import type { IntentRecord, IntentStore } from '../../action-gateway/src/index.js';
import type { RunCheckpointStore, StoredRun } from '../../invocation-boundary/src/index.js';
import type { RunResult } from '../../agent-runtime/src/index.js';
import { schema } from './schema.js';
import { canonicalize } from '../../ontology-kernel/src/index.js';

export { pg };
export async function tenantTransaction<T>(pool: pg.Pool, tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!tenantId) throw new PlatformError(403, 'tenant_required', 'A tenant identity is required');
  const client = await pool.connect();
  try { await client.query('BEGIN'); await client.query("SELECT set_config('onto.tenant_id',$1,true)", [tenantId]); const result = await operation(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
function entity(row: any): EntityRecord { return { id: row.id, tenantId: row.tenant_id, kind: row.kind, name: row.name, state: row.state, revision: row.revision, data: row.data, createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(), createdBy: row.created_by }; }
function job(row: any): JobRecord { return { id: row.id, tenantId: row.tenant_id, actorId: row.actor_id, kind: row.kind, state: row.state, payload: row.payload, attempt: row.attempt, ...(row.lease_token ? {leaseToken: row.lease_token} : {}), ...(row.error ? {error: row.error} : {}), createdAt: new Date(row.created_at).toISOString() }; }
async function appendAudit(client: PoolClient, principal: Principal, kind: string, subjectId: string, details: Record<string, unknown> = {}) {
  await client.query('INSERT INTO audit_events(id,tenant_id,actor_id,kind,subject_id,details) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), principal.tenantId, principal.actorId, kind, subjectId, JSON.stringify(details)]);
}
export class PostgresStore implements PlatformStore {
  constructor(public readonly pool: pg.Pool) {}
  async migrate() { const client = await this.pool.connect(); try { await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtext('onto-schema-v1'))"); await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');const installed=await client.query('SELECT version FROM schema_migrations WHERE version=1');if(!installed.rowCount){await client.query(schema);await client.query('INSERT INTO schema_migrations(version) VALUES(1)');}await client.query('COMMIT'); } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); } }
  async list(tenantId: string, kind: ResourceKind): Promise<EntityRecord[]> { return tenantTransaction(this.pool, tenantId, async c => (await c.query('SELECT * FROM resources WHERE tenant_id=$1 AND kind=$2 ORDER BY updated_at DESC,id LIMIT 5000', [tenantId,kind])).rows.map(entity)); }
  async get(tenantId: string, kind: ResourceKind, id: string): Promise<EntityRecord | undefined> { return tenantTransaction(this.pool,tenantId,async c=>{const row=(await c.query('SELECT * FROM resources WHERE tenant_id=$1 AND kind=$2 AND id=$3',[tenantId,kind,id])).rows[0];return row ? entity(row):undefined;}); }
  async create(principal: Principal, kind: ResourceKind, input: {id?:string;name:string;state?:string;data:Record<string,unknown>}):Promise<EntityRecord> {
    return tenantTransaction(this.pool, principal.tenantId, async c => {
      const id = input.id ?? randomUUID();
      const row = (await c.query('INSERT INTO resources(tenant_id,kind,id,name,state,data,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *',[principal.tenantId,kind,id,input.name,input.state??'draft',JSON.stringify(input.data),principal.actorId])).rows[0];
      if(!row) throw new PlatformError(409,'already_exists','A resource with that ID already exists');
      await appendAudit(c,principal,`${kind}.created`,id,{name:input.name});return entity(row);
    });
  }
  async update(principal:Principal,kind:ResourceKind,id:string,expectedRevision:number,patch:{name?:string;state?:string;data?:Record<string,unknown>}):Promise<EntityRecord> {
    return tenantTransaction(this.pool,principal.tenantId,async c=>{
      const row=(await c.query('UPDATE resources SET name=COALESCE($5,name),state=COALESCE($6,state),data=COALESCE($7::jsonb,data),revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND kind=$2 AND id=$3 AND revision=$4 RETURNING *',[principal.tenantId,kind,id,expectedRevision,patch.name??null,patch.state??null,patch.data===undefined?null:JSON.stringify(patch.data)])).rows[0];
      if(!row) throw new PlatformError(409,'revision_conflict','The resource changed. Refresh it before saving.');
      await appendAudit(c,principal,`${kind}.updated`,id,{revision:row.revision});return entity(row);
    });
  }
  async remove(principal:Principal,kind:ResourceKind,id:string,expectedRevision:number):Promise<void> {
    await tenantTransaction(this.pool,principal.tenantId,async c=>{const result=await c.query('DELETE FROM resources WHERE tenant_id=$1 AND kind=$2 AND id=$3 AND revision=$4',[principal.tenantId,kind,id,expectedRevision]);if(!result.rowCount) throw new PlatformError(409,'revision_conflict','The resource changed. Refresh it before deleting.');await appendAudit(c,principal,`${kind}.deleted`,id);});
  }
  async audit(principal:Principal,kind:string,subjectId:string,details:Record<string,unknown>={}) { await tenantTransaction(this.pool,principal.tenantId,c=>appendAudit(c,principal,kind,subjectId,details)); }
  async auditLog(tenantId:string,limit=200):Promise<AuditRecord[]> { return tenantTransaction(this.pool,tenantId,async c=>(await c.query('SELECT * FROM audit_events WHERE tenant_id=$1 ORDER BY at DESC,id LIMIT $2',[tenantId,Math.max(1,Math.min(limit,1000))])).rows.map(r=>({id:r.id,tenantId:r.tenant_id,actorId:r.actor_id,kind:r.kind,subjectId:r.subject_id,at:new Date(r.at).toISOString(),details:r.details}))); }
  async auditEvidence(tenantId:string,subjectId:string):Promise<AuditRecord|undefined>{return tenantTransaction(this.pool,tenantId,async c=>{const r=(await c.query("SELECT * FROM audit_events WHERE tenant_id=$1 AND subject_id=$2 AND kind='approval.decided' ORDER BY at DESC LIMIT 1",[tenantId,subjectId])).rows[0];return r?{id:r.id,tenantId:r.tenant_id,actorId:r.actor_id,kind:r.kind,subjectId:r.subject_id,at:new Date(r.at).toISOString(),details:r.details}:undefined;});}
  async activateRelease(principal:Principal,id:string,expectedRevision:number,manifestHash:string):Promise<EntityRecord> {
    return tenantTransaction(this.pool,principal.tenantId,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`release:${principal.tenantId}`]);
      const row=(await c.query("SELECT * FROM resources WHERE tenant_id=$1 AND kind='releases' AND id=$2 FOR UPDATE",[principal.tenantId,id])).rows[0];
      if(!row||row.revision!==expectedRevision||row.data.manifestHash!==manifestHash) throw new PlatformError(409,'release_conflict','Release evidence changed before activation');
      const manifest=row.data.manifest;
      const refs=[{kind:'ontologies',id:manifest.ontology.id,revision:manifest.ontology.revision,hash:manifest.ontology.resourceHash},...manifest.resources,{kind:'evaluations',id:manifest.evaluation.id,revision:manifest.evaluation.revision,hash:manifest.evaluation.hash}].sort((a,b)=>`${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
      for(const ref of refs){
        const current=(await c.query('SELECT * FROM resources WHERE tenant_id=$1 AND kind=$2 AND id=$3 FOR SHARE',[principal.tenantId,ref.kind,ref.id])).rows[0];
        const digest=current?`sha256:${createHash('sha256').update(canonicalize({kind:current.kind,id:current.id,revision:current.revision,data:current.data})).digest('hex')}`:'';
        if(!current||current.revision!==ref.revision||digest!==ref.hash)throw new PlatformError(409,'release_stale',`${ref.kind}:${ref.id} changed before activation`);
      }
      await c.query("UPDATE resources SET state='retired',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND kind='releases' AND state='active' AND id<>$2",[principal.tenantId,id]);
      const active=(await c.query("UPDATE resources SET state='active',revision=revision+1,updated_at=now() WHERE tenant_id=$1 AND kind='releases' AND id=$2 RETURNING *",[principal.tenantId,id])).rows[0];
      await appendAudit(c,principal,'release.activated',id,{manifestHash});return entity(active);
    });
  }
  async principal(tenantId:string,actorId:string):Promise<Principal|undefined> {const row=(await this.pool.query('SELECT * FROM users WHERE tenant_id=$1 AND id=$2 AND active=true',[tenantId,actorId])).rows[0];return row?{tenantId,actorId,name:row.name,email:row.email,role:row.role as Role,scopes:[...roleScopes[row.role as Role]]}:undefined;}
  async enqueue(principal:Principal,kind:string,payload:Record<string,unknown>):Promise<JobRecord> {return tenantTransaction(this.pool,principal.tenantId,async c=>{const row=(await c.query('INSERT INTO jobs(id,tenant_id,actor_id,kind,payload) VALUES($1,$2,$3,$4,$5) RETURNING *',[randomUUID(),principal.tenantId,principal.actorId,kind,JSON.stringify(payload)])).rows[0];await appendAudit(c,principal,'job.queued',row.id,{kind});return job(row);});}
  async claimJob(workerId:string,leaseMs=120000):Promise<JobRecord|undefined> {
    const result=await this.pool.query(`WITH candidate AS (SELECT id FROM jobs WHERE state='queued' OR (state='running' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs SET state='running',attempt=attempt+1,lease_token=$1,worker_id=$2,lease_until=now()+($3*interval '1 millisecond'),updated_at=now() FROM candidate WHERE jobs.id=candidate.id RETURNING jobs.*`,[randomUUID(),workerId,leaseMs]);return result.rows[0]?job(result.rows[0]):undefined;
  }
  async heartbeatJob(id:string,leaseToken:string) {const r=await this.pool.query("UPDATE jobs SET lease_until=now()+interval '120 seconds',updated_at=now() WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now()",[id,leaseToken]);if(!r.rowCount)throw new PlatformError(409,'job_lease_lost','Job lease is no longer owned');}
  async completeJob(id:string,leaseToken:string,error?:string) {const r=await this.pool.query('UPDATE jobs SET state=$3,error=$4,lease_until=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2 AND state=\'running\' AND lease_until>now()',[id,leaseToken,error?'failed':'completed',error?.slice(0,1000)??null]);if(!r.rowCount)throw new PlatformError(409,'job_lease_lost','Job completion belongs to an expired lease');}
  async heartbeatWorker(workerId:string) {await this.pool.query('INSERT INTO worker_heartbeats(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET at=now()',[workerId]);}
  async workerHealthy():Promise<boolean>{return (await this.pool.query("SELECT 1 FROM worker_heartbeats WHERE at>now()-interval '90 seconds' LIMIT 1")).rowCount!==0;}
}

export class PgIntentStore implements IntentStore {
  constructor(private readonly pool:pg.Pool){}
  async get(tenantId:string,key:string):Promise<IntentRecord|undefined>{return tenantTransaction(this.pool,tenantId,async c=>(await c.query('SELECT record FROM action_intents WHERE tenant_id=$1 AND idempotency_key=$2',[tenantId,key])).rows[0]?.record);}
  async getById(tenantId:string,id:string):Promise<IntentRecord|undefined>{return tenantTransaction(this.pool,tenantId,async c=>(await c.query('SELECT record FROM action_intents WHERE tenant_id=$1 AND id=$2',[tenantId,id])).rows[0]?.record);}
  async list(tenantId:string):Promise<IntentRecord[]>{return tenantTransaction(this.pool,tenantId,async c=>(await c.query('SELECT record FROM action_intents WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT 1000',[tenantId])).rows.map(r=>r.record));}
  async putIfAbsent(record:IntentRecord):Promise<IntentRecord>{return tenantTransaction(this.pool,record.intent.tenantId,async c=>{await c.query('INSERT INTO action_intents(tenant_id,idempotency_key,id,version,record) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,idempotency_key) DO NOTHING',[record.intent.tenantId,record.intent.idempotencyKey,record.intent.id,record.version,JSON.stringify(record)]);return (await c.query('SELECT record FROM action_intents WHERE tenant_id=$1 AND idempotency_key=$2',[record.intent.tenantId,record.intent.idempotencyKey])).rows[0].record;});}
  async compareAndSwap(record:IntentRecord,expectedVersion:number):Promise<boolean>{if(record.version!==expectedVersion+1)return false;return tenantTransaction(this.pool,record.intent.tenantId,async c=>(await c.query('UPDATE action_intents SET record=$4,version=$5,updated_at=now() WHERE tenant_id=$1 AND idempotency_key=$2 AND version=$3',[record.intent.tenantId,record.intent.idempotencyKey,expectedVersion,JSON.stringify(record),record.version])).rowCount===1);}
}
export class PgCheckpointStore implements RunCheckpointStore {
  private readonly claims=new Map<string,string>();
  constructor(private readonly pool:pg.Pool){}
  async save(record:StoredRun){await this.pool.query("INSERT INTO run_checkpoints(run_id,tenant_id,actor_id,state,record) VALUES($1,$2,$3,'suspended',$4)",[record.spec.runId,record.spec.tenantId,record.spec.actorId,JSON.stringify(record)]);}
  async claim(runId:string,tenantId:string,actorId:string):Promise<StoredRun|undefined>{const token=randomUUID();const r=await this.pool.query("UPDATE run_checkpoints SET state='running',claim_token=$4,updated_at=now() WHERE run_id=$1 AND tenant_id=$2 AND actor_id=$3 AND state='suspended' RETURNING record",[runId,tenantId,actorId,token]);if(r.rows[0])this.claims.set(runId,token);return r.rows[0]?.record;}
  async complete(runId:string,result:RunResult){const token=this.claims.get(runId);if(!token)throw new Error('Run claim is missing');const suspended=result.status==='approval_required'||result.status==='unknown';const r=suspended?await this.pool.query("UPDATE run_checkpoints SET state='suspended',record=jsonb_set(record,'{checkpoint}',$3::jsonb),claim_token=NULL,updated_at=now() WHERE run_id=$1 AND claim_token=$2 AND state='running'",[runId,token,JSON.stringify(result.checkpoint)]):await this.pool.query("DELETE FROM run_checkpoints WHERE run_id=$1 AND claim_token=$2 AND state='running'",[runId,token]);if(!r.rowCount)throw new Error('Run claim changed before completion');this.claims.delete(runId);}
  async quarantine(runId:string){const token=this.claims.get(runId);if(token){await this.pool.query("UPDATE run_checkpoints SET state='manual_recovery',updated_at=now() WHERE run_id=$1 AND claim_token=$2",[runId,token]);this.claims.delete(runId);}}
}
