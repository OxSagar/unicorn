import { _electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppCommand, AppSettings, AppSnapshot, CommandResult } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { BrowserFixtures } from '../fixtures/servers';

export interface Harness {
  app: ElectronApplication;
  page: Page;
  directory: string;
  configPath: string;
}
interface Runtime {
  manager: { getWebContents(id: number): Electron.WebContents };
  controller: { snapshot(): AppSnapshot };
}

export async function launchUnicorn(
  fixtures: BrowserFixtures,
  options: { directory?: string; proxyCount?: number; settings?: Partial<AppSettings> } = {},
): Promise<Harness> {
  const directory = options.directory ?? (await mkdtemp(join(tmpdir(), 'unicorn-e2e-')));
  const settings: AppSettings = {
    ...structuredClone(DEFAULT_SETTINGS),
    browserCount: 1,
    authorizedDomains: ['127.0.0.1', 'localhost'],
    allowLocalhost: true,
    stagingConfirmed: true,
    dailyNavigationLimit: 5000,
    retryLimit: 0,
    proxyTimeoutMs: 3000,
    resourceLimitMb: 65536,
    timings: {
      landingWaitMs: 50,
      landingScrollMs: 100,
      internalWaitMs: 50,
      internalScrollMs: 100,
      externalWaitMs: 50,
      externalScrollMs: 100,
      navigationTimeoutMs: 6000,
      maxScrollPx: 1000,
    },
    ...options.settings,
  };
  const configPath = join(directory, 'fixture-config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      userData: join(directory, 'profile'),
      settings,
      diagnosticUrl: fixtures.diagnosticUrl,
      proxies: fixtures.proxies.slice(0, options.proxyCount ?? 20).map((proxy) => proxy.record),
    }),
  );
  const app = await _electron.launch({
    args: ['.'],
    cwd: process.cwd(),
    env: { ...process.env, UNICORN_E2E: '1', UNICORN_TEST_CONFIG: configPath },
    timeout: 45000,
  });
  try {
    let host: Page | undefined;
    await expect
      .poll(
        () => {
          host = app.windows().find((page) => page.url().endsWith('/renderer/index.html'));
          return Boolean(host);
        },
        { timeout: 45000, message: 'The trusted Unicorn dashboard must finish loading' },
      )
      .toBe(true);
    const page = host!;
    await expect
      .poll(
        () =>
          app.evaluate(() => Boolean((globalThis as unknown as { __unicornTest?: Runtime }).__unicornTest)),
        { timeout: 20000 },
      )
      .toBe(true);
    await page.waitForFunction(() => Boolean(window.unicorn), undefined, { timeout: 20000 });
    await page.waitForFunction(
      async () => (await window.unicorn.invoke({ type: 'snapshot' })).snapshot.browsers.length > 0,
    );
    return { app, page, directory, configPath };
  } catch (error) {
    await app.close().catch(() => app.process().kill());
    throw error;
  }
}
export function invoke(harness: Harness, command: AppCommand): Promise<CommandResult> {
  return harness.page.evaluate((value) => window.unicorn.invoke(value), command);
}
export function snapshot(harness: Harness): Promise<AppSnapshot> {
  return harness.app.evaluate(() =>
    (globalThis as unknown as { __unicornTest: Runtime }).__unicornTest.controller.snapshot(),
  );
}
export function browserEvaluate<T>(harness: Harness, id: number, source: string): Promise<T> {
  return harness.app.evaluate(
    (_electron, input) =>
      (globalThis as unknown as { __unicornTest: Runtime }).__unicornTest.manager
        .getWebContents(input.id)
        .executeJavaScript(input.source),
    { id, source },
  );
}
export async function closeHarness(harness: Harness | undefined): Promise<void> {
  if (!harness) return;
  await harness.app.close();
}
