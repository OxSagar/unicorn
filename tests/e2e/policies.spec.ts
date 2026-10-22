import { test, expect } from '@playwright/test';
import type { AppSettings } from '../../src/shared/types';
import { createFixtures, type BrowserFixtures } from '../fixtures/servers';
import { launchUnicorn, closeHarness, invoke, snapshot, browserEvaluate, type Harness } from './helpers';

let fixtures: BrowserFixtures;
let harness: Harness | undefined;
let origin: string;
let externalOrigin: string;
const timings: AppSettings['timings'] = {
  landingWaitMs: 50,
  landingScrollMs: 0,
  internalWaitMs: 50,
  internalScrollMs: 0,
  externalWaitMs: 50,
  externalScrollMs: 0,
  navigationTimeoutMs: 6000,
  maxScrollPx: 0,
};

test.beforeEach(async () => {
  fixtures = await createFixtures(3);
  if (process.platform === 'win32')
    expect(fixtures.httpsOrigin, 'Windows policy acceptance requires the trusted HTTPS fixture').toBeTruthy();
  origin = fixtures.httpsOrigin ?? fixtures.httpOrigin;
  const external = new URL(origin);
  external.hostname = 'localhost';
  externalOrigin = external.origin;
});
test.afterEach(async () => {
  try {
    await closeHarness(harness);
  } finally {
    harness = undefined;
    await fixtures.close();
  }
});

async function run(url: string, settings: Partial<AppSettings> = {}): Promise<void> {
  harness = await launchUnicorn(fixtures, { settings: { timings, ...settings } });
  await invoke(harness, { type: 'distribute', urls: [url], ids: [1], mode: 'same' });
  await invoke(harness, { type: 'global', action: 'start' });
}

async function expectFinished(status: 'completed' | 'failed'): Promise<void> {
  await expect.poll(async () => (await snapshot(harness!)).jobs[0]?.status, { timeout: 20000 }).toBe(status);
  const state = await snapshot(harness!);
  expect(state.proxies.every((proxy) => proxy.assignedTo === undefined)).toBe(true);
  expect(fixtures.directRequests()).toBe(0);
}

test('an approved external stage navigates to a distinct hostname after the internal stage', async () => {
  await run(`${origin}/policy/landing`);
  await expectFinished('completed');
  const browser = (await snapshot(harness!)).browsers[0]!;
  expect(browser.url).toBe(`${externalOrigin}/policy/external`);
  expect(
    browser.history
      .filter((item) => new URL(item.url).pathname.startsWith('/policy/'))
      .map((item) => new URL(item.url).pathname),
  ).toEqual(['/policy/landing', '/policy/internal', '/policy/external']);
  expect(
    fixtures.requests.some(
      (request) =>
        request.path === '/policy/external' &&
        request.host === new URL(externalOrigin).host &&
        request.proxied,
    ),
  ).toBe(true);
  expect(await browserEvaluate(harness!, 1, 'window.policyReady')).toBe(true);
});

test('a page without an internal link skips that stage and completes cleanly', async () => {
  await run(`${origin}/policy/no-links`);
  await expectFinished('completed');
  const state = await snapshot(harness!);
  expect(state.logs.some((event) => event.message.startsWith('Internal-link stage skipped:'))).toBe(true);
  expect(
    fixtures.requests.filter((request) => request.path.startsWith('/policy/')).map((request) => request.path),
  ).toEqual(['/policy/no-links']);
});

test('an excluded internal link never receives a request', async () => {
  await run(`${origin}/policy/excluded`, { excludedLinkPatterns: ['*/policy/must-not-load*'] });
  await expectFinished('completed');
  expect(
    fixtures.requests.filter((request) => request.path.startsWith('/policy/')).map((request) => request.path),
  ).toEqual(['/policy/excluded']);
  expect(
    (await snapshot(harness!)).logs.some((event) => event.message.startsWith('Internal-link stage skipped:')),
  ).toBe(true);
});

test('an excluded starting URL fails before proxy allocation or page traffic', async () => {
  await run(`${origin}/policy/must-not-load`, { excludedLinkPatterns: ['*/policy/must-not-load*'] });
  await expectFinished('failed');
  expect((await snapshot(harness!)).jobs[0]?.error).toContain(
    'starting URL matches an excluded QA link pattern',
  );
  expect(fixtures.requests).toHaveLength(0);
  expect(fixtures.proxies.every((proxy) => proxy.requests + proxy.tunnels === 0)).toBe(true);
});

test('a daily request limit of three stops a scripted fetch burst without proxy rotation', async () => {
  await run(`${origin}/policy/fetch-burst`, {
    dailyRequestLimit: 3,
    retryLimit: 2,
    timings: { ...timings, landingWaitMs: 1500 },
  });
  await expectFinished('failed');
  const state = await snapshot(harness!);
  expect(state.jobs[0]?.error).toBe('Daily request limit reached for 127.0.0.1');
  expect(state.browsers[0]?.state).toBe('ERROR');
  expect(state.proxies.every((proxy) => proxy.failures === 0)).toBe(true);
  expect(fixtures.proxies.slice(1).every((proxy) => proxy.requests + proxy.tunnels === 0)).toBe(true);
  expect(
    fixtures.requests.filter((request) => request.path.startsWith('/policy/')).map((request) => request.path),
  ).toEqual(['/policy/fetch-burst', '/policy/burst/1', '/policy/burst/2']);
  await expect
    .poll(() => browserEvaluate<number>(harness!, 1, 'window.burst.rejected'), { timeout: 5000 })
    .toBeGreaterThan(0);
});

test('an external-stage HTTP 403 cancels the actual restricted host and preserves unrelated pending work', async () => {
  harness = await launchUnicorn(fixtures, { settings: { browserCount: 2, timings, retryLimit: 2 } });
  const initial = `${origin}/policy/landing?external=forbidden`;
  const restricted = `${externalOrigin}/policy/pending-restricted`;
  const unrelated = `${origin}/policy/pending-origin`;
  await invoke(harness, { type: 'distribute', urls: [initial], ids: [1], mode: 'same' });
  await invoke(harness, { type: 'distribute', urls: [restricted, unrelated], ids: [2], mode: 'round-robin' });
  await invoke(harness, { type: 'browser', id: 1, action: 'start' });
  await expectFinished('failed');
  const state = await snapshot(harness);
  expect(state.jobs.find((job) => job.url === initial)?.error).toContain('HTTP 403');
  expect(state.jobs.find((job) => job.url === restricted)?.status).toBe('cancelled');
  expect(state.jobs.find((job) => job.url === unrelated)?.status).toBe('pending');
  expect(
    fixtures.requests.some(
      (request) => request.path === '/forbidden' && request.host === new URL(externalOrigin).host,
    ),
  ).toBe(true);
  expect(fixtures.requests.some((request) => request.path.startsWith('/policy/pending-'))).toBe(false);
  expect(state.proxies.every((proxy) => proxy.failures === 0)).toBe(true);
  expect(fixtures.proxies.slice(1).every((proxy) => proxy.requests + proxy.tunnels === 0)).toBe(true);
});

test('one cached proxy connection failure retries through one verified replacement and completes', async () => {
  harness = await launchUnicorn(fixtures, { proxyCount: 2, settings: { timings, retryLimit: 1 } });
  await invoke(harness, { type: 'navigate', id: 1, url: `${origin}/policy/warm` });
  const validated = (await snapshot(harness)).browsers[0]?.proxy;
  expect(validated?.id).toBe(fixtures.proxies[0]!.record.id);
  expect(validated?.lastChecked).not.toBeNull();
  await invoke(harness, { type: 'browser', id: 1, action: 'stop' });
  await fixtures.proxies[0]!.stop();
  await invoke(harness, { type: 'distribute', urls: [`${origin}/policy/retry`], ids: [1], mode: 'same' });
  await invoke(harness, { type: 'global', action: 'start' });
  await expectFinished('completed');
  const state = await snapshot(harness);
  expect(state.proxies.find((proxy) => proxy.id === fixtures.proxies[0]!.record.id)?.failures).toBe(1);
  expect(state.proxies.find((proxy) => proxy.id === fixtures.proxies[1]!.record.id)?.failures).toBe(0);
  expect(fixtures.proxies[1]!.requests + fixtures.proxies[1]!.tunnels).toBeGreaterThan(0);
  expect(fixtures.requests.filter((request) => request.path === '/policy/retry')).toHaveLength(1);
  expect(await browserEvaluate(harness, 1, 'window.policyReady')).toBe(true);
});
