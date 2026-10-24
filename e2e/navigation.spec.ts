import { expect, test, type Page } from '@playwright/test';
import { NAV, NAV_ITEMS, type NavItem } from '../src/ui/nav';

// The management bar: every section opens in every scope, the header only offers controls that
// change what is on screen, and where you are survives Back and refresh. Site and entity names are
// read from the page, so the same checks run against the local demo or a deployed site.

// The sections and their rules come from the bar itself, so a new section is checked as soon as it exists.
// These checks sign in as an admin, who is offered every section except those kept to one audience
// (Clients is for Williams, Stanley & Co. people).
const SECTIONS = NAV_ITEMS.filter((t) => t.access === 'everyone' || !t.access.audience).map((t) => t.label);
const labels = (keep: (t: NavItem) => boolean) => NAV_ITEMS.filter(keep).map((t) => t.label);
const SITE_ONLY = labels((t) => !!t.siteOnly);
const PLANNING = labels((t) => !!t.plans);
const WEEK = labels((t) => t.scope === 'week');
const ORG = labels((t) => t.scope === 'org');
const orgTitle = (label: string) => NAV_ITEMS.find((t) => t.label === label)?.title ?? 'Organisation';

const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });
const item = (page: Page, label: string) => bar(page).getByRole('button', { name: label, exact: true });
const groupOf = (label: string) => NAV.find((g) => g.items.some((t) => t.label === label))!;
const toggle = (page: Page, groupId: string) => page.locator(`[data-group="${groupId}"] .nav-toggle`);

/** Opens the section from the bar, unfolding its group first if it is folded away. */
async function go(page: Page, label: string) {
  const t = toggle(page, groupOf(label).id);
  if ((await t.count()) > 0 && (await t.getAttribute('aria-expanded')) === 'false') await t.click();
  await item(page, label).click();
}
const heading = (page: Page) => page.locator('.mast-title h1');

const picker = (page: Page) => page.getByRole('button', { name: 'Site or company' });
const option = (page: Page, name: string) =>
  page.locator('.sp-option').filter({ has: page.locator('.sp-name').getByText(name, { exact: true }) });

/** The sites, or the companies, the scope picker offers. With one company it lists only sites. */
async function choices(page: Page, kind: 'site' | 'entity', within?: string) {
  await picker(page).click();
  const scope = within ? page.locator('.sp-group').filter({ has: option(page, within) }) : page.locator('.sp-menu');
  const names = await scope.locator(`.sp-option[data-kind="${kind}"] .sp-name`).allTextContents();
  await page.keyboard.press('Escape');
  return names;
}

/** Chooses a site or a company from the scope picker. */
async function choose(page: Page, name: string) {
  await picker(page).click();
  await option(page, name).click();
}

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
      title = (await choices(page, 'site'))[0];
      await choose(page, title);
    }
    const several = scope === 'all sites' && (await choices(page, 'site')).length > 1;
    // From one site, Sites steps back out to every site; that has its own test below.
    for (const label of scope === 'all sites' ? SECTIONS : SECTIONS.filter((l) => l !== 'Sites')) {
      await go(page, label);
      await expect(item(page, label)).toHaveAttribute('aria-current', 'page');
      await expect(item(page, label)).toBeEnabled();
      await expect(page.locator('.mast-top .eyebrow')).toHaveText(label);

      const choosing = several && SITE_ONLY.includes(label);
      await expect(page.locator('.site-chooser')).toHaveCount(choosing ? 1 : 0);
      await expect(heading(page)).toHaveText(ORG.includes(label) ? orgTitle(label) : title);
      await expect(picker(page)).toHaveCount(ORG.includes(label) ? 0 : 1);
      await expect(page.getByLabel('Previous week')).toHaveCount(WEEK.includes(label) ? 1 : 0);
      await expect(page.getByRole('complementary', { name: 'Rota P&L' })).toHaveCount(WEEK.includes(label) ? 1 : 0);
      await expect(page.getByRole('button', { name: 'Clear week' })).toHaveCount(PLANNING.includes(label) && !choosing ? 1 : 0);
      await expect(page.locator('main')).not.toBeEmpty();
    }
  });
}

test('a site-only section across several sites asks for a site, then opens it there', async ({ page }) => {
  const sites = await choices(page, 'site');
  test.skip(sites.length < 2, 'Needs at least two sites');
  await go(page, 'Payroll');
  const chooser = page.locator('.site-chooser');
  await expect(chooser).toContainText('Payroll is run one site at a time');
  await expect(chooser.getByRole('button')).toHaveCount(sites.length);
  await chooser.getByRole('button', { name: sites[1] }).click();
  await expect(heading(page)).toHaveText(sites[1]);
  await expect(item(page, 'Payroll')).toHaveAttribute('aria-current', 'page');
  await expect(chooser).toHaveCount(0);
});

test('the chooser only offers the sites in the chosen entity', async ({ page }) => {
  const entities = await choices(page, 'entity');
  test.skip(entities.length < 2, 'Needs at least two entities');
  await choose(page, entities[0]);
  const inEntity = await choices(page, 'site', entities[0]);
  test.skip(inEntity.length < 2, 'Needs an entity with at least two sites');
  await go(page, 'Rota');
  await expect(page.locator('.site-chooser').getByRole('button')).toHaveText(inEntity.map((s) => new RegExp(s)));
});

test('the trail above a site steps back out to its company, then to every site', async ({ page }) => {
  const entities = await choices(page, 'entity');
  test.skip(entities.length < 2, 'Needs at least two companies');
  const site = (await choices(page, 'site', entities[0]))[0];
  await choose(page, site);
  await expect(heading(page)).toHaveText(site);
  const trail = page.getByRole('navigation', { name: 'Scope' });
  await trail.getByRole('button', { name: entities[0] }).click();
  await expect(heading(page)).toHaveText(entities[0]);
  await trail.getByRole('button', { name: 'All sites' }).click();
  await expect(heading(page)).toHaveText('All sites');
});

test('changing site keeps you in the section you are in', async ({ page }) => {
  const sites = await choices(page, 'site');
  test.skip(sites.length < 2, 'Needs at least two sites');
  await choose(page, sites[0]);
  await go(page, 'Absence');
  await choose(page, sites[sites.length - 1]);
  await expect(item(page, 'Absence')).toHaveAttribute('aria-current', 'page');
  await expect(heading(page)).toHaveText(sites[sites.length - 1]);
});

test('opening a site from the overview goes to its rota, and Sites steps back out', async ({ page }) => {
  const link = page.locator('main button.site-link').first();
  const name = (await link.textContent())!.trim();
  await link.click();
  await expect(item(page, 'Rota')).toHaveAttribute('aria-current', 'page');
  await expect(heading(page)).toHaveText(name);
  await go(page, 'Sites');
  await expect(heading(page)).toHaveText('All sites');
  await expect(page.locator('.sp-crumbs')).toHaveCount(0);
});

test('Back and refresh return to the same place', async ({ page }) => {
  const site = (await choices(page, 'site'))[0];
  await choose(page, site);
  await go(page, 'Holiday');
  await go(page, 'Payroll');
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

test('groups fold away, the one you are in opens, and your choice is remembered', async ({ page }) => {
  await go(page, 'Absence');
  const people = toggle(page, 'people');
  await expect(people).toHaveAttribute('aria-expanded', 'true');
  await people.click();
  await expect(people).toHaveAttribute('aria-expanded', 'false');
  await expect(item(page, 'Training')).toHaveCount(0);
  await page.reload();
  await expect(people).toHaveAttribute('aria-expanded', 'false');
  await go(page, 'Training');
  await expect(people).toHaveAttribute('aria-expanded', 'true');
  await expect(item(page, 'Training')).toHaveAttribute('aria-current', 'page');
});

test('Go to finds a section by its name, and / reaches it from anywhere', async ({ page }) => {
  const find = bar(page).getByLabel('Go to a section');
  await page.locator('main').click();
  await page.keyboard.press('/');
  await expect(find).toBeFocused();
  // A section named for what was typed comes before one whose group heading only mentions it.
  await page.keyboard.type('pay');
  await expect(bar(page).locator('.nav-results button').first()).toContainText('Payroll');
  await page.keyboard.press('Enter');
  await expect(item(page, 'Payroll')).toHaveAttribute('aria-current', 'page');
  await expect(find).toHaveValue('');

  await find.fill('nothing like this');
  await expect(bar(page).locator('.nav-none')).toBeVisible();
  await find.press('Escape');
  await expect(find).toHaveValue('');
});

test('a folded group lists what is inside it', async ({ page }) => {
  await go(page, 'Absence');
  const people = toggle(page, 'people');
  await people.click();
  await expect(people).toHaveAttribute('aria-expanded', 'false');
  await expect(people.locator('.nav-preview')).toContainText('Absence');
});

test('a supervisor sees only their sections, and the API refuses the rest', async ({ page }) => {
  // Acting as a demo person is a development build feature, so this runs against the local server only.
  test.skip(!!process.env.PRESHIFT_E2E_URL, 'Needs the local development server');
  await page.evaluate(() => localStorage.setItem('preshift.demoKey', 'dev-usr_sup'));
  await page.reload();
  await expect(bar(page)).toBeVisible();
  for (const g of NAV) {
    const t = toggle(page, g.id);
    if ((await t.count()) > 0 && (await t.getAttribute('aria-expanded')) === 'false') await t.click();
  }
  const shown = (await bar(page).locator('.nav-items button, .nav-group > button:not(.nav-toggle)').allTextContents()).map((x) => x.trim());
  expect(shown).toEqual(expect.arrayContaining(['Rota', 'Clock in', 'Your profile']));
  for (const hidden of ['Sites', 'Labour cost', 'Staff', 'HR overview', 'Cases', 'Reports', 'Close', 'Access', 'GDPR', 'Settings']) {
    expect(shown).not.toContain(hidden);
  }
  // Actions their roles do not include are not shown greyed out; they are not shown.
  await go(page, 'Rota');
  for (const action of ['Clear week', 'Build from forecast', 'Ask the assistant', 'Sign off and publish']) {
    await expect(page.getByRole('button', { name: action })).toHaveCount(0);
  }
  // Hiding is a courtesy; the control is the API. Ask it directly, as the supervisor.
  const status = await page.evaluate(async () => {
    const r = await fetch('/v1/users', { headers: { authorization: 'Bearer dev-usr_sup' } });
    return r.status;
  });
  expect(status).toBe(403);
  await page.evaluate(() => localStorage.removeItem('preshift.demoKey'));
});

test('the organisation picker names where you are and moves only on a deliberate choice', async ({ page }) => {
  // The account is given two more organisations in the browser only; the switch itself is refused,
  // so the check never moves a real session.
  await page.route('**/auth/me', async (route) => {
    const body = await (await route.fetch()).json();
    const others = [{ orgId: 'e2e-a', name: 'Harbour Kitchens Ltd', current: false, home: false }, { orgId: 'e2e-b', name: 'Northern Taverns Ltd', current: false, home: false }];
    await route.fulfill({ json: { ...body, organisations: [...body.organisations, ...others] } });
  });
  await page.route('**/auth/switch', (route) => route.fulfill({ status: 403, json: { message: 'You have no access to that organisation.' } }));
  await page.reload();

  const picker = page.getByRole('button', { name: /^Organisation:/ });
  await expect(picker).toContainText('3 you work in');
  await picker.click();
  const options = page.getByRole('listbox', { name: 'Organisations' }).getByRole('option');
  await expect(options).toHaveCount(3);
  await expect(page.locator('.op-option.selected')).toContainText('Home');
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);

  await picker.click();
  await options.filter({ hasText: 'Harbour Kitchens Ltd' }).click();
  await expect(page.locator('.op-error')).toHaveText('You have no access to that organisation.');
});

test('viewing as someone else says so on every screen, and one click returns to yourself', async ({ page }) => {
  // Acting as a demo person is a development build feature, so this runs against the local server only.
  test.skip(!!process.env.PRESHIFT_E2E_URL, 'Needs the local development server');
  const card = page.getByRole('button', { name: 'Viewing as' });
  await expect(card).toContainText('Yourself');
  await expect(page.locator('.acting-banner')).toHaveCount(0);

  await card.click();
  const people = page.getByRole('listbox', { name: 'People' }).getByRole('option');
  await expect(people.first()).toHaveAttribute('aria-selected', 'true');
  const someone = people.nth(1);
  const name = (await someone.locator('.op-option-name').textContent())!.trim();
  await someone.click();

  await expect(page.locator('.acting-banner')).toContainText(`You are viewing the app as ${name}`);
  await expect(card).toContainText(name);
  await page.getByRole('button', { name: 'Back to yourself' }).click();
  await expect(page.locator('.acting-banner')).toHaveCount(0);
  await expect(card).toContainText('Yourself');
});
