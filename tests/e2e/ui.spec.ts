import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixtures, type BrowserFixtures } from '../fixtures/servers';
import { browserEvaluate, closeHarness, invoke, launchUnicorn, snapshot, type Harness } from './helpers';
import { DEFAULT_SETTINGS, DEVICES } from '../../src/shared/defaults';

let fixtures: BrowserFixtures;
let harness: Harness | undefined;
test.beforeAll(async () => {
  fixtures = await createFixtures(4);
});
test.afterEach(async () => {
  await closeHarness(harness);
  harness = undefined;
});
test.afterAll(async () => {
  await fixtures.close();
});

async function visibleViews(
  current: Harness,
): Promise<Array<{ x: number; y: number; width: number; height: number }>> {
  return current.app.evaluate(({ BrowserWindow, WebContentsView }) => {
    const host = BrowserWindow.getAllWindows()[0];
    if (!host) return [];
    return host.contentView.children
      .filter(
        (child) =>
          child instanceof WebContentsView &&
          child.webContents.id !== host.webContents.id &&
          child.getVisible(),
      )
      .map((child) => child.getBounds());
  });
}

test('UI distribution prepares real jobs and Start executes them through the browser engine', async () => {
  harness = await launchUnicorn(fixtures, { settings: { browserCount: 2 } });
  const page = harness.page;
  await expect(page.getByRole('heading', { name: 'Browsers', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Links/ }).click();
  await page
    .getByLabel('One URL per line')
    .fill(`${fixtures.httpOrigin}/?first\n${fixtures.httpOrigin}/?second`);
  for (const checkbox of await page.locator('.profile-picker input').all()) await checkbox.check();
  await page.getByRole('button', { name: 'Distribute 2 URLs' }).click();
  await expect
    .poll(async () => (await snapshot(harness!)).jobs.filter((job) => job.status === 'pending').length)
    .toBe(2);
  expect(new Set((await snapshot(harness)).jobs.map((job) => job.browserId)).size).toBe(2);
  await page.getByRole('button', { name: 'Start tests', exact: true }).click();
  await expect
    .poll(async () => (await snapshot(harness!)).jobs.filter((job) => job.status === 'completed').length, {
      timeout: 30000,
    })
    .toBe(2);
  expect(fixtures.requests.some((request) => request.path === '/internal' && request.proxied)).toBe(true);
});

test('original URL drafts survive import, distribution, page changes and restart until explicitly cleared', async () => {
  harness = await launchUnicorn(fixtures);
  const directory = harness.directory;
  let page = harness.page;
  await page.getByRole('button', { name: /^Links/ }).click();
  const original = `\n  ${fixtures.httpOrigin}/?raw=one&order=2  \n\n${fixtures.httpOrigin}/?raw=two\n`;
  const imported = `${fixtures.httpOrigin}/?imported=a,b`;
  const expected = `${original}${imported}`;
  const importPath = join(directory, 'original-links.csv');
  await writeFile(importPath, `name,url\nthird,"${imported}"\n`);
  await page.getByLabel('One URL per line').fill(original);
  // Replace only the OS picker. The real import command reads and parses this CSV.
  await harness.app.evaluate(({ dialog }, filePath) => {
    const originalPicker = dialog.showOpenDialog;
    dialog.showOpenDialog = (async () => {
      dialog.showOpenDialog = originalPicker;
      return { canceled: false, filePaths: [filePath] };
    }) as typeof dialog.showOpenDialog;
  }, importPath);
  await page.getByRole('button', { name: 'Import TXT / CSV', exact: true }).click();
  await expect(page.getByLabel('One URL per line')).toHaveValue(expected);
  await page.locator('.profile-picker input').first().check();
  await page.getByRole('button', { name: 'Distribute 3 URLs', exact: true }).click();
  await expect
    .poll(async () => (await snapshot(harness!)).jobs.filter((job) => job.status === 'pending').length)
    .toBe(3);
  await expect(page.getByLabel('One URL per line')).toHaveValue(expected);

  await page.getByLabel('One URL per line').fill('x'.repeat(2_000_001));
  await expect(page.getByLabel('One URL per line')).toHaveValue(expected);
  await expect(page.getByText('Your previous text was kept', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: /^Links/ }).click();
  await expect(page.getByLabel('One URL per line')).toHaveValue(expected);

  await closeHarness(harness);
  harness = undefined;
  harness = await launchUnicorn(fixtures, { directory });
  page = harness.page;
  await page.getByRole('button', { name: /^Links/ }).click();
  await expect(page.getByLabel('One URL per line')).toHaveValue(expected);
  await page.getByRole('button', { name: 'Clear input', exact: true }).click();
  await expect(page.getByLabel('One URL per line')).toHaveValue('');
  expect((await snapshot(harness)).jobs.filter((job) => job.status === 'pending')).toHaveLength(3);

  await closeHarness(harness);
  harness = undefined;
  harness = await launchUnicorn(fixtures, { directory });
  await harness.page.getByRole('button', { name: /^Links/ }).click();
  await expect(harness.page.getByLabel('One URL per line')).toHaveValue('');
});

test('pending queue edits support Cancel, reject unapproved URLs and wait for Start before browsing', async ({}, testInfo) => {
  harness = await launchUnicorn(fixtures, { settings: { browserCount: 2 } });
  const page = harness.page;
  const original = `${fixtures.httpOrigin}/before-edit`;
  const edited = `${fixtures.httpOrigin}/edited?order=a%2Cb`;
  await page.getByRole('button', { name: /^Links/ }).click();
  await page.getByLabel('One URL per line').fill(original);
  for (const checkbox of await page.locator('.profile-picker input').all()) await checkbox.uncheck();
  await page.locator('.profile-picker input').first().check();
  await page.getByRole('button', { name: 'Distribute 1 URL', exact: true }).click();
  await expect.poll(async () => (await snapshot(harness!)).jobs.length).toBe(1);
  const requestsBeforeEdit = fixtures.requests.length;

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page
    .getByLabel('Edit destination URL', { exact: true })
    .fill(`${fixtures.httpOrigin}/cancelled-edit`);
  await page.getByLabel('Edit assigned browser', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await snapshot(harness)).jobs[0]).toMatchObject({
    url: original,
    browserId: 1,
    status: 'pending',
  });
  await expect(page.getByLabel('Edit destination URL', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Edit destination URL', { exact: true }).fill('https://unapproved.invalid/');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('The edit was not saved.', { exact: false })).toBeVisible();
  expect((await snapshot(harness)).jobs[0]).toMatchObject({ url: original, browserId: 1, status: 'pending' });
  await expect(page.getByLabel('Edit destination URL', { exact: true })).toHaveValue(
    'https://unapproved.invalid/',
  );

  await page.getByLabel('Edit destination URL', { exact: true }).fill(edited);
  await page.getByLabel('Edit assigned browser', { exact: true }).selectOption('2');
  await testInfo.attach('pending-queue-editor.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect
    .poll(async () => (await snapshot(harness!)).jobs[0])
    .toMatchObject({ url: edited, browserId: 2, status: 'pending' });
  await expect(page.getByLabel('Edit destination URL', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('One URL per line')).toHaveValue(original);
  expect((await snapshot(harness)).browsers.every((browser) => !browser.url)).toBe(true);
  expect(fixtures.requests.length).toBe(requestsBeforeEdit);

  await page.getByRole('button', { name: 'Start tests', exact: true }).click();
  await expect
    .poll(async () => (await snapshot(harness!)).jobs[0]?.status, { timeout: 30000 })
    .toBe('completed');
  expect(
    fixtures.requests
      .slice(requestsBeforeEdit)
      .some((request) => request.path === '/edited' && request.proxied),
  ).toBe(true);
  expect(
    fixtures.requests
      .slice(requestsBeforeEdit)
      .some((request) => ['/before-edit', '/cancelled-edit'].includes(request.path)),
  ).toBe(false);
  expect((await snapshot(harness)).browsers.find((browser) => browser.id === 1)?.url).toBe('');
});

test('native browser views stay inside the workspace and hide under dialogs and other pages', async ({}, testInfo) => {
  harness = await launchUnicorn(fixtures, { settings: { browserCount: 2 } });
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/` });
  const page = harness.page;
  await expect.poll(async () => (await visibleViews(harness!)).length).toBe(1);
  const clip = await page.locator('.browser-scroll').boundingBox();
  expect(clip).toBeTruthy();
  const view = (await visibleViews(harness))[0];
  expect(view.x).toBeGreaterThanOrEqual(Math.floor(clip!.x));
  expect(view.y).toBeGreaterThanOrEqual(Math.floor(clip!.y));
  expect(view.x + view.width).toBeLessThanOrEqual(Math.ceil(clip!.x + clip!.width));
  expect(view.y + view.height).toBeLessThanOrEqual(Math.ceil(clip!.y + clip!.height));

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect.poll(async () => (await visibleViews(harness!)).length).toBe(0);
  await page.getByRole('button', { name: /^Browsers/ }).click();
  await expect.poll(async () => (await visibleViews(harness!)).length).toBe(1);
  await page.getByRole('button', { name: 'Inspect browser 1', exact: true }).click();
  await page.locator('summary').filter({ hasText: 'Profile data' }).click();
  await page.getByRole('button', { name: 'Reset complete profile', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect.poll(async () => (await visibleViews(harness!)).length).toBe(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(async () => (await visibleViews(harness!)).length).toBe(1);
  expect((await snapshot(harness)).browsers[0]?.url).toContain(fixtures.httpOrigin);
  await testInfo.attach('native-view-layout.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('four-page navigation, browser count and basic device choices operate real browser profiles', async ({}, testInfo) => {
  harness = await launchUnicorn(fixtures);
  const page = harness.page;
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('button')).toHaveCount(4);
  for (const name of [/^Browsers/, /^Links/, /^Proxies/, /^Settings/])
    await expect(navigation.getByRole('button', { name })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Browsers', exact: true })).toBeVisible();
  await page.getByLabel('Browser count', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.locator('.browser-card')).toHaveCount(2);
  await page.getByLabel('Select all browsers', { exact: true }).check();
  await page.getByRole('button', { name: 'Mobile', exact: true }).click();
  await expect
    .poll(async () => (await snapshot(harness!)).browsers.map((browser) => browser.device.preset))
    .toEqual(['mobile', 'mobile']);
  await page.getByLabel('Select browser 2', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Tablet', exact: true }).click();
  await expect
    .poll(async () => (await snapshot(harness!)).browsers.map((browser) => browser.device.preset))
    .toEqual(['tablet', 'mobile']);

  for (const id of [1, 2]) {
    await page.getByLabel(`Address for browser ${id}`, { exact: true }).fill(`${fixtures.httpOrigin}/`);
    await page.getByLabel(`Address for browser ${id}`, { exact: true }).press('Enter');
    await expect.poll(async () => (await snapshot(harness!)).browsers[id - 1]?.loading).toBe(false);
    await expect.poll(() => browserEvaluate(harness!, id, 'window.fixtureReady')).toBe(true);
    const expected = id === 1 ? DEVICES.tablet : DEVICES.mobile;
    await expect
      .poll(() =>
        browserEvaluate(
          harness!,
          id,
          `({ width: innerWidth, dpr: devicePixelRatio, touch: navigator.maxTouchPoints > 0 })`,
        ),
      )
      .toEqual({ width: expected.width, dpr: expected.scaleFactor, touch: expected.touch });
  }
  await testInfo.attach('simple-browser-workspace.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await navigation.getByRole('button', { name: 'Proxies', exact: true }).click();
  await expect(page.getByLabel('Eligible countries')).toContainText('Austria');
  await expect(page.getByRole('columnheader', { name: 'API-reported country', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /validate/i })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: /exit|latency|verified/i })).toHaveCount(0);
  await testInfo.attach('simple-proxies.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('simple Settings preserve advanced saved values and reflect Stop disabling recurrence', async ({}, testInfo) => {
  const timings = { ...DEFAULT_SETTINGS.timings, landingWaitMs: 1234, maxScrollPx: 4567 };
  const schedule = {
    enabled: true,
    intervalMinutes: 42,
    startHour: 5,
    endHour: 21,
    resumeAfterRestart: true,
  };
  const preserved = {
    dailyNavigationLimit: 321,
    dailyRequestLimit: 9876,
    excludedLinkPatterns: ['*://example.test/skip/*'],
    retryLimit: 3,
    proxyRefreshMinutes: 17,
    closePopupsAfterRun: false,
    resourceLimitMb: 54321,
    logRetentionDays: 13,
    timings,
  };
  harness = await launchUnicorn(fixtures, { settings: { ...preserved, schedule } });
  const page = harness.page;
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Settings', exact: true })
    .click();
  await expect(page.getByRole('switch', { name: 'Repeat the reviewed queue', exact: true })).toBeChecked();
  await page.getByLabel('Repeat every (minutes)', { exact: true }).fill('37');
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(async () => (await snapshot(harness!)).settings.theme).toBe('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect((await snapshot(harness)).settings).toMatchObject({
    ...preserved,
    theme: 'light',
    schedule: { ...schedule, intervalMinutes: 37 },
  });

  // A stop changes the backend while this form remains mounted. Saving another
  // visible preference must retain that newer state, not silently restart repetition.
  await page.getByRole('button', { name: 'Stop all', exact: true }).click();
  await expect(
    page.getByRole('switch', { name: 'Repeat the reviewed queue', exact: true }),
  ).not.toBeChecked();
  await page.getByLabel('Appearance', { exact: true }).selectOption('dark');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(async () => (await snapshot(harness!)).settings.theme).toBe('dark');
  expect((await snapshot(harness)).settings).toMatchObject({
    ...preserved,
    theme: 'dark',
    schedule: { ...schedule, enabled: false, intervalMinutes: 37 },
  });
  await expect(page.getByRole('button', { name: 'Export logs', exact: true })).not.toBeVisible();
  await page.locator('summary').filter({ hasText: 'Troubleshooting' }).click();
  await expect(page.getByRole('button', { name: 'Export logs', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export results', exact: true })).toBeVisible();
  await testInfo.attach('simple-settings.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});
