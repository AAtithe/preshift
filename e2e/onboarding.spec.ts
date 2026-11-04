import { expect, test, type Page } from './fixtures';

// Getting started and Set-up, Import as an owner sees them. Navigation and a preview only: nothing is saved.

async function signIn(page: Page, next: string) {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  const form = page.locator('form[action="/auth/login"]');
  await form.locator('input[name=email]').fill(process.env.PRESHIFT_E2E_EMAIL ?? 'dev@preshift.local');
  await form.locator('input[name=password]').fill(process.env.PRESHIFT_E2E_PASSWORD ?? 'preshift-dev-password');
  await form.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Management' })).toBeVisible();
}

test('Getting started shows the plan and its next step', async ({ page }) => {
  await signIn(page, '/app/?view=golive');
  await expect(page.locator('.golive')).toBeVisible();
  await expect(page.locator('.golive .kpi-label', { hasText: 'Progress' })).toBeVisible();
  await expect(page.getByText('Secure the account')).toBeVisible();
  await expect(page.getByText('Holiday balances carried in')).toBeVisible();
  await page.screenshot({ path: 'test-results/golive.png', fullPage: true });
});

test('Import reads a team export, maps its columns and previews it without saving', async ({ page }) => {
  await signIn(page, '/app/?view=setup');
  await page.getByRole('button', { name: /Import$/ }).click();
  await expect(page.getByRole('button', { name: 'Download the Excel template' })).toBeVisible();
  const csv = [
    'Roster system export',
    'Team Member,Job,Hourly Rate,Date of Birth,Hire Date',
    'Taylor Quinn,Server,12.71,30/06/1990,02/09/2021',
    'Morgan Blake,Head Chef,15.50,,',
  ].join('\n');
  await page.locator('.import-panel input[type=file]').setInputFiles({ name: 'export.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('Columns in export.csv')).toBeVisible();
  await expect(page.getByText(/1 ready to add/)).toBeVisible();
  await expect(page.getByText(/Row 4 \(Morgan Blake\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Map the columns with Shifty' })).toBeVisible();
  await page.screenshot({ path: 'test-results/import.png', fullPage: true });
});
