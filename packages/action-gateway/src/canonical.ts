import { createHash } from "node:crypto";
import { canonicalize } from "../../ontology-kernel/src/index.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Same strict canonical JSON encoding used for ontology release digests. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
