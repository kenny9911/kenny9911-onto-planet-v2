import { ONTOLOGY_SCHEMA_VERSION } from "../../contracts/src/index.js";
import type { OntologyBundle } from "../../contracts/src/index.js";
import { isValidFactPath } from "./guard.js";

export interface Diagnostic {
  code: string;
  severity: "error" | "warning";
  path: string;
  message: string;
  suggestion?: string;
}

type RecordValue = Record<string, unknown>;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const COLLECTIONS = ["sources", "values", "sharedProperties", "objects", "relations", "interfaces", "rules", "actions", "functions", "events", "policies"] as const;
type CollectionName = (typeof COLLECTIONS)[number];
const GUARD_COMPARISONS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"]);

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): boolean {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function isLiteral(value: unknown): boolean {
  return isScalar(value) || (Array.isArray(value) && value.length <= 1024 && value.every(isScalar));
}

export function validateBundle(bundle: unknown): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const add = (code: string, path: string, message: string, suggestion?: string): void => {
    diagnostics.push({ code, severity: "error", path, message, ...(suggestion ? { suggestion } : {}) });
  };
  if (!isRecord(bundle)) {
    add("BUNDLE_OBJECT_REQUIRED", "$", "Ontology bundle must be an object");
    return diagnostics;
  }
  const requiredString = (value: unknown, path: string): value is string => {
    if (typeof value !== "string" || value.trim().length === 0) {
      add("STRING_REQUIRED", path, "A nonempty string is required");
      return false;
    }
    return true;
  };
  const validId = (value: unknown, path: string): value is string => {
    if (!requiredString(value, path)) return false;
    if (!ID_PATTERN.test(value)) {
      add("INVALID_ID", path, `ID ${JSON.stringify(value)} must start with a letter and use letters, digits, '.', '_' or '-'`, "Use a stable machine-readable ID");
      return false;
    }
    return true;
  };
  const enumValue = (value: unknown, allowed: readonly string[], path: string): void => {
    if (!allowed.includes(String(value))) add("INVALID_ENUM", path, `Expected one of: ${allowed.join(", ")}`);
  };

  if (bundle.schemaVersion !== ONTOLOGY_SCHEMA_VERSION) add("SCHEMA_VERSION_UNSUPPORTED", "schemaVersion", `Expected schema version ${ONTOLOGY_SCHEMA_VERSION}`);
  validId(bundle.id, "id");
  requiredString(bundle.namespace, "namespace");
  requiredString(bundle.name, "name");
  if (requiredString(bundle.version, "version") && !VERSION_PATTERN.test(bundle.version)) {
    add("INVALID_VERSION", "version", "Bundle version must be SemVer (major.minor.patch with optional prerelease)");
  }

  const entries = {} as Record<CollectionName, { item: RecordValue; path: string }[]>;
  for (const name of COLLECTIONS) {
    const value = bundle[name];
    entries[name] = [];
    if (!Array.isArray(value)) {
      add("COLLECTION_REQUIRED", name, `Bundle ${name} must be an array`, "Use an empty array when there are no definitions");
      continue;
    }
    value.forEach((item: unknown, index: number) => {
      const path = `${name}[${index}]`;
      if (!isRecord(item)) add("DEFINITION_OBJECT_REQUIRED", path, "Definition must be an object");
      else entries[name].push({ item, path });
    });
  }

  const maps = {} as Record<CollectionName, Map<string, RecordValue>>;
  const allIds = new Map<string, string>();
  for (const name of COLLECTIONS) {
    maps[name] = new Map();
    for (const { item, path } of entries[name]) {
      if (!validId(item.id, `${path}.id`)) continue;
      const id = item.id;
      if (maps[name].has(id)) add("DUPLICATE_ID", `${path}.id`, `Duplicate ${name} ID ${id}`);
      else maps[name].set(id, item);
      const previous = allIds.get(id);
      if (previous) add("DUPLICATE_GLOBAL_ID", `${path}.id`, `ID ${id} is already used at ${previous}`, "Use one stable ID per definition across the bundle");
      else allIds.set(id, `${path}.id`);
      if (name !== "sources") requiredString(item.name, `${path}.name`);
    }
  }

  const ref = (value: unknown, map: Map<string, RecordValue>, path: string, collection: string): void => {
    if (validId(value, path) && !map.has(value)) add("UNKNOWN_REFERENCE", path, `${collection} ${value} is not defined`, `Add the ${collection} definition or correct the reference`);
  };
  const stringRefs = (value: unknown, path: string, map: Map<string, RecordValue>, collection: string): void => {
    if (!Array.isArray(value)) {
      add("ARRAY_REQUIRED", path, "Expected an array of IDs");
      return;
    }
    const seen = new Set<string>();
    value.forEach((id: unknown, index: number) => {
      const idPath = `${path}[${index}]`;
      ref(id, map, idPath, collection);
      if (typeof id === "string") {
        if (seen.has(id)) add("DUPLICATE_REFERENCE", idPath, `Reference ${id} appears more than once`);
        seen.add(id);
      }
    });
  };
  const sourceRefs = (item: RecordValue, path: string): void => {
    if (item.sourceRefs !== undefined) stringRefs(item.sourceRefs, `${path}.sourceRefs`, maps.sources, "source");
  };
  const properties = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) {
      add("ARRAY_REQUIRED", path, "Properties must be an array");
      return;
    }
    const ids = new Set<string>();
    value.forEach((property: unknown, index: number) => {
      const p = `${path}[${index}]`;
      if (!isRecord(property)) {
        add("PROPERTY_OBJECT_REQUIRED", p, "Property must be an object");
        return;
      }
      if (validId(property.id, `${p}.id`)) {
        if (ids.has(property.id)) add("DUPLICATE_PROPERTY", `${p}.id`, `Property ${property.id} appears more than once`);
        ids.add(property.id);
      }
      if ((property.valueTypeId === undefined) === (property.sharedPropertyId === undefined)) {
        add("PROPERTY_TYPE_AMBIGUOUS", p, "Property must reference exactly one value type or shared property");
      } else if (property.valueTypeId !== undefined) ref(property.valueTypeId, maps.values, `${p}.valueTypeId`, "value type");
      else ref(property.sharedPropertyId, maps.sharedProperties, `${p}.sharedPropertyId`, "shared property");
      if (property.required !== undefined && typeof property.required !== "boolean") add("BOOLEAN_REQUIRED", `${p}.required`, "Expected a boolean");
      sourceRefs(property, p);
    });
  };
  const parameters = (value: unknown, path: string): void => {
    if (!Array.isArray(value)) {
      add("ARRAY_REQUIRED", path, "Parameters must be an array");
      return;
    }
    const ids = new Set<string>();
    value.forEach((parameter: unknown, index: number) => {
      const p = `${path}[${index}]`;
      if (!isRecord(parameter)) {
        add("PARAMETER_OBJECT_REQUIRED", p, "Parameter must be an object");
        return;
      }
      if (validId(parameter.id, `${p}.id`)) {
        if (ids.has(parameter.id)) add("DUPLICATE_PARAMETER", `${p}.id`, `Parameter ${parameter.id} appears more than once`);
        ids.add(parameter.id);
      }
      ref(parameter.valueTypeId, maps.values, `${p}.valueTypeId`, "value type");
      if (parameter.required !== undefined && typeof parameter.required !== "boolean") add("BOOLEAN_REQUIRED", `${p}.required`, "Expected a boolean");
    });
  };
  const operand = (value: unknown, path: string): void => {
    if (!isRecord(value)) {
      add("GUARD_OPERAND_INVALID", path, "Guard operand must be an object");
      return;
    }
    if (value.kind === "fact") {
      if (!isValidFactPath(value.path)) add("FACT_PATH_INVALID", `${path}.path`, "Fact path must be a safe dotted identifier");
    } else if (value.kind === "literal") {
      if (!isLiteral(value.value)) add("GUARD_LITERAL_INVALID", `${path}.value`, "Literal must be a finite scalar or array of up to 1024 finite scalars");
    } else add("GUARD_OPERAND_INVALID", `${path}.kind`, "Operand kind must be fact or literal");
  };
  const guard = (value: unknown, path: string): void => {
    let nodes = 0;
    const ancestors = new Set<object>();
    const visit = (node: unknown, p: string, depth: number): void => {
      nodes += 1;
      if (nodes > 256 || depth > 32) {
        add("GUARD_LIMIT_EXCEEDED", p, "Guard exceeds 256 nodes or depth 32", "Split the rule into smaller predicates");
        return;
      }
      if (!isRecord(node)) {
        add("GUARD_NODE_INVALID", p, "Guard node must be an object");
        return;
      }
      if (ancestors.has(node)) {
        add("GUARD_CYCLE", p, "Guard cannot contain a cycle");
        return;
      }
      ancestors.add(node);
      if (node.op === "all" || node.op === "any") {
        if (!Array.isArray(node.of) || node.of.length === 0) add("GUARD_GROUP_EMPTY", `${p}.of`, "Guard group must contain at least one clause");
        else for (const [index, child] of node.of.entries()) {
          if (nodes > 256) break;
          visit(child, `${p}.of[${index}]`, depth + 1);
        }
      } else if (node.op === "not") visit(node.of, `${p}.of`, depth + 1);
      else if (node.op === "exists") operand(node.value, `${p}.value`);
      else if (GUARD_COMPARISONS.has(String(node.op))) {
        operand(node.left, `${p}.left`);
        operand(node.right, `${p}.right`);
      } else add("GUARD_OPERATOR_INVALID", `${p}.op`, `Unsupported guard operator ${String(node.op)}`);
      ancestors.delete(node);
    };
    visit(value, path, 0);
  };

  for (const { item, path } of entries.sources) {
    requiredString(item.system, `${path}.system`);
    requiredString(item.resource, `${path}.resource`);
    enumValue(item.kind, ["database", "api", "event", "file", "manual"], `${path}.kind`);
  }
  for (const { item, path } of entries.values) {
    sourceRefs(item, path);
    enumValue(item.kind, ["string", "integer", "decimal", "boolean", "date", "datetime", "enum"], `${path}.kind`);
    if (item.kind === "enum") {
      if (!Array.isArray(item.enumValues) || item.enumValues.length === 0 || !item.enumValues.every(isScalar)) {
        add("ENUM_VALUES_INVALID", `${path}.enumValues`, "Enum requires a nonempty array of finite scalar values");
      } else if (new Set(item.enumValues.map((value: unknown) => JSON.stringify(value))).size !== item.enumValues.length) {
        add("ENUM_VALUES_DUPLICATE", `${path}.enumValues`, "Enum values must be unique");
      }
    } else if (item.enumValues !== undefined) add("ENUM_VALUES_UNEXPECTED", `${path}.enumValues`, "Only enum value types may define enumValues");
  }
  for (const { item, path } of entries.sharedProperties) {
    sourceRefs(item, path);
    ref(item.valueTypeId, maps.values, `${path}.valueTypeId`, "value type");
  }
  for (const { item, path } of entries.objects) {
    sourceRefs(item, path);
    properties(item.properties, `${path}.properties`);
    if (validId(item.primaryKey, `${path}.primaryKey`) && Array.isArray(item.properties)) {
      const key = item.properties.find((property: unknown) => isRecord(property) && property.id === item.primaryKey);
      if (!isRecord(key)) add("PRIMARY_KEY_MISSING", `${path}.primaryKey`, `Primary key property ${item.primaryKey} is not defined`);
      else if (key.required !== true) add("PRIMARY_KEY_OPTIONAL", `${path}.primaryKey`, "Primary key property must be required");
    }
    if (item.implements !== undefined) stringRefs(item.implements, `${path}.implements`, maps.interfaces, "interface");
  }
  for (const { item, path } of entries.relations) {
    sourceRefs(item, path);
    for (const side of ["from", "to"] as const) {
      const endpoint = item[side];
      if (!isRecord(endpoint)) add("RELATION_ENDPOINT_INVALID", `${path}.${side}`, "Relation endpoint must be an object");
      else {
        ref(endpoint.objectTypeId, maps.objects, `${path}.${side}.objectTypeId`, "object type");
        enumValue(endpoint.cardinality, ["one", "many"], `${path}.${side}.cardinality`);
      }
    }
    if (item.properties !== undefined) properties(item.properties, `${path}.properties`);
  }
  for (const { item, path } of entries.interfaces) {
    sourceRefs(item, path);
    parameters(item.properties, `${path}.properties`);
    if (item.actionIds !== undefined) stringRefs(item.actionIds, `${path}.actionIds`, maps.actions, "action");
  }
  for (const { item, path } of entries.rules) {
    sourceRefs(item, path);
    enumValue(item.purpose, ["validation", "decision", "guard"], `${path}.purpose`);
    enumValue(item.severity, ["error", "warning"], `${path}.severity`);
    guard(item.predicate, `${path}.predicate`);
    if (item.appliesTo !== undefined) {
      if (!isRecord(item.appliesTo)) add("RULE_TARGET_INVALID", `${path}.appliesTo`, "Rule target must be an object");
      else {
        const target = item.appliesTo;
        const targetCollections: Record<string, CollectionName> = { object: "objects", relation: "relations", action: "actions", function: "functions" };
        const name = targetCollections[String(target.kind)];
        if (!name) add("RULE_TARGET_INVALID", `${path}.appliesTo.kind`, "Rule target kind must be object, relation, action, or function");
        else ref(target.id, maps[name], `${path}.appliesTo.id`, name);
      }
    }
  }
  for (const { item, path } of entries.actions) {
    sourceRefs(item, path);
    parameters(item.input, `${path}.input`);
    if (item.output !== undefined) parameters(item.output, `${path}.output`);
    if (item.targetObjectTypeId !== undefined) ref(item.targetObjectTypeId, maps.objects, `${path}.targetObjectTypeId`, "object type");
    if (item.objectIdParameterId !== undefined) {
      if (validId(item.objectIdParameterId, `${path}.objectIdParameterId`)) {
        const parameter = Array.isArray(item.input)
          ? item.input.find((entry: unknown) => isRecord(entry) && entry.id === item.objectIdParameterId)
          : undefined;
        if (!isRecord(parameter) || parameter.required !== true || !isRecord(maps.values.get(String(parameter.valueTypeId))) || maps.values.get(String(parameter.valueTypeId))?.kind !== "string") {
          add("ACTION_OBJECT_ID_PARAMETER_INVALID", `${path}.objectIdParameterId`, "Object ID must name a required string input parameter");
        }
      }
    }
    if ((item.risk === "medium" || item.risk === "high") && (item.targetObjectTypeId === undefined || item.objectIdParameterId === undefined)) {
      add("ACTION_OBJECT_REFERENCE_REQUIRED", path, "Medium/high risk actions must declare the affected object type and required ID parameter");
    }
    enumValue(item.approval, ["never", "always", "risk-based"], `${path}.approval`);
    enumValue(item.risk, ["low", "medium", "high"], `${path}.risk`);
    if (item.guard !== undefined) guard(item.guard, `${path}.guard`);
    if (item.policyIds !== undefined) {
      stringRefs(item.policyIds, `${path}.policyIds`, maps.policies, "policy");
      if (Array.isArray(item.policyIds)) for (const [index, id] of item.policyIds.entries()) {
        const policy = typeof id === "string" ? maps.policies.get(id) : undefined;
        if (policy && (!Array.isArray(policy.appliesTo) || !policy.appliesTo.includes(item.id))) {
          add("POLICY_NOT_APPLICABLE", `${path}.policyIds[${index}]`, `Policy ${id} does not apply to action ${String(item.id)}`);
        }
      }
    }
    if (item.compensationActionId !== undefined) ref(item.compensationActionId, maps.actions, `${path}.compensationActionId`, "action");
    if (item.idempotent !== undefined && typeof item.idempotent !== "boolean") add("BOOLEAN_REQUIRED", `${path}.idempotent`, "Expected a boolean");
  }
  for (const { item, path } of entries.functions) {
    sourceRefs(item, path);
    parameters(item.input, `${path}.input`);
    if (item.output !== undefined) parameters(item.output, `${path}.output`);
    if (!isRecord(item.execution)) add("FUNCTION_EXECUTION_INVALID", `${path}.execution`, "Execution target must be an object");
    else {
      enumValue(item.execution.kind, ["workflow", "service", "wasm"], `${path}.execution.kind`);
      requiredString(item.execution.ref, `${path}.execution.ref`);
    }
    enumValue(item.sideEffect, ["pure", "effectful"], `${path}.sideEffect`);
  }
  for (const { item, path } of entries.events) {
    sourceRefs(item, path);
    parameters(item.payload, `${path}.payload`);
    if (item.subjectObjectTypeId !== undefined) ref(item.subjectObjectTypeId, maps.objects, `${path}.subjectObjectTypeId`, "object type");
  }
  for (const { item, path } of entries.policies) {
    sourceRefs(item, path);
    enumValue(item.effect, ["allow", "deny"], `${path}.effect`);
    stringRefs(item.appliesTo, `${path}.appliesTo`, maps.actions, "action");
    guard(item.guard, `${path}.guard`);
    if (item.requiredScopes !== undefined) {
      if (!Array.isArray(item.requiredScopes) || !item.requiredScopes.every((scope: unknown) => typeof scope === "string" && scope.length > 0)) {
        add("SCOPES_INVALID", `${path}.requiredScopes`, "Required scopes must be nonempty strings");
      }
    }
  }

  // Interface conformance is checked after all referenced definitions are indexed.
  for (const { item, path } of entries.objects) {
    if (!Array.isArray(item.implements) || !Array.isArray(item.properties)) continue;
    for (const [interfaceIndex, interfaceId] of item.implements.entries()) {
      const definition = typeof interfaceId === "string" ? maps.interfaces.get(interfaceId) : undefined;
      if (!definition || !Array.isArray(definition.properties)) continue;
      for (const requiredProperty of definition.properties) {
        if (!isRecord(requiredProperty) || typeof requiredProperty.id !== "string") continue;
        const actual = item.properties.find((property: unknown) => isRecord(property) && property.id === requiredProperty.id);
        const propertyPath = `${path}.implements[${interfaceIndex}]`;
        if (!isRecord(actual)) {
          add("INTERFACE_PROPERTY_MISSING", propertyPath, `Object ${String(item.id)} lacks interface ${interfaceId} property ${requiredProperty.id}`);
          continue;
        }
        const actualType = typeof actual.valueTypeId === "string" ? actual.valueTypeId :
          typeof actual.sharedPropertyId === "string" ? maps.sharedProperties.get(actual.sharedPropertyId)?.valueTypeId : undefined;
        if (actualType !== requiredProperty.valueTypeId) add("INTERFACE_PROPERTY_TYPE", propertyPath, `Property ${requiredProperty.id} must use value type ${String(requiredProperty.valueTypeId)}`);
        if (requiredProperty.required === true && actual.required !== true) add("INTERFACE_PROPERTY_OPTIONAL", propertyPath, `Property ${requiredProperty.id} must be required`);
      }
    }
  }

  // Sort independent of insertion order in cross-reference passes for reproducible diagnostics.
  const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  return diagnostics.sort((a, b) => compare(a.path, b.path) || compare(a.code, b.code) || compare(a.message, b.message));
}

export function assertValidBundle(bundle: unknown): asserts bundle is OntologyBundle {
  const errors = validateBundle(bundle).filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) {
    const detail = errors.slice(0, 5).map((error) => `${error.path}: ${error.message}`).join("; ");
    throw new Error(`Invalid ontology bundle (${errors.length} errors): ${detail}`);
  }
}
