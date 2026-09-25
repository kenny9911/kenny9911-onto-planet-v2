# Trusted invocation boundary

`TrustedInvocationBoundary` is the intended API-facing seam for the foundation. It accepts an opaque credential and a small task request. An injected identity adapter supplies the tenant, actor, and scopes; an independently reviewed catalog supplies agent, ontology, model, skill, and tool pins. The boundary filters tool pins by the authenticated scopes and constructs `RunSpec` itself. Suspended run checkpoints remain server-side, and resume is limited to the same actor and an active agent. A failed resume is quarantined for manual recovery rather than replayed.

For action previews, the boundary checks a separate action grant, reads an active tenant/environment `ActionBinding`, and constructs the connector target and binding hash. Request JSON cannot set tenant, actor, tool pins, release, target, or binding hash. The action gateway still rechecks ontology policy and source revision at preview and execution.

The included identity and checkpoint implementations are **ports and in-memory fixtures**. A deployment needs an enterprise IdP adapter, durable claim/checkpoint store, delegated client and workload grants, rate limits, audit, and a network API that exposes only this trusted seam. Internal `AgentRuntime.run` and `ActionGateway.createIntent` methods are not public endpoints.
