import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionBinding } from "../../contracts/src/index.js";
import { ActionGateway, hashActionBinding, InMemoryActionBindingSource, InMemoryIntentStore } from "../../action-gateway/src/index.js";
import type { RunCheckpoint, RunResult, RunSpec } from "../../agent-runtime/src/index.js";
import { InMemoryRunCheckpointStore, InvocationDeniedError, TrustedInvocationBoundary, type PublishedAgent } from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const toolDigest = `sha256:${"b".repeat(64)}` as const;
const clock = () => new Date("2026-09-26T00:00:00.000Z");
const binding: ActionBinding = {
  id: "release-order", version: "1.0.0", tenantId: "tenant-a", environment: "sandbox",
  ontologyRelease: digest, actionId: "releaseOrder",
  adapter: { id: "mock-erp", version: "1.0.0", target: { system: "erp", operation: "release", resource: "orders" } },
  guarantees: { conditionalWrite: true, nativeIdempotency: true, readback: true, reconciliation: true },
};
const deployment: PublishedAgent = {
  tenantId: "tenant-a", id: "order-agent", state: "active", ontologyRelease: digest,
  agent: { id: "order-agent", version: "1.0.0", digest },
  model: { provider: "fixture", id: "deterministic", version: "1" },
  skills: [],
  tools: [
    { pin: { name: "lookup_order", version: "1.0.0", digest: toolDigest, kind: "read" }, requiredScopes: ["order:read"] },
    { pin: { name: "release_order", version: "1.0.0", digest: toolDigest, kind: "action" }, requiredScopes: ["order:write"] },
  ],
  limits: { maxModelCalls: 2, maxToolCalls: 1, maxContextBytes: 100, maxDurationMs: 10 * 60_000 },
};

function fixture(run: (spec: RunSpec, prompt: string, checkpoint?: RunCheckpoint) => Promise<RunResult>) {
  const gateway = new ActionGateway({
    now: clock,
    store: new InMemoryIntentStore(),
    policy: { async evaluate() { return { decision: "allow", reason: "fixture", approval: "none", policyVersion: digest }; } },
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { return { summary: "Release order preview", effects: ["status changes"] }; },
      async execute() { throw new Error("Preview boundary must not execute"); },
      async verify() { throw new Error("Preview boundary must not verify"); },
      async reconcile() { throw new Error("Preview boundary must not reconcile"); },
    },
  });
  const bindings = new InMemoryActionBindingSource([{ binding, state: "active" }]);
  const boundary = new TrustedInvocationBoundary({
    now: clock, runId: () => "server-run-1",
    identity: { async authenticate(credential) {
      if (credential === "alice-token") return { tenantId: "tenant-a", actorId: "alice", scopes: ["order:read", "order:write"] };
      if (credential === "bob-token") return { tenantId: "tenant-a", actorId: "bob", scopes: ["order:read"] };
      return undefined;
    } },
    agents: {
      async resolve(tenantId, agentId) { return tenantId === "tenant-a" && agentId === "order-agent" ? deployment : undefined; },
      async isActive(tenantId, agentId, pin) { return tenantId === "tenant-a" && agentId === "order-agent" && pin === digest; },
    },
    runtime: { run }, checkpointStore: new InMemoryRunCheckpointStore(),
    actionGrants: { async mayPreview(principal) { return principal.scopes.includes("order:write"); } },
    bindings, gateway,
  });
  return { boundary, gateway, bindings };
}

test("authenticated principal and reviewed catalog construct the run; spoofed authority fields are rejected", async () => {
  const seen: RunSpec[] = [];
  const { boundary } = fixture(async (spec, prompt) => {
    seen.push(spec);
    assert.equal(prompt, "Explain order");
    return { status: "completed", text: "Done", checkpoint: {
      specHash: "fixture", promptHash: "fixture", context: [], history: [{ role: "user", text: prompt }], modelCalls: 1, toolCalls: 0,
    } };
  });
  await assert.rejects(boundary.startRun({ credential: "bob-token", agentId: "order-agent", prompt: "Explain order", actorId: "alice" } as never), InvocationDeniedError);
  await assert.rejects(boundary.startRun({ credential: "bad-token", agentId: "order-agent", prompt: "Explain order" }), InvocationDeniedError);
  const result = await boundary.startRun({ credential: "bob-token", agentId: "order-agent", prompt: "Explain order" });
  assert.deepEqual(result, { runId: "server-run-1", status: "completed", text: "Done" });
  assert.equal(seen[0]?.tenantId, "tenant-a");
  assert.equal(seen[0]?.actorId, "bob");
  assert.deepEqual(seen[0]?.tools.map((tool) => tool.name), ["lookup_order"]);
  assert.equal(seen[0]?.limits.deadlineAt, "2026-09-26T00:10:00.000Z");
});

test("resume is actor-bound and uses the trusted stored checkpoint", async () => {
  let calls = 0;
  const { boundary } = fixture(async (spec, prompt, checkpoint) => {
    calls++;
    assert.equal(spec.actorId, "alice");
    assert.equal(prompt, "Release order");
    if (calls === 2) assert.ok(checkpoint);
    const saved = checkpoint ?? { specHash: "fixture", promptHash: "fixture", context: [], history: [{ role: "user" as const, text: prompt }], modelCalls: 1, toolCalls: 1 };
    return calls === 1
      ? { status: "approval_required", reason: "waiting", checkpoint: saved }
      : { status: "completed", text: "Released", checkpoint: saved };
  });
  assert.equal((await boundary.startRun({ credential: "alice-token", agentId: "order-agent", prompt: "Release order" })).status, "approval_required");
  await assert.rejects(boundary.resumeRun({ credential: "bob-token", runId: "server-run-1" }), InvocationDeniedError);
  assert.equal(calls, 1);
  assert.equal((await boundary.resumeRun({ credential: "alice-token", runId: "server-run-1" })).status, "completed");
  assert.equal(calls, 2);
  await assert.rejects(boundary.resumeRun({ credential: "alice-token", runId: "server-run-1" }), InvocationDeniedError);
});

test("action preview derives actor and connector binding from trusted ports", async () => {
  const { boundary, gateway, bindings } = fixture(async () => { throw new Error("Agent runtime should not be called"); });
  await assert.rejects(boundary.previewAction({ credential: "alice-token", actionId: "releaseOrder", environment: "sandbox", args: { orderId: "PO-42" }, requestId: "r1", tenantId: "tenant-b" } as never), InvocationDeniedError);
  await assert.rejects(boundary.previewAction({ credential: "bob-token", actionId: "releaseOrder", environment: "sandbox", args: { orderId: "PO-42" }, requestId: "r2" }), InvocationDeniedError);
  const result = await boundary.previewAction({ credential: "alice-token", actionId: "releaseOrder", environment: "sandbox", args: { orderId: "PO-42" }, requestId: "r3" });
  assert.equal(result.state, "ready");
  const intent = await gateway.get("tenant-a", "alice:r3");
  assert.equal(intent?.intent.actorId, "alice");
  assert.deepEqual(intent?.intent.target, binding.adapter.target);
  assert.equal(intent?.intent.bindingHash, hashActionBinding(binding));
  bindings.setState("tenant-a", "sandbox", "releaseOrder", "revoked");
  await assert.rejects(boundary.previewAction({ credential: "alice-token", actionId: "releaseOrder", environment: "sandbox", args: { orderId: "PO-42" }, requestId: "r4" }), InvocationDeniedError);
});
