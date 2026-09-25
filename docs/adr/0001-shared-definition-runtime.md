# ADR 0001: Shared implementation with versioned definition packages

**Status:** Accepted for V2 design · **Date:** 2026-09-26

## Context

The previous Onto Planet approach and its generated tenant code were judged too heavy in the [initial design brief](https://chatgpt.com/share/6ab6a918-827c-83ec-86c5-f022cdc6ea5e). Customers still expect broad ontology, AI, context, and MCP capabilities.

## Decision

One monorepo produces shared API, Studio, worker, agent, and MCP images. Each tenant/domain publishes an immutable definition package with ontology, knowledge references, bindings, policies, context, agents, skills/plugins, and verification evidence. A tenant-specific deployment can isolate the same image and data/credentials without generating a new source tree. Small SDK/type generation is allowed.

## Consequences

The platform must validate compatibility and loaded hashes, isolate tenant data and credentials, and handle versioned definitions at runtime. A new tenant adds no product code. Customer-specific logic is a reviewed adapter/plugin or external function with an explicit boundary.
