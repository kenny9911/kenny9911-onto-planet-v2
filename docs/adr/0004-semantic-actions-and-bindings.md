# ADR 0004: Semantic actions and environment bindings

**Status:** Accepted for V2 foundation · **Date:** 2026-09-26

## Context

A business action such as `ApprovePurchaseRequest` may be implemented by different ERP operations in two tenants or environments. Putting `{system, operation, resource}` in the ontology action changes the semantic release whenever the source implementation changes. It also allows a model-facing action name to conceal which connector will execute.

## Decision

An `ActionDefinition` contains the typed business verb, affected object type and ID parameter, guard, risk, approval, policy, and expected result. A separate, versioned `ActionBinding` selects a tenant/environment connector operation and declares adapter version, secret reference, idempotency, conditional-write, readback, and reconciliation capabilities. The ontology bundle hash excludes bindings. A binding has its own content hash and independent activation/revocation state.

Every `ActionIntent` pins both the ontology release hash and binding hash. The trusted binding source must show an active binding for the tenant, environment, action, and ontology release at preview and execution. The gateway rejects a mismatched connector target. For material effects, the binding must support a conditional write against the exact target object revision, source readback, and reconciliation. Connector conformance tests must verify those advertised capabilities against a sandbox; a manifest declaration by itself is insufficient for production.

## Consequences

One semantic action can be reused with separate reviewed bindings. Revoking a binding blocks pending execution. Binding changes require their own diff, tests, review, and activation record. Operators receive the exact object identity and expected source revision; a policy check before execution alone cannot close a source-system race.
