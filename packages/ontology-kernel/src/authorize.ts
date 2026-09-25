import type { OntologyBundle, PolicyDefinition } from "../../contracts/src/index.js";
import { evaluateGuard } from "./guard.js";
import { validateBundle } from "./validate.js";

export interface AuthorizationResult {
  allowed: boolean;
  decision: "allow" | "deny";
  reason: string;
  matchedPolicyIds: string[];
  unknownFacts: string[];
}

function deny(reason: string, matchedPolicyIds: string[] = [], unknownFacts: string[] = []): AuthorizationResult {
  return { allowed: false, decision: "deny", reason, matchedPolicyIds, unknownFacts };
}

/** Policy evaluation is deny by default; explicit deny and unknown outrank allow. */
export function authorizeAction(bundle: OntologyBundle, actionId: string, facts: Readonly<Record<string, unknown>>): AuthorizationResult {
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) return deny("Facts context must be an object");
  const diagnostics = validateBundle(bundle);
  if (diagnostics.length > 0) return deny(`Ontology bundle is invalid: ${diagnostics[0]?.code ?? "unknown error"}`);
  const action = bundle.actions.find((candidate) => candidate.id === actionId);
  if (!action) return deny(`Action ${actionId} is not defined`);
  if (action.guard) {
    const guard = evaluateGuard(action.guard, facts);
    if (guard.outcome !== "true") return deny(`Action guard ${guard.outcome}: ${guard.reason}`, [], guard.unknownFacts);
  }
  if (!action.policyIds || action.policyIds.length === 0) return deny(`Action ${actionId} has no attached allow policy`);
  const policies = action.policyIds.map((id) => bundle.policies.find((policy) => policy.id === id)).filter((policy): policy is PolicyDefinition => policy !== undefined);
  const matchedPolicyIds: string[] = [];
  const unknownFacts = new Set<string>();
  let explicitDeny: string | undefined;
  let unknownPolicy: string | undefined;
  let allowedBy: string | undefined;

  for (const policy of policies) {
    if (!policy.appliesTo.includes(actionId)) continue;
    if (policy.requiredScopes && policy.requiredScopes.length > 0) {
      if (!Array.isArray(facts.scopes) || !facts.scopes.every((scope: unknown) => typeof scope === "string")) {
        unknownPolicy ??= policy.id;
        unknownFacts.add("scopes");
        continue;
      }
      if (!policy.requiredScopes.every((scope) => (facts.scopes as string[]).includes(scope))) continue;
    }
    const result = evaluateGuard(policy.guard, facts);
    for (const fact of result.unknownFacts) unknownFacts.add(fact);
    if (result.outcome === "unknown") {
      unknownPolicy ??= policy.id;
      continue;
    }
    if (result.outcome === "true") {
      matchedPolicyIds.push(policy.id);
      if (policy.effect === "deny") explicitDeny ??= policy.id;
      else allowedBy ??= policy.id;
    }
  }
  matchedPolicyIds.sort();
  const unknown = [...unknownFacts].sort();
  if (explicitDeny) return deny(`Explicit deny policy ${explicitDeny} matched`, matchedPolicyIds, unknown);
  if (unknownPolicy) return deny(`Policy ${unknownPolicy} could not be evaluated`, matchedPolicyIds, unknown);
  if (!allowedBy) return deny(`No allow policy matched action ${actionId}`, matchedPolicyIds, unknown);
  return { allowed: true, decision: "allow", reason: `Allow policy ${allowedBy} matched`, matchedPolicyIds, unknownFacts: [] };
}
