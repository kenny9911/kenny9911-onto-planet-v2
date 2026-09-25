# Platform domain services

`PlatformServices` composes the ontology kernel, extension registry, and a tenant-scoped `PlatformStore`. It contains no HTTP framework or per-tenant generated implementation.

- Knowledge transformation preserves supplied text and line evidence in draft Markdown. Ontology proposals use deterministic CSV/JSON field extraction and a small, explicit business-noun vocabulary for text. They do not claim model reasoning or create executable authorization rules.
- When a host injects `OntologyGenerationPort` through `ServiceOptions.ontologyModel`, `AiOntologyProposer` generates a full bundle with the configured model, independently validates the ontology, verifies each definition's exact supplied-source citations, and saves only an unapproved draft. Its method is labeled `model-assisted`. Invalid or unavailable model output is an explicit failure with no silent extraction fallback; source quotations do not substitute for domain-owner semantic review.
- Object queries, relationship traversal, aggregates, and Context Packs apply row access and property masks before search or materialization. Context Pack `bytes` measures the UTF-8 JSON encoding of `items`; the prompt and envelope metadata are outside the profile's item budget. Stale or future-dated observations and unapproved knowledge are excluded.
- Ontology draft edits preserve the active release snapshot. Semantic diffs compare definitions by stable IDs. Policy simulation uses the authenticated principal and stored object facts and is an explanation, not an execution authorization.
- Evaluations execute ontology validation, release integrity, unknown-action denial, explicit allow/deny fixtures, and missing-fact checks. Results are stored as immutable evidence by the API/storage boundary.
- Releases pin the ontology, explicit MCP publication, dependency closure, and evaluation evidence. Production bindings require conformance evidence for the exact binding hash. Sandbox gates validate declared connector contracts; they do not claim production integration verification.
- Activation requires the `release` scope, all passing gates, unchanged resource revisions, verified manifest digests, and the store's atomic `activateRelease` operation. Storage must recheck the pinned resource revisions and hashes inside that transaction, coordinating locks with ordinary resource writes.

The API must prohibit generic mutation of release/evaluation records, apply `canRead` and `visibleObject` to generic read/bootstrap paths, and permit only authorized human workflows to mark source definitions reviewed. Secret references remain references; these services never resolve credentials.

`seedPlatform` installs explicitly labeled procurement fixtures and activates them only through the same release gates. Its source sandbox and deterministic agent configuration support local acceptance tests, not customer production claims.

Run focused tests with `pnpm exec tsx --test packages/platform-services/test/*.test.ts`.
