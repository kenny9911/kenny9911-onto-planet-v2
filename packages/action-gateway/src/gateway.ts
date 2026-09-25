import { randomUUID } from "node:crypto";
import { canonicalJson, digestJson } from "./canonical.js";
import type {
  ActionIntent,
  ActionIntentInput,
  Approval,
  ApprovalAuthorityPort,
  AuditEvent,
  AuditEventKind,
  ConnectorPort,
  ExecutionOutcome,
  IntentRecord,
  IntentStore,
  JsonValue,
  PolicyDecision,
  PolicyPort,
  ReconciliationOutcome,
  VerificationOutcome,
} from "./types.js";

export class IntentConflictError extends Error {}
export class IntentStateError extends Error {}
export class ApprovalError extends Error {}

export interface ActionGatewayOptions {
  store: IntentStore;
  policy: PolicyPort;
  approvalAuthority: ApprovalAuthorityPort;
  connector: ConnectorPort;
  now?: () => Date;
  id?: () => string;
  executionLeaseMs?: number;
}

/**
 * Coordinates a single external operation per tenant/idempotency key. The store's
 * compare-and-swap must be durable and atomic before a production connector is used.
 */
export class ActionGateway {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly executionLeaseMs: number;

  constructor(private readonly options: ActionGatewayOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.executionLeaseMs = options.executionLeaseMs ?? 30_000;
    if (!Number.isInteger(this.executionLeaseMs) || this.executionLeaseMs < 1) throw new TypeError("executionLeaseMs must be positive");
  }

  async createIntent(input: ActionIntentInput): Promise<IntentRecord> {
    for (const [name, value] of Object.entries({
      tenantId: input.tenantId,
      actorId: input.actorId,
      ontologyRelease: input.ontologyRelease,
      actionId: input.actionId,
      environment: input.environment,
      bindingHash: input.bindingHash,
      system: input.target.system,
      operation: input.target.operation,
      idempotencyKey: input.idempotencyKey,
    })) {
      if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.ontologyRelease)) {
      throw new TypeError("ontologyRelease must be a pinned sha256 digest");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(input.bindingHash)) {
      throw new TypeError("bindingHash must be a pinned sha256 digest");
    }
    if (input.objectRef !== undefined && (!input.objectRef ||
      [input.objectRef.objectTypeId, input.objectRef.objectId, input.objectRef.expectedRevision].some((value) => typeof value !== "string" || value.trim() === ""))) {
      throw new TypeError("objectRef requires type, ID, and expected source revision");
    }
    if (input.deadlineAt !== undefined && (typeof input.deadlineAt !== "string" || !Number.isFinite(Date.parse(input.deadlineAt)) || new Date(input.deadlineAt).toISOString() !== input.deadlineAt)) {
      throw new TypeError("deadlineAt must be a canonical UTC timestamp");
    }
    const sanitized = JSON.parse(canonicalJson(input)) as ActionIntentInput;
    const intentHash = digestJson({
      tenantId: sanitized.tenantId,
      actorId: sanitized.actorId,
      runId: sanitized.runId ?? null,
      ontologyRelease: sanitized.ontologyRelease,
      actionId: sanitized.actionId,
      environment: sanitized.environment,
      bindingHash: sanitized.bindingHash,
      target: sanitized.target,
      objectRef: sanitized.objectRef ?? null,
      deadlineAt: sanitized.deadlineAt ?? null,
      args: sanitized.args,
      idempotencyKey: sanitized.idempotencyKey,
    });
    const intent: ActionIntent = {
      ...sanitized,
      id: this.id(),
      intentHash,
      createdAt: this.timestamp(),
    };
    const record: IntentRecord = {
      intent,
      state: "created",
      version: 0,
      events: [this.event(intent, "intent_created", { actionId: intent.actionId, target: JSON.parse(canonicalJson(intent.target)) as JsonValue })],
    };
    const stored = await this.options.store.putIfAbsent(record);
    if (stored.intent.intentHash !== intentHash) {
      throw new IntentConflictError("Idempotency key is already bound to a different action intent");
    }
    return stored;
  }

  async get(tenantId: string, idempotencyKey: string): Promise<IntentRecord | undefined> {
    return this.options.store.get(tenantId, idempotencyKey);
  }

  async preview(tenantId: string, idempotencyKey: string): Promise<IntentRecord> {
    const record = await this.required(tenantId, idempotencyKey);
    if (record.state !== "created") return record;
    if (this.expired(record.intent)) return this.deny(record, "Action intent deadline expired");
    const policy = await this.evaluate(record.intent);
    if (policy.decision === "deny") return this.deny(record, policy.reason);
    const windowError = this.materialWindowError(record.intent, policy);
    if (windowError) return this.deny(record, windowError);

    let preview;
    try {
      preview = await this.options.connector.preview(record.intent);
      canonicalJson(preview);
    } catch (error) {
      return this.update(tenantId, idempotencyKey, (current) => {
        if (current.state !== "created") return false;
        current.state = "failed";
        current.events.push(this.event(current.intent, "preview_failed", { reason: message(error) }));
        return true;
      });
    }
    return this.update(tenantId, idempotencyKey, (current) => {
      if (current.state !== "created") return false;
      if (this.expired(current.intent)) {
        current.state = "denied";
        current.events.push(this.event(current.intent, "policy_denied", { reason: "Action intent deadline expired" }));
        return true;
      }
      current.preview = preview;
      current.policy = policy;
      current.state = policy.approval === "required" ? "awaiting_approval" : "ready";
      current.events.push(this.event(current.intent, "previewed", {
        previewHash: digestJson(preview),
        policyVersion: policy.policyVersion,
        approval: policy.approval,
      }));
      return true;
    });
  }

  async approve(tenantId: string, idempotencyKey: string, approval: Approval): Promise<IntentRecord> {
    const record = await this.required(tenantId, idempotencyKey);
    if (record.state !== "awaiting_approval") throw new IntentStateError("Intent is not awaiting approval");
    if (this.expired(record.intent)) throw new ApprovalError("Action intent deadline expired");
    if (approval.tenantId !== tenantId || approval.intentHash !== record.intent.intentHash) {
      throw new ApprovalError("Approval is not bound to this tenant and canonical intent hash");
    }
    if (!approval.approverId || !approval.evidenceId || approval.approverId === record.intent.actorId) {
      throw new ApprovalError("Independent approver identity and evidence are required");
    }
    const decidedAt = Date.parse(approval.decidedAt);
    if (!Number.isFinite(decidedAt) || decidedAt > this.now().getTime() || decidedAt < Date.parse(record.intent.createdAt)) {
      throw new ApprovalError("Invalid approval time");
    }
    if (approval.expiresAt && (!Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= this.now().getTime())) {
      throw new ApprovalError("Approval has expired");
    }
    if (record.policy?.approvalMaxTtlMs) {
      if (!approval.expiresAt || Date.parse(approval.expiresAt) > decidedAt + record.policy.approvalMaxTtlMs ||
          (record.intent.deadlineAt && Date.parse(approval.expiresAt) > Date.parse(record.intent.deadlineAt))) {
        throw new ApprovalError("Material-action approval requires an expiry within policy TTL and intent deadline");
      }
    }
    if (!(await this.options.approvalAuthority.verify(approval, record.intent))) {
      throw new ApprovalError("Approval authority rejected the decision");
    }
    return this.update(tenantId, idempotencyKey, (current) => {
      if (current.state !== "awaiting_approval") return false;
      current.approval = structuredClone(approval);
      current.state = approval.decision === "approved" ? "ready" : "denied";
      current.events.push(this.event(current.intent, approval.decision === "approved" ? "approval_granted" : "approval_rejected", {
        approverId: approval.approverId,
        evidenceId: approval.evidenceId,
        reason: approval.reason ?? null,
      }));
      return true;
    });
  }

  async execute(tenantId: string, idempotencyKey: string): Promise<IntentRecord> {
    const record = await this.required(tenantId, idempotencyKey);
    if (record.state !== "ready") return record;
    if (this.expired(record.intent)) return this.deny(record, "Action intent deadline expired");
    if (!record.preview || !record.policy) throw new IntentStateError("Ready intent has no preview or policy decision");
    const policy = await this.evaluate(record.intent);
    if (policy.decision === "deny" || policy.policyVersion !== record.policy.policyVersion || policy.approval !== record.policy.approval ||
        policy.risk !== record.policy.risk || policy.approvalMaxTtlMs !== record.policy.approvalMaxTtlMs) {
      return this.deny(record, policy.decision === "deny" ? policy.reason : "Policy changed after preview");
    }
    const windowError = this.materialWindowError(record.intent, policy);
    if (windowError) return this.deny(record, windowError);
    if (this.expired(record.intent)) return this.deny(record, "Action intent deadline expired");
    if (policy.approval === "required") {
      if (!record.approval || record.approval.decision !== "approved" || record.approval.intentHash !== record.intent.intentHash) {
        return this.deny(record, "Approval missing or mismatched");
      }
      if (record.approval.expiresAt && Date.parse(record.approval.expiresAt) <= this.now().getTime()) {
        return this.deny(record, "Approval expired");
      }
      if (policy.approvalMaxTtlMs && !record.approval.expiresAt) return this.deny(record, "Material-action approval expiry is missing");
      let verified = false;
      try { verified = await this.options.approvalAuthority.verify(record.approval, record.intent); }
      catch { /* fail closed */ }
      if (!verified) {
        return this.deny(record, "Approval authority revoked the decision");
      }
    }
    const reservation = await this.reserveExecution(tenantId, idempotencyKey);
    if (!reservation.won) return reservation.record;
    const reserved = reservation.record;
    let outcome: ExecutionOutcome;
    try {
      outcome = await this.options.connector.execute(reserved.intent, reserved.preview!);
    } catch (error) {
      outcome = { status: "unknown", reason: `Connector did not return a definitive result: ${message(error)}` };
    }
    return this.finishExecution(reserved, outcome);
  }

  async reconcile(tenantId: string, idempotencyKey: string): Promise<IntentRecord> {
    const record = await this.required(tenantId, idempotencyKey);
    if (record.state !== "unknown" && !this.isStaleAttempt(record)) return record;
    const reserved = await this.reserveReconciliation(tenantId, idempotencyKey);
    if (!reserved.won) return reserved.record;
    let outcome: ReconciliationOutcome;
    try {
      outcome = await this.options.connector.reconcile(reserved.record.intent, reserved.record.receipt);
    } catch (error) {
      outcome = { status: "unknown", reason: `Reconciliation unavailable: ${message(error)}` };
    }
    if (outcome.status === "pending" || outcome.status === "unknown") {
      const updated = await this.updateOwned(reserved.record, (current) => {
        current.state = "unknown";
        current.unknownReason = outcome.reason;
        current.events.push(this.event(current.intent, "reconciliation_pending", { reason: outcome.reason }));
      });
      return updated.record;
    }
    return this.finishExecution(reserved.record, outcome);
  }

  private async reserveExecution(tenantId: string, key: string): Promise<{ won: boolean; record: IntentRecord }> {
    for (;;) {
      const current = await this.required(tenantId, key);
      if (current.state !== "ready") return { won: false, record: current };
      if (this.expired(current.intent)) return { won: false, record: await this.deny(current, "Action intent deadline expired") };
      if (current.policy?.approval === "required" && current.approval?.expiresAt && Date.parse(current.approval.expiresAt) <= this.now().getTime()) {
        return { won: false, record: await this.deny(current, "Approval expired") };
      }
      const next = structuredClone(current);
      next.state = "executing";
      next.executionReservedAt = this.timestamp();
      next.version++;
      next.events.push(this.event(next.intent, "execution_reserved", { idempotencyKey: key }));
      if (await this.options.store.compareAndSwap(next, current.version)) return { won: true, record: next };
    }
  }

  private async reserveReconciliation(tenantId: string, key: string): Promise<{ won: boolean; record: IntentRecord }> {
    for (;;) {
      const current = await this.required(tenantId, key);
      if (current.state !== "unknown" && !this.isStaleAttempt(current)) return { won: false, record: current };
      const next = structuredClone(current);
      next.state = "reconciling";
      next.reconciliationReservedAt = this.timestamp();
      next.version++;
      next.events.push(this.event(next.intent, "reconciliation_started", {}));
      if (await this.options.store.compareAndSwap(next, current.version)) return { won: true, record: next };
    }
  }

  private async finishExecution(reservation: IntentRecord, outcome: ExecutionOutcome): Promise<IntentRecord> {
    if (outcome.status === "unknown") {
      const updated = await this.updateOwned(reservation, (current) => {
        current.state = "unknown";
        current.unknownReason = outcome.reason;
        current.events.push(this.event(current.intent, "execution_unknown", { reason: outcome.reason }));
      });
      return updated.record;
    }
    if (outcome.status === "rejected") {
      const updated = await this.updateOwned(reservation, (current) => {
        current.state = "failed";
        current.events.push(this.event(current.intent, "execution_rejected", { reason: outcome.reason }));
      });
      return updated.record;
    }
    const transition = await this.updateOwned(reservation, (current) => {
      current.state = "verifying";
      current.receipt = outcome.receipt;
      current.events.push(this.event(current.intent, "execution_accepted", { externalOperationId: outcome.receipt.externalOperationId }));
    });
    // A superseded worker must not verify against another attempt's state.
    if (!transition.won) return transition.record;
    const verifying = transition.record;
    let verification: VerificationOutcome;
    try {
      verification = await this.options.connector.verify(verifying.intent, outcome.receipt);
    } catch (error) {
      verification = { status: "unknown", reason: `Verification unavailable: ${message(error)}` };
    }
    // The verification result belongs to this exact reservation/version. A
    // reconciler may have superseded it while the source-system read was slow.
    const completed = structuredClone(verifying);
    completed.verification = verification;
      if (verification.status === "verified") {
        completed.state = "succeeded";
        completed.events.push(this.event(completed.intent, "verification_succeeded", { evidence: verification.evidence }));
      } else if (verification.status === "failed") {
        completed.state = "failed";
        completed.events.push(this.event(completed.intent, "verification_failed", { reason: verification.reason, evidence: verification.evidence ?? null }));
      } else {
        completed.state = "unknown";
        completed.unknownReason = verification.reason;
        completed.events.push(this.event(completed.intent, "verification_unknown", { reason: verification.reason }));
      }
    completed.version++;
    if (await this.options.store.compareAndSwap(completed, verifying.version)) return completed;
    return this.required(reservation.intent.tenantId, reservation.intent.idempotencyKey);
  }

  private async evaluate(intent: ActionIntent): Promise<PolicyDecision> {
    try {
      const decision = await this.options.policy.evaluate(intent);
      if (!decision || !["allow", "deny"].includes(decision.decision) || !["required", "none"].includes(decision.approval) || !decision.policyVersion) {
        throw new Error("Invalid policy decision");
      }
      return decision;
    } catch (error) {
      return { decision: "deny", reason: `Policy evaluation unavailable: ${message(error)}`, approval: "none", policyVersion: "unavailable" };
    }
  }

  private isStaleAttempt(record: IntentRecord): boolean {
    if (record.state !== "executing" && record.state !== "verifying" && record.state !== "reconciling") return false;
    const reservedAt = record.state === "executing"
      ? record.executionReservedAt
      : record.reconciliationReservedAt ?? record.executionReservedAt;
    return !!reservedAt && Date.parse(reservedAt) + this.executionLeaseMs <= this.now().getTime();
  }

  /** A completion belongs to one reservation version, even when a newer attempt has the same state. */
  private async updateOwned(reservation: IntentRecord, mutate: (record: IntentRecord) => void): Promise<{ won: boolean; record: IntentRecord }> {
    const tenantId = reservation.intent.tenantId;
    const key = reservation.intent.idempotencyKey;
    const current = await this.required(tenantId, key);
    if (current.version !== reservation.version || current.state !== reservation.state) return { won: false, record: current };
    const next = structuredClone(current);
    mutate(next);
    next.version++;
    if (await this.options.store.compareAndSwap(next, reservation.version)) return { won: true, record: next };
    return { won: false, record: await this.required(tenantId, key) };
  }

  private expired(intent: ActionIntent): boolean {
    return intent.deadlineAt !== undefined && Date.parse(intent.deadlineAt) <= this.now().getTime();
  }

  private materialWindowError(intent: ActionIntent, policy: PolicyDecision): string | undefined {
    if (!policy.approvalMaxTtlMs) return undefined;
    if (!intent.deadlineAt) return "Material action requires a bounded deadline";
    if (Date.parse(intent.deadlineAt) > this.now().getTime() + policy.approvalMaxTtlMs) {
      return "Material action deadline exceeds policy window";
    }
    return undefined;
  }

  private async deny(record: IntentRecord, reason: string): Promise<IntentRecord> {
    return this.update(record.intent.tenantId, record.intent.idempotencyKey, (current) => {
      if (current.state !== "created" && current.state !== "ready") return false;
      current.state = "denied";
      current.events.push(this.event(current.intent, "policy_denied", { reason }));
      return true;
    });
  }

  private async update(tenantId: string, key: string, mutate: (record: IntentRecord) => boolean): Promise<IntentRecord> {
    for (;;) {
      const current = await this.required(tenantId, key);
      const next = structuredClone(current);
      if (!mutate(next)) return current;
      next.version++;
      if (await this.options.store.compareAndSwap(next, current.version)) return next;
    }
  }

  private async required(tenantId: string, key: string): Promise<IntentRecord> {
    const record = await this.options.store.get(tenantId, key);
    if (!record) throw new IntentStateError("Action intent not found in tenant scope");
    return record;
  }

  private timestamp(): string { return this.now().toISOString(); }

  private event(intent: ActionIntent, kind: AuditEventKind, details: JsonValue): AuditEvent {
    return {
      id: this.id(),
      at: this.timestamp(),
      tenantId: intent.tenantId,
      intentId: intent.id,
      intentHash: intent.intentHash,
      kind,
      details,
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
