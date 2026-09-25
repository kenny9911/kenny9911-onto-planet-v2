import { canonicalJson, digestJson } from "../../action-gateway/src/index.js";
import type {
  ContextDocument,
  ContextPort,
  ModelPort,
  RunCheckpoint,
  RunResult,
  RunSpec,
  RuntimeAuditPort,
  RuntimeEventKind,
  ToolCallRequestSnapshot,
  ToolPort,
  ToolResult,
  ToolStatus,
} from "./types.js";

export class RunSpecError extends Error {}

export interface AgentRuntimeOptions {
  context: ContextPort;
  model: ModelPort;
  tools: ToolPort;
  audit: RuntimeAuditPort;
  now?: () => Date;
}

/** Bounded, one-tool-at-a-time runtime. The model never receives raw connector authority. */
export class AgentRuntime {
  private readonly now: () => Date;

  constructor(private readonly options: AgentRuntimeOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async run(spec: RunSpec, prompt: string, trustedCheckpoint?: RunCheckpoint): Promise<RunResult> {
    spec = structuredClone(spec);
    trustedCheckpoint = structuredClone(trustedCheckpoint);
    validateSpec(spec);
    const specHash = digestJson(spec);
    const promptHash = digestJson(prompt);
    let checkpoint: RunCheckpoint;
    let resumingPending = trustedCheckpoint !== undefined;
    if (trustedCheckpoint) {
      if (trustedCheckpoint.specHash !== specHash || trustedCheckpoint.promptHash !== promptHash) {
        throw new RunSpecError("Checkpoint does not match the pinned run specification and prompt");
      }
      validateCheckpoint(spec, trustedCheckpoint);
      checkpoint = structuredClone(trustedCheckpoint);
    } else {
      this.assertTime(spec);
      await this.audit(spec, "run_started", { specHash, promptHash });
      let context;
      try {
        context = await this.withDeadline(spec, (signal) => this.options.context.load({
          tenantId: spec.tenantId,
          actorId: spec.actorId,
          ontologyRelease: spec.ontologyRelease,
          prompt,
          maxBytes: spec.limits.maxContextBytes,
          signal,
        }));
      } catch (error) {
        if (!isDeadline(error)) throw error;
        await this.audit(spec, "run_timed_out", { phase: "context" });
        return {
          status: "timed_out",
          reason: "Context load exceeded deadline",
          checkpoint: { specHash, promptHash, context: [], history: [{ role: "user", text: prompt }], modelCalls: 0, toolCalls: 0 },
        };
      }
      validateContext(spec, context);
      checkpoint = {
        specHash,
        promptHash,
        context: structuredClone([...context]),
        history: [{ role: "user", text: prompt }],
        modelCalls: 0,
        toolCalls: 0,
      };
      await this.audit(spec, "context_loaded", { documentIds: context.map((document) => document.id) });
    }

    for (;;) {
      if (this.now().getTime() >= Date.parse(spec.limits.deadlineAt)) {
        if (checkpoint.pendingTool && checkpoint.pendingToolOutcome !== "approval_required") {
          return this.inspectExpiredAction(spec, checkpoint);
        }
        await this.audit(spec, "run_timed_out", {});
        return { status: "timed_out", reason: "Run deadline elapsed", checkpoint };
      }
      if (checkpoint.pendingTool) {
        const result = await this.dispatch(spec, checkpoint.pendingTool, checkpoint, resumingPending || checkpoint.pendingToolOutcome !== undefined);
        resumingPending = false;
        if (result) return result;
        continue;
      }
      if (checkpoint.modelCalls >= spec.limits.maxModelCalls) {
        await this.audit(spec, "run_exhausted", { modelCalls: checkpoint.modelCalls });
        return { status: "exhausted", reason: "Model call budget exhausted", checkpoint };
      }
      let decision;
      try {
        decision = structuredClone(await this.withDeadline(spec, (signal) => this.options.model.next({
          spec: structuredClone(spec),
          context: structuredClone(checkpoint.context),
          history: structuredClone(checkpoint.history),
          signal,
        })));
      } catch (error) {
        if (isDeadline(error)) {
          await this.audit(spec, "run_timed_out", { phase: "model" });
          return { status: "timed_out", reason: "Model call exceeded deadline", checkpoint };
        }
        throw error;
      }
      checkpoint.modelCalls++;
      await this.audit(spec, "model_decision", { type: decision.type, modelCalls: checkpoint.modelCalls });
      if (decision.type === "final") {
        if (typeof decision.text !== "string") throw new RunSpecError("Model returned an invalid final response");
        checkpoint.history.push({ role: "assistant", text: decision.text });
        await this.audit(spec, "run_completed", { modelCalls: checkpoint.modelCalls, toolCalls: checkpoint.toolCalls });
        return { status: "completed", text: decision.text, checkpoint };
      }
      if (decision.type !== "tool" || typeof decision.toolName !== "string") {
        throw new RunSpecError("Model returned an invalid decision");
      }
      const pin = spec.tools.find((tool) => tool.name === decision.toolName);
      if (!pin) throw new RunSpecError(`Model requested unpinned tool: ${decision.toolName}`);
      if (checkpoint.toolCalls >= spec.limits.maxToolCalls) {
        await this.audit(spec, "run_exhausted", { toolCalls: checkpoint.toolCalls });
        return { status: "exhausted", reason: "Tool call budget exhausted", checkpoint };
      }
      canonicalJson(decision.args);
      checkpoint.toolCalls++;
      checkpoint.history.push({ role: "assistant_tool", toolName: pin.name, args: decision.args });
      checkpoint.pendingTool = {
        tenantId: spec.tenantId,
        actorId: spec.actorId,
        runId: spec.runId,
        ontologyRelease: spec.ontologyRelease,
        deadlineAt: spec.limits.deadlineAt,
        toolName: pin.name,
        toolVersion: pin.version,
        toolDigest: pin.digest,
        args: decision.args,
        idempotencyKey: `${spec.runId}:${checkpoint.toolCalls}`,
      };
    }
  }

  private async dispatch(spec: RunSpec, request: ToolCallRequestSnapshot, checkpoint: RunCheckpoint, inspectFirst: boolean): Promise<RunResult | undefined> {
    if (inspectFirst) {
      let status: ToolStatus;
      try {
        status = structuredClone(await this.withDeadline(spec, (signal) => this.options.tools.status({ ...structuredClone(request), signal })));
      } catch (error) {
        status = { status: "unknown", reason: `Tool status unavailable: ${String(error)}` };
      }
      await this.audit(spec, "tool_status_checked", { toolName: request.toolName, status: status.status });
      if ((checkpoint.pendingToolOutcome === "unknown" || checkpoint.pendingToolOutcome === undefined) &&
          (status.status === "ready" || status.status === "approval_required")) {
        checkpoint.pendingToolOutcome = "unknown";
        await this.audit(spec, "run_suspended", { status: "unknown", reason: "Uncertain action has no definitive outcome" });
        return { status: "unknown", reason: "Uncertain action has no definitive outcome", checkpoint };
      }
      if (status.status === "ready") {
        // Only an approved action that has never reached the connector enters
        // this path. An uncertain action remains suspended until definitive.
      } else {
        return this.consumeToolResult(spec, request, checkpoint, status);
      }
    }
    await this.audit(spec, "tool_dispatched", { toolName: request.toolName, idempotencyKey: request.idempotencyKey });
    let result: ToolResult;
    try {
      result = structuredClone(await this.withDeadline(spec, (signal) => this.options.tools.call({ ...structuredClone(request), signal })));
    } catch (error) {
      result = { status: "unknown", reason: isDeadline(error) ? "Tool call exceeded deadline; reconcile before resuming" : String(error) };
    }
    return this.consumeToolResult(spec, request, checkpoint, result);
  }

  /** An execution deadline prevents effects, but must not erase an uncertain source outcome. */
  private async inspectExpiredAction(spec: RunSpec, checkpoint: RunCheckpoint): Promise<RunResult> {
    const request = checkpoint.pendingTool!;
    let status: ToolStatus;
    try {
      const inspectionSpec = { ...spec, limits: { ...spec.limits, deadlineAt: new Date(this.now().getTime() + 5_000).toISOString() } };
      status = structuredClone(await this.withDeadline(inspectionSpec, (signal) => this.options.tools.status({ ...structuredClone(request), signal })));
    } catch (error) {
      status = { status: "unknown", reason: `Tool status unavailable: ${String(error)}` };
    }
    await this.audit(spec, "tool_status_checked", { toolName: request.toolName, status: status.status });
    if (status.status === "completed" || status.status === "denied") {
      await this.consumeToolResult(spec, request, checkpoint, status);
      await this.audit(spec, "run_timed_out", {});
      return { status: "timed_out", reason: `Run deadline elapsed; pending tool is ${status.status}`, checkpoint };
    }
    checkpoint.pendingToolOutcome = "unknown";
    const reason = "Run deadline elapsed; pending source outcome still requires reconciliation";
    await this.audit(spec, "run_suspended", { status: "unknown", reason });
    return { status: "unknown", reason, checkpoint };
  }

  private async consumeToolResult(spec: RunSpec, request: ToolCallRequestSnapshot, checkpoint: RunCheckpoint, result: ToolResult): Promise<RunResult | undefined> {
    if (result.status === "approval_required" || result.status === "unknown") {
      checkpoint.pendingToolOutcome = result.status;
      await this.audit(spec, "run_suspended", { status: result.status, intentHash: result.intentHash ?? null });
      return { status: result.status, reason: result.status === "unknown" ? result.reason : result.summary, checkpoint };
    }
    checkpoint.pendingTool = undefined;
    checkpoint.pendingToolOutcome = undefined;
    checkpoint.history.push({ role: "tool", toolName: request.toolName, result });
    await this.audit(spec, "tool_completed", { toolName: request.toolName, status: result.status });
    return undefined;
  }

  private assertTime(spec: RunSpec): void {
    if (this.now().getTime() >= Date.parse(spec.limits.deadlineAt)) throw new RunSpecError("Run deadline has elapsed");
  }

  private async withDeadline<T>(spec: RunSpec, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const remaining = Date.parse(spec.limits.deadlineAt) - this.now().getTime();
    if (remaining <= 0) throw new DeadlineError();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new DeadlineError());
          }, remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async audit(spec: RunSpec, kind: RuntimeEventKind, details: import("../../action-gateway/src/index.js").JsonValue): Promise<void> {
    await this.options.audit.append({ at: this.now().toISOString(), runId: spec.runId, tenantId: spec.tenantId, kind, details });
  }
}

class DeadlineError extends Error {}
function isDeadline(error: unknown): boolean { return error instanceof DeadlineError; }

function validateSpec(spec: RunSpec): void {
  canonicalJson(spec);
  const required = [spec.runId, spec.tenantId, spec.actorId, spec.agent.id, spec.agent.version, spec.agent.digest, spec.model.provider, spec.model.id, spec.model.version];
  if (required.some((value) => !value || !value.trim())) throw new RunSpecError("Run specification must pin identity, agent, and model");
  if (!/^sha256:[a-f0-9]{64}$/.test(spec.ontologyRelease) || !/^sha256:[a-f0-9]{64}$/.test(spec.agent.digest)) {
    throw new RunSpecError("Run specification needs pinned ontology and agent digests");
  }
  if (!Number.isInteger(spec.limits.maxModelCalls) || spec.limits.maxModelCalls < 1 || !Number.isInteger(spec.limits.maxToolCalls) || spec.limits.maxToolCalls < 0 || !Number.isInteger(spec.limits.maxContextBytes) || spec.limits.maxContextBytes < 0) {
    throw new RunSpecError("Run limits must be non-negative integer bounds");
  }
  if (!Number.isFinite(Date.parse(spec.limits.deadlineAt))) throw new RunSpecError("Run deadline must be an ISO timestamp");
  const names = new Set<string>();
  for (const tool of spec.tools) {
    if (!tool.name || !tool.version || !/^sha256:[a-f0-9]{64}$/.test(tool.digest) || !["read", "action"].includes(tool.kind) || names.has(tool.name)) throw new RunSpecError("Tools require unique names and pinned digests");
    names.add(tool.name);
  }
  for (const skill of spec.skills) {
    if (!skill.id || !skill.version || !/^sha256:[a-f0-9]{64}$/.test(skill.digest)) throw new RunSpecError("Skills require pinned digests");
  }
}

function validateCheckpoint(spec: RunSpec, checkpoint: RunCheckpoint): void {
  validateContext(spec, checkpoint.context);
  if (!Number.isInteger(checkpoint.modelCalls) || checkpoint.modelCalls < 0 || checkpoint.modelCalls > spec.limits.maxModelCalls ||
      !Number.isInteger(checkpoint.toolCalls) || checkpoint.toolCalls < 0 || checkpoint.toolCalls > spec.limits.maxToolCalls ||
      checkpoint.history[0]?.role !== "user") {
    throw new RunSpecError("Checkpoint counters or history are invalid");
  }
  if (checkpoint.pendingTool) {
    const pending = checkpoint.pendingTool;
    const pin = spec.tools.find((tool) => tool.name === pending.toolName);
    if (!pin || pending.tenantId !== spec.tenantId || pending.actorId !== spec.actorId || pending.runId !== spec.runId ||
        pending.ontologyRelease !== spec.ontologyRelease || pending.deadlineAt !== spec.limits.deadlineAt || pending.toolVersion !== pin.version || pending.toolDigest !== pin.digest ||
        pending.idempotencyKey !== `${spec.runId}:${checkpoint.toolCalls}` || checkpoint.toolCalls < 1) {
      throw new RunSpecError("Pending tool call does not match the pinned run");
    }
    canonicalJson(pending.args);
    if (checkpoint.pendingToolOutcome && !["approval_required", "unknown"].includes(checkpoint.pendingToolOutcome)) {
      throw new RunSpecError("Checkpoint has invalid pending tool outcome");
    }
  } else if (checkpoint.pendingToolOutcome) {
    throw new RunSpecError("Checkpoint has tool outcome without pending tool");
  }
}

function validateContext(spec: RunSpec, context: readonly ContextDocument[]): void {
  let bytes = 0;
  for (const document of context) {
    if (document.tenantId !== spec.tenantId || !document.id || !document.version || !document.provenance) {
      throw new RunSpecError("Context port returned unscoped or unattributed data");
    }
    bytes += Buffer.byteLength(document.text, "utf8");
  }
  if (bytes > spec.limits.maxContextBytes) throw new RunSpecError("Context exceeds pinned byte budget");
}
