# MCP gateway

`createOntologyToolRegistry` takes three independent ports: a published ontology snapshot source, an execution port for pure queries and action previews, and a trusted release status source. The status source must read the tenant's current activation record rather than copying a field from the snapshot. Missing, inactive, revoked, or mismatched tenant, release ID, or bundle hash records fail closed.

The registry checks activation before and after projection on discovery, and again immediately before invocation dispatch. It filters tools by the caller's scopes and effective capability grants. Actions are exposed only as previews; connector execution belongs to ActionGateway, which must enforce its own current release and policy checks at execution time.

`createOntologyMcpHttpAdapter` uses the official MCP TypeScript SDK v2 for Streamable HTTP. The hosting application must authenticate each request, supply its `ToolContext`, rate limit calls, and configure Host and Origin allowlists. This package is an adapter, not a standalone public server.
