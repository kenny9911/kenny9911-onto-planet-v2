# Enterprise operator design

Use this skill when mapping an ontology action to a system operation. It defines a design checklist and grants no execution authority.

1. Identify the exact business action, target record, source system, owning team, and minimum scopes. Distinguish a read from a write.
2. Define typed input, expected state change, preconditions, and a non-mutating preview that shows the intended effect and policy decision.
3. Define a stable idempotency key and the evidence needed for a human approval bound to the exact action intent. Changes to arguments require a new approval.
4. Define connector `execute`, independent `verify`, and `reconcile` behavior. An accepted request is not proof of success; an unknown outcome must be reconciled before any retry.
5. Record audit events with tenant, actor, ontology release, action ID, intent hash, approval evidence, and external receipt. Keep secrets and sensitive payloads out of logs.
6. Include tests for denial, approval, duplicate requests, timeouts, uncertain outcomes, and source-system verification before publishing the operator.
