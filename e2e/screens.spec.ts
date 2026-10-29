import { expect, test, type Page } from './fixtures';
import { NAV_ITEMS } from '../src/ui/nav';

// The rota screen and the sections around it, as a person meets them: every section fits a phone,
// the editors close the way dialogs do and never throw work away, a finished week asks for nothing,
// a link to a section someone is not offered says why they landed elsewhere, Shifty is one keypress
// away, and only those who can change the rota are asked to decide.

const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });

async function signIn(page: Page) {
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

/** Moves within the app, as the bar does, rather than loading it afresh for every screen. */
async function open(page: Page, query: string) {
  await page.evaluate((q) => {
    history.pushState(null, '', `${location.pathname}${q}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, query);
}

/** The first site the scope picker offers, by its id in the address once chosen. */
async function firstSite(page: Page) {
  await page.getByRole('button', { name: 'Site or company' }).click();
  await page.locator('.sp-option[data-kind="site"]').first().click();
  await expect.poll(() => new URL(page.url()).searchParams.get('site')).not.toBeNull();
  return new URL(page.url()).searchParams.get('site')!;
}

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('every section fits the width of the screen', async ({ page }) => {
    await signIn(page);
    // On a phone the bar folds behind Menu, so the site is chosen from the heading.
    const site = await firstSite(page);
    const week = new URL(page.url()).searchParams.get('week');
    const wide: string[] = [];
    for (const t of NAV_ITEMS) {
      await open(page, `?view=${t.id}&site=${site}&week=${week}`);
      await page.waitForLoadState('networkidle');
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 1) wide.push(`${t.label} (${over}px)`);
    }
    expect(wide).toEqual([]);
  });
});

test('a week that is over asks for no decisions', async ({ page }) => {
  await signIn(page);
  const site = await firstSite(page);
  await open(page, `?view=rota&site=${site}&week=2020-01-06`);
  await expect(page.locator('.tl-lane').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Decisions this week' })).toHaveCount(0);
});

test('Ask Shifty is the one place to ask: Ctrl K opens it, Escape closes it', async ({ page }) => {
  await signIn(page);
  const shifty = page.getByRole('dialog', { name: 'Shifty' });
  await expect(page.getByRole('button', { name: 'Ask Shifty' })).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(shifty).toBeVisible();
  await expect(shifty.getByPlaceholder('Ask a question, or say what to do...')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(shifty).toHaveCount(0);
});

test.describe('changing the rota', () => {
  // These open a shift and may build the week first, so they run against the local server only.
  test.skip(!!process.env.PRESHIFT_E2E_URL, 'Can build the week, so local only');

  test('the shift editor closes on Escape, and asks before throwing a change away', async ({ page }) => {
    await signIn(page);
    await page.goto('/app/?view=rota&site=mar');
    await page.getByRole('tab', { name: 'Service timeline' }).click();
    await expect(page.locator('.tl-lane').first()).toBeVisible();
    if ((await page.locator('.tl-bar').count()) === 0) await page.getByRole('button', { name: 'Build from forecast' }).click();
    const shift = page.locator('.tl-bar').first();
    const editor = page.getByRole('dialog', { name: /shift/i });

    await shift.click();
    await expect(editor).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor).toHaveCount(0);

    // With a change made, Escape asks first: saying no keeps the editor and the change.
    await shift.click();
    const breakField = editor.getByLabel('Unpaid break (mins)');
    await breakField.fill('45');
    let asked = '';
    page.once('dialog', (d) => {
      asked = d.message();
      void d.dismiss();
    });
    await page.keyboard.press('Escape');
    await expect.poll(() => asked).toBe('Close without saving your changes?');
    await expect(breakField).toHaveValue('45');

    // Saying yes closes it, the change unsaved.
    page.once('dialog', (d) => void d.accept());
    await editor.getByRole('button', { name: 'Cancel' }).click();
    await expect(editor).toHaveCount(0);
  });

  test('a link to a section someone is not offered says why they are elsewhere', async ({ page }) => {
    // Acting as a demo person is a development build feature.
    await signIn(page);
    await page.evaluate(() => localStorage.setItem('preshift.demoKey', 'dev-usr_sup'));
    await page.goto('/app/?view=cases&site=mar');
    await expect(page.getByRole('status').filter({ hasText: 'Cases is not part of your role' })).toBeVisible();
    // Opening a section from the bar is a choice of their own: the note goes.
    await bar(page).locator('[data-group="planning"] .nav-toggle').click();
    await bar(page).getByRole('button', { name: 'Rota', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'not part of your role' })).toHaveCount(0);
    await page.evaluate(() => localStorage.removeItem('preshift.demoKey'));
  });

  test('someone who may only look at the rota is not asked to decide anything', async ({ page }) => {
    await signIn(page);
    await page.evaluate(() => localStorage.setItem('preshift.demoKey', 'dev-usr_sup'));
    await page.goto('/app/?view=rota&site=mar');
    await expect(page.locator('.tl-lane').first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Decisions this week' })).toHaveCount(0);
    await page.evaluate(() => localStorage.removeItem('preshift.demoKey'));
  });
});
