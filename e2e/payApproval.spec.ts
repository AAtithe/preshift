import { expect, test, type Page } from '@playwright/test';

// The two-person pay control end to end in the browser: the people manager proposes a rise, it
// waits with the pay in force unchanged, the finance director approves it, and the new rate is on
// the person's record. It changes data and acts as two demo people, which only a local
// development build allows, so it never runs against a deployed site.

test.skip(!!process.env.PRESHIFT_E2E_URL, 'Changes pay and switches demo people: runs against the local demo only');

const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });
// Shoreditch: the iPad checks move shifts on Marylebone's rota at the same time, so this keeps clear of it.
const PERSON = 'Josh Turner';

async function signIn(page: Page) {
  await page.goto('/login?next=/app/');
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill(process.env.PRESHIFT_E2E_EMAIL ?? 'dev@preshift.local');
  await form.locator('input[name=password]').fill(process.env.PRESHIFT_E2E_PASSWORD ?? 'preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(bar(page)).toBeVisible();
}

/** Acts as one of the demo people, as the demo's person switcher does. */
async function actAs(page: Page, userId: string, path: string) {
  await page.evaluate((key) => localStorage.setItem('preshift.demoKey', key), `dev-${userId}`);
  await page.goto(path);
  await expect(bar(page)).toBeVisible();
}

test('a rise proposed by the people manager waits, then applies when the finance director approves it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // A rate no earlier run has used, so the proposal is always a change.
  const rate = (14 + Math.floor(Math.random() * 90) / 100).toFixed(2);
  await signIn(page);

  // Kate Morgan, people manager, proposes the rise from the Staff list.
  await actAs(page, 'usr_people', '/app/?view=people&site=shd');
  await page.getByRole('row').filter({ hasText: PERSON }).first().click();
  const editor = page.locator('.modal');
  const rateInput = editor.getByLabel('Hourly rate (£)');
  const before = await rateInput.inputValue();
  await rateInput.fill(rate);
  await editor.getByLabel('Reason for the change (finance sees this)').fill('Took on the bar lead role');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(editor).toBeHidden();

  // The pay in force has not moved: reopening shows the old rate and the waiting proposal.
  await page.getByRole('row').filter({ hasText: PERSON }).first().click();
  await expect(editor.getByText(`£${rate} an hour`)).toBeVisible();
  await expect(editor.getByLabel('Hourly rate (£)')).toHaveValue(before);
  await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } });
  await expect(editor).toBeHidden();

  // Nadia Rahman, finance director, sees it with its full cost and approves it.
  await actAs(page, 'usr_fd', '/app/?view=pay');
  const row = page.getByRole('row').filter({ hasText: PERSON }).filter({ hasText: `£${rate}/h` });
  await expect(row).toBeVisible();
  await expect(row.getByText('Took on the bar lead role')).toBeVisible();
  page.once('dialog', (d) => void d.accept('In the bar budget'));
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(`${PERSON} is now on £${rate}/h. Payroll has been told.`)).toBeVisible();

  // The pay history shows the decision, and the record carries the new rate.
  await expect(page.getByRole('row').filter({ hasText: PERSON }).filter({ hasText: 'Nadia Rahman' }).filter({ hasText: 'In the bar budget' }).first()).toBeVisible();
  await page.evaluate(() => localStorage.removeItem('preshift.demoKey'));
  await page.goto('/app/?view=people&site=shd');
  await page.getByRole('row').filter({ hasText: PERSON }).first().click();
  await expect(page.locator('.modal').getByLabel('Hourly rate (£)')).toHaveValue(String(Number(rate)));
  expect(errors).toEqual([]);
});
