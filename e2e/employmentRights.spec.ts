import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

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

// Marylebone's GM, who records and approves hours there (the owner does not approve hours).
const DEV = { authorization: 'Bearer dev-usr_gm_mar' };
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Twelve weeks of clocked hours, two ten hour days a week, for one zero hours worker at Marylebone,
 * entered and approved through the API. The browser checks run without the sample trading history,
 * so the test makes the history its offer rests on rather than assuming it is there.
 */
async function workedTwentyHoursAWeek(request: APIRequestContext): Promise<string> {
  const people = (await (await request.get('/v1/employees', { headers: DEV })).json()) as { id: string; name: string; siteId: string; payBasis: string; contractedHours: number; status?: string; roleIds: string[] }[];
  // Someone not offered yet: an offer takes a person off the list for a reference period, as it should.
  const offered = new Set(((await (await request.get('/v1/employment-rights?siteId=mar', { headers: DEV })).json()) as { offers: { employeeId: string }[] }).offers.map((o) => o.employeeId));
  const worker = people.find((e) => e.siteId === 'mar' && e.payBasis === 'hourly' && e.contractedHours === 0 && e.status !== 'leaver' && !offered.has(e.id))!;
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  // Once only: a retry, or a second run against the same local server, finds the history already there.
  const from = new Date(monday);
  from.setUTCDate(monday.getUTCDate() - 84);
  const existing = (await (await request.get(`/v1/time-entries?siteId=mar&from=${iso(from)}&to=${iso(monday)}`, { headers: DEV })).json()) as { employeeId: string }[];
  if (existing.filter((t) => t.employeeId === worker.id).length >= 24) return worker.name;
  const ids: string[] = [];
  for (let w = 1; w <= 12; w++) {
    for (const d of [0, 2]) {
      const date = new Date(monday);
      date.setUTCDate(monday.getUTCDate() - 7 * w + d);
      const made = await request.post('/v1/time-entries', {
        headers: DEV,
        data: { employeeId: worker.id, siteId: 'mar', roleId: worker.roleIds[0], date: iso(date), clockIn: 480, clockOut: 1080, breakMinutes: 0 },
      });
      expect(made.ok()).toBe(true);
      ids.push(((await made.json()) as { id: string }).id);
    }
  }
  expect((await request.post('/v1/time-entries/approve', { headers: DEV, data: { ids } })).ok()).toBe(true);
  return worker.name;
}

test('a GM makes a guaranteed hours offer, gets the letter and records the answer', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const person = await workedTwentyHoursAWeek(page.request);
  await signIn(page);
  await page.evaluate(() => localStorage.setItem('preshift.demoKey', 'dev-usr_gm_mar'));
  await page.goto('/app/?view=rights&site=mar');
  await expect(bar(page)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Guaranteed hours' })).toBeVisible();

  const row = page.getByRole('row').filter({ hasText: person }).filter({ has: page.getByRole('button', { name: 'Make an offer' }) });
  await row.getByRole('button', { name: 'Make an offer' }).click();
  await page.getByRole('button', { name: 'Record the offer' }).click();
  await expect(page.locator('pre.letter')).toContainText(`Dear ${person.split(' ')[0]},`);
  await expect(page.locator('pre.letter')).toContainText('You do not have to accept');

  const offer = page.getByRole('row').filter({ hasText: person }).filter({ hasText: 'Waiting' });
  await offer.getByRole('button', { name: 'Declined' }).click();
  await expect(page.getByRole('row').filter({ hasText: person }).filter({ hasText: 'Declined' })).toBeVisible();
  expect(errors).toEqual([]);
});
