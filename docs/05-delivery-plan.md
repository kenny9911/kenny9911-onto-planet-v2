# Delivery plan and capability ledger

This plan builds by **complete business flow**, not by finishing empty module shells. The shared [initial design](https://chatgpt.com/share/6ab6a918-827c-83ec-86c5-f022cdc6ea5e) sets the functional breadth; the current request adds a native Agent Runtime and Operator. Status words have strict meanings: **Designed** = specified; **Implemented** = code exists; **Verified** = acceptance test passed in the stated environment; **Production-ready** = security, reliability, operational, and customer gates passed. A document or type definition is not a production capability.

## Increment 0: architectural foundation

Deliver a coherent architecture, source research, versioned ontology contracts, deterministic validation/rules, action gateway and bounded harness ports, extension manifests, and a scoped MCP foundation. Use a safe procurement fixture to test semantics, policy denial, approval binding, duplicate handling, and uncertain external results. This increment does **not** claim live enterprise integrations, durable production execution, or UI parity.

Repository gate: `pnpm install --frozen-lockfile`, `pnpm check`, no committed secrets, and a clean capability ledger. The absence of a Git remote is an external delivery issue, not a reason to call failing tests successful.

## Increment 1: first deployable task closure

Build a **procurement request** sandbox flow with all essential V2 seams represented:

1. A FDE starts from “explain why this request is pending and take the permitted next step.”
2. OntoXForm produces source-linked Markdown; OntoGen proposes an incremental ontology/action change with unresolved gaps visible.
3. A domain owner reviews value/object/relation/rule/action definitions and a real sandbox ERP read/action binding.
4. Test Harness executes frozen contract, role/tenant, threshold boundary, duplicate, stale revision, timeout, and source readback cases. Evaluation compares context/agent task success with a protected holdout and records cost/latency.
5. Release review joins the semantic diff, knowledge/binding/context/agent versions, policy simulation, and quality evidence. Required checks fail closed.
6. Context Profile serves a cited, fresh, authorized pack to one approved office client through MCP, with a structured-text fallback.
7. Native Agent Runtime runs a bounded task, previews an ontology action, waits for exact-intent approval where required, executes once through the gateway/operator, verifies in ERP, and returns a source receipt.
8. Governance shows published, activated, and consumer-loaded hashes, a run trace, source operation ID, and an actionable reconciliation case after a lost response.

This is the minimum credible product demonstration. A mocked adapter alone does not satisfy “real sandbox binding.” A prompt telling an agent not to write production is not test isolation; sandbox credentials and network policy enforce it.

## Increment 2: enterprise completeness

Complete shared properties and interfaces, relationship properties, rich object query/sets/aggregation/timeline, functions, semantic diff and lineage, definition branches, permission simulator, operational what-if scenarios, AI-FDE diagnosis and gap ledger, Solution Packs, Context Inspector, supported MCP Skills/Tasks negotiation, and multiple verified office clients. Add a dedicated connector conformance lab and tenant isolation/security gates.

## Increment 3: scale and system breadth

Add governed materialized read models and graph/search projections where task benchmarks justify them; CDC/events; more ERP/CRM/MRP and custom adapters; isolated UI Operator; cross-system sagas; richer geospatial/time-series/multimodal semantics; workload-aware scaling; disaster recovery and data-residency options. External agent federation (for example A2A) is a later interoperability seam, never an authorization shortcut.

## Quality gates for every release

| Gate | Pass evidence | Failure behavior |
|---|---|---|
| Semantic integrity | Types, references, interfaces, relations, rules, action bindings and compatibility validate | `fail`, `error`, or `unsupported` blocks a required gate |
| Knowledge traceability | Every generated business rule/action links to approved source or explicit owner decision | Missing source/confirmation is a review gap |
| Security | Cross-tenant, row/field, derived-output, tool visibility, action grants and test-as-role pass | Any unauthorized disclosure/write blocks |
| Connector semantics | Preview, idempotency or advertised limit, source revision, readback, timeout/unknown, reconciliation pass | Unsupported guarantee reduces allowed effect tier or blocks |
| Agent behavior | Bounded steps/budgets, tool schema, prompt-injection boundary, human wait, version pinning pass | Run fails safely and is inspectable |
| Evaluation | Protected holdout task success, citation, freshness, safety, latency and cost compare against baseline | Safety failure is a hard stop; regression threshold blocks |
| Operations | Audit, traces, loaded release hash, rollback behavior and recovery rehearsal pass | Release remains inactive |

## Capability ledger after foundation slice

The table is intentionally conservative. It must be updated with actual tests and deployment evidence after each increment.

| Capability | Design | Code | Verification | Production |
|---|---|---|---|---|
| Versioned ontology schema, finite rules, release hash | Specified in [Ontology V2](03-ontology-v2.md) | Contracts and ontology kernel | Schema, guard, reference, release-hash fixture tests pass | No |
| Object Service and live federated/materialized query | Specified | No | No | No |
| OntoXForm/OntoGen with source review | Specified | No | No | No |
| Knowledge Markdown and dependency impact | Specified | No | No | No |
| OntoMapper and real ERP/CRM/MRP bindings | Specified | Versioned action binding contract and in-memory activation source; no real connector | Two environment bindings, hash pinning, revocation and mock source precondition tests pass | No |
| Context Profile/Pack/Inspector | Specified | Harness context port only | Tenant-scoped context fixture; no Context Service flow | No |
| Agent Runtime and Harness | Specified in [runtime design](04-agent-runtime.md) | Bounded model/tool loop, status-only uncertain resume, in-memory checkpoint boundary | Mutation isolation, deadline reconciliation, source revision status and procurement fixture tests pass | No |
| Action gateway and Operator | Specified | Intent/approval/verification/reconciliation gateway; mock adapter only | Duplicate, approval expiry, source revision, readback, stale worker fencing and reconciliation recovery tests pass | No |
| Authenticated invocation boundary | Specified | Identity/catalog/grant ports, trusted run and preview construction, in-memory checkpoint claims | Input snapshots, spoofed authority, actor-bound resume, original publication and current scope tests pass | No |
| Skills and Plugins | Specified | Two reusable skills, versioned registry, signed mock ERP preview plugin | Manifest path traversal, signature, tamper and narrow-grant fixture tests pass | No |
| MCP Builder/Context/Consumer surfaces | Specified | Consumer-style scoped query/action-preview registry and SDK Streamable HTTP adapter | List/call, authorization snapshots, release revocation and HTTP adapter tests pass; client conformance pending | No |
| AI-FDE, Test Harness, Evaluation | Specified | No product service | No | No |
| Release review, activation, consumer acknowledgement | Specified | Canonical ontology sub-manifest and trusted MCP release-status port only | Hash and revocation fixture tests; no cross-asset release gate | No |
| Studio and employee task experience | Specified | No | No | No |

## Open product inputs for the first customer deployment

The design proceeds with safe assumptions. A real deployment will need a named first customer task, the actual source-system sandbox and API owner, enterprise IdP and client hosts, data-classification/retention rules, approval tiers, residency/deployment choice, and customer-validated acceptance cases. These are configuration and evidence inputs, not reasons to generate customer-specific product code.
