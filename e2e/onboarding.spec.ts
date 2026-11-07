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
  await expect(page.getByText(/1 person ready to add/)).toBeVisible();
  await expect(page.getByText(/Row 4 \(Morgan Blake\)/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Map the columns with Shifty' })).toBeVisible();
  await page.screenshot({ path: 'test-results/import.png', fullPage: true });
});

test('Import previews training certificates from an export, matched to the courses inspectors ask for', async ({ page }) => {
  await signIn(page, '/app/?view=setup');
  await page.getByRole('button', { name: /Import$/ }).click();
  await page.getByRole('tab', { name: /Training/ }).click();
  const org = await (await page.request.get('/v1/employees')).json() as { name: string; status?: string }[];
  const someone = org.find((e) => e.status !== 'leaver')!.name;
  const csv = ['Employee,Course,Date Completed,Expiry', `${someone},Level 2 Food Safety,12/03/2024,`, 'Nobody Known,Allergens,01/01/2025,'].join('\n');
  await page.locator('.import-panel input[type=file]').setInputFiles({ name: 'training.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText('Food hygiene level 2')).toBeVisible();
  await expect(page.getByText(/Not on Preshift Rota: Nobody Known \(1\)/)).toBeVisible();
  await page.screenshot({ path: 'test-results/import-training.png', fullPage: true });
});

test('Import adds past hours from a timesheet and undoes the upload', async ({ page }) => {
  await signIn(page, '/app/?view=setup');
  await page.getByRole('button', { name: /Import$/ }).click();
  await page.getByRole('tab', { name: /Past hours/ }).click();
  const org = await (await page.request.get('/v1/employees')).json() as { name: string; status?: string }[];
  const someone = org.find((e) => e.status !== 'leaver')!.name;
  const day = new Date(Date.now() - 20 * 86_400_000);
  const d = `${String(day.getDate()).padStart(2, '0')}/${String(day.getMonth() + 1).padStart(2, '0')}/${day.getFullYear()}`;
  const csv = ['Timesheet export', 'Employee,Date,Clock In,Clock Out,Break', `${someone},${d},09:00,17:30,30`, 'Total,,,,'].join('\n');
  await page.locator('.import-panel input[type=file]').setInputFiles({ name: 'timesheet.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText(/1 day worked, 8h in all/)).toBeVisible();
  await page.getByRole('button', { name: 'Add 1 day worked' }).click();
  await expect(page.getByText(/1 saved\./)).toBeVisible();
  const row = page.locator('tr', { hasText: 'timesheet.csv' }).first();
  await expect(row).toBeVisible();
  page.once('dialog', (dlg) => void dlg.accept());
  await row.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByText(/Undone: everything from that upload is back as it was/)).toBeVisible();
  await page.screenshot({ path: 'test-results/import-undo.png', fullPage: true });
});
