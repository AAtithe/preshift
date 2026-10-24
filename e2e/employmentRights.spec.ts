import { expect, test, type Page } from '@playwright/test';

// Employment rights in the browser: a GM sees who would be owed guaranteed hours on the hours they
// work, makes an offer, gets the letter and records the answer. It changes data and acts as a demo
// person, which only a local development build allows, so it never runs against a deployed site.

test.skip(!!process.env.PRESHIFT_E2E_URL, 'Records an offer and switches demo people: runs against the local demo only');

const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });

async function signIn(page: Page) {
  await page.goto('/login?next=/app/');
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill(process.env.PRESHIFT_E2E_EMAIL ?? 'dev@preshift.local');
  await form.locator('input[name=password]').fill(process.env.PRESHIFT_E2E_PASSWORD ?? 'preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(bar(page)).toBeVisible();
}

test('a GM makes a guaranteed hours offer, gets the letter and records the answer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
  await page.evaluate(() => localStorage.setItem('preshift.demoKey', 'dev-usr_gm_mar'));
  await page.goto('/app/?view=rights&site=mar');
  await expect(bar(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Guaranteed hours' })).toBeVisible();

  const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: 'Make an offer' }) }).first();
  const person = (await row.locator('td').first().innerText()).trim();
  await row.getByRole('button', { name: 'Make an offer' }).click();
  await page.getByRole('button', { name: 'Record the offer' }).click();
  await expect(page.locator('pre.letter')).toContainText(`Dear ${person.split(' ')[0]},`);
  await expect(page.locator('pre.letter')).toContainText('You do not have to accept');

  const offer = page.getByRole('row').filter({ hasText: person }).filter({ hasText: 'Waiting' });
  await offer.getByRole('button', { name: 'Declined' }).click();
  await expect(page.getByRole('row').filter({ hasText: person }).filter({ hasText: 'Declined' })).toBeVisible();
  expect(errors).toEqual([]);
});
