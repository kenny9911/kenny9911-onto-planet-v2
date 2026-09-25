import assert from "node:assert/strict";
import test from "node:test";
import type { Guard, OntologyBundle } from "../../contracts/src/index.js";
import {
  authorizeAction,
  canonicalize,
  createReleaseManifest,
  evaluateGuard,
  evaluateRule,
  hashBundle,
  isValidFactPath,
  validateBundle,
  verifyReleaseManifest,
} from "../src/index.js";

const procurementBundle: OntologyBundle = {
  schemaVersion: "2.0",
  id: "procurement",
  namespace: "com.example.procurement",
  version: "2.0.0",
  name: "Procurement operations",
  sources: [
    { id: "erpOrders", system: "ERP", kind: "database", resource: "purchase_orders" },
    { id: "erpSuppliers", system: "ERP", kind: "database", resource: "suppliers" },
  ],
  values: [
    { id: "identifier", name: "Identifier", kind: "string" },
    { id: "money", name: "Money", kind: "decimal", unit: "USD" },
    { id: "orderStatus", name: "Order status", kind: "enum", enumValues: ["DRAFT", "PENDING", "APPROVED"] },
    { id: "boolean", name: "Boolean", kind: "boolean" },
  ],
  sharedProperties: [{ id: "externalId", name: "External ID", valueTypeId: "identifier" }],
  objects: [
    {
      id: "Supplier",
      name: "Supplier",
      primaryKey: "id",
      sourceRefs: ["erpSuppliers"],
      properties: [
        { id: "id", sharedPropertyId: "externalId", required: true },
        { id: "sanctioned", valueTypeId: "boolean", required: true },
      ],
    },
    {
      id: "PurchaseOrder",
      name: "Purchase order",
      primaryKey: "id",
      sourceRefs: ["erpOrders"],
      implements: ["ApprovableOrder"],
      properties: [
        { id: "id", sharedPropertyId: "externalId", required: true },
        { id: "amount", valueTypeId: "money", required: true },
        { id: "status", valueTypeId: "orderStatus", required: true },
      ],
    },
  ],
  relations: [
    {
      id: "suppliedBy",
      name: "Supplied by",
      from: { objectTypeId: "PurchaseOrder", cardinality: "many" },
      to: { objectTypeId: "Supplier", cardinality: "one" },
      sourceRefs: ["erpOrders"],
    },
  ],
  interfaces: [
    {
      id: "ApprovableOrder",
      name: "Approvable order",
      properties: [
        { id: "id", valueTypeId: "identifier", required: true },
        { id: "amount", valueTypeId: "money", required: true },
      ],
      actionIds: ["approveOrder"],
    },
  ],
  rules: [
    {
      id: "positiveAmount",
      name: "Positive order amount",
      appliesTo: { kind: "object", id: "PurchaseOrder" },
      purpose: "validation",
      severity: "error",
      predicate: { op: "gt", left: { kind: "fact", path: "order.amount" }, right: { kind: "literal", value: 0 } },
    },
  ],
  actions: [
    {
      id: "approveOrder",
      name: "Approve purchase order",
      input: [{ id: "orderId", valueTypeId: "identifier", required: true }],
      output: [{ id: "status", valueTypeId: "orderStatus", required: true }],
      targetObjectTypeId: "PurchaseOrder",
      objectIdParameterId: "orderId",
      approval: "risk-based",
      risk: "high",
      guard: { op: "eq", left: { kind: "fact", path: "order.status" }, right: { kind: "literal", value: "PENDING" } },
      policyIds: ["managerMayApprove", "sanctionedSupplierDeny"],
      idempotent: true,
    },
  ],
  functions: [
    {
      id: "calculateExposure",
      name: "Calculate supplier exposure",
      input: [{ id: "supplierId", valueTypeId: "identifier", required: true }],
      output: [{ id: "amount", valueTypeId: "money" }],
      execution: { kind: "service", ref: "procurement/exposure" },
      sideEffect: "pure",
    },
  ],
  events: [
    {
      id: "orderApproved",
      name: "Order approved",
      payload: [{ id: "orderId", valueTypeId: "identifier", required: true }],
      subjectObjectTypeId: "PurchaseOrder",
    },
  ],
  policies: [
    {
      id: "managerMayApprove",
      name: "Managers may approve",
      appliesTo: ["approveOrder"],
      effect: "allow",
      requiredScopes: ["po:approve"],
      guard: {
        op: "all",
        of: [
          { op: "eq", left: { kind: "fact", path: "actor.role" }, right: { kind: "literal", value: "procurement-manager" } },
          { op: "lte", left: { kind: "fact", path: "order.amount" }, right: { kind: "literal", value: 5000 } },
        ],
      },
    },
    {
      id: "sanctionedSupplierDeny",
      name: "Sanctioned supplier block",
      appliesTo: ["approveOrder"],
      effect: "deny",
      guard: { op: "eq", left: { kind: "fact", path: "supplier.sanctioned" }, right: { kind: "literal", value: true } },
    },
  ],
};

const safeFacts = {
  scopes: ["po:approve"],
  actor: { role: "procurement-manager" },
  order: { amount: 1200, status: "PENDING" },
  supplier: { sanctioned: false },
};

type DeepMutable<T> = T extends ReadonlyArray<infer U>
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

test("procurement bundle validates all ontology kinds and interface conformance", () => {
  assert.deepEqual(validateBundle(procurementBundle), []);
  assert.equal(evaluateRule(procurementBundle.rules[0]!, safeFacts).outcome, "true");
});

test("validation reports deterministic actionable cross-reference diagnostics", () => {
  const broken = structuredClone(procurementBundle) as DeepMutable<OntologyBundle>;
  broken.objects[1]!.properties[1]!.valueTypeId = "missingMoney";
  broken.relations[0]!.to.objectTypeId = "missingSupplier";
  broken.actions[0]!.policyIds = ["missingPolicy"];
  const first = validateBundle(broken);
  const second = validateBundle(broken);
  assert.deepEqual(first, second);
  assert.ok(first.some((item) => item.code === "UNKNOWN_REFERENCE" && item.path.includes("valueTypeId") && item.suggestion));
  assert.ok(first.some((item) => item.code === "UNKNOWN_REFERENCE" && item.path.includes("objectTypeId")));
  assert.ok(first.some((item) => item.code === "UNKNOWN_REFERENCE" && item.path.includes("policyIds")));
});

test("rule purpose is explicit in the published contract", () => {
  const broken = structuredClone(procurementBundle) as DeepMutable<OntologyBundle>;
  broken.rules[0]!.purpose = "unknown" as "validation";
  assert.ok(validateBundle(broken).some((item) => item.code === "INVALID_ENUM" && item.path === "rules[0].purpose"));
});

test("material actions declare a typed object identity contract", () => {
  const missing = structuredClone(procurementBundle) as DeepMutable<OntologyBundle>;
  delete missing.actions[0]!.targetObjectTypeId;
  delete missing.actions[0]!.objectIdParameterId;
  assert.ok(validateBundle(missing).some((item) => item.code === "ACTION_OBJECT_REFERENCE_REQUIRED"));

  const badParameter = structuredClone(procurementBundle) as DeepMutable<OntologyBundle>;
  badParameter.actions[0]!.objectIdParameterId = "missing";
  assert.ok(validateBundle(badParameter).some((item) => item.code === "ACTION_OBJECT_ID_PARAMETER_INVALID"));

  const badType = structuredClone(procurementBundle) as DeepMutable<OntologyBundle>;
  badType.actions[0]!.targetObjectTypeId = "MissingObject";
  assert.ok(validateBundle(badType).some((item) => item.code === "UNKNOWN_REFERENCE" && item.path.endsWith("targetObjectTypeId")));
});

test("finite guards and action authorization fail closed on missing or incompatible facts", () => {
  const allowed = authorizeAction(procurementBundle, "approveOrder", safeFacts);
  assert.equal(allowed.decision, "allow");
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.matchedPolicyIds, ["managerMayApprove"]);

  const unknownSupplier = authorizeAction(procurementBundle, "approveOrder", { ...safeFacts, supplier: {} });
  assert.equal(unknownSupplier.allowed, false);
  assert.deepEqual(unknownSupplier.unknownFacts, ["supplier.sanctioned"]);

  const sanctioned = authorizeAction(procurementBundle, "approveOrder", { ...safeFacts, supplier: { sanctioned: true } });
  assert.equal(sanctioned.allowed, false);
  assert.match(sanctioned.reason, /Explicit deny/);

  const missingScope = authorizeAction(procurementBundle, "approveOrder", { ...safeFacts, scopes: undefined });
  assert.equal(missingScope.allowed, false);
  assert.deepEqual(missingScope.unknownFacts, ["scopes"]);

  const malformed = evaluateGuard({ op: "gt", left: { kind: "fact", path: "order.amount" }, right: { kind: "literal", value: "large" } }, safeFacts);
  assert.equal(malformed.outcome, "unknown");
});

test("oversized guards and unsafe fact paths cannot grant access", () => {
  const oversized: Guard = {
    op: "any",
    of: Array.from({ length: 300 }, (_, index): Guard => ({
      op: "eq",
      left: { kind: "literal", value: index },
      right: { kind: "literal", value: 0 },
    })),
  };
  assert.equal(evaluateGuard(oversized, safeFacts).outcome, "unknown");
  const broken = structuredClone(procurementBundle) as DeepMutable<OntologyBundle>;
  broken.actions[0]!.guard = oversized as DeepMutable<Guard>;
  assert.ok(validateBundle(broken).some((item) => item.code === "GUARD_LIMIT_EXCEEDED"));
  assert.equal(authorizeAction(broken, "approveOrder", safeFacts).allowed, false);
  assert.equal(isValidFactPath("__proto__.polluted"), false);
});

test("release manifest is immutable and binds the exact bundle content", () => {
  const releasedAt = "2026-09-26T00:00:00.000Z";
  const manifest = createReleaseManifest(procurementBundle, releasedAt);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.definitionCounts), true);
  assert.equal(verifyReleaseManifest(procurementBundle, manifest), true);
  assert.equal(manifest.bundleHash, hashBundle(procurementBundle));
  assert.equal(canonicalize({ z: 1, a: 2 }), canonicalize({ a: 2, z: 1 }));

  const changed = structuredClone(procurementBundle) as DeepMutable<OntologyBundle>;
  changed.actions[0]!.risk = "low";
  assert.equal(verifyReleaseManifest(changed, manifest), false);
  assert.throws(() => createReleaseManifest(procurementBundle, "2026-09-26"), /canonical UTC/);
});
