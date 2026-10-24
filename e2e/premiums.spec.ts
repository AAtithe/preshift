import { expect, test, type Page } from '@playwright/test';

// Pay premiums in the browser: only the finance director can change them, and a premium added on
// the Pay screen is listed in plain English. It changes data and acts as demo people, which only a
// local development build allows, so it never runs against a deployed site. It removes what it adds.

test.skip(!!process.env.PRESHIFT_E2E_URL, 'Changes pay rules and switches demo people: runs against the local demo only');

const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });

async function signIn(page: Page) {
  await page.goto('/login?next=/app/');
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill(process.env.PRESHIFT_E2E_EMAIL ?? 'dev@preshift.local');
  await form.locator('input[name=password]').fill(process.env.PRESHIFT_E2E_PASSWORD ?? 'preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(bar(page)).toBeVisible();
}

async function actAs(page: Page, userId: string, path: string) {
  await page.evaluate((key) => localStorage.setItem('preshift.demoKey', key), `dev-${userId}`);
  await page.goto(path);
  await expect(bar(page)).toBeVisible();
}

test('the finance director adds a Sunday premium and others see it but cannot change it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const name = `Sunday ${Math.floor(Math.random() * 1e6)}`;
  await signIn(page);

  await actAs(page, 'usr_fd', '/app/?view=pay');
  const panel = page.locator('.premiums');
  await expect(panel.getByRole('heading', { name: 'Pay premiums' })).toBeVisible();
  const company = panel.locator('.premium-company').first();
  await company.getByRole('button', { name: 'Add a premium' }).click();
  await company.getByLabel('Name').fill(name);
  await company.getByRole('button', { name: 'Save premium' }).click();
  const line = company.locator('li').filter({ hasText: name });
  await expect(line).toContainText('Time and a half on Sundays');

  // The people manager sees the rule but has no way to change it.
  await actAs(page, 'usr_people', '/app/?view=pay');
  await expect(page.locator('.premiums li').filter({ hasText: name })).toBeVisible();
  await expect(page.locator('.premiums').getByRole('button', { name: 'Add a premium' })).toHaveCount(0);

  // Leave the demo as it was.
  await actAs(page, 'usr_fd', '/app/?view=pay');
  await page.locator('.premiums li').filter({ hasText: name }).getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('.premiums li').filter({ hasText: name })).toHaveCount(0);
  expect(errors).toEqual([]);
});
