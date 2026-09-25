# Onto Planet V2

Onto Planet V2 is an enterprise AI platform built around a versioned operational ontology: business objects, relationships, rules, actions, and access. The runnable **v0.2** includes a React Studio, authenticated API and MCP endpoint, PostgreSQL persistence, a leased job worker, an agent harness, and a governed HTTP operator.

The included procurement workspace runs against a separate local HTTP source system. An agent reads a purchase order, proposes an action, waits for an independent person to approve it, executes with a source revision and idempotency key, and verifies the receipt. A lost response leads to reconciliation without replaying the write. Customer ERP, CRM, MRP, identity, and model deployments require their own configuration and acceptance evidence.

## Run locally

Use Node.js 24+, pnpm 9.15.0, and installed PostgreSQL 17 or 18 binaries. The setup script creates an isolated cluster under `.local/` and separate application/test databases.

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm build
pnpm start
```

Open [localhost:4100](http://localhost:4100), create the first administrator, then add a second operator in **Settings**. Run `Approve PO-2026-001` in **Task runner** and use the other account to approve the request. The default planner is a deterministic sandbox demonstration and needs no model API key.

For Docker:

```sh
node scripts/configure-docker.mjs
docker compose up --build -d
```

Use the generated `SETUP_TOKEN` from the private `.env` file for first-admin setup. See [installation](docs/06-installation.md) for prerequisites, model and identity configuration, MCP clients, and the complete walkthrough; see the [runbook](docs/runbook.md) for operations and recovery and the [API and extension guide](docs/07-api-and-extensions.md) for integrations.

## Build, Use, Govern

- **Build:** ontology graph and definition editing, source-linked knowledge transformation, JSON/CSV/text ontology proposals, connectors, context profiles, agents, Skills, applications, and extension metadata.
- **Use:** authorized object queries and relationships, bounded context packs, task runs, approval waits, receipts, source projection refresh, and scoped MCP queries/action previews.
- **Govern:** roles, sessions and scoped tokens, tenant/row/field controls, policy simulation, deterministic evaluations, reviewed releases, audit, and reconciliation.

Ontology proposals use deterministic extraction by default or an optional configured HTTPS model adapter, with schema/source validation and explicit review gaps. Live provider quality remains unverified. Plugins have manifest/signature/grant validation and catalog management; the server does not execute arbitrary plugin code. The browser/UI operator, broad office-client compatibility, autonomous AI-FDE, production scaling, and full Palantir parity are not delivered claims. The [capability ledger](docs/05-delivery-plan.md) records the exact boundaries.

## Validate

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

These gates build the server and Studio, run unit/integration tests, and exercise the browser workflow. They require a PostgreSQL test database. `pnpm setup:local` supplies it; otherwise configure `TEST_DATABASE_URL`. Database suites use unique schemas. `pnpm test:unit` is an explicit reduced check and does not satisfy the repository delivery gate. GitHub Actions uses a PostgreSQL service and runs both gates.

## Repository layout

```text
apps/studio/                 React Studio
apps/api/                    Authenticated HTTP API, MCP, application startup
apps/worker/                 Leased job consumer
apps/source-sandbox/         Separate HTTP procurement source and receipt tables
packages/contracts/          Ontology and execution definitions
packages/ontology-kernel/    Validation, finite rules, canonical release hashes
packages/platform-contracts/ Shared application/storage contracts
packages/persistence/       PostgreSQL stores, sessions, jobs, audit, checkpoints
packages/identity/          Local identity, scoped tokens, configurable OIDC
packages/platform-services/ Knowledge, proposals, objects, context, evaluations, releases
packages/platform-runtime/  Runtime orchestration, providers, HTTP operators
packages/agent-runtime/     Bounded model/tool harness
packages/action-gateway/    Policy, exact approvals, execution, verification, reconciliation
packages/invocation-boundary/ Trusted invocation and resume authority
packages/mcp-gateway/       Scoped MCP publication and transport
packages/extension-registry/ Skills/plugins, signatures and capability grants
skills/                     Reusable task procedures
plugins/                    Signed example extension and manifests
docs/                       Architecture, research, decisions, installation, operations
```

Tenant behavior comes from reviewed definitions and bindings within this shared application.

## Design references

Start with [product principles](docs/01-product-principles.md), [architecture](docs/02-architecture.md), [Ontology V2](docs/03-ontology-v2.md), and [Agent Runtime, Harness and Operator](docs/04-agent-runtime.md). The [requirements trace](docs/requirements-traceability.md), [Palantir research](docs/research/palantir-current.md), and [Semantica research](docs/research/semantica-current.md) connect the implementation to its sources. Those design documents include future scope; use the delivery ledger for implementation status.

The [original shared design](https://chatgpt.com/share/6ab6a918-827c-83ec-86c5-f022cdc6ea5e) remains the source brief. The user's later request makes the native Agent Runtime and Harness part of Onto Planet V2.
