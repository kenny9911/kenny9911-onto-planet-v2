# ADR 0003: Source-verified business actions

**Status:** Accepted for V2 design · **Date:** 2026-09-26

## Context

ERP/CRM/MRP APIs and browser UIs can time out or complete a side effect while the platform loses the response. No general distributed transaction covers those systems and Onto Planet's own projections.

## Decision

The action gateway validates a typed intent, current revision, principal grants, deterministic guard, binding, preview, and exact-intent approval. Operator adapters execute with a runtime idempotency key where supported, verify via source readback, and emit a receipt. Uncertain outcomes enter reconciliation before any retry. Cross-system flows use explicit sagas and compensations where the business operation supports them.

## Consequences

Action definitions advertise source capabilities and limitations. An adapter without safe confirmation may be restricted to preview or require manual resolution for higher-risk effects. A release rollback cannot undo a source-system transaction.
