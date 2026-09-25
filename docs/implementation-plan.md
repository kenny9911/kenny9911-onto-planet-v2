# Runnable platform implementation

The platform preserves the existing ontology and governed action contracts, adds durable PostgreSQL storage, and exposes one authenticated API to a React Studio and MCP clients. A worker consumes leased database jobs. Local installation uses a separate database and explicit sandbox fixtures; production uses configured identity and source systems. [ADR 0005](adr/0005-runnable-platform.md) records the implementation boundaries.

## Work in this delivery

- PostgreSQL tenant-scoped resources, atomic revisions, intents, checkpoints, sessions, audit, and leased jobs.
- Authenticated API, local first-admin setup, OIDC configuration, scoped API tokens, CSRF protection, and role gates.
- Build/Use/Govern Studio: ontology graph/editor, sources, knowledge, context, agents, task runs, approvals, releases, extensions, and audit.
- Knowledge transformation, ontology proposals, object queries, context packs, policy simulation, deterministic evaluations, and gated releases.
- Existing agent harness wired to persisted jobs/intents/checkpoints, configurable model providers, and governed operators.
- Local source-system sandbox over HTTP plus configurable HTTP integration contract and conformance evidence.
- MCP endpoint, installation scripts, Docker deployment, meaningful integration/browser verification, and operational documentation.

Live customer ERP/CRM credentials, enterprise IdP registration, and production hosting are external configuration inputs. The capability ledger will distinguish locally verified behavior from integrations still awaiting those inputs.

## Acceptance

The local acceptance path starts with first-admin setup and a second operator account. A task reads a source purchase order, pauses for independent exact-intent approval, resumes in the worker, writes conditionally to the HTTP source, and displays the verified result. Automated tests additionally exercise source commit followed by lost response, reconciliation without another write, scoped-token authority across the queue, tenant/row/field isolation, and failed release gates.

Run `pnpm check` for the build and backend suites, followed by `pnpm test:e2e` for the isolated browser workflow. GitHub CI runs both gates. The [delivery ledger](05-delivery-plan.md) records remaining product and customer acceptance work.
