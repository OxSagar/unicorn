import { expect, test } from '@playwright/test';
import { createFixtures, type BrowserFixtures } from '../fixtures/servers';
import {
  attachFailureDiagnostics,
  browserEvaluate,
  closeHarness,
  invoke,
  launchUnicornWithDiagnostics as launchUnicorn,
  snapshot,
  type Harness,
} from './helpers';
import { DEFAULT_SETTINGS, DEVICES } from '../../src/shared/defaults';
import type {
  AppCommand,
  AppSnapshot,
  CommandResult,
  DeviceConfig,
  PreparedRun,
} from '../../src/shared/types';

type Preset = 'desktop' | 'mobile' | 'tablet';
interface UiRuntime {
  manager: {
    getWebContents(id: number): Electron.WebContents;
    applyDevice(ids: number[], device: DeviceConfig, signal?: AbortSignal): Promise<void>;
  };
  controller: { command(command: AppCommand): Promise<CommandResult>; snapshot(): AppSnapshot };
  uiPending?: boolean;
  releaseUiCommand?: () => void;
}

let fixtures: BrowserFixtures;
let harness: Harness | undefined;
let origin: string;
test.beforeAll(async () => {
  fixtures = await createFixtures(4);
  if (process.platform === 'win32')
    expect(fixtures.httpsOrigin, 'Windows UI acceptance requires the trusted HTTPS fixture').toBeTruthy();
  origin = fixtures.httpsOrigin ?? fixtures.httpOrigin;
});
test.afterEach(async ({}, testInfo) => {
  try {
    if (testInfo.status !== testInfo.expectedStatus)
      await attachFailureDiagnostics(harness, fixtures, testInfo);
  } finally {
    if (harness)
      await harness.app
        .evaluate(() => {
          (globalThis as unknown as { __unicornTest: UiRuntime }).__unicornTest.releaseUiCommand?.();
        })
        .catch(() => undefined);
    await closeHarness(harness);
    harness = undefined;
  }
});
test.afterAll(async () => {
  await fixtures.close();
});

async function distribute(
  current: Harness,
  text: string,
  count = 1,
  device: Preset = 'desktop',
): Promise<PreparedRun> {
  const previous = (await snapshot(current)).preparedRun?.id;
  await current.page.getByLabel('Browser count', { exact: true }).selectOption(String(count));
  await current.page.getByLabel('Device type', { exact: true }).selectOption(device);
  await current.page.getByLabel('Paste links', { exact: true }).fill(text);
  await current.page.getByRole('button', { name: 'Distribute', exact: true }).click();
  await expect
    .poll(
      async () => {
        const review = (await snapshot(current)).preparedRun;
        return Boolean(review && review.id !== previous && review.status === 'ready');
      },
      { timeout: 30000 },
    )
    .toBe(true);
  await expect(current.page.getByRole('button', { name: 'Start', exact: true })).toBeEnabled();
  return (await snapshot(current)).preparedRun!;
}

async function startAndComplete(current: Harness, review: PreparedRun): Promise<AppSnapshot> {
  await current.page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect
    .poll(
      async () => {
        const state = await snapshot(current);
        return review.jobIds.map((id) => state.jobs.find((job) => job.id === id)?.status);
      },
      { timeout: 30000 },
    )
    .toEqual(review.jobIds.map(() => 'completed'));
  await expect.poll(async () => (await snapshot(current)).preparedRun?.status).toBe('finished');
  const state = await snapshot(current);
  expect(state.proxies.every((proxy) => proxy.assignedTo === undefined)).toBe(true);
  expect(fixtures.directRequests()).toBe(0);
  return state;
}

async function holdNextCommand(
  current: Harness,
  phase: 'distribution reply' | 'device setup',
): Promise<void> {
  await current.app.evaluate((_electron, selectedPhase) => {
    const runtime = (globalThis as unknown as { __unicornTest: UiRuntime }).__unicornTest;
    const wait = () =>
      new Promise<void>((resolve) => {
        runtime.uiPending = true;
        runtime.releaseUiCommand = () => {
          runtime.uiPending = false;
          runtime.releaseUiCommand = undefined;
          resolve();
        };
      });
    if (selectedPhase === 'distribution reply') {
      const original = runtime.controller.command.bind(runtime.controller);
      runtime.controller.command = async (command) => {
        if (command.type !== 'simple-distribute') return original(command);
        runtime.controller.command = original;
        // Prepare a real review, then delay its reply so Stop can invalidate it.
        const result = await original(command);
        await wait();
        return result;
      };
    } else {
      const original = runtime.manager.applyDevice.bind(runtime.manager);
      runtime.manager.applyDevice = async (ids, device, signal) => {
        runtime.manager.applyDevice = original;
        await wait();
        return original(ids, device, signal);
      };
    }
  }, phase);
}

async function pendingCommand(current: Harness): Promise<boolean> {
  return current.app.evaluate(() =>
    Boolean((globalThis as unknown as { __unicornTest: UiRuntime }).__unicornTest.uiPending),
  );
}

async function releaseCommand(current: Harness): Promise<void> {
  await current.app.evaluate(() => {
    (globalThis as unknown as { __unicornTest: UiRuntime }).__unicornTest.releaseUiCommand?.();
  });
}

async function expectNativeClipping(current: Harness): Promise<number[]> {
  let visibleIds: number[] = [];
  await expect
    .poll(
      async () => {
        const expected = await current.page.evaluate(() => {
          const root = document.querySelector('.browser-scroll')!.getBoundingClientRect();
          return [...document.querySelectorAll<HTMLElement>('[data-browser-id]')].map((card) => {
            const rect = card.querySelector('.browser-viewport')!.getBoundingClientRect();
            const x = Math.ceil(Math.max(0, root.left, rect.left));
            const y = Math.ceil(Math.max(0, root.top, rect.top));
            const right = Math.floor(Math.min(innerWidth, root.right, rect.right));
            const bottom = Math.floor(Math.min(innerHeight, root.bottom, rect.bottom));
            return {
              id: Number(card.dataset.browserId),
              x,
              y,
              width: Math.max(0, right - x),
              height: Math.max(0, bottom - y),
              visible: right - x > 24 && bottom - y > 24,
            };
          });
        });
        const actual = await current.app.evaluate(({ BrowserWindow, WebContentsView }) => {
          const runtime = (globalThis as unknown as { __unicornTest: UiRuntime }).__unicornTest;
          const host = BrowserWindow.getAllWindows()[0]!;
          return runtime.controller.snapshot().browsers.map((browser) => {
            const contents = runtime.manager.getWebContents(browser.id);
            const view = host.contentView.children.find(
              (candidate) => candidate instanceof WebContentsView && candidate.webContents === contents,
            );
            return { id: browser.id, visible: view?.getVisible() ?? false, ...view?.getBounds() };
          });
        });
        visibleIds = actual.filter((view) => view.visible).map((view) => view.id);
        return actual.every((view) => {
          const clip = expected.find((candidate) => candidate.id === view.id);
          if (!clip?.visible) return !view.visible;
          return (
            view.visible &&
            view.x === clip.x &&
            view.y === clip.y &&
            view.width === clip.width &&
            view.height === clip.height
          );
        });
      },
      { message: 'Each native view must match its visible DOM anchor inside the main scroll area' },
    )
    .toBe(true);
  return visibleIds;
}

test('paste, Distribute and Start run only the reviewed assignments through scoped proxies', async ({}, testInfo) => {
  harness = await launchUnicorn(fixtures, { settings: { browserCount: 3, stagingConfirmed: false } });
  const page = harness.page;
  await expect(page.getByRole('heading', { name: 'Paste. Distribute. Start.', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await testInfo.attach('minimal-flow-initial.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  const oldUrl = `${origin}/policy/old-pending`;
  await invoke(harness, { type: 'distribute', urls: [oldUrl], ids: [3], mode: 'same' });
  const previousState = await snapshot(harness);
  const previousSettings = previousState.settings;
  const preservedJob = previousState.jobs.find((job) => job.url === oldUrl)!;
  const before = fixtures.requests.length;
  const review = await distribute(harness, `${origin}/policy/landing`, 2);
  expect(review).toMatchObject({ count: 2, device: 'desktop', browserIds: [1, 2], domains: ['127.0.0.1'] });
  expect(review.jobIds).toHaveLength(2);
  const prepared = await snapshot(harness);
  expect(prepared.jobs.filter((job) => review.jobIds.includes(job.id)).map((job) => job.status)).toEqual([
    'pending',
    'pending',
  ]);
  expect(prepared.browsers.every((browser) => !browser.url && !browser.proxy)).toBe(true);
  expect(prepared.proxies.every((proxy) => proxy.assignedTo === undefined)).toBe(true);
  expect(fixtures.requests).toHaveLength(before);
  await expect(page.locator('.assignment-summary')).toHaveAttribute('data-review-id', review.id);
  await expect(page.locator('.review-domains')).toContainText('127.0.0.1');
  await expect(page.locator('[data-browser-id]')).toHaveCount(2);
  await testInfo.attach('minimal-flow-prepared.png', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  const completed = await startAndComplete(harness, review);
  expect(completed.preservedJobs.find((job) => job.url === oldUrl)).toEqual(preservedJob);
  expect(completed.jobs.some((job) => job.url === oldUrl)).toBe(false);
  expect(completed.settings.authorizedDomains).toEqual(previousSettings.authorizedDomains);
  expect(completed.settings.stagingConfirmed).toBe(false);
  expect(completed.browsers.find((browser) => browser.id === 3)?.url).toBe('');
  const traffic = fixtures.requests.slice(before);
  expect(traffic.filter((request) => request.path === '/policy/landing')).toHaveLength(2);
  expect(traffic.filter((request) => request.path === '/policy/internal')).toHaveLength(2);
  expect(
    traffic.some((request) =>
      ['/policy/external', '/policy/old-pending', '/diagnostic'].includes(request.path),
    ),
  ).toBe(false);
  expect(traffic.every((request) => request.proxied && request.host === new URL(origin).host)).toBe(true);
  expect(await browserEvaluate(harness, 1, 'window.policyReady')).toBe(true);
});

test('count 1–20 fills the chosen profiles and queues extra URLs without navigating or changing devices', async () => {
  harness = await launchUnicorn(fixtures, { settings: { browserCount: 3 } });
  await invoke(harness, { type: 'device', ids: [3], device: DEVICES.tablet });
  const before = fixtures.requests.length;
  const single = `${origin}/policy/one`;
  const first = await distribute(harness, `${single}\n  ${single}  `, 1, 'mobile');
  expect(first.urls).toEqual([single]);
  expect(first.browserIds).toEqual([1]);
  expect(first.jobIds).toHaveLength(1);
  expect((await snapshot(harness)).browsers).toHaveLength(3);
  const twenty = await distribute(harness, single, 20, 'mobile');
  const ids = Array.from({ length: 20 }, (_, index) => index + 1);
  expect(twenty.browserIds).toEqual(ids);
  const twentyState = await snapshot(harness);
  expect(
    twentyState.jobs.filter((job) => twenty.jobIds.includes(job.id)).map((job) => [job.browserId, job.url]),
  ).toEqual(ids.map((id) => [id, single]));
  expect(twentyState.browsers).toHaveLength(20);
  const urls = Array.from({ length: 23 }, (_, index) => `${origin}/policy/queued-${index + 1}`);
  const queued = await distribute(harness, urls.join('\n'), 20, 'tablet');
  const queuedState = await snapshot(harness);
  expect(queued.jobIds).toHaveLength(23);
  expect(
    queuedState.jobs.filter((job) => queued.jobIds.includes(job.id)).map((job) => [job.browserId, job.url]),
  ).toEqual(urls.map((url, index) => [(index % 20) + 1, url]));
  const smaller = await distribute(harness, urls.slice(0, 2).join('\n'), 3, 'desktop');
  const final = await snapshot(harness);
  expect(
    final.jobs.filter((job) => smaller.jobIds.includes(job.id)).map((job) => [job.browserId, job.url]),
  ).toEqual([
    [1, urls[0]],
    [2, urls[1]],
    [3, urls[0]],
  ]);
  expect(final.browsers).toHaveLength(20);
  expect(final.browsers.find((browser) => browser.id === 3)?.device).toEqual(DEVICES.tablet);
  expect(
    final.browsers
      .filter((browser) => browser.id !== 3)
      .every((browser) => browser.device.preset === 'desktop'),
  ).toBe(true);
  expect(final.browsers.every((browser) => !browser.url && !browser.proxy)).toBe(true);
  expect(final.proxies.every((proxy) => proxy.assignedTo === undefined)).toBe(true);
  expect(fixtures.requests).toHaveLength(before);
});

test('changing links, count or device requires a new review and stale tokens cannot start work', async () => {
  harness = await launchUnicorn(fixtures);
  const page = harness.page;
  const before = fixtures.requests.length;
  const firstUrl = `${origin}/policy/first-review`;
  const finalUrl = `${origin}/policy/final-review`;
  const first = await distribute(harness, firstUrl);
  await page.getByLabel('Paste links', { exact: true }).fill(finalUrl);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await page.getByLabel('Paste links', { exact: true }).fill(firstUrl);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await distribute(harness, finalUrl);
  await page.getByLabel('Browser count', { exact: true }).selectOption('2');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  await distribute(harness, finalUrl, 2);
  await page.getByLabel('Device type', { exact: true }).selectOption('mobile');
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  const final = await distribute(harness, finalUrl, 2, 'mobile');
  await expect(
    invoke(harness, { type: 'simple-start', reviewId: first.id, confirmed: true }),
  ).rejects.toThrow(/current review|Distribute/);
  expect(fixtures.requests).toHaveLength(before);
  const completed = await startAndComplete(harness, final);
  expect(completed.jobs.filter((job) => job.status === 'completed').map((job) => job.url)).toEqual([
    finalUrl,
    finalUrl,
  ]);
  expect(fixtures.requests.slice(before).some((request) => request.path === '/policy/first-review')).toBe(
    false,
  );
  await expect(
    invoke(harness, { type: 'simple-start', reviewId: final.id, confirmed: true }),
  ).rejects.toThrow(/current review|Distribute/);
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
});

test('Start applies Desktop, Mobile and Tablet to real Chromium while preserving unused profiles and storage', async () => {
  harness = await launchUnicorn(fixtures, { settings: { browserCount: 2 } });
  await invoke(harness, { type: 'device', ids: [2], device: DEVICES.tablet });
  let previous = DEVICES.desktop;
  for (const preset of ['desktop', 'mobile', 'tablet'] as const) {
    const review = await distribute(harness, `${origin}/policy/device-${preset}`, 1, preset);
    expect((await snapshot(harness)).browsers[0]!.device).toEqual(previous);
    await startAndComplete(harness, review);
    const expected = DEVICES[preset];
    await expect
      .poll(() =>
        browserEvaluate(
          harness!,
          1,
          '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints > 0, mobile: navigator.userAgentData.mobile })',
        ),
      )
      .toEqual({
        width: expected.width,
        height: expected.height,
        dpr: expected.scaleFactor,
        touch: expected.touch,
        mobile: preset === 'mobile',
      });
    expect((await snapshot(harness)).browsers[1]!.device).toEqual(DEVICES.tablet);
    if (preset === 'desktop')
      await browserEvaluate(harness, 1, "localStorage.setItem('simple-device-marker', 'retained'); true");
    else
      expect(await browserEvaluate(harness, 1, "localStorage.getItem('simple-device-marker')")).toBe(
        'retained',
      );
    previous = expected;
  }
});

test('the original draft, saved policies and browser profile data survive restart without automatic Start', async () => {
  const settings = {
    browserCount: 3,
    authorizedDomains: ['127.0.0.1', 'localhost'],
    dailyNavigationLimit: 321,
    dailyRequestLimit: 9876,
    excludedLinkPatterns: ['*://example.test/skip/*'],
    retryLimit: 3,
    proxyRefreshMinutes: 17,
    closePopupsAfterRun: false,
    logRetentionDays: 13,
    schedule: { enabled: true, intervalMinutes: 42, startHour: 5, endHour: 21, resumeAfterRestart: true },
    timings: { ...DEFAULT_SETTINGS.timings, landingWaitMs: 1234, maxScrollPx: 4567 },
  };
  harness = await launchUnicorn(fixtures, { settings });
  const directory = harness.directory;
  await invoke(harness, { type: 'device', ids: [2], device: DEVICES.tablet });
  await invoke(harness, { type: 'navigate', id: 2, url: `${origin}/policy/saved-profile` });
  await browserEvaluate(harness, 2, "localStorage.setItem('simple-profile-marker', 'profile-two'); true");
  await invoke(harness, { type: 'browser', id: 2, action: 'stop' });
  const raw = `\n  ${origin}/policy/raw-one?order=2  \n\n${origin}/policy/raw-two\n`;
  const review = await distribute(harness, raw, 2, 'mobile');
  await expect(harness.page.getByLabel('Paste links', { exact: true })).toHaveValue(raw);
  await harness.page.getByLabel('Paste links', { exact: true }).fill('x'.repeat(2_000_001));
  await expect(harness.page.getByLabel('Paste links', { exact: true })).toHaveValue(raw);
  await expect(harness.page.getByText('Your previous text was kept', { exact: false })).toBeVisible();
  const before = fixtures.requests.length;
  expect((await snapshot(harness)).settings).toMatchObject(settings);
  await closeHarness(harness);
  harness = undefined;
  harness = await launchUnicorn(fixtures, { directory, settings });
  await expect(harness.page.getByLabel('Paste links', { exact: true })).toHaveValue(raw);
  await expect(harness.page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  const restored = await snapshot(harness);
  expect(restored.preparedRun).toBeNull();
  expect(restored.settings).toMatchObject(settings);
  expect(restored.jobs.filter((job) => review.jobIds.includes(job.id)).map((job) => job.status)).toEqual([
    'pending',
    'pending',
  ]);
  expect(restored.browsers[1]!.device).toEqual(DEVICES.tablet);
  expect(restored.scheduler.running).toBe(false);
  expect(fixtures.requests).toHaveLength(before);
  await invoke(harness, { type: 'navigate', id: 2, url: `${origin}/policy/saved-profile` });
  expect(await browserEvaluate(harness, 2, "localStorage.getItem('simple-profile-marker')")).toBe(
    'profile-two',
  );
  await invoke(harness, { type: 'browser', id: 2, action: 'stop' });
  await harness.page.getByLabel('Paste links', { exact: true }).fill('');
  await harness.page.getByLabel('Browser count', { exact: true }).focus();
  await harness.page.reload();
  await expect(harness.page.getByLabel('Paste links', { exact: true })).toHaveValue('');
  expect((await snapshot(harness)).jobs.filter((job) => review.jobIds.includes(job.id))).toHaveLength(2);
});

test('Stop remains available during asynchronous setup and late replies cannot restore Start', async () => {
  harness = await launchUnicorn(fixtures);
  const page = harness.page;
  const before = fixtures.requests.length;
  await page.getByLabel('Paste links', { exact: true }).fill(`${origin}/policy/stopped-distribution`);
  await holdNextCommand(harness, 'distribution reply');
  await page.getByRole('button', { name: 'Distribute', exact: true }).click();
  await expect.poll(() => pendingCommand(harness!)).toBe(true);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await snapshot(harness!)).preparedRun?.status).toBe('finished');
  await releaseCommand(harness);
  await expect(page.getByRole('button', { name: 'Distribute', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  const review = await distribute(harness, `${origin}/policy/stopped-start`, 1, 'mobile');
  await holdNextCommand(harness, 'device setup');
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await expect.poll(() => pendingCommand(harness!)).toBe(true);
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect.poll(async () => (await snapshot(harness!)).preparedRun?.status).toBe('finished');
  await releaseCommand(harness);
  await expect(page.getByRole('button', { name: 'Distribute', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start', exact: true })).toBeDisabled();
  const stopped = await snapshot(harness);
  expect(stopped.jobs.filter((job) => review.jobIds.includes(job.id)).map((job) => job.status)).toEqual([
    'cancelled',
  ]);
  expect(stopped.scheduler.running).toBe(false);
  expect(stopped.browsers[0]!.device).toEqual(DEVICES.desktop);
  expect(stopped.browsers.every((browser) => !browser.url && !browser.proxy)).toBe(true);
  expect(stopped.proxies.every((proxy) => proxy.assignedTo === undefined)).toBe(true);
  expect(fixtures.requests).toHaveLength(before);
});

test('live native previews stay clipped while the shared workspace scrolls, resizes and expands', async ({}, testInfo) => {
  harness = await launchUnicorn(fixtures);
  const page = harness.page;
  const review = await distribute(harness, `${origin}/policy/live-preview`, 4);
  await startAndComplete(harness, review);
  await harness.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1050, 720),
  );
  await expect(page.locator('[data-browser-id]')).toHaveCount(4);
  // The composer may put every preview below the fold at this height. Those
  // native views must remain hidden until their anchors scroll into view.
  await expectNativeClipping(harness);
  for (const fraction of [0.5, 1, 0]) {
    await page.locator('.browser-scroll').evaluate((element, position) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * position;
    }, fraction);
    const visible = await expectNativeClipping(harness);
    if (fraction === 1) expect(visible.length).toBeGreaterThan(0);
  }
  await page.getByRole('button', { name: 'Expand browser 3', exact: true }).click();
  await expect(page.locator('[data-browser-id]')).toHaveCount(1);
  await page.locator('.browser-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await expectNativeClipping(harness)).toEqual([3]);
  await harness.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]!.setContentSize(1220, 850),
  );
  expect(await expectNativeClipping(harness)).toEqual([3]);
  await page.getByRole('button', { name: 'Show all browsers', exact: true }).click();
  await expect(page.locator('[data-browser-id]')).toHaveCount(4);
  await page.locator('.browser-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect((await expectNativeClipping(harness)).length).toBeGreaterThan(0);
  for (const id of review.browserIds)
    expect(await browserEvaluate(harness, id, 'window.policyReady')).toBe(true);
  const composite = await harness.app.evaluate(async ({ desktopCapturer }) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1600, height: 1000 },
    });
    return sources[0]!.thumbnail.toDataURL();
  });
  await testInfo.attach('minimal-live-browsers.png', {
    body: Buffer.from(composite.split(',')[1]!, 'base64'),
    contentType: 'image/png',
  });
});
