import type { ActionDefinition, OntologyBundle, ReleaseManifest } from "../../contracts/src/index.js";
import { authorizeAction, verifyReleaseManifest } from "../../ontology-kernel/src/index.js";
import { hashActionBinding, validateActionBinding, type ActionBindingSource } from "./binding.js";
import { canonicalJson } from "./canonical.js";
import type { ActionIntent, PolicyDecision, PolicyPort } from "./types.js";

export interface AuthorizationFactsPort {
  /** When an intent has objectRef, return the live sourceRevision for that object. */
  load(intent: ActionIntent): Promise<Readonly<Record<string, unknown>>>;
}

/** Independent trusted activation record; publishing a manifest does not activate it. */
export interface OntologyReleaseStatusSource {
  getStatus(tenantId: string, releaseId: string): Promise<{
    tenantId: string;
    releaseId: string;
    bundleHash: ReleaseManifest["bundleHash"];
    state: "active" | "inactive" | "revoked";
  } | undefined>;
}

/** Validates the exact ontology release, action contract, and policy on every decision. */
export class OntologyPolicyPort implements PolicyPort {
  constructor(
    private readonly bundle: OntologyBundle,
    private readonly release: ReleaseManifest,
    private readonly facts: AuthorizationFactsPort,
    private readonly bindings: ActionBindingSource,
    private readonly releaseStatus: OntologyReleaseStatusSource,
  ) {}

  async evaluate(intent: ActionIntent): Promise<PolicyDecision> {
    const deny = (reason: string): PolicyDecision => ({
      decision: "deny",
      reason,
      approval: "none",
      policyVersion: this.release.bundleHash,
    });
    if (!verifyReleaseManifest(this.bundle, this.release)) return deny("Ontology release manifest is invalid");
    if (intent.ontologyRelease !== this.release.bundleHash) return deny("Intent targets a different ontology release");
    const activeRelease = await this.releaseStatus.getStatus(intent.tenantId, this.release.releaseId);
    if (!activeRelease || activeRelease.state !== "active" || activeRelease.tenantId !== intent.tenantId ||
        activeRelease.releaseId !== this.release.releaseId || activeRelease.bundleHash !== this.release.bundleHash) {
      return deny("Ontology release is not active for this tenant");
    }
    const action = this.bundle.actions.find((item) => item.id === intent.actionId);
    if (!action) return deny(`Action ${intent.actionId} is not in the pinned ontology release`);
    const snapshot = await this.bindings.resolve(intent.tenantId, intent.environment, action.id);
    if (!snapshot || snapshot.state !== "active") return deny("Action binding is not active");
    const binding = snapshot.binding;
    if (validateActionBinding(binding).length || hashActionBinding(binding) !== snapshot.bindingHash ||
        intent.bindingHash !== snapshot.bindingHash || binding.tenantId !== intent.tenantId ||
        binding.environment !== intent.environment || binding.ontologyRelease !== this.release.bundleHash ||
        binding.actionId !== action.id) return deny("Action binding does not match the pinned tenant, environment, release, and action");
    if (canonicalJson(intent.target) !== canonicalJson(binding.adapter.target)) return deny("Connector target does not match the active action binding");
    if (action.risk !== "low" && (!binding.guarantees.conditionalWrite || !binding.guarantees.readback || !binding.guarantees.reconciliation)) {
      return deny("Material action binding lacks conditional write, readback, or reconciliation capability");
    }
    const inputError = validateActionInput(action, intent.args, this.bundle);
    if (inputError) return deny(inputError);
    if (action.risk !== "low" && !intent.objectRef) {
      return deny("Material action requires an object reference with expected source revision");
    }
    if (action.targetObjectTypeId && intent.objectRef?.objectTypeId !== action.targetObjectTypeId) {
      return deny("Intent object type does not match the action definition");
    }
    if (action.objectIdParameterId && intent.objectRef) {
      const input = intent.args as Record<string, unknown>;
      if (input[action.objectIdParameterId] !== intent.objectRef.objectId) {
        return deny("Intent object ID does not match the action input");
      }
    }
    const loaded = await this.facts.load(intent);
    if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) return deny("Authorization facts are unavailable");
    if (intent.objectRef && loaded.sourceRevision !== intent.objectRef.expectedRevision) {
      return deny(typeof loaded.sourceRevision === "string" ? "Source revision changed since action intent creation" : "Source revision is unavailable");
    }
    const authorization = authorizeAction(this.bundle, action.id, {
      ...loaded,
      tenantId: intent.tenantId,
      actorId: intent.actorId,
      actionId: intent.actionId,
      args: intent.args,
      target: intent.target,
    });
    if (!authorization.allowed) return deny(authorization.reason);
    return {
      decision: "allow",
      reason: authorization.reason,
      approval: action.approval === "always" || (action.approval === "risk-based" && action.risk !== "low") ? "required" : "none",
      policyVersion: this.release.bundleHash,
      risk: action.risk,
      ...(action.risk !== "low" ? { approvalMaxTtlMs: action.risk === "high" ? 15 * 60_000 : 60 * 60_000 } : {}),
    };
  }
}

function validateActionInput(action: ActionDefinition, args: unknown, bundle: OntologyBundle): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "Action input must be a JSON object";
  const input = args as Record<string, unknown>;
  const parameters = new Map(action.input.map((parameter) => [parameter.id, parameter]));
  for (const key of Object.keys(input)) {
    if (!parameters.has(key)) return `Unknown action parameter ${key}`;
  }
  for (const parameter of action.input) {
    if (!(parameter.id in input)) {
      if (parameter.required) return `Missing required action parameter ${parameter.id}`;
      continue;
    }
    const valueType = bundle.values.find((item) => item.id === parameter.valueTypeId);
    if (!valueType) return `Unknown value type ${parameter.valueTypeId}`;
    const value = input[parameter.id];
    const valid = (() => {
      switch (valueType.kind) {
        case "string": return typeof value === "string";
        case "integer": return typeof value === "number" && Number.isSafeInteger(value);
        case "decimal": return typeof value === "number" && Number.isFinite(value);
        case "boolean": return typeof value === "boolean";
        case "date": return typeof value === "string" && isRealDate(value);
        case "datetime": return typeof value === "string" && isOffsetDateTime(value);
        case "enum": return valueType.enumValues?.some((member) => member === value) ?? false;
      }
    })();
    if (!valid) return `Invalid value for action parameter ${parameter.id}`;
  }
  return undefined;
}

function isRealDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function isOffsetDateTime(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || !isRealDate(match[1]!)) return false;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4]);
  const offsetHour = Number(match[8] ?? 0);
  const offsetMinute = Number(match[9] ?? 0);
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 14 && offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0) && Number.isFinite(Date.parse(value));
}
