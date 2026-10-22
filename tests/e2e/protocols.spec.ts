import { test, expect } from '@playwright/test';
import { createFixtures, type BrowserFixtures } from '../fixtures/servers';
import { useSocks5Proxy } from '../fixtures/socks5';
import { launchUnicorn, closeHarness, invoke, snapshot, browserEvaluate, type Harness } from './helpers';

let fixtures: BrowserFixtures | undefined;
let harness: Harness | undefined;
test.afterEach(async () => {
  await closeHarness(harness);
  harness = undefined;
  await fixtures?.close();
  fixtures = undefined;
});

test('SOCKS5 performs a real handshake and proxies browser requests and HTTPS validation', async () => {
  fixtures = await createFixtures(1);
  await useSocks5Proxy(fixtures);
  harness = await launchUnicorn(fixtures, { proxyCount: 1 });
  const before = fixtures.directRequests();
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpsOrigin ?? fixtures.httpOrigin}/` });
  expect(await browserEvaluate(harness, 1, 'window.fixtureReady')).toBe(true);
  const state = await snapshot(harness);
  expect(state.browsers[0]?.proxy?.protocol).toBe('socks5');
  expect(state.browsers[0]?.proxy?.exitIp).toBe('8.8.0.1');
  expect(fixtures.proxies[0]!.tunnels).toBeGreaterThan(0);
  expect(fixtures.directRequests()).toBe(before);
  fixtures.proxies[0]!.fail();
  await expect(
    invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/after-socks-failure` }),
  ).rejects.toThrow();
  expect(fixtures.directRequests()).toBe(before);
});

test('HTTPS proxy uses a trusted TLS connection to the proxy and an HTTPS tunnel to the site', async () => {
  fixtures = await createFixtures(1);
  test.skip(
    !fixtures.httpsOrigin && process.platform !== 'win32',
    'A prepared trusted certificate is required.',
  );
  expect(fixtures.httpsOrigin).toBeTruthy();
  await fixtures.close();
  fixtures = await createFixtures(1, { secureProxy: true });
  harness = await launchUnicorn(fixtures, { proxyCount: 1 });
  const before = fixtures.directRequests();
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpsOrigin}/` });
  expect(await browserEvaluate(harness, 1, 'window.fixtureReady')).toBe(true);
  expect((await snapshot(harness)).browsers[0]?.proxy?.protocol).toBe('https');
  expect(fixtures.proxies[0]!.tunnels).toBeGreaterThan(0);
  expect(fixtures.directRequests()).toBe(before);
});
