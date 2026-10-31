import { expect, test, type Page } from './fixtures';

// The Gantt view: the week as one line per person, a day by the hour, and a bar dragged an hour
// later. It moves a shift, which only a local development build allows, so it never runs against a
// deployed site. It drags the shift back when it is done.

test.skip(!!process.env.PRESHIFT_E2E_URL, 'Moves shifts: runs against the local demo only');

const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });

async function openGantt(page: Page) {
  await page.goto('/login?next=/app/');
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill('dev@preshift.local');
  await form.locator('input[name=password]').fill('preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(bar(page)).toBeVisible();
  await page.getByRole('button', { name: 'Site or company' }).click();
  await page.locator('.sp-option').filter({ has: page.locator('.sp-name').getByText('Marylebone', { exact: true }) }).click();
  // Rota sits in the Planning menu of the bar.
  await bar(page).locator('[data-group="planning"] .nav-toggle').click();
  await bar(page).getByRole('button', { name: 'Rota', exact: true }).click();
  await page.getByRole('tab', { name: 'Gantt' }).click();
  await expect(page.locator('.gantt-axis')).toBeVisible();
  if ((await page.locator('.gantt-bar').count()) === 0) await page.getByRole('button', { name: 'Build from forecast' }).click();
  await expect(page.locator('.gantt-bar').first()).toBeVisible();
}

const timesOf = (title: string | null) => (title ?? '').match(/(\d\d:\d\d)-(\d\d:\d\d)/)?.slice(1) ?? [];

test('the week reads one line per person, a day opens by the hour, and a bar drags an hour later', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openGantt(page);

  // Seven days across, people grouped by department.
  await expect(page.locator('.gantt-day')).toHaveCount(7);
  await expect(page.locator('.gantt-group').first()).toBeVisible();

  // A day's name opens it by the hour, with heads on against heads needed beneath. The build leaves
  // the days already gone empty, so open a day it filled: the one the first bar is on, which is
  // today or later whatever day of the week the check runs.
  const firstDay = (await page.locator('.gantt-bar').first().getAttribute('title'))?.match(/: (\w{3}) \d\d:\d\d/)?.[1];
  expect(firstDay).toBeTruthy();
  await page.locator(`.gantt-day[title="Open ${firstDay} by the hour"]`).click();
  await expect(page.getByRole('tab', { name: 'Day' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.gantt-hour').first()).toBeVisible();
  await expect(page.locator('.gantt-head').first()).toBeVisible();

  // Drag the first person's first bar one hour later, then back.
  const line = page.locator('.gantt-track[data-emp]').first();
  const emp = await line.getAttribute('data-emp');
  const shift = page.locator(`.gantt-track[data-emp="${emp}"] button.gantt-bar`).first();
  const [start] = timesOf(await shift.getAttribute('title'));
  const track = (await line.boundingBox())!;
  const hour = track.width / (await page.locator('.gantt-hour').count());
  async function drag(dx: number) {
    // Other checks move Marylebone's shifts at the same time, which can re-sort the lines under the
    // pointer: press only once the bar has held still and is really what lies under that point.
    // The decisions and notices above the rota can leave the first line at the foot of the screen,
    // under the Ask Shifty button: bring the bar to the middle first, as a person would scroll to it.
    await shift.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    let box = { x: 0, y: 0, width: 0, height: 0 };
    await expect
      .poll(async () => {
        await page.waitForLoadState('networkidle');
        const next = (await shift.boundingBox())!;
        const still = Math.abs(next.x - box.x) < 1 && Math.abs(next.y - box.y) < 1;
        box = next;
        const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        return still && (await shift.evaluate((el, p) => el.contains(document.elementFromPoint(p.x, p.y)), at));
      }, { intervals: [250], timeout: 15_000 })
      .toBe(true);
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx / 2, y, { steps: 5 });
    await page.mouse.move(box.x + box.width / 2 + dx, y, { steps: 5 });
    await page.mouse.up();
  }
  await drag(hour);
  const later = `${String(Number(start.slice(0, 2)) + 1).padStart(2, '0')}${start.slice(2)}`;
  await expect.poll(async () => timesOf(await shift.getAttribute('title'))[0]).toBe(later);
  await drag(-hour);
  await expect.poll(async () => timesOf(await shift.getAttribute('title'))[0]).toBe(start);

  expect(errors).toEqual([]);
});
