import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionGateway,
  InMemoryIntentStore,
  type Approval,
} from "../../action-gateway/src/index.js";
import {
  AgentRuntime,
  GatewayActionToolPort,
  RunSpecError,
  type RunSpec,
  type RuntimeEvent,
  type ToolCallRequest,
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const toolDigest = `sha256:${"b".repeat(64)}` as const;
const deadlineAt = "2026-09-26T00:10:00.000Z";
const now = () => new Date("2026-09-26T00:00:00.000Z");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function spec(overrides: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: "run-1",
    tenantId: "tenant-a",
    actorId: "operator-a",
    ontologyRelease: digest,
    agent: { id: "agent.procurement", version: "2.0.0", digest },
    model: { provider: "model-port", id: "model-1", version: "2026-09" },
    skills: [{ id: "skill.procurement", version: "1.0.0", digest }],
    tools: [{ name: "release_order", version: "1.0.0", digest: toolDigest, kind: "action" }],
    limits: { maxModelCalls: 3, maxToolCalls: 1, maxContextBytes: 100, deadlineAt },
    ...overrides,
  };
}

test("bounded runtime uses pinned tools and tenant-scoped context", async () => {
  const calls: string[] = [];
  const events: RuntimeEvent[] = [];
  const runtime = new AgentRuntime({
    now,
    audit: { async append(event) { events.push(event); } },
    context: { async load(request) {
      assert.equal(request.tenantId, "tenant-a");
      return [{ tenantId: "tenant-a", id: "order-42", version: "v3", provenance: "erp:orders", text: "PO-42 is pending" }];
    } },
    model: { async next(request) {
      return request.history.some((entry) => entry.role === "tool")
        ? { type: "final", text: "Released and verified." }
        : { type: "tool", toolName: "release_order", args: { orderId: "PO-42" } };
    } },
    tools: { async call(request) {
      calls.push(request.idempotencyKey);
      assert.equal(request.toolDigest, toolDigest);
      return { status: "completed", output: { state: "released" } };
    }, async status() { throw new Error("not reached"); } },
  });
  const result = await runtime.run(spec(), "Release PO-42");
  assert.equal(result.status, "completed");
  assert.equal(result.text, "Released and verified.");
  assert.deepEqual(calls, ["run-1:1"]);
  assert.equal(result.checkpoint.modelCalls, 2);
  assert.equal(result.checkpoint.toolCalls, 1);
  assert.deepEqual(events.map((event) => event.kind), ["run_started", "context_loaded", "model_decision", "tool_dispatched", "tool_completed", "model_decision", "run_completed"]);
});

test("runtime rejects cross-tenant context before any model call", async () => {
  let modelCalls = 0;
  const runtime = new AgentRuntime({
    now,
    audit: { async append() {} },
    context: { async load() { return [{ tenantId: "tenant-b", id: "leak", version: "1", provenance: "crm", text: "secret" }]; } },
    model: { async next() { modelCalls++; return { type: "final", text: "bad" }; } },
    tools: { async call() { throw new Error("not reached"); }, async status() { throw new Error("not reached"); } },
  });
  await assert.rejects(runtime.run(spec(), "prompt"), RunSpecError);
  assert.equal(modelCalls, 0);
});

test("runtime refuses model access to an unpinned tool", async () => {
  let toolCalls = 0;
  const runtime = new AgentRuntime({
    now,
    audit: { async append() {} },
    context: { async load() { return []; } },
    model: { async next() { return { type: "tool", toolName: "raw_erp_write", args: {} }; } },
    tools: { async call() { toolCalls++; return { status: "completed", output: {} }; }, async status() { throw new Error("not reached"); } },
  });
  await assert.rejects(runtime.run(spec(), "prompt"), RunSpecError);
  assert.equal(toolCalls, 0);
});

test("a model adapter cannot add a tool to the authoritative run specification", async () => {
  let toolCalls = 0;
  const runtime = new AgentRuntime({
    now, audit: { async append() {} }, context: { async load() { return []; } },
    model: { async next(request) {
      request.spec.tools = [...request.spec.tools, { name: "raw_erp_write", version: "1.0.0", digest: toolDigest, kind: "action" }];
      return { type: "tool", toolName: "raw_erp_write", args: {} };
    } },
    tools: { async call() { toolCalls++; return { status: "completed", output: {} }; }, async status() { throw new Error("not reached"); } },
  });
  await assert.rejects(runtime.run(spec(), "prompt"), /unpinned tool/);
  assert.equal(toolCalls, 0);
});

test("caller, model, and tool mutations cannot change pinned authority or pending arguments", async () => {
  const contextReady = deferred<[]>();
  const contextEntered = deferred<void>();
  const proposed = { type: "tool" as const, toolName: "release_order", args: { orderId: "PO-42" } };
  const runSpec = spec();
  const runtime = new AgentRuntime({
    now,
    audit: { async append(event) { if (event.kind === "model_decision") proposed.args.orderId = "PO-99"; } },
    context: { async load() { contextEntered.resolve(); return contextReady.promise; } },
    model: { async next(request) {
      assert.equal(request.spec.actorId, "operator-a");
      request.spec.actorId = "model-admin";
      (request.history as { role: "user"; text: string }[])[0] = { role: "user", text: "Changed history" };
      return proposed;
    } },
    tools: {
      async call(request) {
        assert.equal(request.actorId, "operator-a");
        assert.deepEqual(request.args, { orderId: "PO-42" });
        (request.args as { orderId: string }).orderId = "PO-100";
        return { status: "approval_required", intentHash: digest, summary: "Approval required" };
      },
      async status() { throw new Error("not reached"); },
    },
  });
  const running = runtime.run(runSpec, "Release PO-42");
  await contextEntered.promise;
  runSpec.actorId = "caller-admin";
  runSpec.tools = [];
  contextReady.resolve([]);
  const result = await running;
  assert.equal(result.status, "approval_required");
  assert.equal(result.checkpoint.pendingTool?.actorId, "operator-a");
  assert.deepEqual(result.checkpoint.pendingTool?.args, { orderId: "PO-42" });
  assert.deepEqual(result.checkpoint.history[0], { role: "user", text: "Release PO-42" });
});

test("expired runs retain uncertain effects and only inspect their outcome", async () => {
  let instant = now();
  let calls = 0;
  let checks = 0;
  let modelCalls = 0;
  let resolved = false;
  const runtime = new AgentRuntime({
    now: () => instant,
    audit: { async append() {} }, context: { async load() { return []; } },
    model: { async next() { modelCalls++; return { type: "tool", toolName: "release_order", args: { orderId: "PO-42" } }; } },
    tools: {
      async call() { calls++; return { status: "unknown", reason: "Connection lost" }; },
      async status(request) {
        checks++;
        assert.equal(request.deadlineAt, deadlineAt);
        return resolved ? { status: "completed", output: { receipt: "erp-42" } } : { status: "ready" };
      },
    },
  });
  const first = await runtime.run(spec(), "Release PO-42");
  assert.equal(first.status, "unknown");
  instant = new Date("2026-09-26T00:11:00.000Z");
  const second = await runtime.run(spec(), "Release PO-42", first.checkpoint);
  assert.equal(second.status, "unknown");
  assert.ok(second.checkpoint.pendingTool);
  resolved = true;
  const third = await runtime.run(spec(), "Release PO-42", second.checkpoint);
  assert.equal(third.status, "timed_out");
  assert.equal(third.checkpoint.pendingTool, undefined);
  assert.equal(calls, 1);
  assert.equal(modelCalls, 1);
  assert.equal(checks, 2);
});

test("uncertain non-gateway action is status-checked on resume and never dispatched again", async () => {
  let calls = 0;
  let checks = 0;
  let externalOutcome: "unknown" | "completed" = "unknown";
  const runtime = new AgentRuntime({
    now,
    audit: { async append() {} },
    context: { async load() { return []; } },
    model: { async next(request) {
      return request.history.some((entry) => entry.role === "tool")
        ? { type: "final", text: "Operation verified." }
        : { type: "tool", toolName: "release_order", args: { orderId: "PO-42" } };
    } },
    tools: {
      async call() { calls++; return { status: "unknown", reason: "transport timed out" }; },
      async status() {
        checks++;
        return externalOutcome === "completed"
          ? { status: "completed", output: { state: "released" } }
          : { status: "ready" };
      },
    },
  });
  const first = await runtime.run(spec(), "Release PO-42");
  assert.equal(first.status, "unknown");
  assert.equal(calls, 1);
  const second = await runtime.run(spec(), "Release PO-42", first.checkpoint);
  assert.equal(second.status, "unknown");
  assert.equal(calls, 1);
  assert.equal(checks, 1);
  externalOutcome = "completed";
  const third = await runtime.run(spec(), "Release PO-42", second.checkpoint);
  assert.equal(third.status, "completed");
  assert.equal(calls, 1);
  assert.equal(checks, 2);
});

test("gateway action tool pauses for hash-bound approval and resumes without another model decision", async () => {
  let connectorCalls = 0;
  let modelCalls = 0;
  const gateway = new ActionGateway({
    now,
    store: new InMemoryIntentStore(),
    policy: { async evaluate() { return { decision: "allow", reason: "manager may release", approval: "required", policyVersion: digest }; } },
    approvalAuthority: { async verify(approval) { return approval.evidenceId === "approval-1"; } },
    connector: {
      async preview() { return { summary: "Release purchase order", effects: ["status becomes released"] }; },
      async execute() { connectorCalls++; return { status: "accepted", receipt: { externalOperationId: "erp-1", acceptedAt: now().toISOString() } }; },
      async verify() { return { status: "verified", evidence: { state: "released" } }; },
      async reconcile() { throw new Error("not needed"); },
    },
  });
  const runtime = new AgentRuntime({
    now,
    audit: { async append() {} },
    context: { async load() { return []; } },
    model: { async next(request) {
      modelCalls++;
      return request.history.some((entry) => entry.role === "tool")
        ? { type: "final", text: "Order released." }
        : { type: "tool", toolName: "release_order", args: { orderId: "PO-42" } };
    } },
    tools: new GatewayActionToolPort(gateway, {
      release_order: {
        actionId: "order.release",
        environment: "sandbox",
        bindingHash: `sha256:${"c".repeat(64)}`,
        target: { system: "erp", operation: "release", resource: "orders" },
        version: "1.0.0",
        digest: toolDigest,
      },
    }),
  });
  const first = await runtime.run(spec(), "Release PO-42");
  assert.equal(first.status, "approval_required");
  assert.equal(first.checkpoint.modelCalls, 1);
  assert.equal(connectorCalls, 0);
  const intent = await gateway.get("tenant-a", "run-1:1");
  assert.equal(intent?.state, "awaiting_approval");
  const approval: Approval = {
    tenantId: "tenant-a",
    intentHash: intent!.intent.intentHash,
    approverId: "manager-b",
    decision: "approved",
    decidedAt: now().toISOString(),
    evidenceId: "approval-1",
  };
  await gateway.approve("tenant-a", "run-1:1", approval);
  const resumed = await runtime.run(spec(), "Release PO-42", first.checkpoint);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.text, "Order released.");
  assert.equal(modelCalls, 2);
  assert.equal(connectorCalls, 1);
});

test("action status retains the original revision after verified source changes", async () => {
  let sourceRevision = "v1";
  let sourceObjectId = "PO-42";
  const gateway = new ActionGateway({
    now, store: new InMemoryIntentStore(),
    policy: { async evaluate() { return { decision: "allow", reason: "fixture", approval: "none", policyVersion: digest }; } },
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { return { summary: "Release order", effects: ["status becomes released"] }; },
      async execute() { sourceRevision = "v2"; return { status: "accepted", receipt: { externalOperationId: "erp-42", acceptedAt: now().toISOString() } }; },
      async verify() { return { status: "verified", evidence: { revision: sourceRevision } }; },
      async reconcile() { throw new Error("not needed"); },
    },
  });
  const tools = new GatewayActionToolPort(gateway, {
    release_order: {
      actionId: "order.release", environment: "sandbox", bindingHash: `sha256:${"c".repeat(64)}`,
      target: { system: "erp", operation: "release", resource: "orders" }, version: "1.0.0", digest: toolDigest,
      resolveObjectRef: () => ({ objectTypeId: "Order", objectId: sourceObjectId, expectedRevision: sourceRevision }),
    },
  });
  const request: ToolCallRequest = {
    tenantId: "tenant-a", actorId: "operator-a", runId: "run-1", ontologyRelease: digest,
    deadlineAt, toolName: "release_order", toolVersion: "1.0.0", toolDigest,
    args: { orderId: "PO-42" }, idempotencyKey: "run-1:1", signal: new AbortController().signal,
  };
  assert.equal((await tools.call(request)).status, "completed");
  assert.equal(sourceRevision, "v2");
  assert.equal((await tools.status(request)).status, "completed");
  assert.equal((await gateway.get("tenant-a", "run-1:1"))?.intent.objectRef?.expectedRevision, "v1");
  sourceObjectId = "PO-99";
  assert.equal((await tools.status(request)).status, "denied");
});
