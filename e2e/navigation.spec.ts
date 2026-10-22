import { expect, test, type Page } from '@playwright/test';
import { NAV_ITEMS, type NavItem } from '../src/ui/nav';

// The management bar: every section opens in every scope, the header only offers controls that
// change what is on screen, and where you are survives Back and refresh. Site and entity names are
// read from the page, so the same checks run against the local demo or a deployed site.

// The sections and their rules come from the bar itself, so a new section is checked as soon as it exists.
// These checks sign in as an admin, who is offered every section.
const SECTIONS = NAV_ITEMS.map((t) => t.label);
const labels = (keep: (t: NavItem) => boolean) => NAV_ITEMS.filter(keep).map((t) => t.label);
const SITE_ONLY = labels((t) => !!t.siteOnly);
const PLANNING = labels((t) => !!t.plans);
const WEEK = labels((t) => t.scope === 'week');
const ORG = labels((t) => t.scope === 'org');
const orgTitle = (label: string) => NAV_ITEMS.find((t) => t.label === label)?.title ?? 'Organisation';

const item = (page: Page, label: string) => page.getByRole('navigation', { name: 'Management' }).getByRole('button', { name: label, exact: true });
const heading = (page: Page) => page.locator('.mast-title h1');

/** The options of a scope picker, without its "All ..." entry. */
async function choices(page: Page, label: 'Site' | 'Entity') {
  const options = await page.getByLabel(label, { exact: true }).locator('option').evaluateAll((os) =>
    (os as HTMLOptionElement[]).filter((o) => o.value).map((o) => o.textContent!.trim()),
  );
  return options;
}

async function signIn(page: Page) {
  // A deployed site with a public demo: each test gets a sandbox of its own, as any visitor would.
  if (process.env.PRESHIFT_E2E_DEMO) {
    await page.goto('/demo');
    await page.getByRole('button', { name: 'Start the demo' }).click();
    await expect(item(page, 'Settings')).toBeVisible();
    return;
  }
  await page.goto('/login?next=/app/');
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill(process.env.PRESHIFT_E2E_EMAIL ?? 'dev@preshift.local');
  await form.locator('input[name=password]').fill(process.env.PRESHIFT_E2E_PASSWORD ?? 'preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(item(page, 'Settings')).toBeVisible();
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

for (const scope of ['all sites', 'one site'] as const) {
  test(`every section opens with the right header controls: ${scope}`, async ({ page }) => {
    let title = 'All sites';
    if (scope === 'one site') {
      title = (await choices(page, 'Site'))[0];
      await page.getByLabel('Site', { exact: true }).selectOption({ label: title });
    }
    const several = scope === 'all sites' && (await choices(page, 'Site')).length > 1;
    // From one site, Sites steps back out to every site; that has its own test below.
    for (const label of scope === 'all sites' ? SECTIONS : SECTIONS.filter((l) => l !== 'Sites')) {
      await item(page, label).click();
      await expect(item(page, label)).toHaveAttribute('aria-current', 'page');
      await expect(item(page, label)).toBeEnabled();
      await expect(page.locator('.mast-top .eyebrow')).toHaveText(label);

      const choosing = several && SITE_ONLY.includes(label);
      await expect(page.locator('.site-chooser')).toHaveCount(choosing ? 1 : 0);
      await expect(heading(page)).toHaveText(ORG.includes(label) ? orgTitle(label) : title);
      await expect(page.getByLabel('Site', { exact: true })).toHaveCount(ORG.includes(label) ? 0 : 1);
      await expect(page.getByLabel('Previous week')).toHaveCount(WEEK.includes(label) ? 1 : 0);
      await expect(page.getByRole('complementary', { name: 'Rota P&L' })).toHaveCount(WEEK.includes(label) ? 1 : 0);
      await expect(page.getByRole('button', { name: 'Clear week' })).toHaveCount(PLANNING.includes(label) && !choosing ? 1 : 0);
      await expect(page.locator('main')).not.toBeEmpty();
    }
  });
}

test('a site-only section across several sites asks for a site, then opens it there', async ({ page }) => {
  const sites = await choices(page, 'Site');
  test.skip(sites.length < 2, 'Needs at least two sites');
  await item(page, 'Payroll').click();
  const chooser = page.locator('.site-chooser');
  await expect(chooser).toContainText('Payroll is run one site at a time');
  await expect(chooser.getByRole('button')).toHaveCount(sites.length);
  await chooser.getByRole('button', { name: sites[1] }).click();
  await expect(heading(page)).toHaveText(sites[1]);
  await expect(item(page, 'Payroll')).toHaveAttribute('aria-current', 'page');
  await expect(chooser).toHaveCount(0);
});

test('the chooser only offers the sites in the chosen entity', async ({ page }) => {
  const entities = await choices(page, 'Entity');
  test.skip(entities.length < 2, 'Needs at least two entities');
  await page.getByLabel('Entity').selectOption({ label: entities[0] });
  const inEntity = await choices(page, 'Site');
  test.skip(inEntity.length < 2, 'Needs an entity with at least two sites');
  await item(page, 'Rota').click();
  await expect(page.locator('.site-chooser').getByRole('button')).toHaveText(inEntity.map((s) => new RegExp(s)));
});

test('changing site keeps you in the section you are in', async ({ page }) => {
  const sites = await choices(page, 'Site');
  test.skip(sites.length < 2, 'Needs at least two sites');
  await page.getByLabel('Site', { exact: true }).selectOption({ label: sites[0] });
  await item(page, 'Absence').click();
  await page.getByLabel('Site', { exact: true }).selectOption({ label: sites[sites.length - 1] });
  await expect(item(page, 'Absence')).toHaveAttribute('aria-current', 'page');
  await expect(heading(page)).toHaveText(sites[sites.length - 1]);
});

test('opening a site from the overview goes to its rota, and Sites steps back out', async ({ page }) => {
  const link = page.locator('main button.site-link').first();
  const name = (await link.textContent())!.trim();
  await link.click();
  await expect(item(page, 'Rota')).toHaveAttribute('aria-current', 'page');
  await expect(heading(page)).toHaveText(name);
  await item(page, 'Sites').click();
  await expect(heading(page)).toHaveText('All sites');
  await expect(page.getByLabel('Site', { exact: true })).toHaveValue('');
});

test('Back and refresh return to the same place', async ({ page }) => {
  const site = (await choices(page, 'Site'))[0];
  await page.getByLabel('Site', { exact: true }).selectOption({ label: site });
  await item(page, 'Holiday').click();
  await item(page, 'Payroll').click();
  await page.getByLabel('Next week').click();
  const url = page.url();
  expect(url).toContain('view=payroll');
  expect(url).toContain('site=');

  await page.reload();
  await expect(item(page, 'Payroll')).toHaveAttribute('aria-current', 'page');
  await expect(heading(page)).toHaveText(site);
  expect(page.url()).toBe(url);

  await page.goBack();
  await expect(item(page, 'Holiday')).toHaveAttribute('aria-current', 'page');
  await expect(heading(page)).toHaveText(site);
  await page.goBack();
  await expect(item(page, 'Rota')).toHaveAttribute('aria-current', 'page');
});
