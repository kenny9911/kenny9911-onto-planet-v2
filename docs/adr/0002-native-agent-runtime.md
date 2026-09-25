# ADR 0002: Native Agent Runtime paired with Ontology V2

**Status:** Accepted for V2 design · **Date:** 2026-09-26

## Context

The shared v0.2 proposal allowed external harnesses to consume the ontology and did not include a new Agent OS. The current user request explicitly calls for a new Agent Runtime and Harness that develop together with Ontology V2.

## Decision

Onto Planet owns a durable model-agnostic Agent Runtime, bounded Harness, and Operator SDK. An agent runs against a pinned ontology release, obtains authorized context, and expresses business writes as ontology ActionIntents. External agents and MCP clients use the same action boundary. The runtime can delegate to narrower child runs and can use external model/agent frameworks through ports.

## Consequences

Version compatibility, checkpointing, budgets, human waits, audit, connector semantics, and evaluations are core platform responsibilities. The product must not expose a direct model-to-ERP credential path.
