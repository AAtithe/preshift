import { expect, test, type Page } from '@playwright/test';

// The management bar: every section opens in every scope, the header only offers controls that
// change what is on screen, and where you are survives Back and refresh.

const SECTIONS = [
  'Sites', 'Rota', 'Demand', 'Clock in',
  'HR overview', 'Staff', 'Holiday', 'Absence', 'Training', 'Probation and reviews', 'Cases',
  'Labour cost', 'Payroll', 'Close', 'Reports',
  'Integrations', 'GDPR', 'Access', 'Settings', 'How to',
];
const SITE_ONLY = ['Rota', 'Demand', 'Clock in', 'Staff', 'Payroll'];
const PLANNING = ['Sites', 'Rota', 'Demand'];
const WEEK = ['Sites', 'Rota', 'Demand', 'Labour cost', 'Payroll', 'Close', 'Reports'];
const ORG = ['Integrations', 'GDPR', 'Access', 'Settings', 'How to'];

const item = (page: Page, label: string) => page.getByRole('navigation', { name: 'Management' }).getByRole('button', { name: label, exact: true });
const heading = (page: Page) => page.locator('.mast-title h1');

async function signIn(page: Page) {
  await page.goto('/login?next=/app/');
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill('dev@preshift.local');
  await form.locator('input[name=password]').fill('preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(item(page, 'Sites')).toBeVisible();
}

// Any uncaught error in the page fails the test it happened in.
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

for (const scope of ['All sites', 'Marylebone'] as const) {
  test(`every section opens with the right header controls: ${scope}`, async ({ page }) => {
    if (scope !== 'All sites') await page.getByLabel('Site', { exact: true }).selectOption({ label: scope });
    // From one site, Sites steps back out to every site; that has its own test below.
    for (const label of scope === 'All sites' ? SECTIONS : SECTIONS.filter((l) => l !== 'Sites')) {
      await item(page, label).click();
      await expect(item(page, label)).toHaveAttribute('aria-current', 'page');
      await expect(item(page, label)).toBeEnabled();
      await expect(page.locator('.mast-top .eyebrow')).toHaveText(label);

      const choosing = scope === 'All sites' && SITE_ONLY.includes(label);
      await expect(page.locator('.site-chooser')).toHaveCount(choosing ? 1 : 0);
      await expect(heading(page)).toHaveText(label === 'How to' ? 'Help' : ORG.includes(label) ? 'Organisation' : scope);
      await expect(page.getByLabel('Site', { exact: true })).toHaveCount(ORG.includes(label) ? 0 : 1);
      await expect(page.getByLabel('Previous week')).toHaveCount(WEEK.includes(label) ? 1 : 0);
      await expect(page.getByRole('complementary', { name: 'Rota P&L' })).toHaveCount(WEEK.includes(label) ? 1 : 0);
      await expect(page.getByRole('button', { name: 'Clear week' })).toHaveCount(PLANNING.includes(label) && !choosing ? 1 : 0);
      await expect(page.locator('main')).not.toBeEmpty();
    }
  });
}

test('a site-only section across several sites asks for a site, then opens it there', async ({ page }) => {
  await item(page, 'Payroll').click();
  const chooser = page.locator('.site-chooser');
  await expect(chooser).toContainText('Payroll is run one site at a time');
  await expect(chooser.getByRole('button')).toHaveCount(3);
  await chooser.getByRole('button', { name: /Fitzrovia/ }).click();
  await expect(heading(page)).toHaveText('Fitzrovia');
  await expect(item(page, 'Payroll')).toHaveAttribute('aria-current', 'page');
  await expect(chooser).toHaveCount(0);
});

test('the chooser only offers the sites in the chosen entity', async ({ page }) => {
  await page.getByLabel('Entity').selectOption({ label: 'West End Dining Ltd' });
  await item(page, 'Rota').click();
  await expect(page.locator('.site-chooser').getByRole('button')).toHaveText([/Marylebone/, /Fitzrovia/]);
});

test('changing site keeps you in the section you are in', async ({ page }) => {
  await page.getByLabel('Site', { exact: true }).selectOption({ label: 'Marylebone' });
  await item(page, 'Absence').click();
  await page.getByLabel('Site', { exact: true }).selectOption({ label: 'Shoreditch' });
  await expect(item(page, 'Absence')).toHaveAttribute('aria-current', 'page');
  await expect(heading(page)).toHaveText('Shoreditch');
});

test('opening a site from the overview goes to its rota, and Sites steps back out', async ({ page }) => {
  await page.locator('main').getByRole('button', { name: 'Marylebone', exact: true }).click();
  await expect(item(page, 'Rota')).toHaveAttribute('aria-current', 'page');
  await expect(heading(page)).toHaveText('Marylebone');
  await item(page, 'Sites').click();
  await expect(heading(page)).toHaveText('All sites');
  await expect(page.getByLabel('Site', { exact: true })).toHaveValue('');
});

test('Back and refresh return to the same place', async ({ page }) => {
  await page.getByLabel('Site', { exact: true }).selectOption({ label: 'Fitzrovia' });
  await item(page, 'Holiday').click();
  await item(page, 'Payroll').click();
  await page.getByLabel('Next week').click();
  const url = page.url();
  expect(url).toContain('view=payroll');
  expect(url).toContain('site=');

  await page.reload();
  await expect(item(page, 'Payroll')).toHaveAttribute('aria-current', 'page');
  await expect(heading(page)).toHaveText('Fitzrovia');
  expect(page.url()).toBe(url);

  await page.goBack();
  await expect(item(page, 'Holiday')).toHaveAttribute('aria-current', 'page');
  await expect(heading(page)).toHaveText('Fitzrovia');
  await page.goBack();
  await expect(item(page, 'Rota')).toHaveAttribute('aria-current', 'page');
});
