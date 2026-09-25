# Procurement reference task

The first V2 story is an illustrative procurement approval. All amounts, roles, systems, IDs, and records here are **test fixtures**. They do not assert a real customer's policy.

## Business task

“Why is request `PR-42` still pending, what policy applies, and can I approve it?”

The full product should show the relevant policy source, current ERP state and read time, approval route, user's permitted next step, and any missing information. A material approval requires a preview and an exact-intent authorization before the operator calls the ERP sandbox. The source response is read back and shown as a receipt.

## Target evidence chain

```text
Policy source revision and source span
  → OntoXForm reviewed Markdown
  → OntoGen change proposal
  → PurchaseRequest / Supplier / ApprovalRecord ontology definitions
  → rule and action binding to ERP sandbox
  → frozen boundary + role + timeout tests
  → evaluated context and agent task
  → approved release and loaded hash
  → Context Pack and MCP preview
  → native agent ActionIntent
  → source-confirmed receipt
```

The current foundation implements pieces of this chain in package tests. The cross-package test at `tests/procurement-closure.test.ts` exercises the in-process ontology release, scoped MCP preview, agent run, policy/approval, action gateway, and source verification together. It uses a mock ERP; the real sandbox integration and complete product flow remain in [Increment 1](../../docs/05-delivery-plan.md).

## Required negative cases

- Amount below, equal to, and above the fixture threshold; missing amount; wrong currency.
- Ordinary employee, manager, finance, and cross-tenant roles.
- Request state changed after preview, missing or expired approval, changed arguments or source revision.
- Repeat with the same idempotency key, repeat with different arguments, timeout after possible source success, and reconciliation without replaying the write.
- No production credential or network route available to fixture tests.

The worker's result is `source_confirmed` only after ERP readback. An HTTP acceptance or a local ontology projection alone is insufficient.
