# Onto Planet V2

Onto Planet V2 is a new enterprise AI platform built around an **operational ontology**: a versioned model of business objects, relationships, rules, actions, and access. It connects enterprise knowledge and live systems to people, agents, and approved office clients.

This repository starts from an empty directory. The current code is a **foundation slice**, not a deployed enterprise platform. The design covers the complete target product; the implementation ledger in [Delivery plan](docs/05-delivery-plan.md) separates designed, implemented, verified, and production-ready capabilities.

## Product shape

- **Build:** AI-assisted domain discovery, OntoXForm/OntoGen, ontology modeling, system bindings, context profiles, tests, evaluations, and releases.
- **Use:** authorized object queries, evidence-backed context, reusable skills, and agentic applications that act through governed ontology actions.
- **Govern:** identity, object and field policy, approvals, versioned releases, source-system receipts, lineage, audit, and quality gates.

The new Agent Runtime, Harness, and Operator are first-class parts of V2. A model may propose an action, but deterministic policy and source-system verification decide and record its execution. ERP, CRM, MRP, and other systems remain authoritative for their business records.

## Read the design

1. [Product principles and experience](docs/01-product-principles.md)
2. [Platform architecture](docs/02-architecture.md)
3. [Ontology V2 contract](docs/03-ontology-v2.md)
4. [Agent Runtime, Harness, Operator, Skills, plugins, and MCP](docs/04-agent-runtime.md)
5. [Delivery plan and capability ledger](docs/05-delivery-plan.md)
6. [Requirements trace](docs/requirements-traceability.md)
7. [Current Palantir research](docs/research/palantir-current.md) and [Semantica research](docs/research/semantica-current.md)

The [original shared design conversation](https://chatgpt.com/share/6ab6a918-827c-83ec-86c5-f022cdc6ea5e) is the source brief. Its v0.2 product expansion is retained; its earlier decision to leave the Agent Runtime outside Onto Planet is superseded by the current request.

## Develop the foundation

Use Node.js 24 or newer and pnpm 9.15.0.

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` builds the TypeScript packages and runs the package tests. The current packages use in-process ports and fixtures; they do not access production systems or require secrets. Review package-level tests for the behaviors that exist today.

GitHub Actions runs the same locked install and validation gate for pull requests and pushes to `main`.

## Repository layout

```text
apps/                 Runnable surfaces as they are implemented
packages/contracts/   Shared semantic and execution contracts
packages/ontology-kernel/
packages/agent-runtime/
packages/action-gateway/
packages/invocation-boundary/
packages/mcp-gateway/
packages/extension-registry/
skills/               Reusable task instruction packages
plugins/              Versioned extension manifests and examples
examples/             Business-task examples and safe fixtures
docs/                 Product, architecture, research, decisions, delivery ledger
```

Package boundaries describe ownership and dependencies. They do not require a separate microservice for each package or a generated application per tenant.
# kenny9911-onto-planet-v2
