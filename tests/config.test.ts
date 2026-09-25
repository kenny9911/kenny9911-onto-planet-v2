import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfig } from '../apps/api/src/config.js';

test('production configuration requires a setup token and keeps private source grants explicit', () => {
  const env = {
    DATABASE_URL: 'postgres://fixture@localhost/fixture',
    NODE_ENV: 'production',
    APP_ORIGIN: 'https://onto.example.test',
  };
  assert.throws(() => readConfig(env), /SETUP_TOKEN is required/);
  const config = readConfig({ ...env, SETUP_TOKEN: 'fixture-only-setup-token', OPERATOR_ALLOWED_ORIGINS: 'https://erp.internal.test' });
  assert.equal(config.allowLocalSandbox, false);
  assert.deepEqual(config.operatorOrigins, ['https://erp.internal.test']);
  assert.deepEqual(config.operatorPrivateOrigins, []);
  assert.deepEqual(readConfig({ ...env, SETUP_TOKEN: 'fixture-only-setup-token', OPERATOR_ALLOWED_PRIVATE_ORIGINS: ' https://erp.internal.test ' }).operatorPrivateOrigins, ['https://erp.internal.test']);
});
