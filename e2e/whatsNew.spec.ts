import { expect, test, type Page } from '@playwright/test';
import { toISODate } from '../src/engine/time';
import { currentRelease } from '../src/ui/walkthrough';

// What's new: this week's release is offered once, walks through each change on its own screen, and
// stays out of the way once seen. It only navigates and keeps its place in the browser, so it runs
// against the local demo, a deployed site and the public demo alike.

const release = currentRelease(toISODate(new Date()));
const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });
const card = (page: Page) => page.getByRole('region', { name: "What's new walkthrough" });

async function signIn(page: Page) {
  if (process.env.PRESHIFT_E2E_DEMO) {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'Start the demo' }).click();
    await expect(bar(page)).toBeVisible({ timeout: 30_000 });
    return;
  }
  await page.goto('/login?next=/app/');
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill(process.env.PRESHIFT_E2E_EMAIL ?? 'dev@preshift.local');
  await form.locator('input[name=password]').fill(process.env.PRESHIFT_E2E_PASSWORD ?? 'preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(bar(page)).toBeVisible();
}

test.skip(!release, 'No release is out yet');

test("this week's changes are walked through once, each on its own screen", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);

  const notice = page.getByRole('status').filter({ hasText: 'New this week.' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Take the walkthrough' }).click();
  await expect(card(page)).toBeVisible();
  await expect(notice).toHaveCount(0);

  // Step through to the end: a step that names a section opens it.
  for (const step of release!.steps) {
    await expect(card(page).getByRole('heading', { name: step.title })).toBeVisible();
    if (step.tab === 'rota') await expect(page.locator('.mast-top .eyebrow')).toHaveText('Rota');
    const next = card(page).getByRole('button', { name: 'Next' });
    if ((await next.count()) === 0) break;
    await next.click();
  }
  await card(page).getByRole('button', { name: 'Done' }).click();
  await expect(card(page)).toHaveCount(0);

  // Seen: not offered again, but What's new brings it back.
  await page.reload();
  await expect(bar(page)).toBeVisible();
  await expect(page.getByText('New this week.')).toHaveCount(0);
  await page.getByRole('button', { name: "What's new" }).click();
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});
