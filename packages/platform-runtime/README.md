# Platform runtime and HTTP operators

`PlatformRuntime` connects the bounded agent harness and governed action gateway to injected PostgreSQL intent/checkpoint stores, a tenant-scoped resource store, and current identity lookup. It exposes queued start/resume/cancel operations, independent approvals, source reconciliation, preview-only MCP actions, connector tests, and source projection refresh.

Runs pin the released agent, ontology, tool input schemas, Skills, connector definitions, and the invocation's effective scopes. Worker authentication intersects those original scopes with the actor's current grants; a narrow API token cannot acquire the user's broader role permissions in a background job. Model adapters see independent copies. Source read fields are filtered using the governed object projection's disclosure policy.

Worker interruption moves a previously running job to manual recovery. It never replays a model or a possibly completed write. A durable suspended checkpoint can continue after independent approval or a definitive source reconciliation. Cancellation prevents subsequent effects; an already dispatched source operation may still require reconciliation.

## HTTP source contract

Source connections use an exact server origin allowlist, secret references resolved by the server, HTTPS for remote sources, pinned DNS addresses, bounded requests and responses, and no redirects. Private/reserved addresses require an additional explicit server grant. The development sandbox exception applies only to approved localhost/Docker sandbox hosts.

The source adapter implements:

- `GET /health` and `GET /objects` for authenticated health and source enumeration.
- `GET /objects/:id` returning `{id,revision,properties}`.
- `POST /actions/preview` with `{intent}`, returning an exact summary, effects and source revision.
- `POST /actions/execute` with `{intent,preview}`, `Idempotency-Key` and `If-Match` headers.
- `GET /operations/:key` returning the persisted receipt for the original intent hash without executing again.

An accepted receipt includes `details: {objectId, revision, expectedProperties}`. Verification checks the persisted operation and reads the source object back against that effect contract. Unknown outcomes remain unknown until operation lookup provides definitive evidence. Successful verification refreshes the materialized ontology object; `syncConnector` provides an explicit read-only refresh and preserves existing object ACLs and links. Queries of those projections are materialized observations, not live federation.

## Model providers

The default `SandboxProcurementModel` is a deterministic demonstration. It looks up a purchase order and recognizes explicit commands such as `Approve PO-2026-001`. It does not claim general language understanding. The optional `HttpDecisionModel` supports server-configured OpenAI Responses and compatible Chat Completions endpoints with a strict JSON decision envelope; published ontology definitions supply the actual tool input schemas. Output is validated again locally, and the gateway retains write authority.

The Responses adapter follows the [official Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs), reviewed September 26, 2026. Configure a matching provider/model in the released AgentSpec plus server-side API credentials. Real provider calls require deployment credentials and have not been exercised by the local fixture tests.

## Verification

`test/platform-runtime.test.ts` includes PostgreSQL and real HTTP integration when `DATABASE_URL` is configured. It verifies independent approval, a process restart at the checkpoint boundary, source revisions, readback, idempotent retries, source commit followed by a failed response, reconciliation without another write, projection refresh, effective token scope preservation, cancellation, revoked grants, and policy denial. The unit checks cover network origin/private-address rejection, custom published model schemas, and explicit sandbox task intent.
