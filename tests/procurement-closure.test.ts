import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionBinding, OntologyBundle } from "../packages/contracts/src/index.js";
import { createReleaseManifest, validateBundle } from "../packages/ontology-kernel/src/index.js";
import { ActionGateway, hashActionBinding, InMemoryActionBindingSource, InMemoryIntentStore, OntologyPolicyPort, type JsonValue } from "../packages/action-gateway/src/index.js";
import { AgentRuntime, GatewayActionToolPort, type RunSpec } from "../packages/agent-runtime/src/index.js";
import { createOntologyToolRegistry, type ToolContext } from "../packages/mcp-gateway/src/index.js";

const clock = () => new Date("2026-09-26T00:00:00.000Z");
const actionTarget = { system: "mock-erp", operation: "approve", resource: "purchase_request" };
const bundle: OntologyBundle = {
  schemaVersion: "2.0",
  id: "procurement-demo",
  namespace: "example.procurement",
  version: "2.0.0",
  name: "Procurement demo",
  sources: [{ id: "erp", system: "mock-erp", kind: "api", resource: "purchase_request" }],
  values: [
    { id: "identifier", name: "Identifier", kind: "string" },
    { id: "status", name: "Status", kind: "enum", enumValues: ["PENDING", "APPROVED"] },
  ],
  sharedProperties: [],
  objects: [{
    id: "PurchaseRequest", name: "Purchase request", primaryKey: "id", sourceRefs: ["erp"],
    properties: [
      { id: "id", valueTypeId: "identifier", required: true },
      { id: "status", valueTypeId: "status", required: true },
    ],
  }],
  relations: [], interfaces: [], rules: [], functions: [], events: [],
  actions: [{
    id: "approveRequest", name: "Approve purchase request", sourceRefs: ["erp"],
    input: [{ id: "requestId", valueTypeId: "identifier", required: true }],
    targetObjectTypeId: "PurchaseRequest", objectIdParameterId: "requestId",
    approval: "always", risk: "high",
    guard: { op: "eq", left: { kind: "fact", path: "request.status" }, right: { kind: "literal", value: "PENDING" } },
    policyIds: ["managerCanApprove"], idempotent: true,
  }],
  policies: [{
    id: "managerCanApprove", name: "Manager can approve", appliesTo: ["approveRequest"],
    effect: "allow", requiredScopes: ["request:approve"],
    guard: { op: "eq", left: { kind: "fact", path: "actor.role" }, right: { kind: "literal", value: "manager" } },
  }],
};

test("one ontology release governs MCP preview and an agent action through source verification", async () => {
  assert.deepEqual(validateBundle(bundle), []);
  const release = createReleaseManifest(bundle, clock().toISOString());
  const binding: ActionBinding = {
    id: "approve-request-mock-erp", version: "1.0.0", tenantId: "tenant-a", environment: "sandbox",
    ontologyRelease: release.bundleHash, actionId: "approveRequest",
    adapter: { id: "mock-erp", version: "1.0.0", target: actionTarget },
    guarantees: { conditionalWrite: true, nativeIdempotency: true, readback: true, reconciliation: true },
  };
  const bindingHash = hashActionBinding(binding);
  const bindings = new InMemoryActionBindingSource([{ binding, state: "active" }]);
  const releaseStatus = { async getStatus(tenantId: string, releaseId: string) {
    return tenantId === "tenant-a" && releaseId === release.releaseId
      ? { tenantId, releaseId, bundleHash: release.bundleHash, state: "active" as const }
      : undefined;
  } };
  let sourceStatus = "PENDING";
  let sourceRevision = "v1";
  let sourceWrites = 0;
  let raceApprovalChecks = 0;
  const gateway = new ActionGateway({
    now: clock,
    store: new InMemoryIntentStore(),
    policy: new OntologyPolicyPort(bundle, release, {
      async load() {
        return { scopes: ["request:approve"], actor: { role: "manager" }, request: { status: sourceStatus }, sourceRevision };
      },
    }, bindings, releaseStatus),
    approvalAuthority: { async verify(approval) {
      if (approval.evidenceId === "race-approval") {
        raceApprovalChecks++;
        if (raceApprovalChecks === 2) sourceRevision = "v4";
        return true;
      }
      return approval.evidenceId === "owner-approval-1";
    } },
    connector: {
      async preview() { return { summary: "Approve PR-42", effects: ["ERP status becomes APPROVED"] }; },
      async execute(intent) {
        if (intent.objectRef?.expectedRevision !== sourceRevision) {
          return { status: "rejected", reason: "ERP revision precondition failed" };
        }
        sourceWrites++;
        sourceStatus = "APPROVED";
        sourceRevision = "v2";
        return { status: "accepted", receipt: { externalOperationId: "erp-op-1", acceptedAt: clock().toISOString() } };
      },
      async verify() {
        return sourceStatus === "APPROVED"
          ? { status: "verified", evidence: { requestId: "PR-42", status: sourceStatus } }
          : { status: "failed", reason: "ERP readback did not confirm approval" };
      },
      async reconcile() { return { status: "pending", reason: "ERP result still unknown" }; },
    },
  });

  const registry = createOntologyToolRegistry({ getPublishedSnapshot: () => ({
    tenantId: "tenant-a", bundle, release,
    capabilities: [{ id: "approveRequest", kind: "action", scopes: ["request:approve"] }],
  }) }, {
    async queryFunction() { throw new Error("No read function published in this fixture"); },
    async previewAction(context, action, input, idempotencyKey) {
      const intent = await gateway.createIntent({
        tenantId: context.tenantId, actorId: context.actorId,
        ontologyRelease: release.bundleHash, actionId: action.id,
        environment: "sandbox", bindingHash, target: binding.adapter.target,
        args: input as JsonValue, idempotencyKey,
        deadlineAt: "2026-09-26T00:10:00.000Z",
        objectRef: { objectTypeId: "PurchaseRequest", objectId: String(input.requestId), expectedRevision: sourceRevision },
      });
      const preview = await gateway.preview(context.tenantId, intent.intent.idempotencyKey);
      return { state: preview.state, intentHash: preview.intent.intentHash, summary: preview.preview?.summary };
    },
  }, releaseStatus);
  const mcpContext: ToolContext = {
    tenantId: "tenant-a", actorId: "manager-a", releaseId: release.releaseId,
    scopes: ["request:approve"], grants: [{ capabilityId: "approveRequest", scopes: ["request:approve"] }],
  };
  const [previewTool] = await registry.listTools(mcpContext);
  if (!previewTool) throw new Error("Published action preview tool was not listed");
  assert.ok(previewTool.name.startsWith("ontology.preview."));
  assert.deepEqual(await registry.listTools({ ...mcpContext, grants: [] }), []);
  const mcpPreview = await registry.callTool(mcpContext, previewTool.name, {
    input: { requestId: "PR-42" }, idempotencyKey: "mcp-preview-1",
  });
  assert.equal(mcpPreview.isError ?? false, false, JSON.stringify(mcpPreview));
  assert.equal((mcpPreview.structuredContent as { state: string }).state, "awaiting_approval");
  assert.equal(sourceWrites, 0);

  const toolDigest = `sha256:${"b".repeat(64)}` as const;
  const runSpec: RunSpec = {
    runId: "agent-run-1", tenantId: "tenant-a", actorId: "manager-a",
    ontologyRelease: release.bundleHash,
    agent: { id: "procurement-agent", version: "1.0.0", digest: release.bundleHash },
    model: { provider: "fixture", id: "deterministic", version: "1" },
    skills: [], tools: [{ name: "approve_purchase", version: "1.0.0", digest: toolDigest, kind: "action" }],
    limits: { maxModelCalls: 3, maxToolCalls: 1, maxContextBytes: 256, deadlineAt: "2026-09-26T00:10:00.000Z" },
  };
  const events: string[] = [];
  const runtime = new AgentRuntime({
    now: clock,
    audit: { async append(event) { events.push(event.kind); } },
    context: { async load() {
      return [{ tenantId: "tenant-a", id: "policy-1", version: "1", provenance: "approved-markdown:policy-1", text: "Managers may approve pending requests." }];
    } },
    model: { async next(request) {
      return request.history.some((entry) => entry.role === "tool")
        ? { type: "final", text: "PR-42 was approved and confirmed by ERP." }
        : { type: "tool", toolName: "approve_purchase", args: { requestId: "PR-42" } };
    } },
    tools: new GatewayActionToolPort(gateway, {
      approve_purchase: { actionId: "approveRequest", environment: "sandbox", bindingHash, target: actionTarget, version: "1.0.0", digest: toolDigest,
        resolveObjectRef: (request) => ({ objectTypeId: "PurchaseRequest", objectId: String((request.args as { requestId: string }).requestId), expectedRevision: sourceRevision }),
      },
    }),
  });
  const first = await runtime.run(runSpec, "Approve PR-42 if permitted");
  assert.equal(first.status, "approval_required");
  assert.equal(sourceWrites, 0);
  const pending = await gateway.get("tenant-a", "agent-run-1:1");
  assert.equal(pending?.state, "awaiting_approval");
  await gateway.approve("tenant-a", "agent-run-1:1", {
    tenantId: "tenant-a", intentHash: pending!.intent.intentHash,
    approverId: "owner-b", decision: "approved", decidedAt: clock().toISOString(),
    expiresAt: "2026-09-26T00:05:00.000Z", evidenceId: "owner-approval-1",
  });
  const done = await runtime.run(runSpec, "Approve PR-42 if permitted", first.checkpoint);
  assert.equal(done.status, "completed");
  assert.equal(done.text, "PR-42 was approved and confirmed by ERP.");
  assert.equal(sourceWrites, 1);
  assert.equal((await gateway.get("tenant-a", "agent-run-1:1"))?.verification?.status, "verified");
  assert.ok(events.includes("run_suspended"));
  assert.ok(events.includes("run_completed"));

  // The same released action is blocked when its live source guard is no longer true.
  await gateway.createIntent({
    tenantId: "tenant-a", actorId: "manager-a", ontologyRelease: release.bundleHash,
    actionId: "approveRequest", environment: "sandbox", bindingHash, target: actionTarget, args: { requestId: "PR-42" },
    deadlineAt: "2026-09-26T00:10:00.000Z",
    objectRef: { objectTypeId: "PurchaseRequest", objectId: "PR-42", expectedRevision: sourceRevision },
    idempotencyKey: "second-attempt",
  });
  assert.equal((await gateway.preview("tenant-a", "second-attempt")).state, "denied");
  assert.equal(sourceWrites, 1);

  // Simulate a source update after the gateway's last policy check. The
  // adapter's conditional write still prevents a stale business effect.
  sourceStatus = "PENDING";
  sourceRevision = "v3";
  await gateway.createIntent({
    tenantId: "tenant-a", actorId: "manager-a", ontologyRelease: release.bundleHash,
    actionId: "approveRequest", environment: "sandbox", bindingHash, target: actionTarget,
    args: { requestId: "PR-43" },
    objectRef: { objectTypeId: "PurchaseRequest", objectId: "PR-43", expectedRevision: "v3" },
    deadlineAt: "2026-09-26T00:10:00.000Z", idempotencyKey: "race",
  });
  const racePreview = await gateway.preview("tenant-a", "race");
  assert.equal(racePreview.state, "awaiting_approval");
  await gateway.approve("tenant-a", "race", {
    tenantId: "tenant-a", intentHash: racePreview.intent.intentHash,
    approverId: "owner-b", decision: "approved", decidedAt: clock().toISOString(),
    expiresAt: "2026-09-26T00:05:00.000Z", evidenceId: "race-approval",
  });
  assert.equal((await gateway.execute("tenant-a", "race")).state, "failed");
  assert.equal(sourceWrites, 1);
});
