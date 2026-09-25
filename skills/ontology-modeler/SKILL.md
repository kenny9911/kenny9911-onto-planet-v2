# Ontology modeler

Use this skill to draft a versioned enterprise ontology from business questions and source-system evidence. The skill supplies a workflow and grants no access to data or systems.

1. Capture the business decisions, actors, terms, and examples. Mark every claim as observed, inferred, or unresolved.
2. Inventory source references for each term. Record system, resource, field, ownership, refresh pattern, and known data-quality limits. Do not copy credentials or private sample records into the ontology.
3. Define value types, shared properties, object types with stable keys, relations with cardinality, and interfaces. Keep IDs stable even when display names change.
4. Model pure functions separately from actions with side effects. For each action, identify the target system and operation, input and output, risk, approval mode, guards, and policy attachment.
5. Validate references, key uniqueness, relation endpoints, interface conformance, and finite guards. Treat missing facts as unresolved; never turn them into an allow decision.
6. Produce a draft bundle, evidence map, assumptions, and unresolved decisions for review. A published release requires independent validation and an explicit release manifest.
