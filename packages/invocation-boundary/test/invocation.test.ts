import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionBinding } from "../../contracts/src/index.js";
import { ActionGateway, hashActionBinding, InMemoryActionBindingSource, InMemoryIntentStore } from "../../action-gateway/src/index.js";
import type { RunCheckpoint, RunResult, RunSpec } from "../../agent-runtime/src/index.js";
import { InMemoryRunCheckpointStore, InvocationDeniedError, TrustedInvocationBoundary, type InvocationBoundaryOptions, type PublishedAgent } from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const toolDigest = `sha256:${"b".repeat(64)}` as const;
const clock = () => new Date("2026-09-26T00:00:00.000Z");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
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

function fixture(run: (spec: RunSpec, prompt: string, checkpoint?: RunCheckpoint) => Promise<RunResult>, overrides: Partial<Pick<InvocationBoundaryOptions, "identity" | "agents" | "actionGrants">> = {}) {
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
    ...overrides,
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

test("preview preserves the action and arguments checked before an asynchronous grant", async () => {
  const granted = deferred<boolean>();
  const entered = deferred<void>();
  const { boundary, gateway } = fixture(async () => { throw new Error("unused"); }, {
    actionGrants: { async mayPreview(_principal, actionId, environment) {
      assert.equal(actionId, "releaseOrder");
      assert.equal(environment, "sandbox");
      entered.resolve();
      return granted.promise;
    } },
  });
  const request = { credential: "alice-token", actionId: "releaseOrder", environment: "sandbox", args: { orderId: "PO-42" }, requestId: "snapshot" };
  const preview = boundary.previewAction(request);
  await entered.promise;
  request.actionId = "deleteOrder";
  request.environment = "production";
  request.args.orderId = "PO-99";
  granted.resolve(true);
  assert.equal((await preview).state, "ready");
  const saved = await gateway.get("tenant-a", "alice:snapshot");
  assert.equal(saved?.intent.actionId, "releaseOrder");
  assert.equal(saved?.intent.environment, "sandbox");
  assert.deepEqual(saved?.intent.args, { orderId: "PO-42" });
});

test("start snapshots both caller input and authenticated principal before catalog lookup", async () => {
  const loaded = deferred<PublishedAgent>();
  const entered = deferred<void>();
  const principal = { tenantId: "tenant-a", actorId: "alice", scopes: ["order:read", "order:write"] };
  const { boundary } = fixture(async (spec, prompt) => {
    assert.equal(spec.actorId, "alice");
    assert.equal(spec.tenantId, "tenant-a");
    assert.equal(spec.tools.length, 2);
    assert.equal(prompt, "Release order");
    return { status: "completed", checkpoint: { specHash: "fixture", promptHash: "fixture", context: [], history: [], modelCalls: 0, toolCalls: 0 } };
  }, {
    identity: { async authenticate() { return principal; } },
    agents: { async resolve() { entered.resolve(); return loaded.promise; }, async isActive() { return true; } },
  });
  const request = { credential: "alice-token", agentId: "order-agent", prompt: "Release order" };
  const started = boundary.startRun(request);
  await entered.promise;
  request.prompt = "Changed prompt";
  request.agentId = "other-agent";
  principal.actorId = "mallory";
  principal.tenantId = "tenant-b";
  principal.scopes.length = 0;
  loaded.resolve(deployment);
  assert.equal((await started).status, "completed");
});

test("resume denies a stored tool after the principal scope is revoked", async () => {
  let scopes = ["order:read", "order:write"];
  let calls = 0;
  const { boundary } = fixture(async (_spec, prompt) => {
    calls++;
    return { status: "approval_required", checkpoint: { specHash: "fixture", promptHash: "fixture", context: [], history: [{ role: "user", text: prompt }], modelCalls: 1, toolCalls: 1 } };
  }, { identity: { async authenticate() { return { tenantId: "tenant-a", actorId: "alice", scopes }; } } });
  await boundary.startRun({ credential: "alice-token", agentId: "order-agent", prompt: "Release order" });
  scopes = ["order:read"];
  await assert.rejects(boundary.resumeRun({ credential: "alice-token", runId: "server-run-1" }), /scope grant changed/);
  assert.equal(calls, 1);
  scopes = ["order:read", "order:write"];
  await assert.rejects(boundary.resumeRun({ credential: "alice-token", runId: "server-run-1" }), /unavailable for resume/);
});

test("resume resolves the stored publication when the catalog default advances", async () => {
  const original = structuredClone(deployment);
  original.agent.id = "definition.orders";
  let current = original;
  let calls = 0;
  const resolvedPins: (string | undefined)[] = [];
  const { boundary } = fixture(async (spec, prompt, checkpoint) => {
    calls++;
    assert.equal(spec.agent.id, "definition.orders");
    assert.equal(spec.agent.digest, digest);
    const saved = checkpoint ?? { specHash: "fixture", promptHash: "fixture", context: [], history: [{ role: "user" as const, text: prompt }], modelCalls: 1, toolCalls: 1 };
    return calls === 1 ? { status: "approval_required", checkpoint: saved } : { status: "completed", checkpoint: saved };
  }, {
    agents: {
      async resolve(_tenantId, agentId, pin) {
        assert.equal(agentId, "order-agent");
        resolvedPins.push(pin);
        return pin === digest ? original : current;
      },
      async isActive(_tenantId, agentId, pin) { return agentId === "order-agent" && pin === digest; },
    },
  });
  await boundary.startRun({ credential: "alice-token", agentId: "order-agent", prompt: "Release order" });
  current = { ...original, agent: { ...original.agent, digest: toolDigest, version: "2.0.0" } };
  assert.equal((await boundary.resumeRun({ credential: "alice-token", runId: "server-run-1" })).status, "completed");
  assert.deepEqual(resolvedPins, [undefined, digest]);
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
