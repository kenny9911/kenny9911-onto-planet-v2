# API and extension guide

Studio, native agents, and MCP share the same tenant resources and governed operations. The HTTP API is served at the configured `APP_ORIGIN`; its implementation is in `apps/api/src/app.ts`. All examples below refer to the installed v0.2 API.

## Authentication and revisions

Use a scoped API token from Settings with `Authorization: Bearer <token>`. Cookie sessions also require `X-CSRF-Token` on mutations. Every authenticated endpoint requires `read`; each operation additionally enforces its own scope. Token scopes can only narrow the current user's permissions.

Generic resources use `/api/resources/:kind` and `/api/resources/:kind/:id`. Creation accepts `{name,data,state?}`; updates accept `{revision,name?,data?,state?}`. `revision` is the last observed positive integer. A stale update returns HTTP409, so fetch and review the new record before editing again. Resource `data` is replaced as a whole when supplied.

The API rejects inline credential fields. Connector credentials are server-configured secret references. External object projections, evaluation reports, runs, and releases require their specific governed operations.

## Operations

| Endpoint | Body / use | Additional scope |
|---|---|---|
| `GET /api/bootstrap` | Current session, visible resources, approvals and service health | Role/row/field filtering; full audit requires `admin` |
| `POST /api/ontology/validate` | `{bundle}` | `build` |
| `POST /api/ontology/propose` | `{name,text}`; produces a draft with source evidence and review gaps | `build` |
| `POST /api/ontology/:id/review` | `{revision,reason,acknowledgedGaps}` | `release` |
| `POST /api/knowledge/transform` | `{name,text,source}`; preserves cited source text | `build` |
| `POST /api/objects/query` | Optional `objectTypeId`, `search`, `filters`, `limit` | Authorized materialized observations |
| `POST /api/objects/aggregate` | Query fields plus `operation`, optional `property`, `groupBy` | Authorized fields before aggregation |
| `GET /api/objects/:id/relations` | Optional `relationId` and `direction=incoming` | Authorized endpoints only |
| `POST /api/context/inspect` | `{prompt,profileId?}` | Authorized active profile and evidence |
| `POST /api/policy/simulate` | `{actionId,args,objectId?,ontologyId?}` | Simulation grants no permission |
| `POST /api/connectors/:id/test` | `{}`; read-only connectivity/contract declarations | `admin` |
| `POST /api/connectors/:id/sync` | `{}`; refresh source observations | `build` |
| `POST /api/evaluations/run` | `{ontologyId?,revision?}` | `build` |
| `POST /api/releases` | `{ontologyId,revision}`; assembles pinned assets and evidence | `build` |
| `POST /api/releases/:id/activate` | `{}`; rechecks release gates and dependencies | `release` |
| `POST /api/runs` | `{agentId,prompt}`; queues a released agent | `operate` |
| `POST /api/runs/:id/resume` | `{}`; original actor's suspended run | `operate` |
| `POST /api/runs/:id/cancel` | `{}`; prevents later effects; dispatched effects may need reconciliation | `operate` |
| `POST /api/approvals/:id` | `{decision:"approved"\|"rejected",reason?}` | `approve`; independent actor |
| `POST /api/intents/:id/reconcile` | `{}`; inspect original source operation | `operate` |
| `GET/POST /api/tokens` | Own token list / `{name,scopes}` | Requested scopes must be a subset |
| `DELETE /api/tokens/:id` | Revoke own token | Token ownership |
| `GET/POST /api/users` | User list / `{name,email,password?,role}` | `admin` |
| `PUT /api/users/:id` | `{role?,active?}`; invalidates sessions | `admin`; own admin removal is blocked |

Object filters use `{property,op,value}` with `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, or `contains`. Aggregation operations are `count`, `sum`, `average`, `min`, and `max`. The materialized query is bounded; it is not a live ERP query engine.

## Reusable Skills

The checked-in examples are `skills/ontology-modeler` and `skills/enterprise-operator`. A Skill contains a strict versioned manifest and reusable instructions. `suggestedCapabilities` describes useful tools; it grants none. The runtime loads only Skills referenced by the released AgentSpec, pins their content digest, and includes their text within the agent's context budget.

To change a Skill, save a new reviewed resource revision, update dependent references, assemble a release, inspect its gates, and activate it. A draft instruction change cannot silently replace a queued run's pinned procedure. Existing actor and resource permissions still apply.

## Plugins and source adapters

The extension registry validates strict manifests, semantic versions, safe module references, Ed25519 signatures, and explicit capability requests. `plugins/mock-erp` is a signed example with a fixture public key. The installed catalog stores these definitions; v0.2 does not dynamically import arbitrary plugin modules or execute remote plugin code.

The delivered execution extension is the governed HTTP source adapter contract described in [the runtime guide](../packages/platform-runtime/README.md#http-source-contract). Implement that contract in a trusted source-facing service, configure its secret and server origin permissions, then bind a reviewed ontology action to it. Exercise preconditions, duplicate requests, receipt/readback, and lost-response reconciliation against the actual source sandbox before admitting it to a release.

## MCP publication

`/mcp` uses Streamable HTTP and bearer tokens. Capabilities must be explicitly declared in the active immutable release, be supported by a registered server handler, and satisfy both publication and caller scopes. Discovery and invocation enforce the same restrictions. Published pure functions can query objects/context; actions expose governed previews. Direct approval, release activation, and raw source writes are not MCP tools in v0.2.

See [installation](06-installation.md#mcp-clients-and-scoped-tokens) for client configuration and the [capability ledger](05-delivery-plan.md) for unsupported extension/client surfaces.
