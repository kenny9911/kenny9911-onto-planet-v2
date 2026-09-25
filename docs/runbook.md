# v0.2 operating runbook

This runbook covers the included PostgreSQL, API/Studio, worker, and HTTP source sandbox. It describes the current recovery boundaries; it is not evidence of a completed production resilience or disaster-recovery program.

## Health and normal startup

For native local use, run `pnpm setup:local`, `pnpm build`, then `pnpm start`. The application serves `http://localhost:4100`; `/health` checks the database. The authenticated Studio health view also reports a recent worker heartbeat. `/health` alone does not prove that a worker, model provider, or source connector can complete a task.

For Docker, use `docker compose up --build -d` and `docker compose ps`. Inspect `docker compose logs api worker source-sandbox` when a service is unhealthy. Native child-process output appears in the launching terminal; database output is in `.local/postgres.log`. API failures include an `x-request-id` response header so a failed request can be matched to its server log.

Use the connector test for authenticated read-only reachability and source capability declarations. Use a sample run with a separate approver to exercise the full write/receipt path. A connection test does not prove conditional-write or idempotency semantics for an unfamiliar ERP.

## Migrations and upgrades

`pnpm db:migrate` applies the application's versioned schema installer to the configured database. API startup also ensures the required schema is installed. The source sandbox installs its separate record/operation tables when it starts. Run migrations with an explicitly selected connection and review new migration code before using it with existing data.

Before updating an installation, retain the current release artifact, database backup and server configuration. Stop new work, let running jobs settle where possible, build the new code, apply its documented migrations, and restart. Keep the source credential and API origin configuration consistent with the deployed release. Source writes that occurred before an upgrade remain real; reverting an application image or ontology release does not reverse them.

Activation checks the reviewed ontology, resource revisions, manifest hashes and evaluation evidence. Editing a pinned connector/agent/context resource requires assembling another reviewed release. The active manifest contains immutable snapshots; a draft edit does not silently change a running agent's definitions.

## Backup and restore

Back up the PostgreSQL database and protected server configuration. The database contains definitions, users, sessions/tokens, jobs, checkpoints, audit, action intents, and the sandbox's separate business/operation tables. The credentials in `.env` or `.local/database.json` are not a substitute for a database backup.

For Docker, a conventional logical backup can be created with:

```sh
docker compose exec -T database pg_dump -U onto_admin -d onto_planet -Fc > /secure/backup/onto-planet.dump
```

For a native or managed database, use `pg_dump`/`pg_restore` with the configured connection and an approved credential mechanism. Keep backups outside the repository, restrict access, and record the application/schema version. Restore into a separate database first, verify login, active manifest hashes, source receipts, and suspended runs, then follow the deployment's cutover procedure. Restore rehearsal, retention, encrypted off-site backup, RPO/RTO and regional failover are deployment responsibilities not verified by the local suite.

For a real external source system, restoring an older platform backup does not restore that source. Reconcile source operation IDs/idempotency keys before accepting any task whose external outcome might have changed after the backup. Never clear operation history to force a retry.

## Worker restart and job leases

The worker claims jobs with an atomic lease token, renews the lease, and completes only the lease it owns. Suspended runs use durable server-side checkpoints. Normal approval/reconciliation continuations can resume after a process restart.

A worker can disappear after an external system commits but before a checkpoint is saved. A redelivered job already marked running is moved to `manual_recovery`; it does not repeat the model plan or external write. Inspect the run trace and its action intents. The current implementation deliberately does not reconstruct an arbitrary interrupted plan automatically.

If the API is healthy but runs remain queued, check worker health, process logs, database access, and `EMBED_WORKER`. Use either the embedded worker or the separate worker entry as intended. Multiple workers share the leased queue. Avoid running competing native and Docker installations against the same unintended database.

## Action and run recovery

| State | Operator response |
|---|---|
| `approval_required` / `awaiting_approval` | Another authorized actor reviews the exact intent. Approval is hash-bound and expires with the run/policy window. |
| `denied` / `failed` | Inspect deterministic policy/source evidence. Fix the definition, grant, source state or task input through its owner; create a new reviewed task when appropriate. |
| `unknown` | Use **Reconcile** to query the source by original idempotency key/receipt. Do not create a replacement write until the source outcome is understood. |
| `executing` / `verifying` | Allow the current attempt to settle. After a stale execution lease, reconciliation can inspect the original operation without re-executing it. |
| `manual_recovery` | Inspect source and action records. Reconcile any known effect. A run lacking a safely resumable checkpoint needs an explicit new task after the outcome is resolved; there is no “force replay” control. |
| `cancelled_pending_reconciliation` | Stop further task effects and resolve the already-dispatched source operation. Cancellation cannot undo a source commit. |

An expired run with an uncertain action retains a read-only status route. Once reconciliation produces a definitive outcome, the record can resolve without another tool execution. Approval expiry never becomes permission to retry.

Successful source verification refreshes the materialized object projection. If that refresh fails, the source receipt remains authoritative and the audit records the projection problem. Use **Connectors → Refresh source** after connectivity is restored. Existing object ACLs and links are preserved; newly discovered records default to administrator access until disclosure policy is reviewed. Context freshness derives from observation timestamps, not from the assumption that a successful HTTP call means all projections are current.

## Identity and access operations

Administrators create users, change roles and deactivate accounts in **Settings**. Session and role checks apply to API calls; worker runs re-read current actor grants and intersect them with the original invocation scopes. Changing a role cannot enlarge a token's original scope ceiling. Revoke compromised API tokens and rotate their replacement credentials through the owning configuration.

Independent approval requires a different currently authorized person. Do not share an administrator login to simulate independence. Use the preprovisioned-user procedure in [installation](06-installation.md#enterprise-identity) before enabling OIDC. The real enterprise IdP and its lifecycle processes need separate testing.

Connector credentials are server-side references, and approved origins come from server configuration. Do not put credentials in resource JSON, Skills, prompts, release manifests or repository files. When rotating a source credential, update the server secret value and the source system together, then rerun the read-only connection test and an approved acceptance task.

## Current operational limits

- The default planner and source are explicit procurement sandbox fixtures. Live model, ERP/CRM/MRP and IdP behavior is not covered by local verification.
- Jobs/checkpoints/receipts are durable, but crash recovery does not automatically rebuild an interrupted model plan. There is no completed HA, load, chaos or disaster-recovery certification.
- Objects are materialized observations with explicit refresh, not a CDC or live federated query service.
- Plugin management validates manifests/signatures/grants; arbitrary plugin execution, a browser/UI operator, cross-system sagas and autonomous AI-FDE are not enabled.
- Evaluations are deterministic cases and release checks. Statistical agent holdouts, provider quality/cost/latency benchmarking and broad external-client compatibility remain future work.
- Deployment still needs its own TLS/network perimeter, customer acceptance, data retention/classification, monitoring, backup and source conformance decisions.

Run `pnpm check`, then `pnpm test:e2e`, against the isolated test database after code/configuration changes. Install the browser once with `pnpm exec playwright install chromium`; CI installs Chromium and runs both gates. `pnpm test:unit` is useful for a fast subset but does not establish complete delivery readiness.
