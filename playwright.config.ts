import { defineConfig } from '@playwright/test';
export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  maxFailures: process.env.CI ? 3 : undefined,
  testDir: './tests/e2e',
  timeout: 120000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }], ['junit', { outputFile: 'test-results/e2e.xml' }]],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
