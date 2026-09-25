import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { ActionIntent, ExternalReceipt } from '../../../packages/action-gateway/src/index.js';
import type { SourceObject } from '../../../packages/platform-runtime/src/http-operator.js';

export interface SourceOperation { status: 'accepted'; intentHash: string; receipt: ExternalReceipt }
export interface SourcePersistence {
  list(tenantId: string): Promise<SourceObject[]>;
  get(tenantId: string, id: string): Promise<SourceObject | undefined>;
  operation(tenantId: string, key: string): Promise<SourceOperation | undefined>;
  /** Atomically compare revision, apply effect, and persist idempotent operation receipt. */
  approve(tenantId: string, intent: ActionIntent): Promise<SourceOperation>;
}
export class SourceConflict extends Error {}

export class PgSourcePersistence implements SourcePersistence {
  constructor(private readonly pool: Pool) {}
  async migrate(): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS source_records(tenant_id text NOT NULL,id text NOT NULL,revision bigint NOT NULL DEFAULT 1,properties jsonb NOT NULL,PRIMARY KEY(tenant_id,id));
      CREATE TABLE IF NOT EXISTS source_operations(tenant_id text NOT NULL,idempotency_key text NOT NULL,intent_hash text NOT NULL,operation jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,idempotency_key));`);
  }
  async seed(tenantId: string): Promise<void> {
    for (const record of procurementSourceRecords()) await this.pool.query('INSERT INTO source_records(tenant_id,id,revision,properties) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [tenantId, record.id, record.revision, JSON.stringify(record.properties)]);
  }
  async list(tenantId: string): Promise<SourceObject[]> {
    const result = await this.pool.query('SELECT id,revision::text,properties FROM source_records WHERE tenant_id=$1 ORDER BY id', [tenantId]); return result.rows as SourceObject[];
  }
  async get(tenantId: string, id: string): Promise<SourceObject | undefined> {
    const result = await this.pool.query('SELECT id,revision::text,properties FROM source_records WHERE tenant_id=$1 AND id=$2', [tenantId, id]); return result.rows[0] as SourceObject | undefined;
  }
  async operation(tenantId: string, key: string): Promise<SourceOperation | undefined> {
    const result = await this.pool.query('SELECT operation FROM source_operations WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, key]); return result.rows[0]?.operation as SourceOperation | undefined;
  }
  async approve(tenantId: string, intent: ActionIntent): Promise<SourceOperation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize duplicate operation IDs before checking existing receipt or touching an object.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify([tenantId, intent.idempotencyKey])]);
      const previous = (await client.query('SELECT operation FROM source_operations WHERE tenant_id=$1 AND idempotency_key=$2', [tenantId, intent.idempotencyKey])).rows[0]?.operation as SourceOperation | undefined;
      if (previous) { if (previous.intentHash !== intent.intentHash) throw new SourceConflict('Idempotency key already binds another intent'); await client.query('COMMIT'); return previous; }
      const row = (await client.query('SELECT id,revision::text,properties FROM source_records WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, intent.objectRef?.objectId])).rows[0] as SourceObject | undefined;
      assertApprovable(row, intent);
      const operation: SourceOperation = { status: 'accepted', intentHash: intent.intentHash, receipt: { externalOperationId: randomUUID(), acceptedAt: new Date().toISOString(),
        details: { objectId: row!.id, revision: String(Number(row!.revision) + 1), expectedProperties: { status: 'APPROVED' } } } };
      await client.query("UPDATE source_records SET revision=revision+1,properties=jsonb_set(properties,'{status}','\"APPROVED\"') WHERE tenant_id=$1 AND id=$2", [tenantId, row!.id]);
      await client.query('INSERT INTO source_operations(tenant_id,idempotency_key,intent_hash,operation) VALUES($1,$2,$3,$4)', [tenantId, intent.idempotencyKey, intent.intentHash, JSON.stringify(operation)]);
      await client.query('COMMIT'); return operation;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}

export function procurementSourceRecords(): SourceObject[] {
  return [
    ['001', 'Acme Industrial', 18500, 'Precision tooling for assembly line'],
    ['002', 'Northstar Components', 4200, 'Replacement safety components'],
    ['003', 'Meridian Systems', 72800, 'Warehouse monitoring equipment'],
    ['004', 'Atlas Robotics', 120000, 'Robotic production cell'],
    ['005', 'Blue Harbor Supply', 9600, 'Packaging materials replenishment'],
    ['006', 'Summit Logistics', 31500, 'Regional freight services'],
  ].map(([suffix, supplier, amount, description], index) => ({ id: `PO-2026-${suffix}`, revision: '1', properties: { id: `PO-2026-${suffix}`, supplier: supplier!, supplierId: `SUP-${index + 1}`, departmentId: index % 2 ? 'DEP-OPS' : 'DEP-ENG', amount: amount!, description: description!, currency: 'USD', status: 'PENDING' } }));
}

export function createSourceSandbox(options: { persistence: SourcePersistence; token: string; tenantId: string }) {
  if (options.token.length < 16) throw new Error('Source sandbox token must contain at least 16 characters');
  return createServer(async (request, response) => {
    try {
      if (!sameSecret(request.headers.authorization ?? '', `Bearer ${options.token}`) || request.headers['x-tenant-id'] !== options.tenantId) return send(response, 401, { error: 'Unauthorized source request' });
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') return send(response, 200, { status: 'ok', system: 'procurement-source-sandbox', guarantees: { conditionalWrite: true, nativeIdempotency: true, readback: true, reconciliation: true } });
      if (request.method === 'GET' && url.pathname === '/objects') return send(response, 200, { objects: await options.persistence.list(options.tenantId) });
      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        const object = await options.persistence.get(options.tenantId, decodeURIComponent(url.pathname.slice('/objects/'.length)));
        return send(response, object ? 200 : 404, object ?? { error: 'Object not found' });
      }
      if (request.method === 'GET' && url.pathname.startsWith('/operations/')) {
        const operation = await options.persistence.operation(options.tenantId, decodeURIComponent(url.pathname.slice('/operations/'.length)));
        return send(response, operation ? 200 : 404, operation ?? { error: 'Operation not found' });
      }
      if (request.method === 'POST' && ['/actions/preview', '/actions/execute'].includes(url.pathname)) {
        const body = await jsonBody(request); const intent = body.intent as ActionIntent;
        if (!intent || intent.tenantId !== options.tenantId || intent.actionId !== 'approveOrder' || intent.target?.operation !== 'approve' ||
            !intent.objectRef || intent.objectRef.objectTypeId !== 'PurchaseOrder' || !intent.args || typeof intent.args !== 'object' || Array.isArray(intent.args) ||
            intent.args.orderId !== intent.objectRef.objectId || !intent.idempotencyKey || !/^sha256:[a-f0-9]{64}$/.test(intent.intentHash)) return send(response, 400, { error: 'Invalid source action contract' });
        if (intent.deadlineAt && Date.parse(intent.deadlineAt) <= Date.now()) return send(response, 409, { error: 'Action deadline expired' });
        if (url.pathname.endsWith('/preview')) {
          const object = await options.persistence.get(options.tenantId, intent.objectRef.objectId); assertApprovable(object, intent);
          return send(response, 200, { summary: `Approve ${object!.id} for ${object!.properties.currency} ${object!.properties.amount}`, effects: ['Purchase order status changes from PENDING to APPROVED'], preconditionToken: object!.revision, details: { objectId: object!.id, revision: object!.revision } });
        }
        if (request.headers['idempotency-key'] !== intent.idempotencyKey || request.headers['if-match'] !== intent.objectRef.expectedRevision) return send(response, 409, { error: 'Conditional write and idempotency headers are required' });
        return send(response, 200, await options.persistence.approve(options.tenantId, intent));
      }
      send(response, 404, { error: 'Endpoint not found' });
    } catch (error) { send(response, error instanceof SourceConflict ? 409 : 500, { error: error instanceof SourceConflict ? error.message : 'Source request failed' }); }
  });
}
function assertApprovable(object: SourceObject | undefined, intent: ActionIntent): void {
  if (!object || object.revision !== intent.objectRef?.expectedRevision) throw new SourceConflict('Source revision changed or object is unavailable');
  if (object.properties.status !== 'PENDING' || object.properties.currency !== 'USD' || typeof object.properties.amount !== 'number' || object.properties.amount <= 0 || object.properties.amount > 100000) throw new SourceConflict('Source procurement controls reject this order');
}
function sameSecret(a: string, b: string): boolean { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
function send(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); response.end(JSON.stringify(value)); }
async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 128_000) throw new SourceConflict('Request too large'); chunks.push(chunk); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceConflict('Expected an object'); return value as Record<string, unknown>;
}
