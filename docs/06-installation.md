# Install and use v0.2

This release runs a shared Studio/API, PostgreSQL storage, a job worker, and an independent HTTP source sandbox. Local verification uses the deterministic procurement planner. Real provider, identity-provider and customer source integrations are configurable seams awaiting deployment-specific validation.

## Native local installation

Requirements: Node.js 24 or newer, pnpm 9.15.0, and PostgreSQL 17 or 18 command-line/server binaries. The setup script searches standard Homebrew/Linux installation directories; set `POSTGRES_BIN` to another installed PostgreSQL `bin` directory if needed. Do not run `initdb` as the operating-system root user.

```sh
pnpm install --frozen-lockfile
pnpm setup:local
pnpm build
pnpm start
```

`setup:local` creates an isolated PostgreSQL cluster at `.local/postgres`, listening on `127.0.0.1:55432`, with separate `onto_planet` and `onto_planet_test` databases. Random database/source credentials are stored in `.local/database.json` with restricted permissions. Existing PostgreSQL services are not reconfigured. These files are ignored by Git.

`pnpm start` starts the source sandbox and API in the default sandbox mode. The API embeds a worker unless `EMBED_WORKER=false`. The Studio is served at [http://localhost:4100](http://localhost:4100); the source service listens on `127.0.0.1:4200`. Stop application processes with Ctrl+C. Stop the isolated database separately with `pnpm db:stop`; rerun `pnpm setup:local` to start it again.

The local launcher reads generated `.local` settings and inherited environment variables. An explicitly exported `DATABASE_URL` overrides the generated application connection; `TEST_DATABASE_URL` selects an external test database. The Docker `.env` file is not automatically loaded by the native launcher. Export native configuration before running the commands.

## Docker installation

With Docker Engine/Compose running:

```sh
node scripts/configure-docker.mjs
docker compose up --build -d
docker compose ps
```

The configuration script writes random credentials and `SETUP_TOKEN` to a private `.env` file. It refuses to overwrite an existing `.env`; review an existing configuration manually. Compose starts PostgreSQL, the API/Studio, a separate worker, and the source sandbox. Only the Studio/API port is exposed, bound to `127.0.0.1:4100`; the database and source communicate on the Compose network.

Open [http://localhost:4100](http://localhost:4100). Enter the generated `SETUP_TOKEN` from `.env` during first-admin setup. The database volume persists across `docker compose down`; deleting the volume deletes the installation's records. The Docker image and all four services have been started and health-checked locally; the full approval/receipt workflow is also verified against native PostgreSQL and HTTP.

## First workspace and approval walkthrough

1. Create the first administrator with a workspace name, email, and a password of at least 12 characters. Enter a setup token when the installation requests it. Docker sets one; native local mode requests one only when `SETUP_TOKEN` is exported.
2. Setup installs the explicitly labelled procurement sample: reviewed ontology, source bindings, context profile, Skills, agent, application, deterministic evaluation cases, and an active release. The source sandbox owns six independent purchase orders.
3. In **Settings**, add a second account with the **operator** role. Use a separate browser profile/private window for that account. An actor cannot approve their own exact action intent.
4. In **Connectors**, select the source sandbox and run the read-only connection test. **Refresh source** updates materialized object observations without writing to the source system.
5. In **Task runner**, select **Procurement assistant** and submit `Inspect PO-2026-001`. Then submit `Approve PO-2026-001`.
6. The run pauses for independent approval. In the second account's **Approvals**, inspect the exact summary/effects and approve or reject it. Approval queues the original actor's continuation with the original invocation scopes intersected with current grants.
7. In **Runs and traces**, inspect the outcome and audit events. The source receipt/readback confirms approval; **Objects** shows the refreshed materialized observation. `Approve PO-2026-004` demonstrates the sample amount-limit denial.

The sandbox planner recognizes explicit procurement commands. Ambiguous or negative instructions do not become an approval command. General natural-language task planning requires the configured model adapter below.

## Configure a model provider

| Variable | Meaning |
|---|---|
| `MODEL_PROVIDER` | `sandbox` (default), `openai`, or `openai-compatible` |
| `MODEL_ID` | Explicit model identifier, matching the released AgentSpec |
| `MODEL_API_KEY` | Provider credential held by the server |
| `MODEL_BASE_URL` | HTTPS API base; default `https://api.openai.com/v1` |

The OpenAI adapter uses Responses with a strict JSON decision envelope. Compatible endpoints use Chat Completions with a strict JSON schema response format. Tool descriptions/input schemas come from the released ontology, and outputs are validated before tool dispatch. Provider refusals/errors fail the run without granting permissions. See the [adapter contract and official reference](../packages/platform-runtime/README.md#model-providers).

The same configured provider enables model-generated ontology proposals. This path requests JSON and validates the complete proposal schema and source references locally before saving a draft. Generated definitions still require owner review, executable evaluations, and release activation. In `sandbox` mode, proposals use deterministic extraction and explicit review gaps. Provider contract tests use fake HTTP responses; live generation quality is not part of the local acceptance claim.

Change the agent's reviewed `model` fields to match the server provider and model ID, update its referenced resource revisions, then assemble and activate a new release through the normal review/evaluation gates. A server environment change alone does not replace the stored agent pins. The live provider path has contract tests with a fake HTTP response; no real provider request is part of the local acceptance claim.

When using a live model with the local source fixture, start `pnpm source:sandbox` separately: the native `pnpm start` launcher automatically starts the source only in sandbox model mode.

## Enterprise identity

Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, and, when required, `OIDC_CLIENT_SECRET`. Configure the provider redirect URI as `<APP_ORIGIN>/api/auth/oidc/callback`. The issuer must use HTTPS. Use an HTTPS `APP_ORIGIN` behind a configured reverse proxy for an externally exposed deployment. Production startup requires an explicit `APP_ORIGIN` and `SETUP_TOKEN`; keep the setup token in protected server configuration.

Create permitted users and their roles in **Settings** before company sign-in. OIDC validates issuer/audience/signature, state, nonce and PKCE, then matches a verified email to an active preprovisioned user; it does not create arbitrary users or assign roles from an unreviewed external claim. Local users, sessions, CSRF protection, role changes, token scoping and tenant controls are covered by automated tests. A real IdP registration/login remains deployment acceptance work.

## Source systems and operators

An administrator manages connector definitions containing `baseUrl`, `secretRef`, and a versioned action binding. Source URLs must also appear in the server's comma-separated `OPERATOR_ALLOWED_ORIGINS`; a resource record cannot expand the server allowlist. Use `env:VARIABLE_NAME` for connector secret references or `secret://env/VARIABLE_NAME` inside an ActionBinding. The resolved secret is never stored in the ontology or sent to the model.

`SOURCE_SANDBOX_URL` defaults to `http://127.0.0.1:4200` for the seeded connector; `SOURCE_SANDBOX_TOKEN` configures the sample source credential. Docker uses `http://source-sandbox:4200`. The localhost/Docker sandbox exception is explicitly enabled for development. Remote sources require HTTPS and public DNS addresses. An intranet source must appear in both `OPERATOR_ALLOWED_ORIGINS` and the additional comma-separated `OPERATOR_ALLOWED_PRIVATE_ORIGINS` server setting. There is no resource field that bypasses either check; a private-origin grant does not remove authentication or HTTPS requirements.

The HTTP adapter contract includes authenticated `/objects`, `/objects/:id`, `/actions/preview`, `/actions/execute`, `/operations/:key`, and `/health` endpoints. Execution forwards `If-Match` and `Idempotency-Key`, persists source receipts, and verifies declared effect properties. See [runtime/operator details](../packages/platform-runtime/README.md#http-source-contract) and [source sandbox](../apps/source-sandbox/README.md). Existing ERP/CRM products need adapters that meet this contract and tests with the actual sandbox APIs; entering a URL does not establish connector conformance.

## MCP clients and scoped tokens

Create a scoped token in **Settings** and save its value when shown. Tokens expire after 30 days and can be revoked. An MCP client connects to `http://localhost:4100/mcp` in local mode (HTTPS for external hosting), sends `Authorization: Bearer <token>`, and uses Streamable HTTP.

Start with `read` plus `order:read` for the sample lookup. A sample action preview also needs `operate` and `order:write`. The MCP endpoint exposes published pure lookups and governed action previews; it does not execute raw source writes, approve intents, or activate releases. Effective token grants apply to every request. A queued native run preserves the invocation's scope ceiling through worker execution and resume.

The SDK transport/list/call flows and API bearer integration are tested. Specific external office/MCP clients, their UI rendering, and Skills/Tasks extension negotiation require client-specific conformance testing.

## Validation and development

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
```

`pnpm check` builds TypeScript and Studio and runs unit plus database/API/HTTP integration suites. The separate Playwright gate exercises the browser workflow against its own test server. Both require the generated local test database or `TEST_DATABASE_URL`. Suites create their own schemas and remove them afterward; do not point the test connection at a production database. CI runs both gates and installs Chromium with its Linux system dependencies.

```sh
pnpm test:unit
pnpm dev:api
pnpm dev:studio
```

`test:unit` explicitly omits database integration and is not the release gate. Run the two development servers in separate terminals; Studio development uses port 5173. `pnpm worker` runs a separate worker when the API uses `EMBED_WORKER=false`. See the [runbook](runbook.md) before upgrades, backups or recovery.
