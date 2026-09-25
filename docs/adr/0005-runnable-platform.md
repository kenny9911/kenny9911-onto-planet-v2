# ADR 0005: Shared application, durable runtime, and explicit source adapters

Status: accepted for v0.2 · September 26, 2026

## Context

The semantic kernel, action gateway, and bounded harness need a usable installation. A real task must survive an approval wait, retain the invoking user's authority, and distinguish an external commit from a lost HTTP response. Studio and MCP must use the same definitions and authorization boundaries.

## Decision

Ship one shared TypeScript application with a React Studio and modular domain packages. The HTTP API serves Studio and MCP. A separate worker can consume PostgreSQL jobs; native development may embed that worker. PostgreSQL stores tenant resources, revisions, audit events, users, sessions, token hashes, jobs, action intents, and suspended checkpoints.

- The application database role is not a superuser. Tenant resources, intents, and audit use forced row-level security and transaction-local tenant identity in addition to explicit tenant predicates.
- Mutations use optimistic revisions. Release activation rechecks the reviewed ontology, dependency revisions/digests, manifest hash, and evaluation evidence within the activation transaction.
- A run pins the release, agent, Skills, tools, connector bindings, model selection, and invocation scopes. A worker intersects that original scope ceiling with the actor's current grants at execution time.
- The model chooses among published tools. The action gateway independently authorizes exact intent, independent approval, source precondition, execution, receipt, and readback. Provider output never becomes a permission.
- The HTTP operator resolves server-held secrets and checks explicitly approved origins, DNS addresses, response sizes, and deadlines. Intranet access needs a separate server configuration grant. A connector record cannot expand network permissions.
- Source operations retain the original idempotency key. An unknown result is reconciled through operation lookup. Worker loss during an unsaved model plan enters manual recovery; it does not replay a potentially completed action.
- The sample source has separate persisted business records and operation receipts behind an HTTP boundary. It is an installation fixture for testing the operator contract, not an adapter certification for a customer's ERP.
- Local users allow the installation to run without an external IdP. OIDC supports preprovisioned users. Scoped bearer tokens expose the published MCP query and preview surface.

## Consequences

The local installation has a complete read → intent → independent approval → source write → verified result path without external credentials. Docker supplies API/Studio, worker, source sandbox, and PostgreSQL; the native installer uses an isolated local database cluster. Unit, PostgreSQL, HTTP, identity/API, and browser tests cover the delivered boundaries.

This design keeps one codebase across tenants and leaves clear boundaries for separating services when measured workload justifies it. Durable jobs do not imply arbitrary crash-safe plan replay. A public cloud production deployment still needs actual source/IdP/model conformance, operational acceptance, and the remaining product capabilities recorded in the delivery ledger.
