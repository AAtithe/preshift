import { expect, test, type Page } from './fixtures';
import { toISODate } from '../src/engine/time';
import { currentRelease } from '../src/ui/walkthrough';

// What's new: this week's release pops up at the first sign-in of the week, walks through each
// change on its own screen, and stays out of the way once seen. It only navigates and keeps its
// place in the browser, so it runs against the local demo, a deployed site and the public demo alike.

const release = currentRelease(toISODate(new Date()));
const titles = new Set(release?.steps.map((s) => s.title));
const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });
const popup = (page: Page) => page.getByRole('dialog', { name: "What's new this week" });
const card = (page: Page) => page.getByRole('region', { name: "What's new walkthrough" });

async function signIn(page: Page) {
  // A deployed site with a public demo: the run's one sandbox, its session already in this browser
  // (e2e/demo.setup.ts).
  if (process.env.PRESHIFT_E2E_DEMO) {
    await page.goto('/app/');
    await expect(bar(page)).toBeVisible();
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
test.use({ whatsNewPopsUp: true });

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (e) => errors.push(e.message));
  await signIn(page);
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

test("this week's changes pop up at the first sign-in and are walked through, each on its own screen", async ({ page }) => {
  await expect(popup(page)).toBeVisible();
  await popup(page).getByRole('button', { name: 'Show me' }).click();
  await expect(popup(page)).toHaveCount(0);
  await expect(card(page)).toBeVisible();

  // Step through to the end: every step is one of this week's, and one that names the rota opens it.
  // Bounded by the release's own length, so a week with more changes is still walked to its end.
  for (let i = 0; i < release!.steps.length; i++) {
    const title = await card(page).locator('h3').innerText();
    expect(titles.has(title)).toBe(true);
    if (release!.steps.find((s) => s.title === title)?.tab === 'rota') await expect(page.locator('.mast-top .eyebrow')).toHaveText('Rota');
    const next = card(page).getByRole('button', { name: 'Next', exact: true });
    if ((await next.count()) === 0) break;
    await next.click();
  }
  await card(page).getByRole('button', { name: 'Done' }).click();
  await expect(card(page)).toHaveCount(0);

  // Seen: it does not pop up again this week, but What's new brings it back.
  await page.reload();
  await expect(bar(page)).toBeVisible();
  await expect(popup(page)).toHaveCount(0);
  await page.getByRole('button', { name: "What's new" }).click();
  await expect(card(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveCount(0);
});

test('Not now puts it away for the week', async ({ page }) => {
  await expect(popup(page)).toBeVisible();
  await popup(page).getByRole('button', { name: 'Not now' }).click();
  await expect(popup(page)).toHaveCount(0);
  await expect(card(page)).toHaveCount(0);
  await page.reload();
  await expect(bar(page)).toBeVisible();
  await expect(popup(page)).toHaveCount(0);
});
