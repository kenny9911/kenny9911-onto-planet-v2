import { createHash } from 'node:crypto';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type {
  ActionDefinition, FunctionDefinition, OntologyBundle, ParameterDefinition,
  ReleaseManifest, ValueTypeDefinition,
} from '../../contracts/src/index.js';
import type { CapabilityGrant } from '../../extension-registry/src/index.js';
import { canonicalize, verifyReleaseManifest } from '../../ontology-kernel/src/index.js';

export type JsonSchema = Record<string, unknown>;

export interface PublishedCapability {
  /** ID of an action or pure ontology function in the bound release. */
  id: string;
  kind: 'action' | 'function';
  /** All of these scopes are required. No wildcard semantics are implied. */
  scopes: readonly string[];
}

export interface PublishedOntologySnapshot {
  tenantId: string;
  bundle: OntologyBundle;
  release: ReleaseManifest;
  /** Explicit allowlist. A released definition is not exposed without an entry here. */
  capabilities: readonly PublishedCapability[];
}

export interface ToolContext {
  tenantId: string;
  actorId: string;
  runId?: string;
  releaseId: string;
  /** Validated caller scopes, supplied by the host authentication boundary. */
  scopes: readonly string[];
  /** Effective grants from policy and extension publication, never raw requests. */
  grants: readonly CapabilityGrant[];
}

export interface PublishedCapabilitySource {
  getPublishedSnapshot(context: ToolContext): PublishedOntologySnapshot | Promise<PublishedOntologySnapshot>;
}

/** Must be backed by trusted tenant release state, independent of the ontology snapshot. */
export interface TrustedReleaseStatus {
  tenantId: string;
  releaseId: string;
  bundleHash: ReleaseManifest['bundleHash'];
  state: 'active' | 'inactive' | 'revoked';
}

export interface TrustedReleaseStatusSource {
  getStatus(tenantId: string, releaseId: string): TrustedReleaseStatus | undefined | Promise<TrustedReleaseStatus | undefined>;
}

export interface OntologyToolExecutionPort {
  /** Must be a read-only query through the platform's tenant and row policy boundary. */
  queryFunction(context: ToolContext, definition: FunctionDefinition, input: Record<string, unknown>, release: ReleaseManifest): Promise<unknown>;
  /** Must preview through ActionGateway; this method must not execute a connector write. */
  previewAction(context: ToolContext, definition: ActionDefinition, input: Record<string, unknown>, idempotencyKey: string, release: ReleaseManifest): Promise<unknown>;
}

export interface OntologyToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: { readOnlyHint: true; destructiveHint: false; openWorldHint: false };
  capabilityId: string;
  kind: 'query' | 'action-preview';
}

export interface OntologyToolResult {
  content: [{ type: 'text'; text: string }];
  structuredContent?: unknown;
  isError?: boolean;
}

interface ProjectedTool {
  definition: OntologyToolDefinition;
  ontologyDefinition: FunctionDefinition | ActionDefinition;
  requiredScopes: readonly string[];
  release: ReleaseManifest;
}

export class UnpublishedOntologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnpublishedOntologyError';
  }
}

export class ToolUnavailableError extends Error {
  constructor(name: string) {
    super(`tool unavailable: ${name}`);
    this.name = 'ToolUnavailableError';
  }
}

const ajv = new Ajv2020({ allErrors: true, strict: true });

function parameterSchema(parameters: readonly ParameterDefinition[], values: readonly ValueTypeDefinition[]): JsonSchema {
  const byId = new Map(values.map((value) => [value.id, value]));
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const parameter of parameters) {
    const value = byId.get(parameter.valueTypeId);
    if (!value) throw new UnpublishedOntologyError(`unknown value type ${parameter.valueTypeId}`);
    const field: JsonSchema = { description: parameter.description ?? value.description ?? value.name };
    switch (value.kind) {
      case 'string':
      case 'date':
      case 'datetime': field.type = 'string'; break;
      case 'integer': field.type = 'integer'; break;
      case 'decimal': field.type = 'number'; break;
      case 'boolean': field.type = 'boolean'; break;
      case 'enum':
        if (!value.enumValues?.length) throw new UnpublishedOntologyError(`empty enum ${value.id}`);
        field.enum = value.enumValues;
        break;
    }
    properties[parameter.id] = field;
    if (parameter.required) required.push(parameter.id);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function toolName(kind: 'query' | 'action-preview', id: string): string {
  const slug = id.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60) || 'capability';
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 12);
  return `ontology.${kind === 'query' ? 'query' : 'preview'}.${slug}.${hash}`;
}

/** Projects only an explicit publication allowlist from a verified immutable release. */
export function projectPublishedOntologyCapabilities(input: PublishedOntologySnapshot): ProjectedTool[] {
  const snapshot = structuredClone(input);
  if (!verifyReleaseManifest(snapshot.bundle, snapshot.release)) {
    throw new UnpublishedOntologyError('ontology release manifest does not match bundle');
  }
  const actions = new Map(snapshot.bundle.actions.map((action) => [action.id, action]));
  const functions = new Map(snapshot.bundle.functions.map((fn) => [fn.id, fn]));
  const seen = new Set<string>();
  const tools: ProjectedTool[] = [];
  for (const capability of snapshot.capabilities) {
    if (capability.kind !== 'action' && capability.kind !== 'function') {
      throw new UnpublishedOntologyError(`unsupported published capability kind: ${String(capability.kind)}`);
    }
    const key = `${capability.kind}:${capability.id}`;
    if (seen.has(key)) throw new UnpublishedOntologyError(`duplicate publication ${key}`);
    seen.add(key);
    if (!capability.scopes.length || new Set(capability.scopes).size !== capability.scopes.length ||
      capability.scopes.some((scope) => !/^[a-zA-Z0-9]+(?:[._:-][a-zA-Z0-9]+)*$/.test(scope))) {
      throw new UnpublishedOntologyError(`invalid scopes for ${key}`);
    }
    const isQuery = capability.kind === 'function';
    const definition = isQuery ? functions.get(capability.id) : actions.get(capability.id);
    if (!definition) throw new UnpublishedOntologyError(`unknown published capability ${key}`);
    if (isQuery && (definition as FunctionDefinition).sideEffect !== 'pure') {
      throw new UnpublishedOntologyError(`effectful function cannot be a query: ${capability.id}`);
    }
    const input = parameterSchema(definition.input, snapshot.bundle.values);
    const schema = isQuery ? input : {
      type: 'object',
      properties: {
        input,
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['input', 'idempotencyKey'],
      additionalProperties: false,
    };
    const name = toolName(isQuery ? 'query' : 'action-preview', capability.id);
    tools.push({
      definition: {
        name,
        title: isQuery ? definition.name : `Preview ${definition.name}`,
        description: isQuery
          ? definition.description ?? `Read-only ontology function ${definition.name}`
          : `Preview the effects and policy decision for ${definition.name}. This does not execute the action. ${definition.description ?? ''}`.trim(),
        inputSchema: schema,
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        capabilityId: capability.id,
        kind: isQuery ? 'query' : 'action-preview',
      },
      ontologyDefinition: definition,
      requiredScopes: capability.scopes,
      release: snapshot.release,
    });
  }
  return tools.sort((a, b) => a.definition.name.localeCompare(b.definition.name));
}

function isAuthorized(context: ToolContext, tool: ProjectedTool): boolean {
  const callerScopes = new Set(context.scopes);
  const grantScopes = new Set(context.grants.find((grant) => grant.capabilityId === tool.definition.capabilityId)?.scopes ?? []);
  return tool.requiredScopes.every((scope) => callerScopes.has(scope) && grantScopes.has(scope));
}

function ensureContext(context: ToolContext): void {
  if (!context.tenantId || !context.actorId || !context.releaseId || !Array.isArray(context.scopes) || !Array.isArray(context.grants)) {
    throw new TypeError('authenticated tenant, actor, release, scopes and grants are required');
  }
}

function jsonResult(value: unknown): OntologyToolResult {
  const serialized = canonicalize(value);
  const structuredContent: unknown = JSON.parse(serialized);
  return { content: [{ type: 'text', text: serialized }], structuredContent };
}

/** Transport-independent tool projection. Checks publication, activation, and grants on every request. */
export function createOntologyToolRegistry(
  source: PublishedCapabilitySource,
  execution: OntologyToolExecutionPort,
  releaseStatus: TrustedReleaseStatusSource,
) {
  async function assertActive(context: ToolContext, expectedHash?: ReleaseManifest['bundleHash']): Promise<TrustedReleaseStatus> {
    const status = structuredClone(await releaseStatus.getStatus(context.tenantId, context.releaseId));
    if (!status || status.state !== 'active' || status.tenantId !== context.tenantId ||
      status.releaseId !== context.releaseId || (expectedHash && status.bundleHash !== expectedHash)) {
      throw new UnpublishedOntologyError('ontology release is not active for this tenant and bundle');
    }
    return status;
  }

  async function available(context: ToolContext): Promise<ProjectedTool[]> {
    ensureContext(context);
    const status = await assertActive(context);
    const snapshot = structuredClone(await source.getPublishedSnapshot(structuredClone(context)));
    if (snapshot.tenantId !== context.tenantId) {
      throw new UnpublishedOntologyError('published snapshot tenant differs from caller tenant');
    }
    if (snapshot.release.releaseId !== context.releaseId) {
      throw new UnpublishedOntologyError('requested release differs from published release');
    }
    if (snapshot.release.bundleHash !== status.bundleHash) {
      throw new UnpublishedOntologyError('active release hash differs from published bundle');
    }
    const tools = projectPublishedOntologyCapabilities(snapshot).filter((tool) => isAuthorized(context, tool));
    await assertActive(context, snapshot.release.bundleHash);
    return tools;
  }

  return {
    async listTools(context: ToolContext): Promise<OntologyToolDefinition[]> {
      context = structuredClone(context);
      return (await available(context)).map((tool) => tool.definition);
    },
    async callTool(context: ToolContext, name: string, argumentsValue: unknown): Promise<OntologyToolResult> {
      context = structuredClone(context);
      // Capture the request before the first await. Caller-owned objects must
      // not change the identity or arguments after authorization/validation.
      try {
        argumentsValue = JSON.parse(canonicalize(argumentsValue));
      } catch {
        return { content: [{ type: 'text', text: 'Invalid tool arguments: expected plain JSON data' }], isError: true };
      }
      const tool = (await available(context)).find((candidate) => candidate.definition.name === name);
      if (!tool) throw new ToolUnavailableError(name);
      const validate = ajv.compile(tool.definition.inputSchema);
      if (!validate(argumentsValue)) {
        const detail = ajv.errorsText(validate.errors, { separator: '; ' });
        return { content: [{ type: 'text', text: `Invalid tool arguments: ${detail}` }], isError: true };
      }
      // A release can be revoked after discovery or during argument validation.
      await assertActive(context, tool.release.bundleHash);
      try {
        if (tool.definition.kind === 'query') {
          return jsonResult(await execution.queryFunction(context, tool.ontologyDefinition as FunctionDefinition, argumentsValue as Record<string, unknown>, tool.release));
        }
        const args = argumentsValue as { input: Record<string, unknown>; idempotencyKey: string };
        return jsonResult(await execution.previewAction(context, tool.ontologyDefinition as ActionDefinition, args.input, args.idempotencyKey, tool.release));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'tool execution failed';
        return { content: [{ type: 'text', text: message }], isError: true };
      }
    },
  };
}

export type OntologyToolRegistry = ReturnType<typeof createOntologyToolRegistry>;
