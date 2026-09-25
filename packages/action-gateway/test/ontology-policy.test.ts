import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActionBinding, OntologyBundle, ReleaseManifest } from "../../contracts/src/index.js";
import { createReleaseManifest, validateBundle } from "../../ontology-kernel/src/index.js";
import { ActionGateway, ApprovalError, hashActionBinding, InMemoryActionBindingSource, InMemoryIntentStore, OntologyPolicyPort, type ActionTarget } from "../src/index.js";

const target = { system: "erp", operation: "release", resource: "orders" };
function makeBinding(release: ReleaseManifest, environment = "sandbox", connectorTarget: ActionTarget = target): ActionBinding {
  return {
    id: "release-order-erp", version: "1.0.0", tenantId: "tenant-a", environment,
    ontologyRelease: release.bundleHash, actionId: "releaseOrder",
    adapter: { id: "mock-erp", version: "1.0.0", target: connectorTarget },
    guarantees: { conditionalWrite: true, nativeIdempotency: true, readback: true, reconciliation: true },
  };
}
function activeRelease(release: ReleaseManifest) {
  return { async getStatus(tenantId: string, releaseId: string) {
    return tenantId === "tenant-a" && releaseId === release.releaseId
      ? { tenantId, releaseId, bundleHash: release.bundleHash, state: "active" as const }
      : undefined;
  } };
}

const bundle: OntologyBundle = {
  schemaVersion: "2.0",
  id: "operations",
  namespace: "com.example.operations",
  version: "2.0.0",
  name: "Operations",
  sources: [],
  values: [{ id: "identifier", name: "Identifier", kind: "string" }],
  sharedProperties: [],
  objects: [{ id: "Order", name: "Order", primaryKey: "id", properties: [{ id: "id", valueTypeId: "identifier", required: true }] }],
  relations: [],
  interfaces: [],
  rules: [],
  actions: [{
    id: "releaseOrder",
    name: "Release order",
    input: [{ id: "orderId", valueTypeId: "identifier", required: true }],
    targetObjectTypeId: "Order",
    objectIdParameterId: "orderId",
    approval: "risk-based",
    risk: "high",
    policyIds: ["allowManagers"],
  }],
  functions: [],
  events: [],
  policies: [{
    id: "allowManagers",
    name: "Allow managers",
    appliesTo: ["releaseOrder"],
    effect: "allow",
    guard: { op: "eq", left: { kind: "literal", value: 1 }, right: { kind: "literal", value: 1 } },
  }],
};

test("ontology policy binds manifest, target, input contract, source revision, and approval risk", async () => {
  assert.deepEqual(validateBundle(bundle), []);
  const release = createReleaseManifest(bundle, "2026-09-26T00:00:00.000Z");
  const binding = makeBinding(release);
  const bindings = new InMemoryActionBindingSource([{ binding, state: "active" }]);
  let sourceRevision: string | undefined = "v1";
  const policy = new OntologyPolicyPort(bundle, release, { async load() { return { sourceRevision }; } }, bindings, activeRelease(release));
  const gateway = new ActionGateway({
    store: new InMemoryIntentStore(),
    policy,
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { return { summary: "Release order", effects: ["status=RELEASED"] }; },
      async execute() { throw new Error("not reached"); },
      async verify() { throw new Error("not reached"); },
      async reconcile() { throw new Error("not reached"); },
    },
    now: () => new Date("2026-09-26T00:00:00.000Z"),
  });
  const base = {
    tenantId: "tenant-a",
    actorId: "manager-a",
    ontologyRelease: release.bundleHash,
    actionId: "releaseOrder",
    environment: "sandbox",
    bindingHash: hashActionBinding(binding),
    target,
    deadlineAt: "2026-09-26T00:10:00.000Z",
    args: { orderId: "PO-42" },
  };
  await gateway.createIntent({ ...base, idempotencyKey: "missing-revision" });
  assert.equal((await gateway.preview("tenant-a", "missing-revision")).state, "denied");
  await gateway.createIntent({ ...base, idempotencyKey: "wrong-target", target: { system: "crm", operation: "release" }, objectRef: { objectTypeId: "Order", objectId: "PO-42", expectedRevision: "v1" } });
  assert.equal((await gateway.preview("tenant-a", "wrong-target")).state, "denied");
  await gateway.createIntent({ ...base, idempotencyKey: "missing-input", args: {}, objectRef: { objectTypeId: "Order", objectId: "PO-42", expectedRevision: "v1" } });
  assert.equal((await gateway.preview("tenant-a", "missing-input")).state, "denied");
  await gateway.createIntent({ ...base, idempotencyKey: "wrong-object-id", objectRef: { objectTypeId: "Order", objectId: "PO-43", expectedRevision: "v1" } });
  assert.equal((await gateway.preview("tenant-a", "wrong-object-id")).state, "denied");
  await gateway.createIntent({ ...base, idempotencyKey: "wrong-object-type", objectRef: { objectTypeId: "Invoice", objectId: "PO-42", expectedRevision: "v1" } });
  assert.equal((await gateway.preview("tenant-a", "wrong-object-type")).state, "denied");
  await gateway.createIntent({ ...base, idempotencyKey: "valid", objectRef: { objectTypeId: "Order", objectId: "PO-42", expectedRevision: "v1" } });
  const valid = await gateway.preview("tenant-a", "valid");
  assert.equal(valid.state, "awaiting_approval");
  assert.equal(valid.policy?.policyVersion, release.bundleHash);
  await assert.rejects(gateway.approve("tenant-a", "valid", {
    tenantId: "tenant-a", intentHash: valid.intent.intentHash,
    approverId: "manager-b", decision: "approved",
    decidedAt: "2026-09-26T00:00:00.000Z", evidenceId: "approval-1",
  }), ApprovalError);
  await assert.rejects(gateway.approve("tenant-a", "valid", {
    tenantId: "tenant-a", intentHash: valid.intent.intentHash,
    approverId: "manager-b", decision: "approved",
    decidedAt: "2026-09-26T00:00:00.000Z", expiresAt: "2026-09-26T00:16:00.000Z", evidenceId: "approval-1",
  }), ApprovalError);
  sourceRevision = "v2";
  await gateway.approve("tenant-a", "valid", {
    tenantId: "tenant-a", intentHash: valid.intent.intentHash,
    approverId: "manager-b", decision: "approved",
    decidedAt: "2026-09-26T00:00:00.000Z", expiresAt: "2026-09-26T00:05:00.000Z", evidenceId: "approval-1",
  });
  assert.equal((await gateway.execute("tenant-a", "valid")).state, "denied");
  await gateway.createIntent({ ...base, idempotencyKey: "stale-revision", objectRef: { objectTypeId: "Order", objectId: "PO-42", expectedRevision: "v1" } });
  assert.equal((await gateway.preview("tenant-a", "stale-revision")).state, "denied");
  sourceRevision = undefined;
  await gateway.createIntent({ ...base, idempotencyKey: "missing-source-revision", objectRef: { objectTypeId: "Order", objectId: "PO-42", expectedRevision: "v1" } });
  assert.equal((await gateway.preview("tenant-a", "missing-source-revision")).state, "denied");
});

test("one semantic action uses distinct environment bindings and revocation blocks execution", async () => {
  const release = createReleaseManifest(bundle, "2026-09-26T00:00:00.000Z");
  const erp = makeBinding(release, "erp-sandbox");
  const crm = makeBinding(release, "crm-sandbox", { system: "crm", operation: "releaseOrder", resource: "sales_orders" });
  const bindings = new InMemoryActionBindingSource([
    { binding: erp, state: "active" }, { binding: crm, state: "active" },
  ]);
  let releaseState: "active" | "revoked" = "active";
  const releaseStatus = { async getStatus(tenantId: string, releaseId: string) {
    return { tenantId, releaseId, bundleHash: release.bundleHash, state: releaseState };
  } };
  const gateway = new ActionGateway({
    store: new InMemoryIntentStore(),
    policy: new OntologyPolicyPort(bundle, release, { async load() { return { sourceRevision: "v1" }; } }, bindings, releaseStatus),
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { return { summary: "Release order", effects: ["released"] }; },
      async execute() { throw new Error("Revoked binding must never execute"); },
      async verify() { throw new Error("not reached"); },
      async reconcile() { throw new Error("not reached"); },
    },
    now: () => new Date("2026-09-26T00:00:00.000Z"),
  });
  const base = {
    tenantId: "tenant-a", actorId: "manager-a", ontologyRelease: release.bundleHash,
    actionId: "releaseOrder", args: { orderId: "PO-42" },
    objectRef: { objectTypeId: "Order", objectId: "PO-42", expectedRevision: "v1" },
    deadlineAt: "2026-09-26T00:10:00.000Z",
  };
  await gateway.createIntent({ ...base, environment: "erp-sandbox", bindingHash: hashActionBinding(erp), target: erp.adapter.target, idempotencyKey: "erp" });
  await gateway.createIntent({ ...base, environment: "crm-sandbox", bindingHash: hashActionBinding(crm), target: crm.adapter.target, idempotencyKey: "crm" });
  assert.equal((await gateway.preview("tenant-a", "erp")).state, "awaiting_approval");
  const crmPreview = await gateway.preview("tenant-a", "crm");
  assert.equal(crmPreview.state, "awaiting_approval");
  assert.notEqual(hashActionBinding(erp), hashActionBinding(crm));
  bindings.setState("tenant-a", "crm-sandbox", "releaseOrder", "revoked");
  await gateway.approve("tenant-a", "crm", {
    tenantId: "tenant-a", intentHash: crmPreview.intent.intentHash, approverId: "manager-b",
    decision: "approved", decidedAt: "2026-09-26T00:00:00.000Z", expiresAt: "2026-09-26T00:05:00.000Z", evidenceId: "approval-2",
  });
  assert.equal((await gateway.execute("tenant-a", "crm")).state, "denied");
  releaseState = "revoked";
  const erpPreview = await gateway.get("tenant-a", "erp");
  await gateway.approve("tenant-a", "erp", {
    tenantId: "tenant-a", intentHash: erpPreview!.intent.intentHash, approverId: "manager-b",
    decision: "approved", decidedAt: "2026-09-26T00:00:00.000Z", expiresAt: "2026-09-26T00:05:00.000Z", evidenceId: "approval-3",
  });
  assert.equal((await gateway.execute("tenant-a", "erp")).state, "denied");
});

test("material action denies a binding without source precondition and readback guarantees", async () => {
  const release = createReleaseManifest(bundle, "2026-09-26T00:00:00.000Z");
  const unsafe = makeBinding(release);
  unsafe.guarantees.conditionalWrite = false;
  const bindings = new InMemoryActionBindingSource([{ binding: unsafe, state: "active" }]);
  let previews = 0;
  const gateway = new ActionGateway({
    store: new InMemoryIntentStore(),
    policy: new OntologyPolicyPort(bundle, release, { async load() { return { sourceRevision: "v1" }; } }, bindings, activeRelease(release)),
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { previews++; return { summary: "Unsafe", effects: [] }; },
      async execute() { throw new Error("not reached"); },
      async verify() { throw new Error("not reached"); },
      async reconcile() { throw new Error("not reached"); },
    },
    now: () => new Date("2026-09-26T00:00:00.000Z"),
  });
  await gateway.createIntent({
    tenantId: "tenant-a", actorId: "manager-a", ontologyRelease: release.bundleHash,
    actionId: "releaseOrder", environment: "sandbox", bindingHash: hashActionBinding(unsafe), target,
    objectRef: { objectTypeId: "Order", objectId: "PO-42", expectedRevision: "v1" },
    args: { orderId: "PO-42" }, deadlineAt: "2026-09-26T00:10:00.000Z", idempotencyKey: "unsafe",
  });
  assert.equal((await gateway.preview("tenant-a", "unsafe")).state, "denied");
  assert.equal(previews, 0);
});

test("action input dates reject impossible days and timezone-less timestamps", async () => {
  const temporalBundle: OntologyBundle = {
    ...bundle,
    values: [
      ...bundle.values,
      { id: "businessDate", name: "Business date", kind: "date" },
      { id: "eventTime", name: "Event time", kind: "datetime" },
    ],
    actions: [{
      ...bundle.actions[0]!,
      input: [
        ...bundle.actions[0]!.input,
        { id: "dueDate", valueTypeId: "businessDate", required: true },
        { id: "scheduledAt", valueTypeId: "eventTime", required: true },
      ],
    }],
  };
  assert.deepEqual(validateBundle(temporalBundle), []);
  const release = createReleaseManifest(temporalBundle, "2026-09-26T00:00:00.000Z");
  const binding = makeBinding(release);
  const bindings = new InMemoryActionBindingSource([{ binding, state: "active" }]);
  const gateway = new ActionGateway({
    store: new InMemoryIntentStore(),
    policy: new OntologyPolicyPort(temporalBundle, release, { async load() { return { sourceRevision: "v1" }; } }, bindings, activeRelease(release)),
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { return { summary: "Scheduled", effects: [] }; },
      async execute() { throw new Error("not reached"); },
      async verify() { throw new Error("not reached"); },
      async reconcile() { throw new Error("not reached"); },
    },
    now: () => new Date("2026-09-26T00:00:00.000Z"),
  });
  const base = {
    tenantId: "tenant-a", actorId: "manager-a", ontologyRelease: release.bundleHash,
    actionId: "releaseOrder", environment: "sandbox", bindingHash: hashActionBinding(binding), target,
    objectRef: { objectTypeId: "Order", objectId: "PO-42", expectedRevision: "v1" },
    deadlineAt: "2026-09-26T00:10:00.000Z",
  };
  await gateway.createIntent({ ...base, idempotencyKey: "bad-day", args: { orderId: "PO-42", dueDate: "2026-02-30", scheduledAt: "2026-09-26T01:00:00Z" } });
  assert.equal((await gateway.preview("tenant-a", "bad-day")).state, "denied");
  await gateway.createIntent({ ...base, idempotencyKey: "no-timezone", args: { orderId: "PO-42", dueDate: "2026-02-28", scheduledAt: "2026-09-26T01:00:00" } });
  assert.equal((await gateway.preview("tenant-a", "no-timezone")).state, "denied");
  await gateway.createIntent({ ...base, idempotencyKey: "valid-temporal", args: { orderId: "PO-42", dueDate: "2026-02-28", scheduledAt: "2026-09-26T01:00:00+08:00" } });
  assert.equal((await gateway.preview("tenant-a", "valid-temporal")).state, "awaiting_approval");
});

test("high-risk action without a connector resource still requires the bound object reference", async () => {
  const noResourceBundle: OntologyBundle = {
    ...bundle,
    actions: [{ ...bundle.actions[0]! }],
  };
  const release = createReleaseManifest(noResourceBundle, "2026-09-26T00:00:00.000Z");
  const noResourceTarget = { system: "erp", operation: "release" };
  const binding = makeBinding(release, "sandbox", noResourceTarget);
  const bindings = new InMemoryActionBindingSource([{ binding, state: "active" }]);
  const gateway = new ActionGateway({
    store: new InMemoryIntentStore(),
    policy: new OntologyPolicyPort(noResourceBundle, release, { async load() { return { sourceRevision: "v1" }; } }, bindings, activeRelease(release)),
    approvalAuthority: { async verify() { return true; } },
    connector: {
      async preview() { return { summary: "Release", effects: [] }; },
      async execute() { throw new Error("not reached"); },
      async verify() { throw new Error("not reached"); },
      async reconcile() { throw new Error("not reached"); },
    },
    now: () => new Date("2026-09-26T00:00:00.000Z"),
  });
  await gateway.createIntent({
    tenantId: "tenant-a", actorId: "manager-a", ontologyRelease: release.bundleHash,
    actionId: "releaseOrder", environment: "sandbox", bindingHash: hashActionBinding(binding), target: noResourceTarget,
    args: { orderId: "PO-42" }, deadlineAt: "2026-09-26T00:10:00.000Z", idempotencyKey: "no-resource",
  });
  assert.equal((await gateway.preview("tenant-a", "no-resource")).state, "denied");
});
