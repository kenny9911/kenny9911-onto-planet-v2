import type { JsonValue } from "../../action-gateway/src/index.js";

export interface ArtifactPin {
  id: string;
  version: string;
  digest: `sha256:${string}`;
}

export interface ToolPin {
  name: string;
  version: string;
  digest: `sha256:${string}`;
  kind: "read" | "action";
}

export interface RunSpec {
  runId: string;
  tenantId: string;
  actorId: string;
  ontologyRelease: `sha256:${string}`;
  agent: ArtifactPin;
  model: { provider: string; id: string; version: string };
  skills: readonly ArtifactPin[];
  tools: readonly ToolPin[];
  limits: {
    maxModelCalls: number;
    maxToolCalls: number;
    maxContextBytes: number;
    deadlineAt: string;
  };
}

export interface ContextDocument {
  tenantId: string;
  id: string;
  version: string;
  text: string;
  provenance: string;
}

export interface ContextPort {
  load(request: {
    tenantId: string;
    actorId: string;
    ontologyRelease: string;
    prompt: string;
    maxBytes: number;
    signal: AbortSignal;
  }): Promise<readonly ContextDocument[]>;
}

export type HistoryEntry =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "assistant_tool"; toolName: string; args: JsonValue }
  | { role: "tool"; toolName: string; result: ToolResult };

export type ModelDecision =
  | { type: "final"; text: string }
  | { type: "tool"; toolName: string; args: JsonValue };

export interface ModelPort {
  next(request: {
    spec: RunSpec;
    context: readonly ContextDocument[];
    history: readonly HistoryEntry[];
    signal: AbortSignal;
  }): Promise<ModelDecision>;
}

export interface ToolCallRequest {
  tenantId: string;
  actorId: string;
  runId: string;
  ontologyRelease: string;
  deadlineAt: string;
  toolName: string;
  toolVersion: string;
  toolDigest: string;
  args: JsonValue;
  idempotencyKey: string;
  signal: AbortSignal;
}

export type ToolResult =
  | { status: "completed"; output: JsonValue }
  | { status: "denied"; reason: string; intentHash?: string }
  | { status: "approval_required"; intentHash: string; summary: string }
  | { status: "unknown"; reason: string; intentHash?: string };

export type ToolStatus = ToolResult | { status: "ready" };

export interface ToolPort {
  call(request: ToolCallRequest): Promise<ToolResult>;
  /** Read-only status query. Must not invoke the action again. */
  status(request: ToolCallRequest): Promise<ToolStatus>;
}

export type RuntimeEventKind =
  | "run_started"
  | "context_loaded"
  | "model_decision"
  | "tool_dispatched"
  | "tool_status_checked"
  | "tool_completed"
  | "run_suspended"
  | "run_completed"
  | "run_exhausted"
  | "run_timed_out";

export interface RuntimeEvent {
  at: string;
  runId: string;
  tenantId: string;
  kind: RuntimeEventKind;
  details: JsonValue;
}

export interface RuntimeAuditPort {
  append(event: RuntimeEvent): Promise<void>;
}

/** Persist as trusted server-side state before returning a suspended run. */
export interface RunCheckpoint {
  specHash: string;
  promptHash: string;
  context: ContextDocument[];
  history: HistoryEntry[];
  modelCalls: number;
  toolCalls: number;
  pendingTool?: ToolCallRequestSnapshot;
  pendingToolOutcome?: "approval_required" | "unknown";
}

export type ToolCallRequestSnapshot = Omit<ToolCallRequest, "signal">;

export interface RunResult {
  status: "completed" | "approval_required" | "unknown" | "exhausted" | "timed_out";
  text?: string;
  reason?: string;
  checkpoint: RunCheckpoint;
}
