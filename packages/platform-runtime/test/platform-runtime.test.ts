import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { PostgresStore, PgIntentStore, PgCheckpointStore, pg } from '../../persistence/src/index.js';
import { roleScopes, type Principal, type JobRecord, type PlatformStore, type EntityRecord } from '../../platform-contracts/src/index.js';
import { seedPlatform } from '../../platform-services/src/seed.js';
import { ObjectServices } from '../../platform-services/src/objects.js';
import { createSourceSandbox, PgSourcePersistence } from '../../../apps/source-sandbox/src/index.js';
import { runWorker } from '../../../apps/worker/src/index.js';
import { PlatformRuntime, HttpOperator, HttpDecisionModel, approvedJsonRequest, isPrivateAddress, parseDecision, SandboxProcurementModel, type ReleasedRunContext } from '../src/index.js';

test('operator denies unapproved origins, private addresses, and model-invented tools', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('169.254.169.254'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('0:0:0:0:0:ffff:7f00:1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  const config = { allowedOrigins: ['https://127.0.0.1'], secret: () => undefined };
  await assert.rejects(approvedJsonRequest(config, 'https://127.0.0.1', 'health'), /private or reserved/);
  await assert.rejects(approvedJsonRequest(config, 'https://example.com', 'health'), /not approved/);
  assert.throws(() => parseDecision('{"type":"tool","toolName":"raw_write","argsJson":"{}"}', ['lookup_order']), /invalid decision/);
});

test('HTTP model adapter sends the published custom tool schema and validates the decision', async () => {
  const transport: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const task = JSON.parse(body.input[1].content);
    assert.deepEqual(task.allowedTools[0].inputSchema.properties, { assetId: { type: 'string' } });
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ type: 'tool', toolName: 'inspect_asset', argsJson: '{"assetId":"ASSET-1"}', text: null }) }] }] }), { status: 200 });
  };
  const model = new HttpDecisionModel({ mode: 'openai', model: 'configured-model', apiKey: 'test-only-placeholder' }, transport,
    [{ name: 'inspect_asset', description: 'Inspect equipment', inputSchema: { type: 'object', properties: { assetId: { type: 'string' } }, required: ['assetId'], additionalProperties: false } }]);
  const decision = await model.next({ spec: { model: { provider: 'openai', id: 'configured-model' }, tools: [{ name: 'inspect_asset', kind: 'read' }] } as never, context: [], history: [], signal: new AbortController().signal });
  assert.deepEqual(decision, { type: 'tool', toolName: 'inspect_asset', args: { assetId: 'ASSET-1' } });
});

test('sandbox model requires an explicit approval command and does not turn a negation into a write', async () => {
  const model = new SandboxProcurementModel();
  const decision = await model.next({ spec: { tools: [{ name: 'approve_order' }] } as never,
    context: [], signal: new AbortController().signal,
    history: [{ role: 'user', text: 'Do not approve PO-2026-001' }, { role: 'tool', toolName: 'lookup_order', result: { status: 'completed', output: { status: 'PENDING' } } }],
  });
  assert.equal(decision.type, 'final');
});

test('worker drains an in-flight lease heartbeat before shutdown and honors a lost lease', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const abort = new AbortController();
  let releaseJob!: () => void, rejectHeartbeat!: (reason: Error) => void, jobStarted!: () => void;
  const started = new Promise<void>((resolve) => { jobStarted = resolve; });
  const jobWait = new Promise<void>((resolve) => { releaseJob = resolve; });
  const heartbeatWait = new Promise<void>((_resolve, reject) => { rejectHeartbeat = reject; });
  let completed = 0, settled = false;
  const worker = runWorker({ signal: abort.signal, leaseMs: 3000,
    runtime: { handleJob: async () => { jobStarted(); await jobWait; } },
    queue: {
      claimJob: async () => ({ id: 'job', tenantId: 'tenant', actorId: 'actor', kind: 'agent.start', state: 'running', payload: {}, attempt: 1, leaseToken: 'lease', createdAt: new Date().toISOString() }),
      heartbeatJob: () => heartbeatWait,
      completeJob: async () => { completed++; },
    },
  }).then(() => { settled = true; });
  await started; t.mock.timers.tick(1000);
  abort.abort(); abort.abort(); releaseJob();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(settled, false, 'Caller must not close the pool while heartbeat is pending');
  rejectHeartbeat(new Error('Lease ownership lost during shutdown'));
  await worker;
  assert.equal(completed, 0, 'A lost lease must not complete a job');
});

test('durable run crosses HTTP source, independent approval, restart, readback and idempotent receipt', { skip: !process.env.DATABASE_URL }, async () => {
  const schema = `onto_runtime_test_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  const db = new PostgresStore(pool); await db.migrate();
  const tenantId = `runtime-test-${randomUUID()}`;
  const principal = (actorId: string): Principal => ({ tenantId, actorId, name: actorId, email: `${actorId}@example.com`, role: 'admin', scopes: [...roleScopes.admin] });
  const alice = principal('alice'), bob = principal('bob');
  let aliceScopes = [...alice.scopes];
  let aliceActive = true;
  const source = new PgSourcePersistence(pool); await source.migrate(); await source.seed(tenantId);
  let uncertainExecutions = 0;
  const faultingSource = new Proxy(source, { get(target, property) {
    if (property === 'approve') return async (...args: Parameters<PgSourcePersistence['approve']>) => {
      const result = await target.approve(...args);
      if (args[1].objectRef?.objectId === 'PO-2026-006') { uncertainExecutions++; throw new Error('Connection ended after source commit'); }
      return result;
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const token = randomUUID(); const server = createSourceSandbox({ persistence: faultingSource, token, tenantId });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const origin = `http://127.0.0.1:${address.port}`;
  const queued: JobRecord[] = [];
  const store: PlatformStore = new Proxy(db, { get(target, property) {
    if (property === 'enqueue') return async (p: Principal, kind: string, payload: Record<string, unknown>): Promise<JobRecord> => {
      const job: JobRecord = { id: randomUUID(), tenantId: p.tenantId, actorId: p.actorId, kind, payload, state: 'queued', attempt: 1, createdAt: new Date().toISOString() }; queued.push(job); return job;
    };
    const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const operator = { allowedOrigins: [origin], allowLocalSandbox: true, secret: () => token };
  const options = { store, intents: new PgIntentStore(pool), checkpoints: new PgCheckpointStore(pool), operator,
    principalLookup: async (tenant: string, actor: string) => tenant === tenantId ? (actor === alice.actorId ? aliceActive ? { ...alice, scopes: aliceScopes } : undefined : actor === bob.actorId ? bob : undefined) : undefined };
  const originalSourceUrl = process.env.SOURCE_SANDBOX_URL;
  try {
    await pool.query('INSERT INTO tenants(id,name) VALUES($1,$1)', [tenantId]);
    process.env.SOURCE_SANDBOX_URL = origin; await seedPlatform(store, alice);
    const firstRuntime = new PlatformRuntime(options);

    const restore = async (original: EntityRecord) => {
      const current = (await store.get(tenantId, original.kind, original.id))!;
      await store.update(alice, original.kind, original.id, current.revision, { data: original.data, state: original.state });
    };
    const agent = (await store.get(tenantId, 'agents', 'procurement-agent'))!;
    await store.update(alice, 'agents', agent.id, agent.revision, { data: { ...agent.data, access: { actorIds: ['bob'] } } });
    await assert.rejects(firstRuntime.enqueueRun(alice, { agentId: agent.id, prompt: 'Inspect PO-2026-002' }), /Agent access is denied/);
    await restore(agent);
    const skill = (await store.get(tenantId, 'skills', 'enterprise-operator'))!;
    await store.update(alice, 'skills', skill.id, skill.revision, { data: { ...skill.data, access: { actorIds: ['bob'] } } });
    await assert.rejects(firstRuntime.enqueueRun(alice, { agentId: agent.id, prompt: 'Inspect PO-2026-002' }), /Skill access is denied/);
    await restore(skill);

    const revokedSkillRun = await firstRuntime.enqueueRun(alice, { agentId: agent.id, prompt: 'Approve PO-2026-002' });
    const currentSkill = (await store.get(tenantId, 'skills', skill.id))!;
    await store.update(alice, 'skills', skill.id, currentSkill.revision, { data: { ...skill.data, access: { actorIds: ['bob'] } } });
    await assert.rejects(firstRuntime.handleJob(queued.shift()!), /Run resource access/);
    assert.equal((await store.get(tenantId, 'runs', revokedSkillRun.id))?.state, 'failed');
    assert.equal((await options.intents.list(tenantId)).some((entry) => entry.intent.runId === revokedSkillRun.id), false);
    await restore(skill);

    for (const revoke of ['actor', 'scope']) {
      const revokedRun = await firstRuntime.enqueueRun(alice, { agentId: agent.id, prompt: 'Approve PO-2026-002' });
      if (revoke === 'actor') aliceActive = false; else aliceScopes = aliceScopes.filter((scope) => scope !== 'operate');
      await assert.rejects(firstRuntime.handleJob(queued.shift()!), /Run authorization is no longer available/);
      assert.equal((await store.get(tenantId, 'runs', revokedRun.id))?.state, 'failed');
      assert.equal((await options.intents.list(tenantId)).some((entry) => entry.intent.runId === revokedRun.id), false);
      assert.equal((await source.get(tenantId, 'PO-2026-002'))?.revision, '1');
      aliceActive = true; aliceScopes = [...alice.scopes];
    }

    let loadedContext: ReleasedRunContext | undefined, loadedKnowledgeText = '';
    const pinnedRuntime = new PlatformRuntime({ ...options, context: async (actor, prompt, _maxBytes, released) => {
      assert.ok(released); loadedContext = structuredClone(released);
      const pack = await new ObjectServices(store, () => new Date()).inspectReleasedContext(actor, { prompt, ...released });
      loadedKnowledgeText = pack.items.filter((item) => item.kind === 'knowledge').map((item) => item.text).join('\n');
      return pack.items.map((item) => ({ tenantId, id: item.id, version: item.sourceRevision, text: item.text, provenance: JSON.stringify(item.source) }));
    } });
    const profile = (await store.get(tenantId, 'contextProfiles', 'procurement-context'))!;
    const knowledge = (await store.get(tenantId, 'knowledge', 'procurement-policy'))!;
    const pinnedRun = await pinnedRuntime.enqueueRun(alice, { agentId: agent.id, prompt: 'Inspect PO-2026-002' });
    await store.update(alice, 'contextProfiles', profile.id, profile.revision, { data: { ...profile.data, knowledgeIds: [], maxBytes: 32 } });
    await store.update(alice, 'knowledge', knowledge.id, knowledge.revision, { data: { ...knowledge.data, markdown: 'UNREVIEWED LIVE CONTENT' } });
    await pinnedRuntime.handleJob(queued.shift()!);
    assert.equal((await store.get(tenantId, 'runs', pinnedRun.id))?.state, 'completed');
    assert.deepEqual(loadedContext?.profile.data.knowledgeIds, ['procurement-policy']);
    assert.equal(loadedContext?.knowledge[0]?.data.markdown, knowledge.data.markdown);
    assert.ok(loadedKnowledgeText.length > 0);
    assert.equal(loadedKnowledgeText.includes('UNREVIEWED LIVE CONTENT'), false);
    await restore(profile); await restore(knowledge);

    const liveKnowledge = (await store.get(tenantId, 'knowledge', knowledge.id))!;
    await store.update(alice, 'knowledge', knowledge.id, liveKnowledge.revision, { data: { ...knowledge.data, access: { actorIds: ['bob'] } } });
    const restrictedContext = await firstRuntime.enqueueRun(alice, { agentId: agent.id, prompt: 'Inspect PO-2026-002' });
    assert.deepEqual((restrictedContext.data.contextSnapshot as ReleasedRunContext).knowledge, []);
    await firstRuntime.cancelRun(alice, restrictedContext.id); await firstRuntime.handleJob(queued.shift()!);
    await restore(knowledge);

    const run = await firstRuntime.enqueueRun(alice, { agentId: 'procurement-agent', prompt: 'Approve PO-2026-001' });
    await firstRuntime.handleJob(queued.shift()!);
    assert.equal((await store.get(tenantId, 'runs', run.id))?.state, 'approval_required');
    assert.equal((await source.get(tenantId, 'PO-2026-001'))?.properties.status, 'PENDING');
    const approval = (await firstRuntime.listApprovals(alice))[0]!;
    assert.ok(approval);
    const approvalObject = (await store.get(tenantId, 'objects', 'PO-2026-001'))!;
    await store.update(alice, 'objects', approvalObject.id, approvalObject.revision, { data: { ...approvalObject.data, access: { actorIds: ['alice'] } } });
    assert.equal((await firstRuntime.listApprovals(bob)).some((item) => item.id === approval.id), false);
    await assert.rejects(firstRuntime.decideApproval(bob, approval.id, { decision: 'approved' }), /Action intent not found/);
    await assert.rejects(firstRuntime.reconcile(bob, approval.id), /Action intent not found/);
    await restore(approvalObject);
    const visibleApprovalObject = (await store.get(tenantId, 'objects', approvalObject.id))!;
    await store.update(alice, 'objects', approvalObject.id, visibleApprovalObject.revision, { data: { ...approvalObject.data, access: { fieldRoles: { amount: ['operator'] } } } });
    assert.equal((await firstRuntime.listApprovals(bob)).some((item) => item.id === approval.id), false);
    await assert.rejects(firstRuntime.decideApproval(bob, approval.id, { decision: 'approved' }), /Action intent not found/);
    await restore(approvalObject);
    assert.deepEqual(await firstRuntime.listApprovals({ ...principal('viewer'), role: 'viewer', scopes: ['read'] }), []);
    await assert.rejects(firstRuntime.decideApproval(alice, approval.id, { decision: 'approved' }), /different authorized person/);
    await firstRuntime.decideApproval(bob, approval.id, { decision: 'approved', reason: 'Verified sample order' });
    // New orchestrator and PostgreSQL store objects simulate a process restart at the approval boundary.
    const resumedRuntime = new PlatformRuntime({ ...options, intents: new PgIntentStore(pool), checkpoints: new PgCheckpointStore(pool) });
    await resumedRuntime.handleJob(queued.shift()!);
    assert.equal((await store.get(tenantId, 'runs', run.id))?.state, 'completed');
    const record = await options.intents.getById(tenantId, approval.id); assert.equal(record?.state, 'succeeded'); assert.equal(record?.verification?.status, 'verified');
    assert.equal((await source.get(tenantId, 'PO-2026-001'))?.revision, '2');
    const projected = await store.get(tenantId, 'objects', 'PO-2026-001');
    assert.equal((projected?.data.properties as Record<string, unknown>).status, 'APPROVED');
    assert.equal(projected?.data.sourceRevision, '2');
    assert.ok(projected?.data.access); assert.ok(projected?.data.links);
    const http = new HttpOperator({ id: 'sandbox-erp', baseUrl: origin, secretRef: 'env:SOURCE_SANDBOX_TOKEN' }, operator);
    assert.equal((await http.execute(record!.intent, record!.preview!)).status, 'accepted');
    assert.equal((await source.get(tenantId, 'PO-2026-001'))?.revision, '2');
    assert.equal((await http.reconcile(record!.intent)).status, 'accepted');
    const connector = await store.get(tenantId, 'connectors', 'sandbox-erp'); await resumedRuntime.testConnector(alice, 'sandbox-erp');
    assert.equal((await store.get(tenantId, 'connectors', 'sandbox-erp'))?.revision, connector?.revision);
    const sync = await resumedRuntime.syncConnector(alice, 'sandbox-erp'); assert.equal(sync.refreshed, 6);

    const narrowed = { ...alice, scopes: ['read', 'operate', 'order:read'] };
    const narrowedRun = await resumedRuntime.enqueueRun(narrowed, { agentId: 'procurement-agent', prompt: 'Approve PO-2026-005' });
    await resumedRuntime.handleJob(queued.shift()!);
    assert.equal((await store.get(tenantId, 'runs', narrowedRun.id))?.state, 'completed');
    assert.equal((await options.intents.list(tenantId)).some((entry) => entry.intent.runId === narrowedRun.id), false);
    await assert.rejects(resumedRuntime.previewAction(narrowed, { actionId: 'approveOrder', args: { orderId: 'PO-2026-005' } }), /scope|policy/i);
    await resumedRuntime.previewAction(alice, { actionId: 'approveOrder', args: { orderId: 'PO-2026-005' }, requestId: 'scope-bound-preview' });
    await assert.rejects(resumedRuntime.previewAction(narrowed, { actionId: 'approveOrder', args: { orderId: 'PO-2026-005' }, requestId: 'scope-bound-preview' }), /scope|policy/i);
    assert.equal((await source.get(tenantId, 'PO-2026-005'))?.revision, '1');

    const uncertainRun = await resumedRuntime.enqueueRun(alice, { agentId: 'procurement-agent', prompt: 'Approve PO-2026-006' });
    await resumedRuntime.handleJob(queued.shift()!);
    const uncertainApproval = (await resumedRuntime.listApprovals(bob)).find((entry) => entry.runId === uncertainRun.id)!;
    await resumedRuntime.decideApproval(bob, uncertainApproval.id, { decision: 'approved' });
    await resumedRuntime.handleJob(queued.shift()!);
    assert.equal((await store.get(tenantId, 'runs', uncertainRun.id))?.state, 'unknown');
    assert.equal((await source.get(tenantId, 'PO-2026-006'))?.revision, '2');
    assert.equal((await resumedRuntime.reconcile(bob, uncertainApproval.id)).state, 'succeeded');
    await resumedRuntime.handleJob(queued.shift()!);
    assert.equal((await store.get(tenantId, 'runs', uncertainRun.id))?.state, 'completed');
    assert.equal(uncertainExecutions, 1);

    const deniedRun = await resumedRuntime.enqueueRun(alice, { agentId: 'procurement-agent', prompt: 'Approve PO-2026-004' });
    await resumedRuntime.handleJob(queued.shift()!);
    assert.equal((await options.intents.list(tenantId)).find((entry) => entry.intent.runId === deniedRun.id)?.state, 'denied');
    assert.equal((await source.get(tenantId, 'PO-2026-004'))?.revision, '1');

    const cancelled = await resumedRuntime.enqueueRun(alice, { agentId: 'procurement-agent', prompt: 'Approve PO-2026-002' });
    await resumedRuntime.cancelRun(alice, cancelled.id); await resumedRuntime.handleJob(queued.shift()!);
    assert.equal((await source.get(tenantId, 'PO-2026-002'))?.revision, '1');
    assert.equal((await store.get(tenantId, 'runs', cancelled.id))?.state, 'cancelled');

    const revoked = await resumedRuntime.enqueueRun(alice, { agentId: 'procurement-agent', prompt: 'Approve PO-2026-003' });
    await resumedRuntime.handleJob(queued.shift()!);
    const pending = (await resumedRuntime.listApprovals(bob)).find((entry) => entry.runId === revoked.id)!;
    await resumedRuntime.decideApproval(bob, pending.id, { decision: 'approved' });
    aliceScopes = aliceScopes.filter((scope) => scope !== 'order:write');
    await assert.rejects(resumedRuntime.handleJob(queued.shift()!), /scope grant changed/);
    assert.equal((await source.get(tenantId, 'PO-2026-003'))?.revision, '1');
  } finally {
    if (originalSourceUrl === undefined) delete process.env.SOURCE_SANDBOX_URL; else process.env.SOURCE_SANDBOX_URL = originalSourceUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
  }
});
