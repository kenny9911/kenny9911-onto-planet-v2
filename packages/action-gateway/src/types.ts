import type { JsonValue } from "./canonical.js";

export type { JsonValue } from "./canonical.js";

export interface ActionTarget {
  system: string;
  operation: string;
  resource?: string;
}

export interface ObjectRef {
  objectTypeId: string;
  objectId: string;
  expectedRevision: string;
}

export interface ActionIntentInput {
  tenantId: string;
  actorId: string;
  runId?: string;
  ontologyRelease: string;
  actionId: string;
  environment: string;
  bindingHash: `sha256:${string}`;
  target: ActionTarget;
  objectRef?: ObjectRef;
  deadlineAt?: string;
  args: JsonValue;
  idempotencyKey: string;
}

export interface ActionIntent extends ActionIntentInput {
  id: string;
  intentHash: string;
  createdAt: string;
}

export type IntentState =
  | "created"
  | "awaiting_approval"
  | "ready"
  | "denied"
  | "executing"
  | "verifying"
  | "unknown"
  | "reconciling"
  | "succeeded"
  | "failed";

export interface ActionPreview {
  summary: string;
  effects: string[];
  preconditionToken?: string;
  details?: JsonValue;
}

export interface PolicyDecision {
  decision: "allow" | "deny";
  reason: string;
  approval: "required" | "none";
  policyVersion: string;
  risk?: "low" | "medium" | "high";
  approvalMaxTtlMs?: number;
}

export interface Approval {
  tenantId: string;
  intentHash: string;
  approverId: string;
  decision: "approved" | "rejected";
  decidedAt: string;
  expiresAt?: string;
  reason?: string;
  evidenceId: string;
}

export interface ExternalReceipt {
  externalOperationId: string;
  acceptedAt: string;
  details?: JsonValue;
}

export type ExecutionOutcome =
  | { status: "accepted"; receipt: ExternalReceipt }
  | { status: "rejected"; reason: string }
  | { status: "unknown"; reason: string };

export type VerificationOutcome =
  | { status: "verified"; evidence: JsonValue }
  | { status: "failed"; reason: string; evidence?: JsonValue }
  | { status: "unknown"; reason: string };

export type ReconciliationOutcome = ExecutionOutcome | { status: "pending"; reason: string };

export interface ConnectorPort {
  /** Read-only description of the exact intended effect. */
  preview(intent: ActionIntent): Promise<ActionPreview>;
  /** Must forward idempotencyKey to the underlying system when supported. */
  execute(intent: ActionIntent, preview: ActionPreview): Promise<ExecutionOutcome>;
  /** Checks source-system state; an accepted request alone is not success. */
  verify(intent: ActionIntent, receipt: ExternalReceipt): Promise<VerificationOutcome>;
  /** Queries by idempotency key or external operation ID; must never execute again. */
  reconcile(intent: ActionIntent, receipt?: ExternalReceipt): Promise<ReconciliationOutcome>;
}

export interface PolicyPort {
  evaluate(intent: ActionIntent): Promise<PolicyDecision>;
}

export interface ApprovalAuthorityPort {
  verify(approval: Approval, intent: ActionIntent): Promise<boolean>;
}

export type AuditEventKind =
  | "intent_created"
  | "policy_denied"
  | "previewed"
  | "preview_failed"
  | "approval_granted"
  | "approval_rejected"
  | "execution_reserved"
  | "execution_accepted"
  | "execution_rejected"
  | "execution_unknown"
  | "verification_succeeded"
  | "verification_failed"
  | "verification_unknown"
  | "reconciliation_started"
  | "reconciliation_pending";

export interface AuditEvent {
  id: string;
  at: string;
  tenantId: string;
  intentId: string;
  intentHash: string;
  kind: AuditEventKind;
  details: JsonValue;
}

export interface IntentRecord {
  intent: ActionIntent;
  state: IntentState;
  version: number;
  preview?: ActionPreview;
  policy?: PolicyDecision;
  approval?: Approval;
  receipt?: ExternalReceipt;
  verification?: VerificationOutcome;
  unknownReason?: string;
  executionReservedAt?: string;
  reconciliationReservedAt?: string;
  events: AuditEvent[];
}

export interface IntentStore {
  get(tenantId: string, idempotencyKey: string): Promise<IntentRecord | undefined>;
  putIfAbsent(record: IntentRecord): Promise<IntentRecord>;
  compareAndSwap(record: IntentRecord, expectedVersion: number): Promise<boolean>;
}
