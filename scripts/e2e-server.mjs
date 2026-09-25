import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { localEnvironment } from './environment.mjs';

const root = resolve(import.meta.dirname, '..');
const sourceEntry = resolve(root, 'dist/apps/source-sandbox/src/main.js');
const apiEntry = resolve(root, 'dist/apps/api/src/main.js');
const studioEntry = resolve(root, 'apps/studio/dist/index.html');
const origin = 'http://127.0.0.1:4160';
const sourceOrigin = 'http://127.0.0.1:4260';
const schema = `onto_e2e_${randomUUID().replaceAll('-', '')}`;
const children = [];
const base = localEnvironment(true).DATABASE_URL;
let schemaCreated = false;
let stopping = false;

if (!base) throw new Error('E2E requires TEST_DATABASE_URL or pnpm setup:local.');
for (const entry of [sourceEntry, apiEntry, studioEntry]) {
  if (!existsSync(entry)) throw new Error(`Missing build artifact: ${entry}. Run pnpm build before the browser gate.`);
}

const url = new URL(base);
url.searchParams.set('options', `${url.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim());
const token = randomBytes(32).toString('hex');
const env = {
  ...localEnvironment(true),
  DATABASE_URL: url.toString(),
  APP_ORIGIN: origin,
  PORT: '4160',
  HOST: '127.0.0.1',
  SOURCE_SANDBOX_URL: sourceOrigin,
  SOURCE_PORT: '4260',
  SOURCE_HOST: '127.0.0.1',
  SOURCE_TENANT_ID: 'default',
  SOURCE_SANDBOX_TOKEN: token,
  OPERATOR_ALLOWED_ORIGINS: sourceOrigin,
  MODEL_PROVIDER: 'sandbox',
  MODEL_API_KEY: '',
  MODEL_BASE_URL: '',
  OIDC_ISSUER: '',
  SETUP_TOKEN: '',
  ALLOW_LOCAL_SANDBOX: 'true',
  EMBED_WORKER: 'true',
  NODE_ENV: 'test',
};

async function withDatabase(operation) {
  const client = new pg.Client({ connectionString: base });
  await client.connect();
  try { return await operation(client); }
  finally { await client.end(); }
}

function start(label, entry) {
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(child);
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`${label} exited before the browser gate completed (${code ?? signal}).`);
      process.exitCode = 1;
      void stop();
    }
  });
  return child;
}

async function waitFor(url, headers, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`${url} process stopped during startup`);
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch { /* The service has not bound its port yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${url} did not become ready within 30 seconds`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
}

async function stop() {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled(children.map(stopChild));
  if (schemaCreated) {
    try { await withDatabase((client) => client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)); }
    catch (error) { console.error('Failed to remove E2E schema:', error); process.exitCode = 1; }
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(); });
process.on('uncaughtException', (error) => { console.error(error); process.exitCode = 1; void stop(); });
process.on('unhandledRejection', (error) => { console.error(error); process.exitCode = 1; void stop(); });

try {
  await withDatabase((client) => client.query(`CREATE SCHEMA ${schema}`));
  schemaCreated = true;
  const source = start('Source sandbox', sourceEntry);
  await waitFor(`${sourceOrigin}/health`, { authorization: `Bearer ${token}`, 'x-tenant-id': 'default' }, source);
  const api = start('API', apiEntry);
  await waitFor(`${origin}/health`, {}, api);
  console.log(`E2E workspace ready at ${origin} in isolated schema ${schema}.`);
} catch (error) {
  console.error('E2E workspace startup failed:', error);
  process.exitCode = 1;
  await stop();
}
