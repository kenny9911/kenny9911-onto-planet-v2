import { canonicalJson } from "../../action-gateway/src/index.js";
import type { ActionGateway, ActionTarget, IntentRecord, JsonValue, ObjectRef } from "../../action-gateway/src/index.js";
import type { ToolCallRequest, ToolPort, ToolResult, ToolStatus } from "./types.js";

export interface ActionToolBinding {
  actionId: string;
  environment: string;
  bindingHash: `sha256:${string}`;
  target: ActionTarget;
  version: string;
  digest: string;
  resolveObjectRef?: (request: ToolCallRequest) => ObjectRef;
}

/** Maps pinned action tools to the gateway; never exposes a connector to the model. */
export class GatewayActionToolPort implements ToolPort {
  private readonly bindings: Readonly<Record<string, ActionToolBinding>>;

  constructor(
    private readonly gateway: ActionGateway,
    bindings: Readonly<Record<string, ActionToolBinding>>,
  ) {
    this.bindings = Object.fromEntries(Object.entries(bindings).map(([name, binding]) =>
      [name, { ...binding, target: structuredClone(binding.target) }]));
  }

  async call(request: ToolCallRequest): Promise<ToolResult> {
    request = snapshotRequest(request);
    const binding = this.bindings[request.toolName];
    if (!binding || binding.version !== request.toolVersion || binding.digest !== request.toolDigest) {
      return { status: "denied", reason: "Action tool is not registered at the pinned version and digest" };
    }
    if (request.signal.aborted) return { status: "unknown", reason: "Tool request was aborted before dispatch" };
    const objectRef = binding.resolveObjectRef?.(snapshotRequest(request));
    let record = await this.gateway.createIntent({
      tenantId: request.tenantId,
      actorId: request.actorId,
      runId: request.runId,
      ontologyRelease: request.ontologyRelease,
      actionId: binding.actionId,
      environment: binding.environment,
      bindingHash: binding.bindingHash,
      target: binding.target,
      ...(objectRef ? { objectRef } : {}),
      deadlineAt: request.deadlineAt,
      args: request.args,
      idempotencyKey: request.idempotencyKey,
    });
    if (record.state === "created") record = await this.gateway.preview(request.tenantId, request.idempotencyKey);
    if (record.state === "ready") record = await this.gateway.execute(request.tenantId, request.idempotencyKey);
    return toToolResult(record);
  }

  async status(request: ToolCallRequest): Promise<ToolStatus> {
    request = snapshotRequest(request);
    const binding = this.bindings[request.toolName];
    if (!binding || binding.version !== request.toolVersion || binding.digest !== request.toolDigest) {
      return { status: "denied", reason: "Action tool is not registered at the pinned version and digest" };
    }
    const record = await this.gateway.get(request.tenantId, request.idempotencyKey);
    if (!record) return { status: "unknown", reason: "Action intent is absent; no execution may be assumed" };
    const objectRef = binding.resolveObjectRef?.(snapshotRequest(request));
    if (record.intent.actorId !== request.actorId || record.intent.runId !== request.runId ||
        record.intent.ontologyRelease !== request.ontologyRelease || record.intent.actionId !== binding.actionId ||
        record.intent.environment !== binding.environment || record.intent.bindingHash !== binding.bindingHash ||
        record.intent.deadlineAt !== request.deadlineAt ||
        canonicalJson(record.intent.args) !== canonicalJson(request.args) ||
        canonicalJson(record.intent.target) !== canonicalJson(binding.target) ||
        canonicalJson(objectIdentity(record.intent.objectRef)) !== canonicalJson(objectIdentity(objectRef))) {
      return { status: "denied", reason: "Stored intent does not match pinned action tool" };
    }
    if (record.state === "ready") return { status: "ready" };
    return toToolResult(record);
  }
}

function snapshotRequest(request: ToolCallRequest): ToolCallRequest {
  const { signal, ...snapshot } = request;
  return { ...structuredClone(snapshot), signal };
}

/** Status preserves the intent's original revision: a completed write may advance the live revision. */
function objectIdentity(reference: ObjectRef | undefined): JsonValue {
  return reference ? { objectTypeId: reference.objectTypeId, objectId: reference.objectId } : null;
}

function toToolResult(record: IntentRecord): ToolResult {
  const intentHash = record.intent.intentHash;
  if (record.state === "awaiting_approval") {
    return { status: "approval_required", intentHash, summary: record.preview?.summary ?? "Approval required" };
  }
  if (record.state === "succeeded") {
    const output: JsonValue = {
      intentHash,
      externalOperationId: record.receipt?.externalOperationId ?? null,
      verification: record.verification?.status === "verified" ? record.verification.evidence : null,
    };
    return { status: "completed", output };
  }
  if (record.state === "denied" || record.state === "failed") {
    const latest = record.events.at(-1);
    return { status: "denied", reason: typeof latest?.details === "object" && latest.details && !Array.isArray(latest.details) && typeof latest.details.reason === "string" ? latest.details.reason : record.state, intentHash };
  }
  return { status: "unknown", reason: record.unknownReason ?? `Intent is ${record.state}; reconcile before resuming`, intentHash };
}
