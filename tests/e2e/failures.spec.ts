import { test, expect } from '@playwright/test';
import { createFixtures, type BrowserFixtures } from '../fixtures/servers';
import { launchUnicorn, closeHarness, invoke, snapshot, browserEvaluate, type Harness } from './helpers';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

let fixtures: BrowserFixtures;
let harness: Harness | undefined;
test.beforeEach(async () => {
  fixtures = await createFixtures(3);
});
test.afterEach(async () => {
  await closeHarness(harness);
  harness = undefined;
  await fixtures.close();
});

test('missing proxies leave the browser waiting and block even a direct WebContents load', async () => {
  harness = await launchUnicorn(fixtures, { proxyCount: 0 });
  const before = fixtures.requests.length;
  await expect(invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/` })).rejects.toThrow(
    /No validated/,
  );
  expect((await snapshot(harness)).browsers[0]?.state).toBe('WAITING_FOR_PROXY');
  const rawLoad = await harness.app.evaluate(async (_electron, url) => {
    const manager = (
      globalThis as unknown as {
        __unicornTest: { manager: { getWebContents(id: number): Electron.WebContents } };
      }
    ).__unicornTest.manager;
    try {
      await manager.getWebContents(1).loadURL(url);
      return 'unexpected-success';
    } catch {
      return 'blocked';
    }
  }, `${fixtures.httpOrigin}/direct-attempt`);
  expect(rawLoad).toBe('blocked');
  expect(fixtures.requests).toHaveLength(before);
});

test('wrong-country verification refuses the endpoint before any page navigation', async () => {
  fixtures.proxies[0]!.record.country = 'DE';
  harness = await launchUnicorn(fixtures, { proxyCount: 1 });
  await expect(
    invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/wrong-country-test` }),
  ).rejects.toThrow(/No validated/);
  expect(fixtures.requests.some((request) => request.path === '/wrong-country-test')).toBe(false);
  expect((await snapshot(harness)).proxies[0]?.status).toBe('failed');
});

test('slow proxy verification times out without issuing a site request', async () => {
  fixtures.proxies[0]!.stall();
  harness = await launchUnicorn(fixtures, { proxyCount: 1, settings: { proxyTimeoutMs: 1000 } });
  const started = Date.now();
  await expect(
    invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/slow-proxy-test` }),
  ).rejects.toThrow(/No validated/);
  expect(Date.now() - started).toBeLessThan(8000);
  expect(fixtures.requests.some((request) => request.path === '/slow-proxy-test')).toBe(false);
});

test('untrusted HTTPS diagnostic certificate is rejected', async () => {
  await fixtures.close();
  fixtures = await createFixtures(1, { untrustedCertificate: true });
  test.skip(
    !fixtures.httpsOrigin && process.platform !== 'win32',
    'A generated untrusted TLS fixture is required.',
  );
  expect(fixtures.httpsOrigin).toBeTruthy();
  harness = await launchUnicorn(fixtures, { proxyCount: 1 });
  await expect(
    invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/certificate-test` }),
  ).rejects.toThrow(/No validated/);
  const state = await snapshot(harness);
  expect(state.proxies[0]?.status).toBe('failed');
  expect(fixtures.requests.some((request) => request.path === '/certificate-test')).toBe(false);
});

test('failed proxy cannot fall back to a direct socket or leave an active lease', async () => {
  harness = await launchUnicorn(fixtures, { proxyCount: 1 });
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/` });
  fixtures.proxies[0]!.fail();
  const before = fixtures.directRequests();
  await expect(
    invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/after-disconnect` }),
  ).rejects.toThrow();
  expect(fixtures.directRequests()).toBe(before);
  expect(fixtures.requests.some((request) => request.path === '/after-disconnect')).toBe(false);
  expect((await snapshot(harness)).proxies.every((proxy) => proxy.assignedTo === undefined)).toBe(true);
});

for (const endpoint of ['forbidden', 'limited'])
  test(`HTTP ${endpoint === 'forbidden' ? 403 : 429} stops QA without rotating proxies`, async () => {
    harness = await launchUnicorn(fixtures, { settings: { retryLimit: 2 } });
    await invoke(harness, {
      type: 'distribute',
      urls: [`${fixtures.httpOrigin}/${endpoint}`],
      ids: [1],
      mode: 'same',
    });
    await invoke(harness, { type: 'global', action: 'start' });
    await expect.poll(async () => (await snapshot(harness!)).jobs[0]?.status).toBe('failed');
    expect(fixtures.proxies.slice(1).every((proxy) => proxy.requests + proxy.tunnels === 0)).toBe(true);
    expect((await snapshot(harness)).proxies.every((proxy) => proxy.failures === 0)).toBe(true);
  });

test('unsafe URL, out-of-scope redirect and unapproved popup are rejected', async () => {
  harness = await launchUnicorn(fixtures);
  await expect(invoke(harness, { type: 'navigate', id: 1, url: 'file:///etc/passwd' })).rejects.toThrow();
  await expect(
    invoke(harness, { type: 'navigate', id: 1, url: 'https://unapproved.invalid/' }),
  ).rejects.toThrow(/scope/);
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/` });
  await browserEvaluate(harness, 1, "window.open('https://unapproved.invalid/');true");
  expect((await snapshot(harness)).browsers[0]?.popups).toEqual([]);
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/redirect-outside` }).catch(
    () => undefined,
  );
  expect((await snapshot(harness)).browsers[0]?.url).not.toContain('unapproved.invalid');
  expect((await snapshot(harness)).logs.some((log) => /blocked/i.test(log.message))).toBe(true);
});

test('navigation timeout is bounded and leaves the desktop bridge responsive', async () => {
  harness = await launchUnicorn(fixtures, {
    settings: { timings: { ...DEFAULT_SETTINGS.timings, navigationTimeoutMs: 1000 } },
  });
  const started = Date.now();
  await expect(
    invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/slow` }),
  ).rejects.toThrow(/timed out|ERR_ABORTED/);
  expect(Date.now() - started).toBeLessThan(10000);
  expect((await invoke(harness, { type: 'snapshot' })).snapshot.browsers[0]?.state).toBe('ERROR');
});

test('emergency stop cancels an active QA job and releases its network resources', async () => {
  harness = await launchUnicorn(fixtures, {
    settings: { timings: { ...DEFAULT_SETTINGS.timings, landingWaitMs: 30000 } },
  });
  await invoke(harness, { type: 'distribute', urls: [`${fixtures.httpOrigin}/`], ids: [1], mode: 'same' });
  await invoke(harness, { type: 'global', action: 'start' });
  await expect.poll(async () => (await snapshot(harness!)).browsers[0]?.state).toBe('RUNNING');
  await invoke(harness, { type: 'global', action: 'stop' });
  await expect.poll(async () => (await snapshot(harness!)).jobs[0]?.status).toBe('cancelled');
  const state = await snapshot(harness);
  expect(state.browsers[0]?.state).toBe('STOPPED');
  expect(state.proxies.every((proxy) => proxy.assignedTo === undefined)).toBe(true);
});

test('pausing a QA job preserves remaining dwell and resumes cleanly', async () => {
  harness = await launchUnicorn(fixtures, {
    settings: {
      timings: {
        landingWaitMs: 1200,
        landingScrollMs: 0,
        internalWaitMs: 0,
        internalScrollMs: 0,
        externalWaitMs: 0,
        externalScrollMs: 0,
        navigationTimeoutMs: 6000,
        maxScrollPx: 0,
      },
    },
  });
  await invoke(harness, { type: 'distribute', urls: [`${fixtures.httpOrigin}/`], ids: [1], mode: 'same' });
  await invoke(harness, { type: 'global', action: 'start' });
  await expect.poll(async () => (await snapshot(harness!)).browsers[0]?.state).toBe('RUNNING');
  await invoke(harness, { type: 'global', action: 'pause' });
  expect((await snapshot(harness)).browsers[0]?.state).toBe('PAUSED');
  // Poll over a duration longer than the original dwell: job must remain paused throughout.
  const until = Date.now() + 1500;
  while (Date.now() < until) {
    expect((await snapshot(harness)).jobs[0]?.status).toBe('running');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await invoke(harness, { type: 'global', action: 'resume' });
  await expect
    .poll(async () => (await snapshot(harness!)).jobs[0]?.status, { timeout: 12000 })
    .toBe('completed');
});

test('renderer crash is contained and reopening preserves the profile', async () => {
  harness = await launchUnicorn(fixtures);
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/` });
  await browserEvaluate(harness, 1, "localStorage.setItem('crash-recovery','retained')");
  await harness.app.evaluate(() => {
    const manager = (
      globalThis as unknown as {
        __unicornTest: { manager: { getWebContents(id: number): Electron.WebContents } };
      }
    ).__unicornTest.manager;
    manager.getWebContents(1).forcefullyCrashRenderer();
  });
  await expect.poll(async () => (await snapshot(harness!)).browsers[0]?.state).toBe('ERROR');
  await invoke(harness, { type: 'browser', id: 1, action: 'close' });
  await invoke(harness, { type: 'create', count: 1 });
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/` });
  expect(await browserEvaluate(harness, 1, "localStorage.getItem('crash-recovery')")).toBe('retained');
});
