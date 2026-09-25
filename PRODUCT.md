# Product context

**Name:** Onto Planet V2
**Mission:** Help enterprises build a trustworthy operational ontology, then make it useful to employees and agents as governed context and business capabilities.
**Primary users:** Forward deployed engineers and implementation teams, domain owners, employees, developers, and security administrators.

The starting point is a business task: what someone needs to know, decide, or do. Onto Planet helps discover the relevant sources and system capabilities, proposes semantic definitions with evidence, tests them, releases approved versions, and serves the result to agentic applications and office clients.

The platform has three visible experiences:

- **Build:** a task-led workbench for knowledge, ontology, bindings, context, agents, tests, evaluations, and release review.
- **Use:** simple role-specific tasks, explanations, object views, previews, approvals, and receipts.
- **Govern:** access simulation, policy, approvals, lineage, quality gates, versions, and audit.

Product invariants:

1. One shared implementation loads versioned tenant and domain definitions. A new tenant does not generate a new product codebase.
2. Source business systems own their records. Onto Planet owns the semantic contract, configuration, evidence, and execution record.
3. AI proposes; deterministic validation, policy, and human review control production changes and business actions.
4. Every active agent run pins the ontology, context, skills, plugins, tools, policy, and model versions it used.
5. Skills teach agents a procedure; they never grant authority. Plugins package integrations and capabilities; MCP exposes governed interfaces.
6. Build-time tests and evaluations are part of the release gate. Unsupported checks cannot silently pass.
7. User experiences start with business work, while technical machinery remains inspectable for builders and administrators.

The current task adds a **new Agent Runtime, Agent Harness, and Operator** to the v0.2 shared design. See [the product principles](docs/01-product-principles.md) for the full decision and experience model.
