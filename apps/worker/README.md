# Durable job worker

`runWorker` consumes an injected lease queue and dispatches to `PlatformRuntime.handleJob`. It refreshes the worker heartbeat and job lease, and completes a job only using its current lease token. Shutdown stops further claims after the current handler settles.

The queue's claim/heartbeat/complete operations must be atomic and durable. A redelivered run that may have reached an external effect is sent to manual recovery rather than replayed. Action reconciliation is a separate, read-only source operation.
