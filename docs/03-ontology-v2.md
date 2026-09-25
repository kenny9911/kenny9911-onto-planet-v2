# Ontology V2 semantic contract

Ontology V2 is the **shared language between builders, employees, agents, policies, and source-system operators**. It represents business meaning and permitted behavior, not merely a graph schema. The design follows the current public [Palantir Ontology system](https://www.palantir.com/docs/foundry/architecture-center/ontology-system) at the level of principles; Onto Planet defines its own contracts and does not claim proprietary API compatibility.

## Versioned semantic assets

| Asset | Meaning | Required controls |
|---|---|---|
| **Value type** | Reusable value and unit contract such as Money, Email, Quantity, DateRange or GeoPoint | Validation, conversion, display, unknown/null semantics |
| **Object type** | Business entity with stable identity, properties, ownership/source mode, lifecycle and aliases | Key, property classification, provenance, indexes, source freshness |
| **Relation type** | Directed, cardinality-constrained relation; can have its own properties and source | Endpoint types, traversal policy, temporal validity |
| **Shared property** | Central cross-type property definition without merging instance storage | Compatible type, owner, change impact |
| **Interface** | Polymorphic shape/capability shared by object types, including relation constraints | Contract conformance and safe versioning |
| **Rule** | Finite deterministic validation, decision, or action guard | Typed inputs, explicit `true/false/unknown/error`, fixture tests |
| **Function** | Registered query or derived computation over authorized objects | Input/output schema, source policy, effect = read or governed write |
| **Action** | Business verb with typed arguments, target, guard, effect class and expected result | Policy, preview, approval, binding, idempotency, verification |
| **Event** | Typed fact emitted by a source or action | Correlation, producer, version, replay policy |
| **Policy** | Object/field/action/derived-output access and disclosure | Principal and source context, classification, simulation |

Value, object, relation, shared property, and interface definitions are distinct because they solve different reuse problems. A relation may need attributes such as role, amount, time range, or confidence rather than being flattened into a foreign key. Types can be marked example, experimental, active, promoted, or deprecated; a promoted core type requires owner review before incompatible changes. Palantir documents analogous [shared-property](https://www.palantir.com/docs/foundry/object-link-types/shared-property-overview), [interface](https://www.palantir.com/docs/foundry/interfaces/interface-link-types-overview), and [metadata-status](https://www.palantir.com/docs/foundry/object-link-types/metadata-statuses) concepts.

Every asset has a stable ID, display name, description, semantic version, source references, owner, status, and dependency references. IDs remain stable across renames. Cross-reference validation detects missing types, illegal relation endpoints, incompatible property types, unbound actions, inaccessible sources, and cycles where forbidden. A semantic diff reports not just JSON edits but affected object queries, context profiles, skills, agents, bindings, tests, and consumers.

## Rule semantics

Rules are deterministic, side-effect-free, and deliberately finite. Their initial expression language supports typed comparisons, boolean composition, set membership, existence, arithmetic with units, and bounded relationship predicates. A decision table is a compiled form of the same semantics. Unrestricted JavaScript, Python, prompts, and remote calls are not policy rules.

Three purposes are separate:

- **Validation:** Is a value or object valid? Example: amount is nonnegative and has currency.
- **Decision:** What business category or path applies? Example: which approval route matches a request.
- **Guard:** May this particular action occur now? Example: request is submitted, actor has an allowed relationship, and source revision matches.

`unknown` means insufficient or stale information; `error` means evaluation failed. Neither passes a required release gate or a material action guard. Model reasoning can explain or propose a rule, but cannot replace deterministic authorization.

## Action semantics and bindings

An Action defines the **business contract** independently of its customer implementation. A typical `ApprovePurchaseRequest` carries:

```text
stable action ID and version
target PurchaseRequest reference + expected source revision
input/output schema
effect class and risk tier
required grants and action guard
preview/diff contract
approval requirement and expiry
intended state transition and postcondition
idempotency and verification expectations
```

OntoMapper provides the environment-specific connection, field transformations, source operation, timeout, result mapping, readback, and compensation/reconciliation capability. If the source API cannot provide idempotency, version checks, or readback, the binding advertises that limitation and the release gate decides whether the action is eligible for production. A system gap remains `unbound`; AI cannot invent an API and mark it complete.

The foundation code now keeps the connector target in a separate `ActionBinding` with its own hash and activation state. The gateway pins both ontology and binding hashes in each intent, checks the active binding at preview and execution, and denies medium/high risk actions unless the binding declares conditional write, readback, and reconciliation. Two fixture environments bind the same ontology action to different connector targets. These declarations still require sandbox conformance evidence before a real source is eligible for production.

Connections reference secrets and identity policy, never hold plaintext credentials in definition packages. Read bindings declare identity keys, source fields, relation mapping, units, query capabilities, and freshness. Event bindings declare producer, schema, cursor/replay behavior, and source timestamp.

## Knowledge and generation

**OntoXForm** turns a versioned source into parsed/normalized evidence, extraction candidates, and editable Markdown. A reviewer confirms the Markdown and source spans. The approved Markdown is the human-readable knowledge authority; chunks and embeddings can be rebuilt.

**OntoGen** takes approved knowledge, current ontology, and discovered source schemas/capabilities. It emits an **incremental proposal** with provenance, confidence, conflicts, unknowns, and a gap ledger. It must not overwrite a human revision or regenerate a tenant application. Structured source schemas may be imported directly without an artificial Markdown round-trip. Manual modeling remains a first-class path.

An example pipeline:

```text
Business source revision
  → OntoXForm parse/normalize/extract
  → Markdown draft + source spans
  → human knowledge review
  → OntoGen semantic change proposal
  → deterministic validation + dependency impact
  → system binding confirmation
  → tests and evaluations
  → release review
```

All pipeline steps have typed input/output, version, cost and time limit, retry policy, and resumable state. A missing business condition is `needs_clarification`. A missing system capability is `unbound`. Neither is silently treated as success.

## Object service

The Ontology is useful only when it can serve real tasks. The Object Service supports authorized object lookup and exploration, saved object sets, filtering, aggregation, relation traversal, timelines, derived properties, and registered functions. Each query declares whether results came from a live federated source, a materialized read model, or an Onto Planet native object. Result metadata exposes source, observation time, freshness, and incompleteness. A stale result may answer an informational question but cannot automatically satisfy a live write guard.

Object and property policies are enforced before a result enters a model context. The classification of a derived result is tracked separately; the [Palantir security guidance](https://www.palantir.com/docs/foundry/security/access-control-propagation) is a useful warning that source read permissions do not automatically constrain downstream outputs.

## Branches, scenarios, and releases

Three kinds of isolation have different purposes:

1. **Definition branch:** ontology, knowledge, binding, context, agent, or policy changes before review.
2. **Test fixture:** frozen, reproducible data and expected results, never production write credentials.
3. **Operational scenario:** a what-if object state fork for an authorized user or agent, with explicit merge-back permission. It is not a historical snapshot; see current [Ontology Scenarios](https://www.palantir.com/docs/foundry/ontology/overview-ontology-scenario).

The release manager canonicalizes approved asset revisions into a content-addressed manifest, runs required checks, and records evidence. `fail`, `error`, and `unsupported` each block a required gate. Activation in an environment and consumer acknowledgement are separate from publication. Runs pin the exact release hash. Definition rollback changes future behavior, not business operations already executed in ERP/CRM/MRP.

## Illustrative procurement task

The first example domain models `PurchaseRequest`, `Supplier`, `Department`, and `ApprovalRecord`. A sample policy may say that a request over a stated threshold needs a manager's approval. That number is **fixture data**, never assumed to be an enterprise policy. The tests cover below/equal/above threshold, missing amount, wrong currency, unauthorized actor, cross-tenant access, duplicate intent, lost response, and source revision conflict. The same task must be usable from the FDE Studio, a Context Profile, a scoped MCP client, and the native Agent Runtime.
