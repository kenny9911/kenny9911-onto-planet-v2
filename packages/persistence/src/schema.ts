/** Idempotent schema installation for a new deployment; run via `pnpm db:migrate`. */
export const schema = `
CREATE TABLE IF NOT EXISTS tenants (id text PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS users (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), name text NOT NULL,
 email text NOT NULL UNIQUE, password_hash text, role text NOT NULL CHECK(role IN ('admin','builder','operator','viewer')),
 oidc_subject text UNIQUE, active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), csrf_hash text NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS api_tokens (
 id text PRIMARY KEY, token_hash text NOT NULL UNIQUE, tenant_id text NOT NULL REFERENCES tenants(id),
 user_id text NOT NULL REFERENCES users(id), name text NOT NULL, scopes jsonb NOT NULL,
 expires_at timestamptz NOT NULL, revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS resources (
 tenant_id text NOT NULL REFERENCES tenants(id), kind text NOT NULL, id text NOT NULL,
 name text NOT NULL, state text NOT NULL DEFAULT 'draft', revision integer NOT NULL DEFAULT 1,
 data jsonb NOT NULL, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,kind,id)
);
CREATE INDEX IF NOT EXISTS resources_kind_idx ON resources(tenant_id,kind,updated_at DESC);
CREATE TABLE IF NOT EXISTS audit_events (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), actor_id text NOT NULL,
 kind text NOT NULL, subject_id text NOT NULL, details jsonb NOT NULL DEFAULT '{}', at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_tenant_idx ON audit_events(tenant_id,at DESC);
CREATE TABLE IF NOT EXISTS action_intents (
 tenant_id text NOT NULL, idempotency_key text NOT NULL, id text NOT NULL UNIQUE,
 version integer NOT NULL, record jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,idempotency_key)
);
CREATE TABLE IF NOT EXISTS run_checkpoints (
 run_id text PRIMARY KEY, tenant_id text NOT NULL, actor_id text NOT NULL, state text NOT NULL,
 record jsonb NOT NULL, claim_token text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
 id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES tenants(id), actor_id text NOT NULL, kind text NOT NULL,
 state text NOT NULL DEFAULT 'queued', payload jsonb NOT NULL, attempt integer NOT NULL DEFAULT 0,
 lease_token text, lease_until timestamptz, worker_id text, error text,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(state,created_at);
CREATE TABLE IF NOT EXISTS worker_heartbeats (id text PRIMARY KEY, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS oidc_states (state_hash text PRIMARY KEY, verifier text NOT NULL, nonce text NOT NULL, expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS auth_attempts (key text PRIMARY KEY, count integer NOT NULL DEFAULT 0, window_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources FORCE ROW LEVEL SECURITY;
ALTER TABLE action_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='resources' AND policyname='tenant_boundary') THEN
  CREATE POLICY tenant_boundary ON resources USING (tenant_id = current_setting('onto.tenant_id',true)) WITH CHECK (tenant_id = current_setting('onto.tenant_id',true));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='action_intents' AND policyname='tenant_boundary') THEN
  CREATE POLICY tenant_boundary ON action_intents USING (tenant_id = current_setting('onto.tenant_id',true)) WITH CHECK (tenant_id = current_setting('onto.tenant_id',true));
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='audit_events' AND policyname='tenant_boundary') THEN
  CREATE POLICY tenant_boundary ON audit_events USING (tenant_id = current_setting('onto.tenant_id',true)) WITH CHECK (tenant_id = current_setting('onto.tenant_id',true));
 END IF;
END $$;
`;
