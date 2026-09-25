import { randomUUID } from "node:crypto";
import type { AgentRuntime, ArtifactPin, RunCheckpoint, RunResult, RunSpec, ToolPin } from "../../agent-runtime/src/index.js";
import { hashActionBinding, validateActionBinding, type ActionBindingSource, type ActionGateway, type JsonValue, type ObjectRef } from "../../action-gateway/src/index.js";

/** Supplied only by a trusted authentication adapter; never copied from request JSON. */
export interface Principal {
  tenantId: string;
  actorId: string;
  scopes: readonly string[];
}

export interface IdentityPort {
  authenticate(credential: string): Promise<Principal | undefined>;
}

export interface PublishedAgent {
  tenantId: string;
  id: string;
  state: "active" | "inactive" | "revoked";
  ontologyRelease: `sha256:${string}`;
  agent: ArtifactPin;
  model: RunSpec["model"];
  skills: readonly ArtifactPin[];
  tools: readonly { pin: ToolPin; requiredScopes: readonly string[] }[];
  limits: Omit<RunSpec["limits"], "deadlineAt"> & { maxDurationMs: number };
}

/** Must read a reviewed catalog and activation state, not client-provided pins. */
export interface AgentCatalogPort {
  resolve(tenantId: string, agentId: string): Promise<PublishedAgent | undefined>;
  isActive(tenantId: string, agentId: string, digest: string): Promise<boolean>;
}

export interface ActionGrantPort {
  mayPreview(principal: Principal, actionId: string, environment: string): Promise<boolean>;
}

export interface StoredRun {
  spec: RunSpec;
  prompt: string;
  checkpoint: RunCheckpoint;
}

/** Claims prevent concurrent resume; an interrupted claim needs manual recovery. */
export interface RunCheckpointStore {
  save(record: StoredRun): Promise<void>;
  claim(runId: string, tenantId: string, actorId: string): Promise<StoredRun | undefined>;
  complete(runId: string, result: RunResult): Promise<void>;
  quarantine(runId: string): Promise<void>;
}

export class InMemoryRunCheckpointStore implements RunCheckpointStore {
  private readonly entries = new Map<string, { record: StoredRun; state: "suspended" | "running" | "manual_recovery" }>();

  async save(record: StoredRun): Promise<void> {
    if (this.entries.has(record.spec.runId)) throw new Error("Run ID already exists");
    this.entries.set(record.spec.runId, { record: structuredClone(record), state: "suspended" });
  }

  async claim(runId: string, tenantId: string, actorId: string): Promise<StoredRun | undefined> {
    const entry = this.entries.get(runId);
    if (!entry || entry.state !== "suspended" || entry.record.spec.tenantId !== tenantId || entry.record.spec.actorId !== actorId) return undefined;
    entry.state = "running";
    return structuredClone(entry.record);
  }

  async complete(runId: string, result: RunResult): Promise<void> {
    const entry = this.entries.get(runId);
    if (!entry || entry.state !== "running") throw new Error("Run claim is missing");
    if (result.status === "approval_required" || result.status === "unknown") {
      entry.record.checkpoint = structuredClone(result.checkpoint);
      entry.state = "suspended";
    } else this.entries.delete(runId);
  }

  async quarantine(runId: string): Promise<void> {
    const entry = this.entries.get(runId);
    if (entry) entry.state = "manual_recovery";
  }
}

export interface InvocationBoundaryOptions {
  identity: IdentityPort;
  agents: AgentCatalogPort;
  runtime: Pick<AgentRuntime, "run">;
  checkpointStore: RunCheckpointStore;
  actionGrants: ActionGrantPort;
  bindings: ActionBindingSource;
  gateway: Pick<ActionGateway, "createIntent" | "preview">;
  now?: () => Date;
  runId?: () => string;
}

export class InvocationDeniedError extends Error {}

/** The public-facing request shape carries no tenant, actor, release, tool pins, or connector target. */
export class TrustedInvocationBoundary {
  private readonly now: () => Date;
  private readonly runId: () => string;

  constructor(private readonly options: InvocationBoundaryOptions) {
    this.now = options.now ?? (() => new Date());
    this.runId = options.runId ?? randomUUID;
  }

  async startRun(request: { credential: string; agentId: string; prompt: string }): Promise<PublicRunResult> {
    exactKeys(request, ["credential", "agentId", "prompt"]);
    const principal = await this.principal(request.credential);
    const deployment = await this.options.agents.resolve(principal.tenantId, request.agentId);
    if (!deployment || deployment.state !== "active" || deployment.tenantId !== principal.tenantId || deployment.id !== request.agentId) {
      throw new InvocationDeniedError("Agent is not active for this tenant");
    }
    if (!Number.isInteger(deployment.limits.maxDurationMs) || deployment.limits.maxDurationMs < 1 || deployment.limits.maxDurationMs > 24 * 60 * 60_000) {
      throw new InvocationDeniedError("Published agent has an invalid duration bound");
    }
    const grantedTools = deployment.tools.filter(({ pin, requiredScopes }) =>
      (pin.kind !== "action" || requiredScopes.length > 0) && requiredScopes.every((scope) => principal.scopes.includes(scope)));
    const spec: RunSpec = {
      runId: this.runId(), tenantId: principal.tenantId, actorId: principal.actorId,
      ontologyRelease: deployment.ontologyRelease,
      agent: structuredClone(deployment.agent), model: structuredClone(deployment.model),
      skills: structuredClone(deployment.skills), tools: grantedTools.map((entry) => structuredClone(entry.pin)),
      limits: {
        maxModelCalls: deployment.limits.maxModelCalls,
        maxToolCalls: deployment.limits.maxToolCalls,
        maxContextBytes: deployment.limits.maxContextBytes,
        deadlineAt: new Date(this.now().getTime() + deployment.limits.maxDurationMs).toISOString(),
      },
    };
    const result = await this.options.runtime.run(spec, request.prompt);
    if (result.status === "approval_required" || result.status === "unknown") {
      await this.options.checkpointStore.save({ spec, prompt: request.prompt, checkpoint: result.checkpoint });
    }
    return publicResult(spec.runId, result);
  }

  async resumeRun(request: { credential: string; runId: string }): Promise<PublicRunResult> {
    exactKeys(request, ["credential", "runId"]);
    const principal = await this.principal(request.credential);
    const record = await this.options.checkpointStore.claim(request.runId, principal.tenantId, principal.actorId);
    if (!record) throw new InvocationDeniedError("Run is unavailable for resume");
    if (record.spec.tenantId !== principal.tenantId || record.spec.actorId !== principal.actorId ||
        !(await this.options.agents.isActive(principal.tenantId, record.spec.agent.id, record.spec.agent.digest))) {
      await this.options.checkpointStore.quarantine(request.runId);
      throw new InvocationDeniedError("Run principal or agent activation changed");
    }
    try {
      const result = await this.options.runtime.run(record.spec, record.prompt, record.checkpoint);
      await this.options.checkpointStore.complete(request.runId, result);
      return publicResult(request.runId, result);
    } catch (error) {
      await this.options.checkpointStore.quarantine(request.runId);
      throw error;
    }
  }

  async previewAction(request: {
    credential: string; actionId: string; environment: string; args: JsonValue;
    objectRef?: ObjectRef; requestId: string;
  }): Promise<{ state: string; intentHash: string; summary?: string }> {
    exactKeys(request, ["credential", "actionId", "environment", "args", "objectRef", "requestId"]);
    const principal = await this.principal(request.credential);
    if (!(await this.options.actionGrants.mayPreview(principal, request.actionId, request.environment))) {
      throw new InvocationDeniedError("Action preview grant is absent");
    }
    const snapshot = await this.options.bindings.resolve(principal.tenantId, request.environment, request.actionId);
    if (!snapshot || snapshot.state !== "active" || validateActionBinding(snapshot.binding).length ||
        hashActionBinding(snapshot.binding) !== snapshot.bindingHash || snapshot.binding.tenantId !== principal.tenantId ||
        snapshot.binding.environment !== request.environment || snapshot.binding.actionId !== request.actionId) {
      throw new InvocationDeniedError("Active action binding is unavailable");
    }
    if (!request.requestId || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId)) throw new InvocationDeniedError("Invalid request ID");
    const intent = await this.options.gateway.createIntent({
      tenantId: principal.tenantId, actorId: principal.actorId,
      ontologyRelease: snapshot.binding.ontologyRelease,
      actionId: request.actionId, environment: request.environment,
      bindingHash: snapshot.bindingHash, target: snapshot.binding.adapter.target,
      ...(request.objectRef ? { objectRef: request.objectRef } : {}),
      args: request.args,
      deadlineAt: new Date(this.now().getTime() + 5 * 60_000).toISOString(),
      idempotencyKey: `${principal.actorId}:${request.requestId}`,
    });
    const preview = await this.options.gateway.preview(principal.tenantId, intent.intent.idempotencyKey);
    return { state: preview.state, intentHash: preview.intent.intentHash,
      ...(preview.preview ? { summary: preview.preview.summary } : {}) };
  }

  private async principal(credential: string): Promise<Principal> {
    if (typeof credential !== "string" || !credential) throw new InvocationDeniedError("Authentication is required");
    const principal = await this.options.identity.authenticate(credential);
    if (!principal?.tenantId || !principal.actorId || !Array.isArray(principal.scopes)) {
      throw new InvocationDeniedError("Authentication failed");
    }
    return principal;
  }
}

export interface PublicRunResult {
  runId: string;
  status: RunResult["status"];
  text?: string;
  reason?: string;
}

function publicResult(runId: string, result: RunResult): PublicRunResult {
  return { runId, status: result.status, ...(result.text ? { text: result.text } : {}),
    ...(result.reason ? { reason: result.reason } : {}) };
}

function exactKeys(value: object, keys: readonly string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new InvocationDeniedError("Request contains authority fields outside the public invocation contract");
  }
}
