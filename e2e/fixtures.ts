import { test as base } from '@playwright/test';

export { expect } from '@playwright/test';
export type { APIRequestContext, Page } from '@playwright/test';

/**
 * The browser checks, with the week's What's new kept from popping up by itself: it would sit over
 * every screen they check. e2e/whatsNew.spec.ts turns it back on to check the pop-up itself.
 */
export const test = base.extend<{ whatsNewPopsUp: boolean }>({
  whatsNewPopsUp: [false, { option: true }],
  page: async ({ page, whatsNewPopsUp }, use) => {
    if (!whatsNewPopsUp) await page.addInitScript(() => localStorage.setItem('preshift.whatsnew.auto', 'off'));
    await use(page);
  },
});
