import { expect, test, type Page } from '@playwright/test';

// Dragging a shift's finish past midnight. It moves a shift, which only a local development build
// allows, so it never runs against a deployed site. It drags the shift back when it is done.

test.skip(!!process.env.PRESHIFT_E2E_URL, 'Moves shifts: runs against the local demo only');

const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });

async function openTimeline(page: Page) {
  await page.goto('/login?next=/app/');
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill('dev@preshift.local');
  await form.locator('input[name=password]').fill('preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(bar(page)).toBeVisible();
  await page.getByRole('button', { name: 'Site or company' }).click();
  await page.locator('.sp-option').filter({ has: page.locator('.sp-name').getByText('Marylebone', { exact: true }) }).click();
  await bar(page).getByRole('button', { name: 'Rota', exact: true }).click();
  await page.getByRole('tab', { name: 'Service timeline' }).click();
  await expect(page.locator('.tl-lane').first()).toBeVisible();
  if ((await page.locator('.tl-bar').count()) === 0) await page.getByRole('button', { name: 'Build from forecast' }).click();
  await expect(page.locator('.tl-bar').first()).toBeVisible();
}

/** The hours in a bar's title, as minutes from the start of its day: a finish before the start is the next morning. */
function hoursOf(title: string) {
  const [, a, b] = title.match(/(\d\d:\d\d)-(\d\d:\d\d)/) ?? [];
  const m = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const start = m(a);
  const end = m(b) <= start ? m(b) + 1440 : m(b);
  return { start, end };
}

test('the finish of a closing shift drags past midnight and the day widens to show it', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openTimeline(page);

  // The latest finishing shift. Ryan Walsh is only
  // available until midnight in the sample, so his shift rightly stops there: use someone else's.
  const bars = page.locator('.tl-bar');
  const titles = () => bars.evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''));
  // Titles carry warnings on new lines, which a CSS selector cannot quote: find the bar by position.
  const barWith = async (title: string) => bars.nth((await titles()).indexOf(title));
  const title = (await titles()).filter((t) => !t.startsWith('Ryan Walsh')).reduce((a, b) => (hoursOf(b).end > hoursOf(a).end ? b : a));
  const before = hoursOf(title);
  const who = title.slice(0, title.search(/\d\d:\d\d-/));
  const same = (t: string) => t.startsWith(who) && hoursOf(t).start === before.start;
  const shift = await barWith(title);
  await shift.scrollIntoViewIfNeeded();
  const hoursBefore = await page.locator('.tl-hour').count();

  // Drag the finish three hours on, a step at a time: the day widens as it goes past the edge.
  const hour = (await page.locator('.tl-hour').nth(1).boundingBox())!.x - (await page.locator('.tl-hour').nth(0).boundingBox())!.x;
  const edge = (await shift.locator('.tl-edge.end').boundingBox())!;
  const at = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 3 * hour, at.y, { steps: 30 });
  await page.mouse.up();

  await expect.poll(async () => (await titles()).some((t) => same(t) && hoursOf(t).end === before.end + 180)).toBe(true);
  expect(await page.locator('.tl-hour').count()).toBeGreaterThan(hoursBefore);

  // Put it back: Alt, Shift and the up arrow shorten the finish a quarter hour at a time.
  const moved = (await titles()).find((t) => same(t) && hoursOf(t).end === before.end + 180)!;
  // Each press is saved and drawn again before the next, which acts on the shift as it then stands.
  for (let m = hoursOf(moved).end; m > before.end; m -= 15) {
    const now = (await titles()).find((t) => same(t) && hoursOf(t).end === m)!;
    await (await barWith(now)).focus();
    await page.keyboard.press('Alt+Shift+ArrowUp');
    await expect.poll(async () => (await titles()).some((t) => same(t) && hoursOf(t).end === m - 15)).toBe(true);
  }
  await expect.poll(async () => (await titles()).includes(title)).toBe(true);
  expect(errors).toEqual([]);
});
