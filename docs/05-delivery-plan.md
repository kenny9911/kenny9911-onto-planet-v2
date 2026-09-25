# Delivery plan and capability ledger

This plan builds by **complete business flow**, not by finishing empty module shells. The shared [initial design](https://chatgpt.com/share/6ab6a918-827c-83ec-86c5-f022cdc6ea5e) sets the functional breadth; the current request adds a native Agent Runtime and Operator. Status words have strict meanings: **Designed** = specified; **Implemented** = code exists; **Verified** = acceptance test passed in the stated environment; **Production-ready** = security, reliability, operational, and customer gates passed. A document or type definition is not a production capability.

## Increment 0: architectural foundation — delivered in v0.1

Deliver a coherent architecture, source research, versioned ontology contracts, deterministic validation/rules, action gateway and bounded harness ports, extension manifests, and a scoped MCP foundation. Use a safe procurement fixture to test semantics, policy denial, approval binding, duplicate handling, and uncertain external results. This increment does **not** claim live enterprise integrations, durable production execution, or UI parity.

Repository gate: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:e2e`, no committed secrets, and an accurate capability ledger. v0.2 adds mandatory PostgreSQL integration and browser workflow gates; `pnpm test:unit` is an explicitly reduced check.

## Increment 1: first runnable task closure — v0.2 scope and remaining gates

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

v0.2 delivers the local PostgreSQL/API/Studio/worker installation and the full source-read → intent → independent approval → conditional HTTP write → receipt/readback flow against a separately persisted HTTP source sandbox. A source commit followed by a failed response is reconciled without replay. Reviewed cross-asset manifests, deterministic evaluations, role/tenant controls, context inspection, and scoped MCP query/preview are implemented. The default planner and proposal extraction are deterministic; optional configured HTTPS model adapters support task decisions and ontology proposals with local schema/source validation. Actual customer-source conformance, live model/IdP testing, protected statistical agent holdouts, office-client certification, and consumer-loaded release acknowledgements remain open.

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

## Capability ledger for runnable v0.2

The table is intentionally conservative. It must be updated with actual tests and deployment evidence after each increment.

| Capability | Delivered code | Verification scope | Remaining boundary |
|---|---|---|---|
| Ontology schema, finite rules, canonical hashes | Contracts/kernel plus Studio graph and definition editor | Schema, references, guards, thresholds, tampering and release hash tests | Rich scenarios, geospatial/time-series and full Palantir semantics remain target scope |
| Object Service | Tenant/row/field filtered materialized queries, filters, relation traversal and explicit source refresh | API/domain authorization and projection tests; HTTP readback refresh | No live federation, CDC, graph index or complete aggregation/timeline engine |
| OntoXForm/OntoGen | Cited Markdown extraction; deterministic JSON/CSV/text proposals or configured HTTPS model proposals, with schema/source validation and review gaps | Deterministic extraction, proposal validation and mocked provider contract | Live model document understanding/quality unverified; no autonomous ontology approval |
| Knowledge and context | Versioned knowledge, profile inspection, bounded cited/fresh context packs | Scope/freshness/budget and context dependency tests | Broad document ingestion, embeddings and statistical retrieval evaluation not included |
| Connector bindings | Reviewed release snapshots, server-approved HTTP origins/secret references, read-only connection test | Active binding, source revision, network policy and HTTP integration tests | Customer ERP/CRM/MRP adapters require actual API conformance evidence |
| Agent Runtime/Harness | PostgreSQL jobs/checkpoints/intents, lease worker, model/tool loop, release and invocation-scope pins, cancellation and resume | Restart at approval boundary, immutable authority, narrowed tokens, revocation, cancellation and deadline tests | Interrupted unsaved plans require manual recovery; HA/load/chaos not certified |
| Operator/action closure | Conditional HTTP write, exact independent approval, idempotency, source receipt, readback and reconciliation | Real PostgreSQL + separate HTTP sandbox, including commit-then-response-failure and one-write reconciliation | No browser/UI operator, arbitrary source API synthesis or cross-system saga |
| Model adapters | Deterministic local planner; configured Responses/compatible Chat Completions JSON adapter with published schemas | Sandbox workflow and mocked HTTP provider contract | Live external model/quality/cost/latency testing awaits credentials and reviewed AgentSpec |
| Identity/invocation | Local users/sessions, CSRF, roles, scoped/revocable tokens, configurable OIDC and trusted worker identity | API tenant/role/field/token tests; current scopes intersect original invocation | Real IdP login/lifecycle, workload identity and customer security acceptance remain open |
| Skills/plugins | Released Skills loaded within context budget; manifest/signature/grant checks; extension catalog and signed example | Versioned Skills and signature/tamper/path/grant fixtures | No arbitrary plugin execution or general plugin sandbox |
| MCP | Authenticated Streamable HTTP endpoint publishing scoped pure queries and governed previews | SDK list/call, HTTP/authentication, scope and release tests | Builder/Context endpoint separation, external client certification, Skills/Tasks negotiation pending |
| Evaluation/Test Harness | Deterministic executable ontology/policy cases and persisted reports in Studio | Boundary/denial/manifest cases and fail-closed release checks | Statistical holdouts, multi-model evals and autonomous AI-FDE remain future work |
| Release review/activation | Cross-asset manifest snapshots, dependency/revision hashes, owner review, gates, transactional activation | Stale revision, tamper, required resource and failed evaluation tests | Consumer-loaded acknowledgement, deployment promotion and production rollback procedures not certified |
| Studio | Build/Use/Govern screens, ontology/object/knowledge views, context inspector, task runner, approvals, traces, releases, audit and settings | Server/Studio build; API flow tests; browser acceptance recorded during delivery | No claim of full Palantir UI or workflow parity |
| Installation/operations | Native isolated PostgreSQL setup, API/source/worker launch, Docker Compose, migration installer and runbook | Native database/HTTP integration; Docker image built and all containers healthy at localhost:4100 with first-admin setup pending | Production hosting, backup restore/DR and scale tests are separate gates |

No row is labelled production-ready. In-memory stores remain available for focused foundation tests; the runnable application injects PostgreSQL implementations. Installation instructions are in [06-installation](06-installation.md); operational recovery is in the [runbook](runbook.md).

## Open product inputs for the first customer deployment

The design proceeds with safe assumptions. A real deployment will need a named first customer task, the actual source-system sandbox and API owner, enterprise IdP and client hosts, data-classification/retention rules, approval tiers, residency/deployment choice, and customer-validated acceptance cases. These are configuration and evidence inputs, not reasons to generate customer-specific product code.
