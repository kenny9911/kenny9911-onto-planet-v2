import type { ActionBinding } from "../../contracts/src/index.js";
import { digestJson } from "./canonical.js";

export type BindingState = "active" | "inactive" | "revoked";

/** Activation is mutable operational state and is deliberately outside the content hash. */
export interface BindingSnapshot {
  binding: ActionBinding;
  bindingHash: `sha256:${string}`;
  state: BindingState;
}

/** Trusted source; callers and model tool arguments cannot publish or activate bindings. */
export interface ActionBindingSource {
  resolve(tenantId: string, environment: string, actionId: string): Promise<BindingSnapshot | undefined>;
}

export function hashActionBinding(binding: ActionBinding): `sha256:${string}` {
  return digestJson(binding) as `sha256:${string}`;
}

export function validateActionBinding(binding: ActionBinding): string[] {
  const errors: string[] = [];
  const required = [binding.id, binding.version, binding.tenantId, binding.environment,
    binding.actionId, binding.adapter.id, binding.adapter.version,
    binding.adapter.target.system, binding.adapter.target.operation];
  if (required.some((value) => typeof value !== "string" || !value.trim())) errors.push("Binding identity and adapter target must be nonempty");
  if (!/^sha256:[a-f0-9]{64}$/.test(binding.ontologyRelease)) errors.push("Binding must pin an ontology release hash");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(binding.version)) errors.push("Binding version must be SemVer");
  if (binding.adapter.secretRef !== undefined && (typeof binding.adapter.secretRef !== "string" || !/^secret:\/\/[A-Za-z0-9/_.-]+$/.test(binding.adapter.secretRef))) {
    errors.push("Binding secretRef must be a secret broker reference");
  }
  for (const [name, value] of Object.entries(binding.guarantees)) {
    if (typeof value !== "boolean") errors.push(`Binding guarantee ${name} must be a boolean`);
  }
  return errors;
}

/** Test and local fixture source; deployments need a transactional activation store. */
export class InMemoryActionBindingSource implements ActionBindingSource {
  private readonly snapshots = new Map<string, BindingSnapshot>();

  constructor(bindings: readonly { binding: ActionBinding; state: BindingState }[]) {
    for (const entry of bindings) {
      const errors = validateActionBinding(entry.binding);
      if (errors.length) throw new TypeError(errors.join("; "));
      const key = this.key(entry.binding.tenantId, entry.binding.environment, entry.binding.actionId);
      if (this.snapshots.has(key)) throw new TypeError(`Duplicate action binding for ${key}`);
      this.snapshots.set(key, {
        binding: structuredClone(entry.binding),
        bindingHash: hashActionBinding(entry.binding),
        state: entry.state,
      });
    }
  }

  async resolve(tenantId: string, environment: string, actionId: string): Promise<BindingSnapshot | undefined> {
    const snapshot = this.snapshots.get(this.key(tenantId, environment, actionId));
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  setState(tenantId: string, environment: string, actionId: string, state: BindingState): void {
    const snapshot = this.snapshots.get(this.key(tenantId, environment, actionId));
    if (!snapshot) throw new Error("Binding does not exist");
    this.snapshots.set(this.key(tenantId, environment, actionId), { ...snapshot, state });
  }

  private key(tenantId: string, environment: string, actionId: string): string {
    return JSON.stringify([tenantId, environment, actionId]);
  }
}
