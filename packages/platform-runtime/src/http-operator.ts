import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { ActionIntent, ActionPreview, ConnectorPort, ExecutionOutcome, ExternalReceipt, JsonValue, ReconciliationOutcome, VerificationOutcome } from '../../action-gateway/src/index.js';

export interface OperatorConfig {
  allowedOrigins: string[];
  allowLocalSandbox?: boolean;
  /** An explicit server configuration, never a connector resource field. */
  allowedPrivateOrigins?: string[];
  secret(reference: string): string | undefined;
}
export interface HttpConnectorDefinition { id: string; baseUrl: string; secretRef: string; timeoutMs?: number }
export interface SourceObject { id: string; revision: string; properties: Record<string, JsonValue> }

export function isPrivateAddress(address: string): boolean {
  let canonical = address.toLowerCase();
  if (isIP(canonical) === 6) canonical = new URL(`http://[${canonical}]`).hostname.slice(1, -1);
  const normalized = canonical.replace(/^::ffff:/, '');
  if (isIP(normalized) === 4) {
    const [a = 0, b = 0] = normalized.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || a === 198 && (b === 18 || b === 19);
  }
  return isIP(normalized) !== 6 || normalized === '::' || normalized === '::1' || /^f[cd]/.test(normalized) || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('::');
}

/** DNS is checked and the chosen address is pinned to the socket; redirects are never followed. */
export async function approvedJsonRequest(config: OperatorConfig, base: string, path: string, options: {
  method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<{ status: number; body: unknown }> {
  const origin = new URL(base);
  if (origin.username || origin.password || origin.search || origin.hash || !['http:', 'https:'].includes(origin.protocol) ||
      !config.allowedOrigins.includes(origin.origin)) throw new Error('Connector origin is not approved by the server');
  const url = new URL(path, `${origin.origin}${origin.pathname.replace(/\/$/, '')}/`);
  if (url.origin !== origin.origin) throw new Error('Connector path escaped its approved origin');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const local = config.allowLocalSandbox === true && ['localhost', '127.0.0.1', '::1', 'source-sandbox'].includes(hostname);
  if (url.protocol !== 'https:' && !local) throw new Error('Remote connectors require HTTPS');
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address) && !local && !config.allowedPrivateOrigins?.includes(url.origin))) {
    throw new Error('Connector address is private or reserved and has not been explicitly approved');
  }
  const pinned = addresses[0]!;
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: options.method ?? 'GET', signal: options.signal,
      headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}), ...options.headers },
      lookup: ((_host: string, lookupOptions: { all?: boolean }, callback: (...args: unknown[]) => void) =>
        lookupOptions.all ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family)) as never,
    }, (response) => {
      let size = 0; const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 1_048_576) { req.destroy(new Error('Connector response exceeds 1 MiB')); } else chunks.push(chunk); });
      response.on('end', () => { try { resolve({ status: response.statusCode ?? 502, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch { reject(new Error('Connector returned invalid JSON')); } });
      response.on('error', reject);
    });
    const deadline = setTimeout(() => req.destroy(new Error('Connector request timed out')), Math.max(100, Math.min(options.timeoutMs ?? 10_000, 30_000)));
    req.once('close', () => clearTimeout(deadline));
    req.on('error', reject); if (payload) req.write(payload); req.end();
  });
}

export class HttpOperator implements ConnectorPort {
  constructor(readonly definition: HttpConnectorDefinition, private readonly config: OperatorConfig) {}
  private async request(tenantId: string, path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
    const secret = this.config.secret(this.definition.secretRef);
    if (!secret) throw new Error('Connector credential reference is unavailable');
    return approvedJsonRequest(this.config, this.definition.baseUrl, path, { method, body, timeoutMs: this.definition.timeoutMs,
      headers: { authorization: `Bearer ${secret}`, 'x-tenant-id': tenantId, ...headers } });
  }
  async object(tenantId: string, id: string): Promise<SourceObject> {
    const result = await this.request(tenantId, `objects/${encodeURIComponent(id)}`);
    if (result.status !== 200 || !isObject(result.body) || result.body.id !== id || typeof result.body.revision !== 'string' || !isObject(result.body.properties)) throw new Error('Source object is unavailable or malformed');
    return result.body as unknown as SourceObject;
  }
  async objects(tenantId: string): Promise<SourceObject[]> {
    const result = await this.request(tenantId, 'objects');
    if (result.status !== 200 || !isObject(result.body) || !Array.isArray(result.body.objects)) throw new Error('Source listing unavailable');
    return result.body.objects as SourceObject[];
  }
  async health(tenantId: string): Promise<Record<string, unknown>> {
    const result = await this.request(tenantId, 'health');
    if (result.status !== 200 || !isObject(result.body)) throw new Error('Source health check failed');
    return result.body;
  }
  async preview(intent: ActionIntent): Promise<ActionPreview> {
    const result = await this.request(intent.tenantId, 'actions/preview', 'POST', { intent });
    if (result.status !== 200 || !isObject(result.body) || typeof result.body.summary !== 'string' || !Array.isArray(result.body.effects)) throw new Error('Source rejected the action preview');
    return result.body as unknown as ActionPreview;
  }
  async execute(intent: ActionIntent, preview: ActionPreview): Promise<ExecutionOutcome> {
    try {
      const result = await this.request(intent.tenantId, 'actions/execute', 'POST', { intent, preview }, {
        'idempotency-key': intent.idempotencyKey, 'if-match': intent.objectRef?.expectedRevision ?? '',
      });
      if (result.status >= 400 && result.status < 500) return { status: 'rejected', reason: 'Source rejected the conditional action' };
      return accepted(result.body) ?? { status: 'unknown', reason: 'Source did not return a valid operation receipt' };
    } catch { return { status: 'unknown', reason: 'Source connection ended without a definitive outcome; reconciliation required' }; }
  }
  async verify(intent: ActionIntent, receipt: ExternalReceipt): Promise<VerificationOutcome> {
    try {
      const operation = await this.reconcile(intent);
      if (operation.status !== 'accepted' || operation.receipt.externalOperationId !== receipt.externalOperationId) return { status: 'unknown', reason: 'Source operation receipt cannot be confirmed' };
      const details = operation.receipt.details;
      if (!isObject(details) || details.objectId !== intent.objectRef?.objectId || typeof details.revision !== 'string' || !isObject(details.expectedProperties) || Object.keys(details.expectedProperties).length === 0) return { status: 'unknown', reason: 'Source receipt has no verifiable object effect contract' };
      const object = await this.object(intent.tenantId, intent.objectRef!.objectId);
      if (object.revision !== details.revision || Object.entries(details.expectedProperties).some(([key, value]) => JSON.stringify(object.properties[key]) !== JSON.stringify(value))) return { status: 'failed', reason: 'Readback did not confirm the source receipt effect' };
      return { status: 'verified', evidence: { objectId: object.id, revision: object.revision, properties: details.expectedProperties as JsonValue, externalOperationId: receipt.externalOperationId } };
    } catch { return { status: 'unknown', reason: 'Source readback unavailable' }; }
  }
  async reconcile(intent: ActionIntent): Promise<ReconciliationOutcome> {
    try {
      const result = await this.request(intent.tenantId, `operations/${encodeURIComponent(intent.idempotencyKey)}`);
      if (result.status === 404) return { status: 'unknown', reason: 'No source operation found; never replay automatically' };
      if (!isObject(result.body) || result.body.intentHash !== intent.intentHash) return { status: 'unknown', reason: 'Source operation does not match the exact intent' };
      return accepted(result.body) ?? { status: 'unknown', reason: 'Source operation remains unresolved' };
    } catch { return { status: 'unknown', reason: 'Source reconciliation unavailable' }; }
  }
}
function accepted(value: unknown): ExecutionOutcome | undefined {
  if (isObject(value) && value.status === 'accepted' && isObject(value.receipt) && typeof value.receipt.externalOperationId === 'string' && typeof value.receipt.acceptedAt === 'string') {
    return { status: 'accepted', receipt: value.receipt as unknown as ExternalReceipt };
  }
  return undefined;
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
