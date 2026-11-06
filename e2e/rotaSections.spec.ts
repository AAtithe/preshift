import { expect, test, type Page } from './fixtures';

// The rota grid's department sections: each can be minimised to its header, or hidden and shown again,
// and the choice is kept for the site across a refresh.

async function openRota(page: Page) {
  if (process.env.PRESHIFT_E2E_DEMO) {
    await page.goto('/app/');
  } else {
    await page.goto('/login?next=/app/');
    const form = page.locator('form[action="/auth/login"]');
    await form.locator('input[name=email]').fill(process.env.PRESHIFT_E2E_EMAIL ?? 'dev@preshift.local');
    await form.locator('input[name=password]').fill(process.env.PRESHIFT_E2E_PASSWORD ?? 'preshift-dev-password');
    await form.getByRole('button', { name: 'Sign in' }).click();
  }
  await page.locator('main button.site-link').first().click();
  await page.getByRole('tab', { name: 'By person' }).click();
  await expect(page.locator('table.rota tr.group').first()).toBeVisible();
}

test('a rota section minimises, hides and comes back, and stays as left after a refresh', async ({ page }) => {
  await openRota(page);
  const rows = () => page.locator('table.rota tbody tr:not(.group)');
  const toggle = page.locator('table.rota .group-toggle').first();
  const name = (await toggle.textContent())!.replace(/[▸▾]/g, '').trim();
  const all = await rows().count();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const minimised = await rows().count();
  expect(minimised).toBeLessThan(all);

  await page.reload();
  await page.getByRole('tab', { name: 'By person' }).click();
  await expect(page.locator('table.rota .group-toggle').first()).toHaveAttribute('aria-expanded', 'false');
  await page.locator('table.rota .group-toggle').first().click();
  await expect(rows()).toHaveCount(all);

  await page.locator('table.rota tr.group').first().hover();
  await page.locator('table.rota .group-hide').first().click();
  await expect(page.locator('table.rota .group-toggle', { hasText: name })).toHaveCount(0);
  await page.getByRole('button', { name: `Show ${name}` }).click();
  await expect(page.locator('table.rota .group-toggle', { hasText: name })).toHaveCount(1);
  await expect(rows()).toHaveCount(all);
});
