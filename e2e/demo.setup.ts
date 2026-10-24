import { expect, test as setup } from '@playwright/test';
import { DEMO_SESSION } from '../playwright.config';

// The public demo allows ten sandboxes per visitor address a day, and one run of the checks has more
// tests than that. So a run starts one sandbox, as a single visitor would, and every test goes in
// with its session. The checks only navigate, and anything a test changes lives in its own browser.
setup('start one demo sandbox for the run', async ({ page }) => {
  await page.goto('/demo');
  await page.getByRole('button', { name: 'Start the demo' }).click();
  // Building a fresh sandbox takes the live site around six seconds, longer than a check's usual wait.
  await expect(page.getByRole('navigation', { name: 'Management' })).toBeVisible({ timeout: 30_000 });
  await page.context().storageState({ path: DEMO_SESSION });
});
