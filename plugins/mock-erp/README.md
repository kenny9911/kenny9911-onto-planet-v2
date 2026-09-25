# Mock ERP plugin example

This example manifest requests `inventory:read` for `function.lookup` and `inventory:write` for `action.reserve`, and references two reusable skill versions. Requests grant no authority by themselves. The platform must intersect them with published capabilities and tenant policy before a tool is exposed.

`mock-adapter.js` returns deterministic local stock lookups and reservation previews. It has no connector `execute` method and does not contact or change an ERP. A production operator must use ActionGateway for intent creation, policy, approval, execution, verification, and reconciliation.

The manifest carries an Ed25519 signature over the registry's `ontoplanet-json-v1` canonical payload. `public-key.pem` is an example trust key for tests. A real deployment needs a managed trust store, key rotation, artifact provenance, and package integrity checks. The private key used to sign this example is not included.
