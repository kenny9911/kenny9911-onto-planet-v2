import { randomUUID } from 'node:crypto';
import { ActionGateway, OntologyPolicyPort, digestJson, hashActionBinding, type ActionIntent, type ActionBindingSource, type IntentRecord, type IntentStore, type JsonValue } from '../../action-gateway/src/index.js';
import { AgentRuntime, type ContextDocument, type ToolCallRequest, type ToolPort, type ToolResult, type ToolStatus } from '../../agent-runtime/src/index.js';
import { TrustedInvocationBoundary, type PublishedAgent, type RunCheckpointStore } from '../../invocation-boundary/src/index.js';
import type { ActionBinding, OntologyBundle, ReleaseManifest } from '../../contracts/src/index.js';
import { authorizeAction } from '../../ontology-kernel/src/index.js';
import { ObjectServices } from '../../platform-services/src/objects.js';
import { canRead, record, strings, visibleObject } from '../../platform-services/src/common.js';
import { requireScope, PlatformError, type AuditRecord, type BootstrapResponse, type EntityRecord, type JobRecord, type PlatformStore, type Principal } from '../../platform-contracts/src/index.js';
import { HttpOperator, type HttpConnectorDefinition, type OperatorConfig, type SourceObject } from './http-operator.js';
import { HttpDecisionModel, SandboxProcurementModel, type ModelConfig, type ModelToolDefinition } from './model.js';
export * from './http-operator.js';
export * from './model.js';

export interface DurableIntentStore extends IntentStore { list(tenantId: string): Promise<IntentRecord[]>; getById(tenantId: string, id: string): Promise<IntentRecord | undefined> }
export interface ReleasedRunContext { profile: EntityRecord; knowledge: EntityRecord[] }
export interface PlatformRuntimeOptions {
  store: PlatformStore; intents: DurableIntentStore; checkpoints: RunCheckpointStore;
  principalLookup(tenantId: string, actorId: string): Promise<Principal | undefined>;
  operator: OperatorConfig; model?: ModelConfig;
  context?(principal: Principal, prompt: string, maxBytes: number, released?: ReleasedRunContext): Promise<ContextDocument[]>;
  auditEvidence?(tenantId: string, evidenceId: string): Promise<AuditRecord | undefined>;
}
interface AgentTool { name: string; kind: 'read' | 'action'; requiredScopes: string[]; actionId?: string; functionId?: string; connectorId?: string }
interface ToolContract extends ModelToolDefinition { objectIdParameterId: string; targetObjectTypeId?: string }
interface AgentData {
  ontologyRelease: `sha256:${string}`; model: PublishedAgent['model']; tools: AgentTool[];
  limits: PublishedAgent['limits']; contextProfileId?: string; instructions?: string;
  skills?: Array<{ id: string; version: string }>;
}
interface ReleaseData {
  manifest: { ontology: { bundle: OntologyBundle; release: ReleaseManifest; hash: string }; resources: Array<{ kind: string; id: string; revision: number; name?: string; state?: string; data: Record<string, unknown>; hash: string }> };
}
interface RunData extends Record<string, unknown> { prompt: string; agentId: string; publication: PublishedAgent; invocationScopes: string[]; toolDefinitions: AgentTool[]; toolContracts: ToolContract[]; procedures: ContextDocument[]; agentSnapshot: EntityRecord; skillSnapshots: EntityRecord[]; contextSnapshot?: ReleasedRunContext; releaseId: string; actorId: string; result?: unknown; }

export class PlatformRuntime {
  readonly gateway: ActionGateway;
  constructor(private readonly options: PlatformRuntimeOptions) {
    this.gateway = new ActionGateway({ store: options.intents,
      policy: { evaluate: async (intent) => this.evaluate(intent) },
      approvalAuthority: { verify: async (approval, intent) => {
        const principal = await options.principalLookup(intent.tenantId, approval.approverId);
        if (!principal?.scopes.includes('approve') || principal.actorId === intent.actorId || !await this.mayInspectIntent(principal, intent)) return false;
        const evidence = await options.auditEvidence?.(intent.tenantId, approval.evidenceId);
        const events = options.auditEvidence ? (evidence ? [evidence] : []) : await options.store.auditLog(intent.tenantId, 10000);
        return events.some((event) => event.kind === 'approval.decided' && event.subjectId === approval.evidenceId && event.actorId === approval.approverId && event.details.intentHash === intent.intentHash && event.details.decision === approval.decision);
      } },
      connector: {
        preview: async (intent) => (await this.operatorForIntent(intent)).preview(intent),
        execute: async (intent, preview) => (await this.operatorForIntent(intent)).execute(intent, preview),
        verify: async (intent, receipt) => {
          const operator = await this.operatorForIntent(intent), result = await operator.verify(intent, receipt);
          if (result.status === 'verified') {
            const principal = await options.principalLookup(intent.tenantId, intent.actorId);
            if (principal) {
              try { await this.projectObject(principal, operator.definition.id, await operator.object(intent.tenantId, intent.objectRef!.objectId), intent.objectRef!.objectTypeId); }
              catch { await options.store.audit(principal, 'projection.refresh_failed', intent.id, { message: 'Source effect verified; materialized projection needs refresh' }); }
            }
          }
          return result;
        },
        reconcile: async (intent, receipt) => (await this.operatorForIntent(intent)).reconcile(intent),
      },
    });
  }

  async enqueueRun(principal: Principal, input: { agentId: string; prompt: string }): Promise<EntityRecord> {
    principal = structuredClone(principal); input = structuredClone(input); requireScope(principal, 'operate');
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000) throw new PlatformError(400, 'invalid_prompt', 'Enter a task of at most 16,000 characters');
    const live = await this.options.store.get(principal.tenantId, 'agents', input.agentId);
    if (!live || !canRead(principal, live)) throw new PlatformError(403, 'agent_denied', 'Agent access is denied');
    if (!live || live.state !== 'active') throw new PlatformError(409, 'inactive_agent', 'Publish and activate this agent before running it');
    const data = live.data as unknown as AgentData;
    const release = await this.release(principal.tenantId, data.ontologyRelease);
    const released = (release.data as unknown as ReleaseData).manifest.resources.find((item) => item.kind === 'agents' && item.id === live.id);
    if (!released || digestJson(released.data) !== digestJson(live.data)) throw new PlatformError(409, 'unreleased_agent', 'The current agent has changes that are not in its active release');
    const agentSnapshot = this.snapshot(released, live), skillSnapshots: EntityRecord[] = [];
    const resources = (release.data as unknown as ReleaseData).manifest.resources;
    const publication = this.publication(principal.tenantId, live.id, released.revision, data);
    const toolContracts = this.toolContracts(data.tools, (release.data as unknown as ReleaseData).manifest.ontology.bundle);
    const procedures: ContextDocument[] = [{ tenantId: principal.tenantId, id: `agent:${live.id}`, version: publication.agent.version, text: data.instructions ?? '', provenance: `reviewed-agent:${publication.agent.digest}` }];
    for (const skillRef of data.skills ?? []) {
      const skill = (release.data as unknown as ReleaseData).manifest.resources.find((item) => item.kind === 'skills' && item.id === skillRef.id);
      if (!skill) throw new PlatformError(409, 'unreleased_skill', `Skill ${skillRef.id} is absent from this release`);
      const currentSkill = await this.options.store.get(principal.tenantId, 'skills', skill.id);
      if (!currentSkill || !canRead(principal, currentSkill)) throw new PlatformError(403, 'skill_denied', 'Skill access is denied');
      const skillSnapshot = this.snapshot(skill, currentSkill);
      if (!canRead(principal, skillSnapshot)) throw new PlatformError(403, 'skill_denied', 'Released skill access is denied');
      skillSnapshots.push(skillSnapshot);
      const digest = digestJson(skill.data) as `sha256:${string}`;
      publication.skills = [...publication.skills, { id: skillRef.id, version: skillRef.version, digest }];
      procedures.push({ tenantId: principal.tenantId, id: `skill:${skillRef.id}`, version: skillRef.version, text: String(skill.data.instructions ?? ''), provenance: `reviewed-skill:${digest}` });
    }
    let contextSnapshot: ReleasedRunContext | undefined;
    if (data.contextProfileId) {
      const releasedProfile = resources.find((item) => item.kind === 'contextProfiles' && item.id === data.contextProfileId);
      const liveProfile = await this.options.store.get(principal.tenantId, 'contextProfiles', data.contextProfileId);
      if (!releasedProfile || !liveProfile || liveProfile.state !== 'active' || !canRead(principal, liveProfile)) throw new PlatformError(403, 'context_denied', 'Released context profile access is denied');
      const profile = this.snapshot(releasedProfile, liveProfile);
      if (!canRead(principal, profile)) throw new PlatformError(403, 'context_denied', 'Released context profile access is denied');
      const knowledge: EntityRecord[] = [];
      for (const id of Array.isArray(profile.data.knowledgeIds) ? profile.data.knowledgeIds : []) {
        const releasedKnowledge = resources.find((item) => item.kind === 'knowledge' && item.id === id);
        if (!releasedKnowledge) throw new PlatformError(409, 'unreleased_knowledge', 'Context knowledge is absent from the pinned release');
        const liveKnowledge = await this.options.store.get(principal.tenantId, 'knowledge', String(id));
        if (!liveKnowledge || !canRead(principal, liveKnowledge)) continue;
        const snapshot = this.snapshot(releasedKnowledge, liveKnowledge);
        if (canRead(principal, snapshot)) knowledge.push(snapshot);
      }
      contextSnapshot = { profile, knowledge };
    }
    if (procedures.reduce((total, item) => total + Buffer.byteLength(item.text), 0) > publication.limits.maxContextBytes) throw new PlatformError(409, 'procedure_budget', 'Agent instructions and skills exceed its context budget');
    const run = await this.options.store.create(principal, 'runs', { name: input.prompt.slice(0, 80), state: 'queued', data: {
      prompt: input.prompt, agentId: live.id, publication, invocationScopes: [...principal.scopes], toolDefinitions: structuredClone(data.tools), toolContracts, procedures, agentSnapshot, skillSnapshots, ...(contextSnapshot ? { contextSnapshot } : {}), releaseId: release.id, actorId: principal.actorId,
    } });
    await this.options.store.enqueue(principal, 'agent.start', { runId: run.id });
    return run;
  }
  async resumeRun(principal: Principal, id: string): Promise<EntityRecord> {
    requireScope(principal, 'operate'); const run = await this.ownedRun(principal, id);
    if (!['approval_required', 'unknown', 'manual_recovery'].includes(run.state)) throw new PlatformError(409, 'run_not_suspended', 'This run is not waiting to resume');
    if (run.state === 'manual_recovery') throw new PlatformError(409, 'manual_recovery', 'Inspect and reconcile source receipts before continuing this interrupted run');
    const invocationScopes = (run.data as RunData).invocationScopes.filter((scope) => principal.scopes.includes(scope));
    const updated = await this.options.store.update(principal, 'runs', id, run.revision, { state: 'queued_resume', data: { ...run.data, invocationScopes } });
    await this.options.store.enqueue(principal, 'agent.resume', { runId: id }); return updated;
  }
  async cancelRun(principal: Principal, id: string): Promise<EntityRecord> {
    requireScope(principal, 'operate'); const run = await this.ownedRun(principal, id);
    if (['completed', 'cancelled', 'timed_out', 'exhausted', 'failed'].includes(run.state)) return run;
    const pending = (await this.options.intents.list(principal.tenantId)).some((entry) => entry.intent.runId === id && ['executing', 'verifying', 'unknown', 'reconciling'].includes(entry.state));
    const result = await this.options.store.update(principal, 'runs', id, run.revision, { state: pending ? 'cancelled_pending_reconciliation' : 'cancelled' });
    await this.options.store.audit(principal, 'run.cancelled', id, { pendingSourceOutcome: pending }); return result;
  }
  async listApprovals(principal: Principal): Promise<BootstrapResponse['approvals']> {
    requireScope(principal, 'read');
    const accessible: IntentRecord[] = [];
    for (const entry of await this.options.intents.list(principal.tenantId)) {
      if (['awaiting_approval', 'unknown', 'executing', 'reconciling'].includes(entry.state) && await this.mayInspectIntent(principal, entry.intent)) accessible.push(entry);
    }
    return accessible.map((record) => ({
      id: record.intent.id, name: record.intent.actionId, state: record.state, actorId: record.intent.actorId, intentHash: record.intent.intentHash,
      summary: record.preview?.summary ?? record.unknownReason ?? 'Awaiting source outcome', effects: record.preview?.effects ?? [], idempotencyKey: record.intent.idempotencyKey,
      ...(record.intent.runId ? { runId: record.intent.runId } : {}), createdAt: record.intent.createdAt,
    }));
  }
  async decideApproval(principal: Principal, intentId: string, input: { decision: 'approved' | 'rejected'; reason?: string }): Promise<IntentRecord> {
    requireScope(principal, 'approve');
    if (!['approved', 'rejected'].includes(input.decision)) throw new PlatformError(400, 'invalid_decision', 'Choose approved or rejected');
    const record = await this.intent(principal, intentId);
    if (record.intent.actorId === principal.actorId) throw new PlatformError(403, 'independent_approval', 'A different authorized person must approve this request');
    const evidenceId = randomUUID(), decidedAt = new Date().toISOString();
    const expiry = Math.min(Date.now() + (record.policy?.approvalMaxTtlMs ?? 15 * 60_000), Date.parse(record.intent.deadlineAt ?? new Date(Date.now() + 15 * 60_000).toISOString()));
    await this.options.store.audit(principal, 'approval.decided', evidenceId, { intentId, intentHash: record.intent.intentHash, decision: input.decision, reason: input.reason ?? '' });
    const result = await this.gateway.approve(principal.tenantId, record.intent.idempotencyKey, {
      tenantId: principal.tenantId, intentHash: record.intent.intentHash, approverId: principal.actorId,
      decision: input.decision, decidedAt, expiresAt: new Date(expiry).toISOString(), evidenceId, ...(input.reason ? { reason: input.reason } : {}),
    });
    if (record.intent.runId) await this.queueOriginalActor(principal.tenantId, record.intent.runId);
    return result;
  }
  async reconcile(principal: Principal, intentId: string): Promise<IntentRecord> {
    requireScope(principal, 'operate'); const record = await this.intent(principal, intentId);
    const result = await this.gateway.reconcile(principal.tenantId, record.intent.idempotencyKey);
    await this.options.store.audit(principal, 'action.reconciled', intentId, { state: result.state });
    if (record.intent.runId && ['succeeded', 'denied', 'failed'].includes(result.state)) await this.queueOriginalActor(principal.tenantId, record.intent.runId);
    return result;
  }
  async testConnector(principal: Principal, id: string): Promise<Record<string, unknown>> {
    requireScope(principal, 'build'); const connector = await this.options.store.get(principal.tenantId, 'connectors', id);
    if (!connector) throw new PlatformError(404, 'not_found', 'Connector not found');
    const operator = this.operator(connector.id, connector.data); const health = await operator.health(principal.tenantId);
    const records = await operator.objects(principal.tenantId);
    const evidence = { testedAt: new Date().toISOString(), health, objectCount: records.length, checks: ['authenticated source access', 'source listing', 'declared conditional write and operation lookup contract'], scope: 'read-only connectivity; execute/idempotency conformance is covered by sandbox integration tests' };
    await this.options.store.audit(principal, 'connector.tested', id, evidence); return evidence;
  }

  async syncConnector(principal: Principal, id: string): Promise<Record<string, unknown>> {
    if (!principal.scopes.includes('operate')) requireScope(principal, 'build');
    const connector = await this.options.store.get(principal.tenantId, 'connectors', id);
    if (!connector || connector.state !== 'active') throw new PlatformError(404, 'connector_unavailable', 'Active connector not found');
    const binding = connector.data.binding as unknown as ActionBinding;
    const release = await this.release(principal.tenantId, binding.ontologyRelease);
    const objectTypeId = (release.data as unknown as ReleaseData).manifest.ontology.bundle.actions.find((action) => action.id === binding.actionId)?.targetObjectTypeId;
    if (!objectTypeId) throw new PlatformError(409, 'missing_object_type', 'Published connector object type is unavailable');
    const objects = await this.operator(id, connector.data).objects(principal.tenantId);
    for (const object of objects) await this.projectObject(principal, id, object, objectTypeId);
    const evidence = { refreshed: objects.length, observedAt: new Date().toISOString(), mode: 'materialized', sourceWrites: 0 };
    await this.options.store.audit(principal, 'connector.synced', id, evidence); return evidence;
  }

  async previewAction(principal: Principal, input: { actionId: string; args: JsonValue; requestId?: string }): Promise<IntentRecord> {
    requireScope(principal, 'operate'); input = structuredClone(input);
    const releases = (await this.options.store.list(principal.tenantId, 'releases')).filter((entry) => entry.state === 'active');
    const release = releases.find((entry) => (entry.data as unknown as ReleaseData).manifest?.ontology.bundle.actions.some((action) => action.id === input.actionId));
    if (!release) throw new PlatformError(404, 'action_unavailable', 'Action is not published in an active release');
    const manifest = (release.data as unknown as ReleaseData).manifest;
    const action = manifest.ontology.bundle.actions.find((entry) => entry.id === input.actionId)!;
    const objectIdParameterId = action.objectIdParameterId;
    const connector = manifest.resources.find((entry) => entry.kind === 'connectors' && (entry.data.binding as unknown as ActionBinding)?.actionId === input.actionId);
    if (!connector || !objectIdParameterId || !action.targetObjectTypeId || !input.args || typeof input.args !== 'object' || Array.isArray(input.args) || typeof input.args[objectIdParameterId] !== 'string') throw new PlatformError(400, 'invalid_action', 'The published object identifier and an active connector binding are required');
    const visibleTarget = await this.options.store.get(principal.tenantId, 'objects', input.args[objectIdParameterId]);
    if (!visibleTarget || !this.fullObjectAccess(principal, visibleTarget)) throw new PlatformError(403, 'object_denied', 'Target object is unavailable for this principal');
    const binding = connector.data.binding as unknown as ActionBinding;
    const key = `${principal.actorId}:preview:${input.requestId ?? randomUUID()}`;
    if (!/^[A-Za-z0-9._:-]{1,256}$/.test(key)) throw new PlatformError(400, 'invalid_request_id', 'Invalid preview request ID');
    const previous = await this.options.intents.get(principal.tenantId, key);
    if (previous) {
      if (previous.intent.actorId !== principal.actorId || previous.intent.actionId !== input.actionId || digestJson(previous.intent.args) !== digestJson(input.args)) throw new PlatformError(409, 'intent_conflict', 'Preview request ID already binds different arguments');
    }
    const source = await this.operator(connector.id, connector.data).object(principal.tenantId, input.args[objectIdParameterId]);
    const authorized = authorizeAction(manifest.ontology.bundle, input.actionId, {
      tenantId: principal.tenantId, actorId: principal.actorId, scopes: principal.scopes, actor: { role: principal.role }, object: source.properties,
      ...(action.targetObjectTypeId === 'PurchaseOrder' ? { order: source.properties } : {}), args: input.args,
    });
    if (!authorized.allowed) throw new PlatformError(403, 'action_denied', authorized.reason);
    if (previous) return previous;
    await this.gateway.createIntent({ tenantId: principal.tenantId, actorId: principal.actorId, ontologyRelease: manifest.ontology.hash,
      actionId: input.actionId, environment: binding.environment, bindingHash: hashActionBinding(binding), target: binding.adapter.target,
      objectRef: { objectTypeId: action.targetObjectTypeId, objectId: source.id, expectedRevision: source.revision }, deadlineAt: new Date(Date.now() + 5 * 60000).toISOString(), args: input.args, idempotencyKey: key });
    return this.gateway.preview(principal.tenantId, key);
  }

  async handleJob(job: JobRecord): Promise<void> {
    if (!['agent.start', 'agent.resume'].includes(job.kind)) throw new Error(`Unsupported runtime job ${job.kind}`);
    const run = await this.options.store.get(job.tenantId, 'runs', String(job.payload.runId));
    if (!run || run.tenantId !== job.tenantId || run.data.actorId !== job.actorId) throw new PlatformError(404, 'run_not_found', 'Run is unavailable for this job actor');
    if (run.state.startsWith('cancelled') || ['completed', 'failed', 'timed_out', 'exhausted'].includes(run.state)) return;
    const actor = await this.options.principalLookup(job.tenantId, job.actorId);
    if (!actor || actor.tenantId !== job.tenantId || actor.actorId !== job.actorId) {
      await this.failUnauthorizedJob(job, run); throw new Error('Run authorization is no longer available');
    }
    const principal = this.effectivePrincipal(actor, (run.data as RunData).invocationScopes);
    if (!principal.scopes.includes('operate')) { await this.failUnauthorizedJob(job, run); throw new Error('Run authorization is no longer available'); }
    if (run.state === 'running' || job.attempt > 1) {
      // A worker lease can expire after an effect. Never re-run a model or tool on redelivery.
      await this.setRun(principal, run.id, { state: 'manual_recovery', data: { ...run.data, error: 'Worker was interrupted. Reconcile source operations; this job was not replayed.' } }); return;
    }
    const expected = job.kind === 'agent.start' ? 'queued' : 'queued_resume';
    if (run.state !== expected) return;
    await this.options.store.update(principal, 'runs', run.id, run.revision, { state: 'running' });
    try {
      await this.requireRunAccess(principal, run.data as RunData);
      const boundary = this.boundary(principal, run as EntityRecord<RunData>);
      const result = job.kind === 'agent.start'
        ? await boundary.startRun({ credential: 'internal-job', agentId: (run.data as RunData).agentId, prompt: (run.data as RunData).prompt })
        : await boundary.resumeRun({ credential: 'internal-job', runId: run.id });
      const current = await this.options.store.get(principal.tenantId, 'runs', run.id);
      if (current && !current.state.startsWith('cancelled')) await this.setRun(principal, run.id, { state: result.status, data: { ...current.data, result, finishedAt: new Date().toISOString() } });
    } catch (error) {
      const intents = (await this.options.intents.list(principal.tenantId)).filter((item) => item.intent.runId === run.id);
      const uncertain = intents.some((item) => ['unknown', 'executing', 'verifying', 'reconciling'].includes(item.state));
      const current = await this.options.store.get(principal.tenantId, 'runs', run.id);
      if (current && !current.state.startsWith('cancelled')) await this.setRun(principal, run.id, { state: uncertain ? 'manual_recovery' : 'failed', data: { ...current.data, error: error instanceof Error ? error.message : 'Run failed' } });
      throw error;
    }
  }

  private boundary(principal: Principal, run: EntityRecord<RunData>): TrustedInvocationBoundary {
    const data = structuredClone(run.data);
    const runtime = new AgentRuntime({
      model: this.options.model?.mode && this.options.model.mode !== 'sandbox' ? new HttpDecisionModel(this.options.model, fetch, data.toolContracts) : new SandboxProcurementModel(),
      context: { load: async (request) => {
        const currentActor = await this.options.principalLookup(principal.tenantId, principal.actorId);
        if (!currentActor) throw new PlatformError(403, 'run_denied', 'Run authorization is no longer available');
        const currentPrincipal = this.effectivePrincipal(currentActor, data.invocationScopes);
        await this.requireRunAccess(currentPrincipal, data);
        const bytes = data.procedures.reduce((total, item) => total + Buffer.byteLength(item.text), 0);
        const maxBytes = Math.max(0, request.maxBytes - bytes);
        const context = this.options.context ? await this.options.context(currentPrincipal, request.prompt, maxBytes, structuredClone(data.contextSnapshot)) : await this.context(currentPrincipal, request.prompt, maxBytes, data.contextSnapshot);
        return [...data.procedures, ...context];
      } },
      audit: { append: async (event) => { await this.options.store.audit(principal, `runtime.${event.kind}`, run.id, event.details as Record<string, unknown>); } },
      tools: this.tools(principal, run),
    });
    return new TrustedInvocationBoundary({
      identity: { authenticate: async () => {
        const actor = await this.options.principalLookup(principal.tenantId, principal.actorId);
        return actor ? this.effectivePrincipal(actor, data.invocationScopes) : undefined;
      } },
      agents: {
        resolve: async (tenantId, agentId, hash) => {
          if (tenantId !== principal.tenantId || agentId !== data.agentId || hash && hash !== data.publication.agent.digest) return undefined;
          const live = await this.options.store.get(tenantId, 'agents', agentId);
          const release = await this.options.store.get(tenantId, 'releases', data.releaseId);
          if (live?.state !== 'active' || !canRead(principal, live) || release?.state !== 'active') return undefined;
          return structuredClone(data.publication);
        },
        isActive: async (tenantId, agentId, hash) => {
          const live = await this.options.store.get(tenantId, 'agents', agentId), release = await this.options.store.get(tenantId, 'releases', data.releaseId);
          return live?.state === 'active' && canRead(principal, live) && release?.state === 'active' && hash === data.publication.agent.digest;
        },
      },
      runtime, checkpointStore: this.options.checkpoints, actionGrants: { mayPreview: async () => false },
      bindings: this.bindings(), gateway: this.gateway, runId: () => run.id,
    });
  }
  private tools(principal: Principal, run: EntityRecord<RunData>): ToolPort {
    const check = async (request: ToolCallRequest) => {
      const current = await this.options.store.get(principal.tenantId, 'runs', run.id);
      const liveActor = await this.options.principalLookup(principal.tenantId, principal.actorId);
      const actor = liveActor ? this.effectivePrincipal(liveActor, run.data.invocationScopes) : undefined;
      const tool = run.data.toolDefinitions.find((item) => item.name === request.toolName);
      const pin = run.data.publication.tools.find((item) => item.pin.name === request.toolName);
      const contract = run.data.toolContracts.find((item) => item.name === request.toolName);
      if (!current || current.state !== 'running' || !actor || !tool || !pin || !contract || request.tenantId !== principal.tenantId || request.actorId !== principal.actorId ||
          request.toolDigest !== pin.pin.digest || request.toolVersion !== pin.pin.version || !tool.requiredScopes.every((scope) => actor.scopes.includes(scope))) throw new Error('Tool permission or run activation changed');
      await this.requireRunAccess(actor, run.data);
      if (!request.args || typeof request.args !== 'object' || Array.isArray(request.args) || typeof request.args[contract.objectIdParameterId] !== 'string') throw new Error('Published object identifier argument is missing');
      return { tool, contract, objectId: request.args[contract.objectIdParameterId] as string };
    };
    const status = async (request: ToolCallRequest): Promise<ToolStatus> => {
      const { tool, contract, objectId } = await check(request);
      if (tool.kind === 'read') return { status: 'unknown', reason: 'Read result was interrupted; create a new task if needed' };
      const record = await this.options.intents.get(principal.tenantId, request.idempotencyKey);
      if (!record || record.intent.runId !== run.id || record.intent.actorId !== principal.actorId || record.intent.actionId !== tool.actionId || record.intent.objectRef?.objectId !== objectId || record.intent.objectRef?.objectTypeId !== contract.targetObjectTypeId || digestJson(record.intent.args) !== digestJson(request.args)) return { status: 'unknown', reason: 'Exact action intent is unavailable' };
      return record.state === 'ready' ? { status: 'ready' } : toolResult(record);
    };
    return { status, call: async (request): Promise<ToolResult> => {
      const { tool, contract, objectId } = await check(request);
      const release = await this.release(principal.tenantId, request.ontologyRelease);
      const resources = (release.data as unknown as ReleaseData).manifest.resources;
      const connectors = resources.filter((entry) => entry.kind === 'connectors');
      const connector = tool.connectorId ? connectors.find((entry) => entry.id === tool.connectorId) : connectors.length === 1 ? connectors[0] : undefined;
      if (!connector) return { status: 'denied', reason: 'Connector was not included in the active release' };
      const operator = this.operator(connector.id, connector.data);
      if (tool.kind === 'read') {
        const source = await operator.object(principal.tenantId, objectId);
        const liveActor = await this.options.principalLookup(principal.tenantId, principal.actorId);
        const actor = liveActor ? this.effectivePrincipal(liveActor, run.data.invocationScopes) : undefined;
        if (!actor) return { status: 'denied', reason: 'Principal no longer active' };
        return { status: 'completed', output: await this.discloseObject(actor, source) as unknown as JsonValue };
      }
      let record = await this.options.intents.get(principal.tenantId, request.idempotencyKey);
      if (!record) {
        const source = await operator.object(principal.tenantId, objectId);
        const binding = connector.data.binding as unknown as ActionBinding;
        record = await this.gateway.createIntent({ tenantId: principal.tenantId, actorId: principal.actorId, runId: run.id,
          ontologyRelease: request.ontologyRelease, actionId: tool.actionId!, environment: binding.environment, bindingHash: hashActionBinding(binding), target: binding.adapter.target,
          objectRef: { objectTypeId: contract.targetObjectTypeId!, objectId, expectedRevision: source.revision }, deadlineAt: request.deadlineAt, args: request.args, idempotencyKey: request.idempotencyKey });
      } else {
        const existing = await status(request); if (existing.status !== 'ready') return existing;
      }
      if (record.state === 'created') record = await this.gateway.preview(principal.tenantId, request.idempotencyKey);
      if (record.state === 'ready') record = await this.gateway.execute(principal.tenantId, request.idempotencyKey);
      return toolResult(record);
    } };
  }
  private async evaluate(intent: ActionIntent) {
    const deny = (reason: string) => ({ decision: 'deny' as const, reason, approval: 'none' as const, policyVersion: intent.ontologyRelease });
    let principal = await this.options.principalLookup(intent.tenantId, intent.actorId);
    if (!principal?.scopes.includes('operate')) return deny('Invoking principal no longer has operation permission');
    if (intent.runId) {
      const run = await this.options.store.get(intent.tenantId, 'runs', intent.runId); if (!run || run.state.startsWith('cancelled')) return deny('Run was cancelled or is unavailable');
      principal = this.effectivePrincipal(principal, (run.data as RunData).invocationScopes);
      if (!principal.scopes.includes('operate')) return deny('Original invocation did not grant operation permission');
    }
    const authorizedPrincipal = principal;
    if (intent.objectRef) {
      const object = await this.options.store.get(intent.tenantId, 'objects', intent.objectRef.objectId);
      if (!object || !this.fullObjectAccess(authorizedPrincipal, object)) return deny('Target object access is denied');
    }
    let release: EntityRecord; try { release = await this.release(intent.tenantId, intent.ontologyRelease); } catch { return deny('Pinned release is not active'); }
    const ontology = (release.data as unknown as ReleaseData).manifest.ontology;
    const policy = new OntologyPolicyPort(ontology.bundle, ontology.release, { load: async () => {
      const source = await (await this.operatorForIntent(intent)).object(intent.tenantId, intent.objectRef!.objectId);
      return { sourceRevision: source.revision, scopes: authorizedPrincipal.scopes, object: source.properties,
        ...(intent.objectRef?.objectTypeId === 'PurchaseOrder' ? { order: source.properties } : {}),
        actor: { role: authorizedPrincipal.role }, principal: { role: authorizedPrincipal.role, scopes: authorizedPrincipal.scopes } };
    } }, this.bindings(intent.ontologyRelease), { getStatus: async (tenantId, releaseId) => ({ tenantId, releaseId, bundleHash: ontology.release.bundleHash, state: release.state === 'active' ? 'active' : 'inactive' }) });
    return policy.evaluate(intent);
  }
  private bindings(ontologyHash?: string): ActionBindingSource {
    return { resolve: async (tenantId, environment, actionId) => {
      const releases = await this.options.store.list(tenantId, 'releases');
      for (const release of releases.filter((entry) => entry.state === 'active' && (!ontologyHash || (entry.data as unknown as ReleaseData).manifest?.ontology.hash === ontologyHash))) {
        for (const resource of (release.data as unknown as ReleaseData).manifest?.resources ?? []) {
          if (resource.kind !== 'connectors') continue; const binding = resource.data.binding as unknown as ActionBinding;
          if (binding?.tenantId !== tenantId || binding.environment !== environment || binding.actionId !== actionId) continue;
          const live = await this.options.store.get(tenantId, 'connectors', resource.id);
          if (live?.state !== 'active') return undefined;
          return { binding, bindingHash: hashActionBinding(binding), state: 'active' };
        }
      }
      return undefined;
    } };
  }
  private async operatorForIntent(intent: ActionIntent): Promise<HttpOperator> {
    const release = await this.release(intent.tenantId, intent.ontologyRelease);
    const connector = (release.data as unknown as ReleaseData).manifest.resources.find((entry) => entry.kind === 'connectors' && entry.data.binding && hashActionBinding(entry.data.binding as unknown as ActionBinding) === intent.bindingHash);
    if (!connector) throw new Error('Pinned connector binding unavailable');
    const live = await this.options.store.get(intent.tenantId, 'connectors', connector.id);
    if (live?.state !== 'active') throw new Error('Connector has been deactivated');
    return this.operator(connector.id, connector.data);
  }
  private operator(id: string, data: Record<string, unknown>): HttpOperator {
    if (typeof data.baseUrl !== 'string' || typeof data.secretRef !== 'string') throw new Error('Connector endpoint or credential reference missing');
    const definition: HttpConnectorDefinition = { id, baseUrl: data.baseUrl, secretRef: data.secretRef, timeoutMs: typeof data.timeoutMs === 'number' ? data.timeoutMs : 10000 };
    return new HttpOperator(definition, this.options.operator);
  }
  private publication(tenantId: string, id: string, revision: number, data: AgentData): PublishedAgent {
    if (!Array.isArray(data.tools) || !data.limits) throw new PlatformError(400, 'invalid_agent', 'Agent tools and limits are required');
    return { tenantId, id, state: 'active', ontologyRelease: data.ontologyRelease,
      agent: { id, version: `0.1.${revision}`, digest: digestJson({ id, revision, data }) as `sha256:${string}` },
      model: data.model, skills: [], tools: data.tools.map((tool) => ({ pin: { name: tool.name, kind: tool.kind, version: `0.1.${revision}`, digest: digestJson(tool) as `sha256:${string}` }, requiredScopes: tool.requiredScopes })), limits: data.limits };
  }
  private toolContracts(tools: AgentTool[], bundle: OntologyBundle): ToolContract[] {
    return tools.map((tool) => {
      const action = tool.kind === 'action' ? bundle.actions.find((entry) => entry.id === tool.actionId) : undefined;
      const fn = tool.kind === 'read' ? bundle.functions.find((entry) => entry.id === tool.functionId || !tool.functionId && entry.id.toLowerCase() === tool.name.replace(/_/g, '').toLowerCase()) : undefined;
      const definition = action ?? fn;
      const objectIdParameterId = action?.objectIdParameterId ?? fn?.input[0]?.id;
      if (!definition || !objectIdParameterId || tool.kind === 'action' && !action?.targetObjectTypeId) throw new PlatformError(400, 'invalid_tool_contract', `${tool.name} needs a published object lookup or object action contract`);
      const properties: Record<string, unknown> = {};
      for (const parameter of definition.input) {
        const type = bundle.values.find((entry) => entry.id === parameter.valueTypeId);
        if (!type) throw new Error('Published parameter value type is missing');
        properties[parameter.id] = type.kind === 'enum' ? { type: 'string', enum: type.enumValues } : { type: type.kind === 'decimal' ? 'number' : ['date', 'datetime'].includes(type.kind) ? 'string' : type.kind };
      }
      return { name: tool.name, description: definition.description ?? definition.name, objectIdParameterId,
        ...(action?.targetObjectTypeId ? { targetObjectTypeId: action.targetObjectTypeId } : {}),
        inputSchema: { type: 'object', properties, required: definition.input.filter((parameter) => parameter.required).map((parameter) => parameter.id), additionalProperties: false } };
    });
  }
  private async release(tenantId: string, hash: string): Promise<EntityRecord> {
    const release = (await this.options.store.list(tenantId, 'releases')).find((entry) => entry.state === 'active' && (entry.data as unknown as ReleaseData).manifest?.ontology.hash === hash);
    if (!release) throw new PlatformError(409, 'inactive_release', 'The pinned ontology release is not active'); return release;
  }
  private async ownedRun(principal: Principal, id: string): Promise<EntityRecord> {
    const run = await this.options.store.get(principal.tenantId, 'runs', id);
    if (!run || run.data.actorId !== principal.actorId) throw new PlatformError(404, 'run_not_found', 'Run is unavailable for this actor'); return run;
  }
  private effectivePrincipal(actor: Principal, invocationScopes: string[]): Principal {
    return { ...actor, scopes: actor.scopes.filter((scope) => invocationScopes.includes(scope)) };
  }
  private snapshot(released: ReleaseData['manifest']['resources'][number], live: EntityRecord): EntityRecord {
    return { ...structuredClone(live), revision: released.revision, name: released.name ?? live.name, state: released.state ?? live.state, data: structuredClone(released.data) };
  }
  private async requireRunAccess(principal: Principal, data: RunData): Promise<void> {
    if (!data.agentSnapshot || !Array.isArray(data.skillSnapshots)) throw new PlatformError(409, 'missing_run_pins', 'Run procedure access pins are unavailable');
    for (const snapshot of [data.agentSnapshot, ...data.skillSnapshots, ...(data.contextSnapshot ? [data.contextSnapshot.profile] : [])]) {
      const live = await this.options.store.get(principal.tenantId, snapshot.kind, snapshot.id);
      const allowedStates = snapshot.kind === 'skills' ? ['active', 'published', 'approved'] : ['active'];
      if (!live || !allowedStates.includes(live.state) || !allowedStates.includes(snapshot.state) || !canRead(principal, live) || !canRead(principal, snapshot)) throw new PlatformError(403, 'run_resource_denied', 'Run resource access is no longer available');
    }
  }
  private async failUnauthorizedJob(job: JobRecord, run: EntityRecord): Promise<void> {
    // A trusted queue identity may persist failure evidence, but has no tool or
    // source authority after the initiating account/grants have been revoked.
    const auditPrincipal: Principal = { tenantId: job.tenantId, actorId: job.actorId, name: 'Run worker', email: '', role: 'viewer', scopes: [] };
    const uncertain = (await this.options.intents.list(job.tenantId)).some((entry) => entry.intent.runId === run.id && ['unknown', 'executing', 'verifying', 'reconciling'].includes(entry.state));
    await this.setRun(auditPrincipal, run.id, { state: uncertain ? 'manual_recovery' : 'failed', data: { ...run.data, error: 'Run authorization is no longer available' } });
    await this.options.store.audit(auditPrincipal, 'run.authorization_unavailable', run.id, { pendingSourceOutcome: uncertain });
  }
  private fullObjectAccess(principal: Principal, object: EntityRecord): boolean {
    if (!canRead(principal, object)) return false;
    // Approval summaries originate at the source and may describe any protected
    // field. Do not disclose that summary to an actor with a partial field view.
    return Object.values(record(record(object.data.access).fieldRoles)).every((roles) => strings(roles).includes(principal.role));
  }
  private async mayInspectIntent(principal: Principal, intent: ActionIntent): Promise<boolean> {
    if (intent.tenantId !== principal.tenantId || !(intent.actorId === principal.actorId || principal.scopes.includes('approve') || principal.scopes.includes('admin')) || !intent.objectRef) return false;
    const object = await this.options.store.get(principal.tenantId, 'objects', intent.objectRef.objectId);
    return !!object && this.fullObjectAccess(principal, object);
  }
  private async intent(principal: Principal, id: string): Promise<IntentRecord> {
    const record = await this.options.intents.getById(principal.tenantId, id); if (!record || !await this.mayInspectIntent(principal, record.intent)) throw new PlatformError(404, 'intent_not_found', 'Action intent not found'); return record;
  }
  private async queueOriginalActor(tenantId: string, id: string): Promise<void> {
    const run = await this.options.store.get(tenantId, 'runs', id); if (!run || !['approval_required', 'unknown'].includes(run.state)) return;
    const actor = await this.options.principalLookup(tenantId, String(run.data.actorId)); if (!actor?.scopes.includes('operate')) return;
    await this.resumeRun(actor, id);
  }
  private async setRun(principal: Principal, id: string, patch: { state?: string; data?: Record<string, unknown> }): Promise<EntityRecord> {
    const current = await this.options.store.get(principal.tenantId, 'runs', id); if (!current) throw new Error('Run disappeared');
    if (current.state.startsWith('cancelled') || current.state === 'manual_recovery' && patch.state !== 'manual_recovery') return current;
    return this.options.store.update(principal, 'runs', id, current.revision, patch);
  }
  private async projectObject(principal: Principal, connectorId: string, object: SourceObject, objectTypeId: string): Promise<void> {
    if (!object || typeof object.id !== 'string' || typeof object.revision !== 'string' || !object.properties || typeof object.properties !== 'object') throw new Error('Source object projection is malformed');
    const existing = await this.options.store.get(principal.tenantId, 'objects', object.id);
    if (existing && existing.data.objectTypeId !== objectTypeId) throw new Error('Source object ID conflicts with another object type');
    const data = { ...existing?.data, objectTypeId, properties: object.properties, sourceRevision: object.revision, observedAt: new Date().toISOString(),
      source: existing?.data.source ?? { system: connectorId, resource: 'objects', id: object.id },
      access: existing?.data.access ?? { requiredScopes: ['admin'] } };
    if (existing) await this.options.store.update(principal, 'objects', object.id, existing.revision, { state: 'observed', data });
    else await this.options.store.create(principal, 'objects', { id: object.id, name: object.id, state: 'observed', data });
  }
  private async discloseObject(principal: Principal, source: SourceObject): Promise<SourceObject> {
    const object = await this.options.store.get(principal.tenantId, 'objects', source.id);
    if (!object) throw new Error('Source object has no governed disclosure policy; synchronize its projection first');
    const visible = visibleObject(principal, { ...object, data: { ...object.data, properties: source.properties } });
    if (!visible) throw new Error('Object read permission denied');
    return { ...source, properties: visible.data.properties as Record<string, JsonValue> };
  }
  private async context(principal: Principal, prompt: string, maxBytes: number, released?: ReleasedRunContext): Promise<ContextDocument[]> {
    requireScope(principal, 'read'); const result: ContextDocument[] = []; let bytes = 0;
    if (!released) return result;
    const pack = await new ObjectServices(this.options.store, () => new Date()).inspectReleasedContext(principal, { prompt, ...released });
    for (const item of pack.items) {
      const size = Buffer.byteLength(item.text);
      if (bytes + size > maxBytes) continue; bytes += size;
      result.push({ tenantId: principal.tenantId, id: item.id, version: item.sourceRevision, text: item.text, provenance: JSON.stringify(item.source) });
    }
    return result;
  }
}
function toolResult(record: IntentRecord): ToolResult {
  if (record.state === 'awaiting_approval') return { status: 'approval_required', intentHash: record.intent.intentHash, summary: record.preview?.summary ?? 'Independent approval required' };
  if (record.state === 'succeeded') return { status: 'completed', output: { intentHash: record.intent.intentHash, receipt: record.receipt as unknown as JsonValue, verification: record.verification as unknown as JsonValue } };
  if (record.state === 'denied' || record.state === 'failed') return { status: 'denied', reason: String((record.events.at(-1)?.details as Record<string, unknown>)?.reason ?? record.state), intentHash: record.intent.intentHash };
  return { status: 'unknown', reason: record.unknownReason ?? `Action is ${record.state}; reconcile source status`, intentHash: record.intent.intentHash };
}
