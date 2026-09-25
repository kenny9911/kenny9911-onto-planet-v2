# Procurement source sandbox

This is a separate HTTP business system with dedicated PostgreSQL `source_records` and `source_operations` tables. It implements the platform HTTP source contract without sharing ontology projection tables. Every endpoint requires the configured bearer token and the fixed sandbox tenant header.

`PgSourcePersistence.approve` serializes duplicate operation keys, locks the target row, compares its revision, applies the sample procurement rules, and stores the effect and receipt in one database transaction. Six sample purchase orders are seeded idempotently; the order above the sample approval ceiling is intentionally denied.

Run the compiled `src/main.ts` entry with `DATABASE_URL`, `SOURCE_SANDBOX_TOKEN` (at least 16 characters), and optional `SOURCE_TENANT_ID` (default `default`), `SOURCE_HOST` (default `127.0.0.1`) and `SOURCE_PORT` (default `4200`). Use a separate token and database role for real deployments. This service represents a local test source, not an ERP product integration.
