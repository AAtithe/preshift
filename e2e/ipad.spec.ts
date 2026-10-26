import { devices } from '@playwright/test';
import { expect, test, type Page } from './fixtures';
import { NAV } from '../src/ui/nav';

// The rota on an iPad-sized touch screen. Chromium stands in for Safari here, so this catches
// touch handling we control (hold to lift, swipe to scroll, the tap that opens the picker) but
// not Safari's own quirks: a real iPad still gets a run before a client sees a release.

const { defaultBrowserType: _browser, ...ipad } = devices['iPad Pro 11 landscape'];
test.use({ ...ipad });
// They share one server's rota for the week, so they take turns.
test.describe.configure({ mode: 'serial' });
// They build, move and stretch shifts, so they run against the local server only: checks of a
// deployed site only navigate.
test.skip(!!process.env.PRESHIFT_E2E_URL, 'Changes the rota, so local only');

const bar = (page: Page) => page.getByRole('navigation', { name: 'Management' });

/** Opens a section from the bar, unfolding its group first if it is folded away. */
async function go(page: Page, label: string) {
  const group = NAV.find((g) => g.items.some((t) => t.label === label))!;
  const toggle = page.locator(`[data-group="${group.id}"] .nav-toggle`);
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await bar(page).getByRole('button', { name: label, exact: true }).click();
}

async function openTimeline(page: Page) {
  await page.goto('/login?next=/app/');
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill('dev@preshift.local');
  await form.locator('input[name=password]').fill('preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(bar(page)).toBeVisible();
  // Marylebone, from the scope picker in the heading.
  await page.getByRole('button', { name: 'Site or company' }).click();
  await page.locator('.sp-option').filter({ has: page.locator('.sp-name').getByText('Marylebone', { exact: true }) }).click();
  await go(page, 'Rota');
  await page.getByRole('tab', { name: 'Service timeline' }).click();
  await expect(page.locator('.tl-lane').first()).toBeVisible();
  // A fresh server may have no rota this week yet: build one from the forecast to work with.
  if ((await page.locator('.tl-bar').count()) === 0) await page.getByRole('button', { name: 'Build from forecast' }).click();
  await expect(page.locator('.tl-bar').first()).toBeVisible();
  await settled(page);
}

/** API requests each page has waiting: a save or a banner still loading means the screen is about to change. */
const inFlight = new WeakMap<Page, Set<unknown>>();

/**
 * Waits until the timeline stops moving. Banners above it (what is coming up, gaps the build could not
 * fill) arrive after the rota does and push it down, a re-render puts the timeline's sideways scroll back
 * to the start, and a drop is saved and drawn again after the finger lifts. A touch aimed before that
 * lands on whatever moved into its place, so every test measures only once no API request is waiting
 * and the first lane and bar have held still for a few frames in a row.
 */
async function settled(page: Page) {
  const where = () =>
    page.evaluate(() =>
      ['.tl-plot', '.tl-bar']
        .map((s) => document.querySelector(s)?.getBoundingClientRect())
        .map((r) => (r ? `${Math.round(r.x)},${Math.round(r.y)}` : '-'))
        .join(' '),
    );
  let last = '';
  let still = 0;
  await expect
    .poll(
      async () => {
        if (inFlight.get(page)?.size) return (still = 0);
        const now = await where();
        still = now === last ? still + 1 : 0;
        last = now;
        return still;
      },
      { intervals: [100], timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(4);
}

/** Real touch events, so the browser runs its own touch-to-pointer handling as a tablet does. */
async function touch(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  return {
    /** Press, optionally hold, then slide to a point in steps and lift. */
    async drag(from: { x: number; y: number }, to: { x: number; y: number }, holdMs: number) {
      await send('touchStart', from.x, from.y);
      if (holdMs) await page.waitForTimeout(holdMs);
      for (let i = 1; i <= 10; i++) {
        await send('touchMove', from.x + ((to.x - from.x) * i) / 10, from.y + ((to.y - from.y) * i) / 10);
        await page.waitForTimeout(16);
      }
      await send('touchEnd', to.x, to.y);
    },
  };
}

/** The centre of an element, scrolled into view first: a touch outside the screen lands on nothing. */
async function centre(page: Page, selector: string, index = 0) {
  const el = page.locator(selector).nth(index);
  await el.scrollIntoViewIfNeeded();
  await settled(page);
  const box = (await el.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width };
}

/** What a touch at a point actually lands on, so a test cannot pass by touching nothing. */
const hit = (page: Page, p: { x: number; y: number }) => page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.tl-bar') !== null, p);

/** Bars re-sort after a drop, so a shift is followed by its title: name, role and hours. */
const titleOf = (page: Page, index = 0) => page.locator('.tl-bar').nth(index).getAttribute('title');
const withTitle = (page: Page, title: string | null) => page.locator(`.tl-bar[title="${title}"]`).count();

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on('pageerror', (e) => list.push(e.message));
  const waiting = new Set<unknown>();
  inFlight.set(page, waiting);
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/v1/')) waiting.add(r); });
  page.on('requestfinished', (r) => waiting.delete(r));
  page.on('requestfailed', (r) => waiting.delete(r));
  await openTimeline(page);
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

test('a quick swipe over a shift scrolls and leaves it where it was', async ({ page }) => {
  const from = await centre(page, '.tl-bar');
  expect(await hit(page, from)).toBe(true);
  const title = await titleOf(page);
  const count = await withTitle(page, title);
  await (await touch(page)).drag(from, { x: from.x + 120, y: from.y }, 0);
  await page.waitForTimeout(300);
  expect(await withTitle(page, title)).toBe(count);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('press and hold lifts a shift, a slide moves it, and sliding back puts it back', async ({ page }) => {
  const title = await titleOf(page);
  const count = await withTitle(page, title);
  // An hour's width on the axis.
  const hour = (await page.locator('.tl-hour').nth(1).boundingBox())!.x - (await page.locator('.tl-hour').nth(0).boundingBox())!.x;
  const finger = await touch(page);
  // Aimed last, straight before the finger goes down, so nothing has moved under it.
  const from = await centre(page, '.tl-bar');
  expect(await hit(page, from)).toBe(true);

  await finger.drag(from, { x: from.x + hour, y: from.y }, 450);
  await expect.poll(() => withTitle(page, title)).toBe(count - 1);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // An hour later, the same person and role: find it by its new title and slide it back.
  const later = (title ?? '').replace(/(\d\d):00-(\d\d):00/, (_m, a: string, b: string) => `${String((Number(a) + 1) % 24).padStart(2, '0')}:00-${String((Number(b) + 1) % 24).padStart(2, '0')}:00`);
  const moved = page.locator(`.tl-bar[title="${later}"]`).first();
  await expect(moved).toHaveCount(1);
  // The drop saves and re-renders, which moves things again: settle before aiming at the moved shift.
  // Brought to the middle, not just on screen: at the foot of the screen the Undo toast covers it.
  await moved.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }));
  await settled(page);
  const box = (await moved.boundingBox())!;
  const back = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(await hit(page, back)).toBe(true);
  await finger.drag(back, { x: back.x - hour, y: back.y }, 450);
  await expect.poll(() => withTitle(page, title)).toBe(count);
});

test('dragging the end of a shift changes its hours, and dragging it back restores them', async ({ page }) => {
  const bar = page.locator('.tl-bar').first();
  await bar.scrollIntoViewIfNeeded();
  await settled(page);
  const title = await titleOf(page);
  const count = await withTitle(page, title);
  const hour = (await page.locator('.tl-hour').nth(1).boundingBox())!.x - (await page.locator('.tl-hour').nth(0).boundingBox())!.x;
  const edge = (await bar.locator('.tl-edge.end').boundingBox())!;
  const from = { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 };
  const finger = await touch(page);

  await finger.drag(from, { x: from.x + hour, y: from.y }, 0);
  await expect.poll(() => withTitle(page, title)).toBe(count - 1);
  const longer = (title ?? '').replace(/-(\d\d):00/, (_m, b: string) => `-${String((Number(b) + 1) % 24).padStart(2, '0')}:00`);
  const stretched = page.locator(`.tl-bar[title="${longer}"]`).first();
  await expect(stretched).toHaveCount(1);
  await stretched.scrollIntoViewIfNeeded();
  await settled(page);
  const end = (await stretched.locator('.tl-edge.end').boundingBox())!;
  await finger.drag({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, { x: end.x + end.width / 2 - hour, y: end.y + end.height / 2 }, 0);
  await expect.poll(() => withTitle(page, title)).toBe(count);
});

test('a tap on an empty stretch of the day opens the picker without adding anyone, and offers people to borrow', async ({ page }) => {
  const bars = await page.locator('.tl-bar').count();
  const plot = page.locator('.tl-plot').first();
  await plot.scrollIntoViewIfNeeded();
  await settled(page);
  // Early in the day, well clear of the bars and the gap strip, on a point the plot itself receives:
  // the timeline scrolls sideways, so part of the plot can sit under the day's name or off screen.
  const point = await plot.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const y = box.y + 12;
    for (let x = box.x + 4; x < box.x + box.width / 2; x += 8) {
      const at = document.elementFromPoint(x, y);
      if (at && el.contains(at) && !at.closest('.tl-cell, .tl-bar')) return { x, y };
    }
    return null;
  });
  expect(point, 'an empty, uncovered point on the first day').not.toBeNull();
  await page.touchscreen.tap(point!.x, point!.y);
  const dialog = page.getByRole('dialog', { name: 'Add a shift' });
  await expect(dialog).toBeVisible();
  // The click that follows the tap must not land on a name and add them.
  await page.waitForTimeout(600);
  await expect(dialog).toBeVisible();
  expect(await page.locator('.tl-bar').count()).toBe(bars);
  await expect(dialog.getByText(/^Borrow from/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});
