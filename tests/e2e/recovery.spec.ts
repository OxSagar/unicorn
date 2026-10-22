import { test, expect } from '@playwright/test';
import type { AppSettings } from '../../src/shared/types';
import { DEVICES } from '../../src/shared/defaults';
import { createFixtures, type BrowserFixtures } from '../fixtures/servers';
import { launchUnicorn, closeHarness, invoke, snapshot, browserEvaluate, type Harness } from './helpers';

let fixtures: BrowserFixtures;
let harness: Harness | undefined;
let target: string;
const timings: AppSettings['timings'] = {
  landingWaitMs: 1800,
  landingScrollMs: 0,
  internalWaitMs: 0,
  internalScrollMs: 0,
  externalWaitMs: 0,
  externalScrollMs: 0,
  navigationTimeoutMs: 6000,
  maxScrollPx: 0,
};

test.beforeEach(async () => {
  fixtures = await createFixtures(3);
  if (process.platform === 'win32')
    expect(fixtures.httpsOrigin, 'Windows recovery acceptance requires trusted HTTPS').toBeTruthy();
  target = `${fixtures.httpsOrigin ?? fixtures.httpOrigin}/policy/no-links`;
});
test.afterEach(async () => {
  try {
    await closeHarness(harness);
  } finally {
    harness = undefined;
    await fixtures?.close();
  }
});

async function rendererId(id = 1): Promise<number> {
  return harness!.app.evaluate((_electron, browserId) => {
    const manager = (
      globalThis as unknown as {
        __unicornTest: { manager: { getWebContents(id: number): Electron.WebContents } };
      }
    ).__unicornTest.manager;
    return manager.getWebContents(browserId).id;
  }, id);
}

async function crash(): Promise<void> {
  await harness!.app.evaluate(() => {
    const manager = (
      globalThis as unknown as {
        __unicornTest: { manager: { getWebContents(id: number): Electron.WebContents } };
      }
    ).__unicornTest.manager;
    // A real native process exit, rather than a synthetic emitted event or mocked error.
    manager.getWebContents(1).forcefullyCrashRenderer();
  });
}

async function waitForLanding(): Promise<void> {
  await expect
    .poll(
      async () => {
        const state = await snapshot(harness!);
        return (
          state.jobs[0]?.status === 'running' &&
          state.browsers[0]?.state === 'RUNNING' &&
          state.browsers[0]?.stage === 'Landing page: initialization'
        );
      },
      { timeout: 15000, intervals: [50, 100, 200] },
    )
    .toBe(true);
}

async function start(): Promise<string> {
  await invoke(harness!, { type: 'distribute', urls: [target], ids: [1], mode: 'same' });
  const id = (await snapshot(harness!)).jobs[0]!.id;
  await invoke(harness!, { type: 'browser', id: 1, action: 'start' });
  await waitForLanding();
  return id;
}

async function waitForBackoff(): Promise<void> {
  await expect
    .poll(async () => (await snapshot(harness!)).browsers[0]?.state, {
      timeout: 10000,
      intervals: [25, 50, 100],
    })
    .toBe('RETRY_WAIT');
}

test('a real renderer crash completes the original job once and retains its isolated profile', async () => {
  harness = await launchUnicorn(fixtures, { settings: { browserCount: 2, retryLimit: 2, timings } });
  await invoke(harness, { type: 'device', ids: [1], device: DEVICES.mobile });
  await invoke(harness, { type: 'navigate', id: 1, url: target });
  await browserEvaluate(
    harness,
    1,
    `localStorage.setItem('recovery-profile', 'retained'); document.cookie='recovery=retained; path=/'; true`,
  );
  const originalUserAgent = await browserEvaluate(harness, 1, 'navigator.userAgent');
  await invoke(harness, { type: 'navigate', id: 2, url: target });
  await browserEvaluate(harness, 2, `localStorage.setItem('recovery-profile', 'sibling'); true`);
  const original = await rendererId();
  const sibling = await rendererId(2);
  const loadedBefore = fixtures.requests.filter((request) => request.path === '/policy/no-links').length;
  const jobId = await start();
  await crash();
  await expect
    .poll(async () => (await snapshot(harness!)).jobs[0]?.status, { timeout: 20000 })
    .toBe('completed');
  const state = await snapshot(harness);
  expect(state.jobs).toHaveLength(1);
  expect(state.jobs[0]?.id).toBe(jobId);
  expect(state.totals).toMatchObject({ completed: 1, failed: 0 });
  expect(state.browsers[0]).toMatchObject({ state: 'COMPLETED', device: DEVICES.mobile });
  expect(await rendererId()).not.toBe(original);
  expect(await rendererId(2)).toBe(sibling);
  expect(await browserEvaluate(harness, 1, `localStorage.getItem('recovery-profile')`)).toBe('retained');
  expect(await browserEvaluate(harness, 1, 'document.cookie')).toContain('recovery=retained');
  expect(await browserEvaluate(harness, 1, 'navigator.userAgent')).toBe(originalUserAgent);
  expect(await browserEvaluate(harness, 2, `localStorage.getItem('recovery-profile')`)).toBe('sibling');
  expect(await browserEvaluate(harness, 2, 'document.cookie')).not.toContain('recovery=retained');
  expect(fixtures.requests.filter((request) => request.path === '/policy/no-links')).toHaveLength(
    loadedBefore + 2,
  );
  expect(state.proxies.every((proxy) => proxy.failures === 0)).toBe(true);
  expect(state.proxies.some((proxy) => proxy.assignedTo === 1)).toBe(false);
  expect(
    state.logs.filter((event) => event.message.startsWith('Restarting the accepted QA job')),
  ).toHaveLength(1);
  expect(fixtures.directRequests()).toBe(0);
});

test('Pause holds renderer recovery and Resume completes the same job', async () => {
  harness = await launchUnicorn(fixtures, { settings: { retryLimit: 1, timings } });
  const jobId = await start();
  const original = await rendererId();
  await crash();
  await waitForBackoff();
  await invoke(harness, { type: 'browser', id: 1, action: 'pause' });
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    const state = await snapshot(harness);
    expect(state.browsers[0]?.state).toBe('PAUSED');
    expect(state.jobs[0]).toMatchObject({ id: jobId, status: 'running' });
    expect(await rendererId()).toBe(original);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await invoke(harness, { type: 'browser', id: 1, action: 'resume' });
  await expect
    .poll(async () => (await snapshot(harness!)).jobs[0]?.status, { timeout: 20000 })
    .toBe('completed');
  expect(await rendererId()).not.toBe(original);
  expect((await snapshot(harness)).totals).toMatchObject({ completed: 1, failed: 0 });
  expect(fixtures.directRequests()).toBe(0);
});

test('Stop cancels a pending recovery without replaying the page or quarantining its healthy proxy', async () => {
  harness = await launchUnicorn(fixtures, { settings: { retryLimit: 2, timings } });
  await start();
  const original = await rendererId();
  await crash();
  await waitForBackoff();
  await invoke(harness, { type: 'browser', id: 1, action: 'stop' });
  await expect.poll(async () => (await snapshot(harness!)).jobs[0]?.status).toBe('cancelled');
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    expect((await snapshot(harness)).browsers[0]?.state).toBe('STOPPED');
    expect(await rendererId()).toBe(original);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = await snapshot(harness);
  expect(state.proxies.every((proxy) => proxy.failures === 0 && proxy.assignedTo === undefined)).toBe(true);
  expect(fixtures.requests.filter((request) => request.path === '/policy/no-links')).toHaveLength(1);
  expect(fixtures.directRequests()).toBe(0);
});

test('repeated native crashes stop at the configured retry limit', async () => {
  harness = await launchUnicorn(fixtures, { settings: { retryLimit: 2, timings } });
  const jobId = await start();
  for (let retry = 0; retry < 2; retry++) {
    const previous = await rendererId();
    await crash();
    await expect.poll(rendererId, { timeout: 15000 }).not.toBe(previous);
    await waitForLanding();
  }
  await crash();
  await expect
    .poll(async () => (await snapshot(harness!)).jobs[0]?.status, { timeout: 15000 })
    .toBe('failed');
  const state = await snapshot(harness);
  expect(state.jobs).toHaveLength(1);
  expect(state.jobs[0]?.id).toBe(jobId);
  expect(state.browsers[0]?.state).toBe('ERROR');
  expect(state.jobs[0]?.error).toContain('Browser renderer exited:');
  expect(state.totals).toMatchObject({ completed: 0, failed: 1 });
  expect(state.proxies.every((proxy) => proxy.failures === 0 && proxy.assignedTo === undefined)).toBe(true);
  expect(fixtures.requests.filter((request) => request.path === '/policy/no-links')).toHaveLength(3);
  expect(
    state.logs.filter((event) => event.message.startsWith('Restarting the accepted QA job')),
  ).toHaveLength(2);
  expect(fixtures.directRequests()).toBe(0);
});

test('retry limit zero fails the original QA job and keeps the dashboard responsive', async () => {
  harness = await launchUnicorn(fixtures, { settings: { retryLimit: 0, timings } });
  await start();
  const original = await rendererId();
  await crash();
  await expect.poll(async () => (await snapshot(harness!)).jobs[0]?.status).toBe('failed');
  expect(await rendererId()).toBe(original);
  const state = (await invoke(harness, { type: 'snapshot' })).snapshot;
  expect(state.browsers[0]?.state).toBe('ERROR');
  expect(state.logs.some((event) => event.message.startsWith('Restarting the accepted QA job'))).toBe(false);
  expect(state.proxies.every((proxy) => proxy.assignedTo === undefined)).toBe(true);
  expect(fixtures.requests.filter((request) => request.path === '/policy/no-links')).toHaveLength(1);
});
