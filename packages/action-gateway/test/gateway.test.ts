import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActionGateway,
  ApprovalError,
  InMemoryIntentStore,
  IntentConflictError,
  type ActionIntentInput,
  type Approval,
  type ConnectorPort,
  type PolicyDecision,
  type ExecutionOutcome,
  type ReconciliationOutcome,
  type VerificationOutcome,
} from "../src/index.js";

const release = `sha256:${"a".repeat(64)}`;
const clock = () => new Date("2026-09-26T00:00:00.000Z");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function input(overrides: Partial<ActionIntentInput> = {}): ActionIntentInput {
  return {
    tenantId: "tenant-a",
    actorId: "operator-a",
    ontologyRelease: release,
    actionId: "order.release",
    environment: "sandbox",
    bindingHash: `sha256:${"c".repeat(64)}`,
    target: { system: "erp", operation: "release", resource: "orders" },
    args: { orderId: "PO-42", priority: 1 },
    idempotencyKey: "run-1:1",
    ...overrides,
  };
}

function fixture(policy: PolicyDecision = { decision: "allow", reason: "allowed", approval: "none", policyVersion: release }) {
  const counts = { preview: 0, execute: 0, verify: 0, reconcile: 0 };
  let executeResult: "accepted" | "timeout" = "accepted";
  const connector: ConnectorPort = {
    async preview() {
      counts.preview++;
      return { summary: "Release PO-42", effects: ["Order becomes released"], preconditionToken: "etag-1" };
    },
    async execute() {
      counts.execute++;
      if (executeResult === "timeout") throw new Error("socket timeout");
      await new Promise((resolve) => setTimeout(resolve, 1));
      return { status: "accepted", receipt: { externalOperationId: "erp-123", acceptedAt: clock().toISOString() } };
    },
    async verify() {
      counts.verify++;
      return { status: "verified", evidence: { orderId: "PO-42", state: "released" } };
    },
    async reconcile() {
      counts.reconcile++;
      return { status: "accepted", receipt: { externalOperationId: "erp-123", acceptedAt: clock().toISOString() } };
    },
  };
  const gateway = new ActionGateway({
    store: new InMemoryIntentStore(),
    connector,
    policy: { async evaluate() { return policy; } },
    approvalAuthority: { async verify(approval) { return approval.evidenceId === "approval-1"; } },
    now: clock,
  });
  return { gateway, counts, setExecuteResult: (value: typeof executeResult) => { executeResult = value; } };
}

test("policy denial fails closed before connector preview or execution", async () => {
  const { gateway, counts } = fixture({ decision: "deny", reason: "scope absent", approval: "none", policyVersion: release });
  await gateway.createIntent(input());
  const record = await gateway.preview("tenant-a", "run-1:1");
  assert.equal(record.state, "denied");
  assert.deepEqual(counts, { preview: 0, execute: 0, verify: 0, reconcile: 0 });
  assert.equal(record.events.at(-1)?.kind, "policy_denied");
});

test("approval is independent and bound to the exact tenant and canonical intent hash", async () => {
  const { gateway, counts } = fixture({ decision: "allow", reason: "allowed", approval: "required", policyVersion: release });
  await gateway.createIntent(input());
  const preview = await gateway.preview("tenant-a", "run-1:1");
  assert.equal(preview.state, "awaiting_approval");
  const approval: Approval = {
    tenantId: "tenant-a",
    intentHash: preview.intent.intentHash,
    approverId: "supervisor-b",
    decision: "approved",
    decidedAt: clock().toISOString(),
    evidenceId: "approval-1",
  };
  await assert.rejects(gateway.approve("tenant-a", "run-1:1", { ...approval, intentHash: `sha256:${"b".repeat(64)}` }), ApprovalError);
  await assert.rejects(gateway.approve("tenant-a", "run-1:1", { ...approval, approverId: "operator-a" }), ApprovalError);
  assert.equal(counts.execute, 0);
  assert.equal((await gateway.approve("tenant-a", "run-1:1", approval)).state, "ready");
  const done = await gateway.execute("tenant-a", "run-1:1");
  assert.equal(done.state, "succeeded");
  assert.equal(done.receipt?.externalOperationId, "erp-123");
  assert.equal(done.verification?.status, "verified");
  assert.deepEqual(done.events.map((event) => event.kind), [
    "intent_created", "previewed", "approval_granted", "execution_reserved", "execution_accepted", "verification_succeeded",
  ]);
});

test("same idempotency key returns one intent and at most one connector execution", async () => {
  const { gateway, counts } = fixture();
  const first = await gateway.createIntent(input({ args: { priority: 1, orderId: "PO-42" } }));
  const duplicate = await gateway.createIntent(input({ args: { orderId: "PO-42", priority: 1 } }));
  assert.equal(duplicate.intent.id, first.intent.id);
  await assert.rejects(gateway.createIntent(input({ args: { orderId: "PO-43", priority: 1 } })), IntentConflictError);
  await gateway.preview("tenant-a", "run-1:1");
  const [a, b] = await Promise.all([gateway.execute("tenant-a", "run-1:1"), gateway.execute("tenant-a", "run-1:1")]);
  assert.ok([a.state, b.state].includes("succeeded"));
  assert.equal(counts.execute, 1);
  assert.equal((await gateway.execute("tenant-a", "run-1:1")).state, "succeeded");
  assert.equal(counts.execute, 1);
});

test("approval hash and idempotency binding change with source revision or deadline", async () => {
  const { gateway } = fixture();
  const objectRef = { objectTypeId: "PurchaseOrder", objectId: "PO-42", expectedRevision: "etag-1" };
  const deadlineAt = "2026-09-26T00:05:00.000Z";
  const first = await gateway.createIntent(input({ objectRef, deadlineAt }));
  assert.ok(first.intent.intentHash.startsWith("sha256:"));
  await assert.rejects(
    gateway.createIntent(input({ objectRef: { ...objectRef, expectedRevision: "etag-2" }, deadlineAt })),
    IntentConflictError,
  );
  await assert.rejects(
    gateway.createIntent(input({ objectRef, deadlineAt: "2026-09-26T00:06:00.000Z" })),
    IntentConflictError,
  );
});

test("expired intent is denied before preview or execution", async () => {
  let time = new Date("2026-09-26T00:00:00.000Z");
  let executionCount = 0;
  const gateway = new ActionGateway({
    now: () => time,
    store: new InMemoryIntentStore(),
    policy: { async evaluate() { return { decision: "allow", reason: "allowed", approval: "none", policyVersion: release }; } },
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { return { summary: "Release", effects: [] }; },
      async execute() { executionCount++; return { status: "accepted", receipt: { externalOperationId: "erp-1", acceptedAt: time.toISOString() } }; },
      async verify() { return { status: "verified", evidence: {} }; },
      async reconcile() { return { status: "unknown", reason: "not found" }; },
    },
  });
  await gateway.createIntent(input({ deadlineAt: "2026-09-26T00:01:00.000Z", idempotencyKey: "expired-preview" }));
  time = new Date("2026-09-26T00:01:00.000Z");
  assert.equal((await gateway.preview("tenant-a", "expired-preview")).state, "denied");
  time = new Date("2026-09-26T00:00:00.000Z");
  await gateway.createIntent(input({ deadlineAt: "2026-09-26T00:01:00.000Z", idempotencyKey: "expired-execute" }));
  assert.equal((await gateway.preview("tenant-a", "expired-execute")).state, "ready");
  time = new Date("2026-09-26T00:01:00.000Z");
  assert.equal((await gateway.execute("tenant-a", "expired-execute")).state, "denied");
  assert.equal(executionCount, 0);
});

test("timeout becomes unknown and reconciliation does not replay the write", async () => {
  const { gateway, counts, setExecuteResult } = fixture();
  setExecuteResult("timeout");
  await gateway.createIntent(input());
  await gateway.preview("tenant-a", "run-1:1");
  const unknown = await gateway.execute("tenant-a", "run-1:1");
  assert.equal(unknown.state, "unknown");
  assert.match(unknown.unknownReason ?? "", /socket timeout/);
  await gateway.execute("tenant-a", "run-1:1");
  assert.equal(counts.execute, 1);
  const recovered = await gateway.reconcile("tenant-a", "run-1:1");
  assert.equal(recovered.state, "succeeded");
  assert.equal(counts.execute, 1);
  assert.equal(counts.reconcile, 1);
  assert.equal(counts.verify, 1);
});

test("stale executing reservation reconciles without a second write after worker loss", async () => {
  let time = new Date("2026-09-26T00:00:00.000Z");
  let releaseExecution!: (value: { status: "accepted"; receipt: { externalOperationId: string; acceptedAt: string } }) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const executionPromise = new Promise<{ status: "accepted"; receipt: { externalOperationId: string; acceptedAt: string } }>((resolve) => { releaseExecution = resolve; });
  let writes = 0;
  const gateway = new ActionGateway({
    now: () => time,
    executionLeaseMs: 1000,
    store: new InMemoryIntentStore(),
    policy: { async evaluate() { return { decision: "allow", reason: "allowed", approval: "none", policyVersion: release }; } },
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { return { summary: "Release", effects: [] }; },
      async execute() { writes++; started(); return executionPromise; },
      async verify() { return { status: "verified", evidence: { state: "released" } }; },
      async reconcile() { return { status: "accepted", receipt: { externalOperationId: "erp-1", acceptedAt: time.toISOString() } }; },
    },
  });
  await gateway.createIntent(input({ idempotencyKey: "stale-worker" }));
  await gateway.preview("tenant-a", "stale-worker");
  const original = gateway.execute("tenant-a", "stale-worker");
  await startedPromise;
  time = new Date("2026-09-26T00:00:02.000Z");
  const recovered = await gateway.reconcile("tenant-a", "stale-worker");
  assert.equal(recovered.state, "succeeded");
  releaseExecution({ status: "accepted", receipt: { externalOperationId: "erp-1", acceptedAt: time.toISOString() } });
  assert.equal((await original).state, "succeeded");
  assert.equal(writes, 1);
  assert.equal(recovered.events.filter((event) => event.kind === "execution_accepted").length, 1);
});

test("late verification cannot overwrite a newer reconciled result", async () => {
  let time = new Date("2026-09-26T00:00:00.000Z");
  let releaseOldVerification!: (value: { status: "failed"; reason: string }) => void;
  let verificationStarted!: () => void;
  const started = new Promise<void>((resolve) => { verificationStarted = resolve; });
  const oldVerification = new Promise<{ status: "failed"; reason: string }>((resolve) => { releaseOldVerification = resolve; });
  let verifyCalls = 0;
  const gateway = new ActionGateway({
    now: () => time,
    executionLeaseMs: 1000,
    store: new InMemoryIntentStore(),
    policy: { async evaluate() { return { decision: "allow", reason: "allowed", approval: "none", policyVersion: release }; } },
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { return { summary: "Release", effects: [] }; },
      async execute() { return { status: "accepted", receipt: { externalOperationId: "erp-1", acceptedAt: time.toISOString() } }; },
      async verify() {
        verifyCalls++;
        if (verifyCalls === 1) { verificationStarted(); return oldVerification; }
        return { status: "verified", evidence: { state: "released" } };
      },
      async reconcile() { return { status: "accepted", receipt: { externalOperationId: "erp-1", acceptedAt: time.toISOString() } }; },
    },
  });
  await gateway.createIntent(input({ idempotencyKey: "stale-verification" }));
  await gateway.preview("tenant-a", "stale-verification");
  const original = gateway.execute("tenant-a", "stale-verification");
  await started;
  time = new Date("2026-09-26T00:00:02.000Z");
  assert.equal((await gateway.reconcile("tenant-a", "stale-verification")).state, "succeeded");
  releaseOldVerification({ status: "failed", reason: "stale read" });
  assert.equal((await original).state, "succeeded");
  assert.equal((await gateway.get("tenant-a", "stale-verification"))?.verification?.status, "verified");
});

test("accepted connector response succeeds only after source-system verification", async () => {
  const { gateway, counts } = fixture();
  await gateway.createIntent(input());
  await gateway.preview("tenant-a", "run-1:1");
  const done = await gateway.execute("tenant-a", "run-1:1");
  assert.equal(done.state, "succeeded");
  assert.equal(done.verification?.status, "verified");
  assert.equal(counts.verify, 1);
});

test("late execution cannot verify using the reservation owned by reconciliation", async () => {
  let time = clock();
  const execution = deferred<ExecutionOutcome>();
  const executing = deferred<void>();
  const verification = deferred<VerificationOutcome>();
  const verifying = deferred<void>();
  const verifiedReceipts: string[] = [];
  let reconciliations = 0;
  const gateway = new ActionGateway({
    now: () => time,
    executionLeaseMs: 1000,
    store: new InMemoryIntentStore(),
    policy: { async evaluate() { return { decision: "allow", reason: "allowed", approval: "none", policyVersion: release }; } },
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { return { summary: "Release", effects: [] }; },
      async execute() { executing.resolve(); return execution.promise; },
      async reconcile() {
        reconciliations++;
        return { status: "accepted", receipt: { externalOperationId: "reconciled", acceptedAt: time.toISOString() } };
      },
      async verify(_intent, receipt) {
        verifiedReceipts.push(receipt.externalOperationId);
        if (receipt.externalOperationId === "reconciled") { verifying.resolve(); return verification.promise; }
        return { status: "failed", reason: "stale receipt" };
      },
    },
  });
  await gateway.createIntent(input());
  await gateway.preview("tenant-a", "run-1:1");
  const original = gateway.execute("tenant-a", "run-1:1");
  await executing.promise;
  time = new Date(time.getTime() + 1001);
  const recovery = gateway.reconcile("tenant-a", "run-1:1");
  await verifying.promise;
  // Reconciliation gets a fresh lease; the original expired lease cannot reclaim it immediately.
  assert.equal((await gateway.reconcile("tenant-a", "run-1:1")).state, "verifying");
  assert.equal(reconciliations, 1);
  execution.resolve({ status: "accepted", receipt: { externalOperationId: "original", acceptedAt: time.toISOString() } });
  assert.equal((await original).state, "verifying");
  assert.deepEqual(verifiedReceipts, ["reconciled"]);
  verification.resolve({ status: "verified", evidence: { state: "released" } });
  const recovered = await recovery;
  assert.equal(recovered.state, "succeeded");
  assert.equal(recovered.receipt?.externalOperationId, "reconciled");
  assert.equal(recovered.events.filter((event) => event.kind === "execution_accepted").length, 1);
});

for (const staleOutcome of [
  { status: "accepted", receipt: { externalOperationId: "stale", acceptedAt: clock().toISOString() } },
  { status: "rejected", reason: "stale rejection" },
  { status: "unknown", reason: "stale unknown" },
  { status: "pending", reason: "stale pending" },
] satisfies ReconciliationOutcome[]) {
  test(`stale reconciliation is recoverable and its late ${staleOutcome.status} result cannot replace a new attempt`, async () => {
    let time = clock();
    const firstLookup = deferred<ReconciliationOutcome>();
    const firstStarted = deferred<void>();
    const secondLookup = deferred<ReconciliationOutcome>();
    const secondStarted = deferred<void>();
    let writes = 0;
    let lookups = 0;
    let verifications = 0;
    const gateway = new ActionGateway({
      now: () => time,
      executionLeaseMs: 1000,
      store: new InMemoryIntentStore(),
      policy: { async evaluate() { return { decision: "allow", reason: "allowed", approval: "none", policyVersion: release }; } },
      approvalAuthority: { async verify() { return true; } },
      connector: {
        async preview() { return { summary: "Release", effects: [] }; },
        async execute() { writes++; return { status: "unknown", reason: "response lost" }; },
        async reconcile() {
          lookups++;
          if (lookups === 1) { firstStarted.resolve(); return firstLookup.promise; }
          secondStarted.resolve();
          return secondLookup.promise;
        },
        async verify() { verifications++; return { status: "verified", evidence: { state: "released" } }; },
      },
    });
    await gateway.createIntent(input());
    await gateway.preview("tenant-a", "run-1:1");
    await gateway.execute("tenant-a", "run-1:1");
    const first = gateway.reconcile("tenant-a", "run-1:1");
    await firstStarted.promise;
    time = new Date(time.getTime() + 1001);
    const second = gateway.reconcile("tenant-a", "run-1:1");
    await secondStarted.promise;
    firstLookup.resolve(staleOutcome);
    assert.equal((await first).state, "reconciling");
    assert.equal(verifications, 0);
    secondLookup.resolve({ status: "accepted", receipt: { externalOperationId: "recovered", acceptedAt: time.toISOString() } });
    const recovered = await second;
    assert.equal(recovered.state, "succeeded");
    assert.equal(recovered.receipt?.externalOperationId, "recovered");
    assert.equal(writes, 1);
    assert.equal(lookups, 2);
    assert.equal(verifications, 1);
  });
}

test("approval expiry is checked again after the authority verification wait", async () => {
  let time = clock();
  let authorityChecks = 0;
  let writes = 0;
  const gateway = new ActionGateway({
    now: () => time,
    store: new InMemoryIntentStore(),
    policy: { async evaluate() { return { decision: "allow", reason: "allowed", approval: "required", policyVersion: release, risk: "high", approvalMaxTtlMs: 60_000 }; } },
    approvalAuthority: { async verify() {
      if (++authorityChecks === 2) time = new Date("2026-09-26T00:00:10.000Z");
      return true;
    } },
    connector: {
      async preview() { return { summary: "Release", effects: [] }; },
      async execute() { writes++; return { status: "unknown", reason: "must not execute" }; },
      async verify() { return { status: "unknown", reason: "unused" }; },
      async reconcile() { return { status: "unknown", reason: "unused" }; },
    },
  });
  const intent = await gateway.createIntent(input({ deadlineAt: "2026-09-26T00:01:00.000Z" }));
  await gateway.preview("tenant-a", "run-1:1");
  await gateway.approve("tenant-a", "run-1:1", {
    tenantId: "tenant-a", intentHash: intent.intent.intentHash, approverId: "supervisor-b",
    evidenceId: "approval-1", decision: "approved", decidedAt: time.toISOString(), expiresAt: "2026-09-26T00:00:10.000Z",
  });
  const denied = await gateway.execute("tenant-a", "run-1:1");
  assert.equal(denied.state, "denied");
  assert.equal(writes, 0);
  assert.deepEqual(denied.events.at(-1)?.details, { reason: "Approval expired" });
});
