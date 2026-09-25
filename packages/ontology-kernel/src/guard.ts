import type { Guard, GuardOperand, RuleDefinition } from "../../contracts/src/index.js";

export type GuardOutcome = "true" | "false" | "unknown";

export interface GuardResult {
  outcome: GuardOutcome;
  reason: string;
  unknownFacts: string[];
}

const MAX_GUARD_DEPTH = 32;
const MAX_GUARD_NODES = 256;
const MAX_GUARD_LIST_ITEMS = 1024;
const FACT_PATH = /^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/;
const RESERVED = new Set(["__proto__", "prototype", "constructor"]);

export function isValidFactPath(path: unknown): path is string {
  return typeof path === "string" && FACT_PATH.test(path) && !path.split(".").some((part) => RESERVED.has(part));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function scalarEqual(left: unknown, right: unknown): boolean | undefined {
  if (!isScalar(left) || !isScalar(right)) return undefined;
  return left === right;
}

function orderedCompare(left: unknown, right: unknown): number | undefined {
  if (typeof left === "number" && typeof right === "number" && Number.isFinite(left) && Number.isFinite(right)) {
    return Math.sign(left - right);
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return undefined;
}

interface EvaluationState {
  nodes: number;
  limitExceeded: boolean;
  unknownFacts: Set<string>;
  reason?: string;
}

function unknown(state: EvaluationState, reason: string): GuardOutcome {
  state.reason ??= reason;
  return "unknown";
}

function operandValue(operand: GuardOperand, facts: Readonly<Record<string, unknown>>, state: EvaluationState): { known: boolean; value?: unknown } {
  if (!isRecord(operand)) {
    unknown(state, "Guard operand is invalid");
    return { known: false };
  }
  if (operand.kind === "literal") return { known: true, value: operand.value };
  if (operand.kind !== "fact" || !isValidFactPath(operand.path)) {
    unknown(state, "Guard fact path is invalid");
    return { known: false };
  }
  let cursor: unknown = facts;
  for (const part of operand.path.split(".")) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, part)) {
      state.unknownFacts.add(operand.path);
      unknown(state, `Fact ${operand.path} is missing`);
      return { known: false };
    }
    cursor = cursor[part];
  }
  if (cursor === undefined || (typeof cursor === "number" && !Number.isFinite(cursor))) {
    state.unknownFacts.add(operand.path);
    unknown(state, `Fact ${operand.path} has no usable value`);
    return { known: false };
  }
  return { known: true, value: cursor };
}

function evaluateNode(guard: Guard, facts: Readonly<Record<string, unknown>>, state: EvaluationState, depth: number): GuardOutcome {
  state.nodes += 1;
  if (state.nodes > MAX_GUARD_NODES || depth > MAX_GUARD_DEPTH) {
    state.limitExceeded = true;
    return unknown(state, "Guard exceeds finite evaluation limits");
  }
  if (!isRecord(guard)) return unknown(state, "Guard node is invalid");

  if (guard.op === "all" || guard.op === "any") {
    if (!Array.isArray(guard.of) || guard.of.length === 0) return unknown(state, "Guard group must contain at least one clause");
    let sawUnknown = false;
    let decisive = false;
    for (const clause of guard.of) {
      if (state.limitExceeded) break;
      const result = evaluateNode(clause, facts, state, depth + 1);
      if (result === "unknown") sawUnknown = true;
      if (guard.op === "all" && result === "false") decisive = true;
      if (guard.op === "any" && result === "true") decisive = true;
    }
    if (state.limitExceeded) return "unknown";
    if (decisive) return guard.op === "all" ? "false" : "true";
    return sawUnknown ? "unknown" : guard.op === "all" ? "true" : "false";
  }
  if (guard.op === "not") {
    const result = evaluateNode(guard.of, facts, state, depth + 1);
    return result === "unknown" ? result : result === "true" ? "false" : "true";
  }
  if (guard.op === "exists") {
    const value = operandValue(guard.value, facts, state);
    return !value.known ? "unknown" : value.value === null ? "false" : "true";
  }
  if (!["eq", "neq", "gt", "gte", "lt", "lte", "in", "contains"].includes(String(guard.op))) {
    return unknown(state, `Guard operator ${String(guard.op)} is unsupported`);
  }
  const comparison = guard as Extract<Guard, { left: GuardOperand; right: GuardOperand }>;
  const left = operandValue(comparison.left, facts, state);
  const right = operandValue(comparison.right, facts, state);
  if (!left.known || !right.known) return "unknown";

  let outcome: boolean | undefined;
  if (guard.op === "eq" || guard.op === "neq") {
    const equal = scalarEqual(left.value, right.value);
    outcome = equal === undefined ? undefined : guard.op === "eq" ? equal : !equal;
  } else if (guard.op === "gt" || guard.op === "gte" || guard.op === "lt" || guard.op === "lte") {
    const relation = orderedCompare(left.value, right.value);
    outcome = relation === undefined ? undefined : guard.op === "gt" ? relation > 0 : guard.op === "gte" ? relation >= 0 : guard.op === "lt" ? relation < 0 : relation <= 0;
  } else if (guard.op === "in") {
    outcome = Array.isArray(right.value) && right.value.length <= MAX_GUARD_LIST_ITEMS && isScalar(left.value) && right.value.every(isScalar)
      ? right.value.some((item: unknown) => scalarEqual(item, left.value))
      : undefined;
  } else if (guard.op === "contains") {
    outcome = Array.isArray(left.value) && left.value.length <= MAX_GUARD_LIST_ITEMS && isScalar(right.value) && left.value.every(isScalar)
      ? left.value.some((item: unknown) => scalarEqual(item, right.value))
      : typeof left.value === "string" && typeof right.value === "string"
        ? left.value.includes(right.value)
        : undefined;
  }
  return outcome === undefined ? unknown(state, `Guard ${guard.op} operands have incompatible types`) : outcome ? "true" : "false";
}

export function evaluateGuard(guard: Guard, facts: Readonly<Record<string, unknown>>): GuardResult {
  const state: EvaluationState = { nodes: 0, limitExceeded: false, unknownFacts: new Set() };
  const evaluated = evaluateNode(guard, facts, state, 0);
  const outcome = state.limitExceeded ? "unknown" : evaluated;
  return {
    outcome,
    reason: outcome === "unknown" ? (state.reason ?? "Guard could not be evaluated") : `Guard evaluated ${outcome}`,
    unknownFacts: [...state.unknownFacts].sort(),
  };
}

export function evaluateRule(rule: Pick<RuleDefinition, "predicate">, facts: Readonly<Record<string, unknown>>): GuardResult {
  return evaluateGuard(rule.predicate, facts);
}
