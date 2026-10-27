import { expect, test, type Page } from './fixtures';

// Building the By person rota: what is on each day along the top, a note on a day, cover against
// demand under each day, and a shift type pasted onto a person and day. It writes a note and adds a
// shift, which only a local development build allows, so it never runs against a deployed site. It
// takes both back when it is done.

test.skip(!!process.env.PRESHIFT_E2E_URL, 'Adds a shift and a note: runs against the local demo only');

const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });

async function openByPerson(page: Page) {
  await page.goto('/login?next=/app/');
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill('dev@preshift.local');
  await form.locator('input[name=password]').fill('preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(bar(page)).toBeVisible();
  await page.getByRole('button', { name: 'Site or company' }).click();
  await page.locator('.sp-option').filter({ has: page.locator('.sp-name').getByText('Marylebone', { exact: true }) }).click();
  await bar(page).locator('[data-group="planning"] .nav-toggle').click();
  await bar(page).getByRole('button', { name: 'Rota', exact: true }).click();
  await page.getByRole('tab', { name: 'By person' }).click();
  await expect(page.locator('table.rota')).toBeVisible();
}

test('the week, its notes and cover sit on the rota, and a shift type pastes onto a person and day', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openByPerson(page);

  // Seven days along the top, and cover against demand under each day of the grid.
  await expect(page.locator('.week-strip .ws-day')).toHaveCount(7);
  await expect(page.locator('table.rota .cover-bars')).toHaveCount(7);

  // A note on the last day of the week, then taken off again.
  const sunday = page.locator('.week-strip .ws-day').last();
  await sunday.hover();
  await sunday.getByRole('button', { name: /Add a note/ }).click();
  await sunday.getByRole('textbox').fill('Road closed for the half marathon until noon.');
  await sunday.getByRole('button', { name: 'Save' }).click();
  await expect(sunday.locator('.ws-note')).toHaveText('Road closed for the half marathon until noon.');
  await sunday.locator('.ws-note').click();
  await sunday.getByRole('textbox').fill('');
  await sunday.getByRole('button', { name: 'Save' }).click();
  await expect(sunday.locator('.ws-note')).toHaveCount(0);

  // Pick a shift type, paste it into an empty cell, and the shift is there.
  await page.locator('.type-pick select').selectOption({ index: 1 });
  await expect(page.locator('.clip-bar')).toBeVisible();
  // The last day of the week: a day gone may already be worked, and a worked shift cannot be removed.
  const last = await page.locator('table.rota td[data-emp]').last().getAttribute('data-date');
  const cell = page.locator(`table.rota td[data-emp][data-date="${last}"]:not(.leave)`).filter({ hasNot: page.locator('.chip') }).filter({ has: page.locator('button.paste') }).first();
  const emp = await cell.getAttribute('data-emp');
  const date = await cell.getAttribute('data-date');
  const target = page.locator(`table.rota td[data-emp="${emp}"][data-date="${date}"]`);
  await target.getByRole('button', { name: /Paste/ }).click();
  // A paste refused by availability says why instead; either way the page stays whole.
  const pasted = target.locator('.chip');
  const refused = page.getByText(/Not pasted\./);
  await expect(pasted.or(refused).first()).toBeVisible();
  if (process.env.PRESHIFT_E2E_SHOTS) await page.screenshot({ path: `${process.env.PRESHIFT_E2E_SHOTS}/by-person.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.locator('.clip-bar')).toHaveCount(0);
  if ((await pasted.count()) > 0) {
    await pasted.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  }
  await expect(target.locator('.chip')).toHaveCount(0);
  expect(errors).toEqual([]);
});
