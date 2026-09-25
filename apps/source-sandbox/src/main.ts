import { Pool } from 'pg';
import { createSourceSandbox, PgSourcePersistence } from './index.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const persistence = new PgSourcePersistence(pool);
await persistence.migrate();
const tenantId = process.env.SOURCE_TENANT_ID ?? 'default';
await persistence.seed(tenantId);
const server = createSourceSandbox({ persistence, tenantId, token: process.env.SOURCE_SANDBOX_TOKEN ?? '' });
server.listen(Number(process.env.SOURCE_PORT ?? 4200), process.env.SOURCE_HOST ?? '127.0.0.1', () => console.log('Source sandbox listening'));
let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  // The supervisor and process group can both signal the same child. Drain HTTP
  // requests before ending their shared pool, exactly once across both signals.
  return shutdownPromise ??= new Promise<void>((resolve) => server.close(() => resolve()))
    .then(() => pool.end())
    .catch((error: unknown) => { console.error('Source sandbox shutdown failed:', error); process.exitCode = 1; });
}
for (const event of ['SIGINT', 'SIGTERM'] as const) process.on(event, () => { void shutdown(); });
