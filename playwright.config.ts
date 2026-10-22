import { defineConfig, devices } from '@playwright/test';

// Browser checks against the real app. By default they start the API and the web app together, as in
// npm run dev, and sign in as the local dev user. Set PRESHIFT_E2E_URL to check a deployed site
// instead, with PRESHIFT_E2E_EMAIL and PRESHIFT_E2E_PASSWORD for an admin account there. The checks
// only navigate: they never build, clear, publish or save.
const target = process.env.PRESHIFT_E2E_URL;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: target ?? 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: target
    ? undefined
    : {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
