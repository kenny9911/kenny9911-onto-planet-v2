# Requirements trace

This trace treats the [shared design conversation](https://chatgpt.com/share/6ab6a918-827c-83ec-86c5-f022cdc6ea5e) as the source brief and the current request as the latest authority. The shared conversation includes an initial v0.1 answer and a v0.2 expansion after the user asked for broader Palantir parity, FDE help, office clients, MCP, and enterprise context. The current request explicitly adds a native Agent Runtime/Harness/Operator, superseding v0.1/v0.2 suggestions to leave agent execution outside the product.

| Source requirement or decision | Where it is designed | Proof target |
|---|---|---|
| Rebuild from scratch; avoid heavy old architecture and generated tenant code | [Principles](01-product-principles.md), [architecture](02-architecture.md) | Second tenant loads a definition package with zero generated product code |
| Pipeline Manager for OntoXForm and OntoGen | [Ontology generation](03-ontology-v2.md) | Source → reviewed Markdown → incremental semantic proposal |
| OntoGen produces diffs, preserves human edits, flags unknowns | [Ontology generation](03-ontology-v2.md) | Human edit survives rerun; missing rule is `needs_clarification` |
| Manual schema modeling and direct structured import remain possible | [Ontology generation](03-ontology-v2.md) | Object/action definition can publish without document pipeline |
| Ontology Manager: data/value/object types, relations, rules, actions | [Semantic assets](03-ontology-v2.md) | Type/reference and finite rule contract suite |
| Newer Palantir depth: shared properties, interfaces, relation properties, rich values, aliases, units, lifecycle, events, functions, policy | [Semantic assets](03-ontology-v2.md), [research](research/palantir-current.md) | Conformance and business task cases per asset type |
| Task-linked object search and investigation, object sets, filters, aggregation, links, saved analyses, timeline, derived values | [Object Service](03-ontology-v2.md), [architecture](02-architecture.md) | Authorized live/materialized/native query suite |
| Rules distinguish validation, decision, and guard; unknown fails closed | [Rule semantics](03-ontology-v2.md) | Boundary/unknown/error fixtures |
| Actions separate business contract from customer-specific source call | [Action semantics](03-ontology-v2.md), [ADR 0004](adr/0004-semantic-actions-and-bindings.md) | Same ontology hash works with two active environment bindings; revocation blocks execution |
| OntoMapper connections, read/action/event bindings, real source discovery | [Ontology bindings](03-ontology-v2.md), [architecture](02-architecture.md) | One sandbox ERP read/write, capability and freshness checks |
| ERP, CRM, MRP, custom apps, web apps supported through an Operator | [Operator ports](04-agent-runtime.md), [architecture](02-architecture.md) | API-first contract; later CRM/MRP/UI conformance suites |
| Unknown source result is reconciled, not blind-retried | [Gateway lifecycle](04-agent-runtime.md) | Lost-response test produces `reconciliation_required` |
| Knowledge Base owns reviewed Markdown, source spans, revisions and dependency impact | [Knowledge](03-ontology-v2.md) | Policy update reports affected definitions/tests without changing production |
| Semantica researched and optionally adapted, not made platform authority | [Semantica assessment](research/semantica-current.md) | Pinned adapter contract test and baseline comparison |
| Test Harness for schema, rule, binding, security, action, failure recovery | [Runtime tests](04-agent-runtime.md), [delivery gates](05-delivery-plan.md) | Frozen fixtures and sandbox-only integration tests |
| Evaluation for LLM, agent, workflow, pipeline, ontology task, context and client | [Runtime evaluation](04-agent-runtime.md), [delivery plan](05-delivery-plan.md) | Holdout comparison and safety hard gate |
| Test and Evaluation share datasets, run/trace/evidence infrastructure | [Architecture](02-architecture.md), [delivery plan](05-delivery-plan.md) | One execution record schema with distinct graders |
| Releases unify diffs, dependencies, quality evidence, publish/activate/loaded hash and rollback | [Release flow](02-architecture.md), [ontology releases](03-ontology-v2.md) | Required unsupported check blocks; loaded hash visible |
| FDE Workbench and AI-FDE start with business outcomes; discover sources, propose, test and diagnose | [Experience](01-product-principles.md), [delivery plan](05-delivery-plan.md) | Mission-driven procurement walkthrough with gap ledger |
| AI-generated tests and reference answers need human confirmation and protected holdouts | [Runtime evaluation](04-agent-runtime.md) | Independent failure and boundary set prevents self-grading |
| Solution Packs and reusable role/task packages | [Skills and Plugins](04-agent-runtime.md), [experience](01-product-principles.md) | Install pack; map customer differences; no sample policy auto-activation |
| Enterprise Context combines semantics, knowledge, live facts, rules, capabilities and confirmed history | [Context flow](02-architecture.md), [principles](01-product-principles.md) | Context Pack displays all six layers with evidence and omissions |
| Context Profile is versioned; Context Pack is request-specific; Inspector compares roles and freshness | [Context flow](02-architecture.md), [experience](01-product-principles.md) | Test-as-role and changed-source comparison |
| Knowledge-ready, data-connected, action-enabled maturity | [Principles](01-product-principles.md) | UI states exact capability boundary |
| Builder, Context and Consumer MCP authority surfaces | [MCP hub](04-agent-runtime.md) | Scope-filtered list/call tests and client compatibility suite |
| WorkBuddy, Claude Cowork, Codex/ChatGPT, Grok, Muse and other clients are targets | [Client stance](01-product-principles.md) | Per-host/version auth, transport, structured output, UI, task and revoke results |
| Cards and simple employee task UX, with text fallback | [Use experience](01-product-principles.md), [MCP hub](04-agent-runtime.md) | Task pack usable without ontology or MCP terminology |
| New native Agent Runtime with Harness and Operator | [Runtime](04-agent-runtime.md), [architecture](02-architecture.md) | Bounded pinned run through sandbox action and receipt |
| Agentic applications and multiagent delegation | [Agentic applications](04-agent-runtime.md) | Child gets narrower grants, own budget and trace |
| Skills reusable across agent tasks with no implicit authority | [Skills](04-agent-runtime.md) | Skill install cannot reveal or execute ungranted tool |
| Plugins extend ontology, connectors, MCP and UI through signed/versioned bundle | [Plugins](04-agent-runtime.md) | Grant review, compatibility test, staged rollout, revoke |
| Security simulation, definition branches, scenarios, lineage and audit | [Ontology isolation](03-ontology-v2.md), [governance experience](01-product-principles.md) | Distinct branch/fixture/scenario behavior and test-as-role |
| Latest Palantir Ontology and AIP researched, without inventing product version | [Current baseline](research/palantir-current.md) | Dated official-source matrix with GA/beta/future distinctions |
| AIP Evolve-like bounded improvement and operational evaluation | [Runtime evaluation](04-agent-runtime.md), [research](research/palantir-current.md) | Improvement cannot modify gate, holdout, or approval |
| One full customer scenario before broad platform claims | [Delivery plan](05-delivery-plan.md) | Procurement closure with FDE → source → context/MCP → agent → verified action |

The implementation status of each area is in the [capability ledger](05-delivery-plan.md). This trace is a coverage map, not evidence that every target has shipped.
