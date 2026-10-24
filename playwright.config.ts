import { defineConfig, devices } from '@playwright/test';

// Browser checks against the real app. By default they start the API and the web app together, as in
// npm run dev, and sign in as the local dev user. Set PRESHIFT_E2E_URL to check a deployed site
// instead, with PRESHIFT_E2E_EMAIL and PRESHIFT_E2E_PASSWORD for an admin account there, or
// PRESHIFT_E2E_DEMO=1 to go in through its public demo, one sandbox for the whole run. The checks
// only navigate: they never build, clear, publish or save.
const target = process.env.PRESHIFT_E2E_URL;
const demo = !!target && !!process.env.PRESHIFT_E2E_DEMO;
/** The demo sandbox's session, started once by e2e/demo.setup.ts and shared by every test. */
export const DEMO_SESSION = 'test-results/.demo-session.json';
const browser = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } };

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: target ?? 'http://localhost:5173', trace: 'retain-on-failure' },
  projects: demo
    ? [
        { name: 'demo', testMatch: /demo\.setup\.ts/, use: browser },
        { name: 'chromium', dependencies: ['demo'], use: { ...browser, storageState: DEMO_SESSION } },
      ]
    : [{ name: 'chromium', testIgnore: /demo\.setup\.ts/, use: browser }],
  webServer: target
    ? undefined
    : {
        command: 'npm run dev',
        // The plain sample, without the worked history: these checks build and move this week's shifts.
        env: { PRESHIFT_SAMPLE_HISTORY: '0' },
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
