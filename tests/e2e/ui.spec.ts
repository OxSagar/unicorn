import { expect, test } from '@playwright/test';
import { createFixtures, type BrowserFixtures } from '../fixtures/servers';
import { closeHarness, invoke, launchUnicorn, snapshot, type Harness } from './helpers';

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
  await expect(page.getByRole('heading', { name: 'Workspace overview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Link distribution/ }).click();
  await page
    .getByLabel('One URL per line')
    .fill(`${fixtures.httpOrigin}/?first\n${fixtures.httpOrigin}/?second`);
  for (const checkbox of await page.locator('.profile-picker input').all()) await checkbox.check();
  await page.getByRole('radio').nth(1).check();
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

  await page.getByRole('button', { name: 'Device profiles', exact: true }).click();
  await expect.poll(async () => (await visibleViews(harness!)).length).toBe(0);
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await expect.poll(async () => (await visibleViews(harness!)).length).toBe(1);
  await page.getByRole('button', { name: 'Inspect browser 1', exact: true }).click();
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

test('device and settings pages apply validated changes, including light theme, without fake state', async () => {
  harness = await launchUnicorn(fixtures);
  const page = harness.page;
  await page.getByRole('button', { name: 'Device profiles', exact: true }).click();
  await page.getByRole('button', { name: /^Mobile 390/ }).click();
  await page.getByRole('button', { name: 'Apply to all', exact: true }).click();
  await expect.poll(async () => (await snapshot(harness!)).browsers[0]?.device.preset).toBe('mobile');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect.poll(async () => (await snapshot(harness!)).settings.theme).toBe('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await expect(page.locator('.browser-card')).toHaveCount(1);
  await expect(page.locator('.browser-tags')).toContainText('mobile');
});
