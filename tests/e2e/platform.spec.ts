import { expect, test } from '@playwright/test';

const admin = { email: 'e2e-admin@example.test', password: 'e2e-admin-password-2026' };
const operator = { email: 'e2e-operator@example.test', password: 'e2e-operator-password-2026' };

test('Studio completes an independently approved source action and remains usable on mobile', async ({ page, browser }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await test.step('Create an isolated workspace with the sandbox ontology', async () => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Create your workspace' })).toBeVisible();
    await page.getByLabel('Full name').fill('E2E Administrator');
    await page.getByLabel('Workspace name').fill('E2E verification');
    await page.getByLabel('Email address').fill(admin.email);
    await page.getByLabel('Password').fill(admin.password);
    await page.getByRole('button', { name: 'Create workspace' }).click();
    await expect(page.getByRole('heading', { name: 'Operational ontology' })).toBeVisible();
    await expect(page.getByText('Procurement operations', { exact: true }).first()).toBeVisible();
  });

  await test.step('Create a separate operator account', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const addUser = page.getByRole('heading', { name: 'Add user' }).locator('..');
    await addUser.getByLabel('Name', { exact: true }).fill('E2E Operator');
    await addUser.getByLabel('Email', { exact: true }).fill(operator.email);
    await addUser.getByLabel('Password', { exact: true }).fill(operator.password);
    await addUser.getByLabel('Role', { exact: true }).selectOption('operator');
    await addUser.getByRole('button', { name: 'Add user' }).click();
    await expect(page.getByText(operator.email)).toBeVisible();
    const ownEntry = page.locator('.user-entry').filter({ hasText: admin.email });
    await expect(ownEntry.getByRole('button', { name: 'Disable user' })).toBeDisabled();
    const operatorEntry = page.locator('.user-entry').filter({ hasText: operator.email });
    await expect(operatorEntry.getByRole('button', { name: 'Disable user' })).toBeEnabled();
  });

  await test.step('Create and revoke a personal API token', async () => {
    const tokenForm = page.getByRole('heading', { name: 'Create scoped token' }).locator('..');
    await tokenForm.getByLabel('Name').fill('E2E read client');
    await tokenForm.getByLabel('Scopes, comma separated').fill('read');
    await tokenForm.getByRole('button', { name: 'Create token' }).click();
    const tokenEntry = page.locator('.token-entry').filter({ hasText: 'E2E read client' });
    await expect(tokenEntry).toContainText('Active');
    await tokenEntry.getByRole('button', { name: 'Revoke token' }).click();
    await expect(tokenEntry).toContainText('Revoked');
    await expect(tokenEntry.getByRole('button', { name: 'Revoke token' })).toBeDisabled();
  });

  await test.step('Start an action that requires independent approval', async () => {
    await page.getByRole('button', { name: 'Task runner', exact: true }).click();
    await page.locator('.task-examples').getByRole('button', { name: 'Approve PO-2026-001', exact: true }).click();
    await expect(page.getByLabel('Task instructions')).toHaveValue(/Approve PO-2026-001/);
    await page.getByRole('button', { name: 'Start run' }).click();
    await expect(page.getByRole('heading', { name: 'Run status' })).toBeVisible();
    await expect(page.locator('.result-panel .status')).toContainText(/approval required/i, { timeout: 35_000 });
    await page.getByRole('button', { name: /^Approvals/ }).click();
    await expect(page.getByText('You initiated this action. A different authorized operator must review it.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve exact intent' })).toHaveCount(0);
  });

  const operatorContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4160' });
  const operatorPage = await operatorContext.newPage();
  operatorPage.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await test.step('Approve the exact intent from the second account', async () => {
      await operatorPage.goto('/');
      await expect(operatorPage.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
      await operatorPage.getByLabel('Email address').fill(operator.email);
      await operatorPage.getByLabel('Password').fill(operator.password);
      await operatorPage.getByRole('button', { name: 'Sign in' }).click();
      await expect(operatorPage.getByRole('heading', { name: 'Operational ontology' })).toBeVisible();
      await operatorPage.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(operatorPage.getByRole('heading', { name: 'Your API tokens' })).toBeVisible();
      await expect(operatorPage.getByRole('heading', { name: 'Users', exact: true })).toHaveCount(0);
      await expect(operatorPage.getByText('E2E read client')).toHaveCount(0);
      await operatorPage.getByRole('button', { name: /^Approvals/ }).click();
      await expect(operatorPage.getByRole('button', { name: 'Approve exact intent' })).toBeVisible();
      await operatorPage.getByLabel('Reason or review note').fill('Independent review of the exact purchase order intent.');
      await operatorPage.getByRole('button', { name: 'Approve exact intent' }).click();
      await expect(operatorPage.getByText('Approval approved')).toBeVisible();
    });
  } finally { await operatorContext.close(); }

  await test.step('Verify the run and source-backed object in Studio', async () => {
    await page.getByRole('button', { name: 'Runs and traces', exact: true }).click();
    await expect(page.locator('.run-detail .status')).toContainText(/completed/i, { timeout: 35_000 });
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Cancel run', exact: true })).toBeDisabled();
    await expect(page.getByRole('heading', { name: 'Execution events' })).toBeVisible();
    await page.getByRole('button', { name: 'Objects', exact: true }).click();
    await page.locator('.table-panel').getByRole('button', { name: /^PO-2026-001/ }).click();
    await expect(page.locator('.object-detail-grid .json-inspector')).toContainText('"status": "APPROVED"');
  });

  const mobileContext = await browser.newContext({
    baseURL: 'http://127.0.0.1:4160',
    storageState: await page.context().storageState(),
    viewport: { width: 320, height: 780 },
    isMobile: true,
    hasTouch: true,
  });
  const mobilePage = await mobileContext.newPage();
  mobilePage.on('pageerror', (error) => pageErrors.push(error.message));
  try {
    await test.step('Check mobile navigation and horizontal fit', async () => {
      await mobilePage.goto('/#overview');
      await expect(mobilePage.getByRole('heading', { name: 'Operational ontology' })).toBeVisible();
      const fits = () => mobilePage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
      expect(await fits()).toBe(true);
      await mobilePage.getByRole('button', { name: 'Open navigation' }).click();
      await expect(mobilePage.locator('aside.sidebar')).toHaveClass(/sidebar-open/);
      await mobilePage.locator('aside.sidebar').getByRole('button', { name: 'Ontology', exact: true }).click();
      await expect(mobilePage.getByRole('heading', { name: 'Ontology', exact: true })).toBeVisible();
      expect(await fits()).toBe(true);
      await expect(mobilePage.getByRole('button', { name: 'Open navigation' })).toBeVisible();
      await mobilePage.getByRole('button', { name: 'Open navigation' }).click();
      await mobilePage.locator('aside.sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(mobilePage.getByRole('heading', { name: 'Your API tokens' })).toBeVisible();
      expect(await fits()).toBe(true);
    });
  } finally { await mobileContext.close(); }

  expect(pageErrors).toEqual([]);
});
