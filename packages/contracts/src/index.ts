/** The V2 contract is data, not generated tenant-specific TypeScript. */
export const ONTOLOGY_SCHEMA_VERSION = "2.0" as const;

export type DefinitionId = string;
export type JsonScalar = string | number | boolean | null;
export type JsonValue = JsonScalar | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface DefinitionBase {
  /** Stable within a bundle; renaming an ID is a breaking ontology change. */
  id: DefinitionId;
  name: string;
  description?: string;
  sourceRefs?: readonly DefinitionId[];
}

export interface SourceReference {
  id: DefinitionId;
  system: string;
  kind: "database" | "api" | "event" | "file" | "manual";
  resource: string;
  /** Optional source field/path used for lineage, not a credential. */
  field?: string;
}

export interface ValueTypeDefinition extends DefinitionBase {
  kind: "string" | "integer" | "decimal" | "boolean" | "date" | "datetime" | "enum";
  enumValues?: readonly JsonScalar[];
  unit?: string;
}

export interface SharedPropertyDefinition extends DefinitionBase {
  valueTypeId: DefinitionId;
}

export interface ObjectPropertyDefinition {
  id: DefinitionId;
  /** Exactly one of valueTypeId and sharedPropertyId must be present. */
  valueTypeId?: DefinitionId;
  sharedPropertyId?: DefinitionId;
  required?: boolean;
  sourceRefs?: readonly DefinitionId[];
}

export interface ObjectTypeDefinition extends DefinitionBase {
  primaryKey: DefinitionId;
  properties: readonly ObjectPropertyDefinition[];
  implements?: readonly DefinitionId[];
}

export interface RelationEndpoint {
  objectTypeId: DefinitionId;
  cardinality: "one" | "many";
}

export interface RelationDefinition extends DefinitionBase {
  from: RelationEndpoint;
  to: RelationEndpoint;
  properties?: readonly ObjectPropertyDefinition[];
}

export interface InterfacePropertyDefinition {
  id: DefinitionId;
  valueTypeId: DefinitionId;
  required?: boolean;
}

export interface InterfaceDefinition extends DefinitionBase {
  properties: readonly InterfacePropertyDefinition[];
  actionIds?: readonly DefinitionId[];
}

export interface ParameterDefinition {
  id: DefinitionId;
  valueTypeId: DefinitionId;
  required?: boolean;
  description?: string;
}

export type GuardOperand =
  | { kind: "literal"; value: JsonValue }
  | { kind: "fact"; path: string };

/** Deliberately finite and side-effect-free. No script, call, regex, or network operators. */
export type Guard =
  | { op: "all" | "any"; of: readonly Guard[] }
  | { op: "not"; of: Guard }
  | { op: "exists"; value: GuardOperand }
  | {
      op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";
      left: GuardOperand;
      right: GuardOperand;
    };

export interface RuleDefinition extends DefinitionBase {
  appliesTo?: { kind: "object" | "relation" | "action" | "function"; id: DefinitionId };
  /** Declares whether the predicate checks data, informs a decision, or gates execution. */
  purpose: "validation" | "decision" | "guard";
  predicate: Guard;
  severity: "error" | "warning";
}

export interface ActionDefinition extends DefinitionBase {
  input: readonly ParameterDefinition[];
  output?: readonly ParameterDefinition[];
  /** Business object affected by an action. Required for medium/high risk actions. */
  targetObjectTypeId?: DefinitionId;
  /** Required string input parameter carrying the same ID as the target object. */
  objectIdParameterId?: DefinitionId;
  approval: "never" | "always" | "risk-based";
  risk: "low" | "medium" | "high";
  /** Optional extra action precondition. Unknown fact values deny execution. */
  guard?: Guard;
  /** Explicit policy attachment; no matching allow policy means deny. */
  policyIds?: readonly DefinitionId[];
  compensationActionId?: DefinitionId;
  idempotent?: boolean;
}

/** A source implementation is versioned separately from the semantic action. */
export interface ActionBinding {
  id: DefinitionId;
  version: string;
  tenantId: string;
  environment: string;
  ontologyRelease: `sha256:${string}`;
  actionId: DefinitionId;
  adapter: {
    id: string;
    version: string;
    target: { system: string; operation: string; resource?: string };
    /** Reference to a secret broker entry, never a credential value. */
    secretRef?: string;
  };
  guarantees: {
    /** Source applies the write only if its current object revision matches the intent. */
    conditionalWrite: boolean;
    /** Underlying source understands the stable idempotency key. */
    nativeIdempotency: boolean;
    /** A source read can verify the intended postcondition. */
    readback: boolean;
    /** An uncertain result can be queried without another write. */
    reconciliation: boolean;
  };
}

export interface FunctionDefinition extends DefinitionBase {
  input: readonly ParameterDefinition[];
  output?: readonly ParameterDefinition[];
  execution: { kind: "workflow" | "service" | "wasm"; ref: string };
  sideEffect: "pure" | "effectful";
}

export interface EventDefinition extends DefinitionBase {
  payload: readonly ParameterDefinition[];
  subjectObjectTypeId?: DefinitionId;
}

export interface PolicyDefinition extends DefinitionBase {
  /** Only actions are executable. Read/query access is a separate boundary. */
  appliesTo: readonly DefinitionId[];
  effect: "allow" | "deny";
  guard: Guard;
  requiredScopes?: readonly string[];
}

export interface OntologyBundle {
  schemaVersion: typeof ONTOLOGY_SCHEMA_VERSION;
  id: DefinitionId;
  namespace: string;
  version: string;
  name: string;
  description?: string;
  sources: readonly SourceReference[];
  values: readonly ValueTypeDefinition[];
  sharedProperties: readonly SharedPropertyDefinition[];
  objects: readonly ObjectTypeDefinition[];
  relations: readonly RelationDefinition[];
  interfaces: readonly InterfaceDefinition[];
  rules: readonly RuleDefinition[];
  actions: readonly ActionDefinition[];
  functions: readonly FunctionDefinition[];
  events: readonly EventDefinition[];
  policies: readonly PolicyDefinition[];
}

export interface DefinitionCounts {
  sources: number;
  values: number;
  sharedProperties: number;
  objects: number;
  relations: number;
  interfaces: number;
  rules: number;
  actions: number;
  functions: number;
  events: number;
  policies: number;
}

/** A bundle is published only when it is paired with this verified manifest. */
export interface ReleaseManifest {
  schemaVersion: typeof ONTOLOGY_SCHEMA_VERSION;
  releaseId: string;
  bundleId: DefinitionId;
  bundleVersion: string;
  bundleHash: `sha256:${string}`;
  releasedAt: string;
  definitionCounts: Readonly<DefinitionCounts>;
}
