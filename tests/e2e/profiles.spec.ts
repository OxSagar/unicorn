import { expect, test } from '@playwright/test';
import { DEVICES } from '../../src/shared/defaults';
import type { BrowserSnapshot } from '../../src/shared/types';
import { createFixtures, type BrowserFixtures } from '../fixtures/servers';
import { browserEvaluate, closeHarness, invoke, launchUnicorn, snapshot, type Harness } from './helpers';

interface SiteData {
  cookie: string;
  local: string | null;
  database: string | null;
  databases: string[];
  cache: string | null;
  cacheNames: string[];
  serviceWorkers: string[];
}
interface NativeRuntime {
  manager: { getWebContents(id: number): Electron.WebContents };
}

let fixtures: BrowserFixtures;
let harness: Harness | undefined;
let origin: string;
let originalSites: SiteData[];
let originalBrowsers: BrowserSnapshot[];

test.beforeAll(async () => {
  fixtures = await createFixtures(2);
  if (process.platform === 'win32')
    expect(
      fixtures.httpsOrigin,
      'Windows profile acceptance requires the trusted HTTPS fixture',
    ).toBeTruthy();
  origin = fixtures.httpsOrigin ?? fixtures.httpOrigin;
});
test.beforeEach(async () => {
  harness = await launchUnicorn(fixtures, { settings: { browserCount: 2 } });
  await invoke(harness, { type: 'device', ids: [1], device: DEVICES.mobile });
  await invoke(harness, { type: 'device', ids: [2], device: DEVICES.tablet });
  for (const id of [1, 2]) await seedProfile(harness, id);
  originalSites = await Promise.all([1, 2].map((id) => readSiteData(harness!, id)));
  originalBrowsers = (await snapshot(harness)).browsers;
  for (const id of [1, 2]) {
    expect(originalSites[id - 1]).toMatchObject({
      cookie: `cleanup=browser-${id}`,
      local: `browser-${id}`,
      database: `browser-${id}`,
      cache: `browser-${id}`,
      cacheNames: ['unicorn-profile-cleanup'],
      serviceWorkers: [`${origin}/`],
    });
    expect(originalSites[id - 1]!.databases).toContain('unicorn-profile-cleanup');
  }
});
test.afterEach(async () => {
  try {
    await closeHarness(harness);
  } finally {
    harness = undefined;
  }
});
test.afterAll(async () => {
  await fixtures.close();
});

async function seedProfile(current: Harness, id: number): Promise<void> {
  await invoke(current, { type: 'navigate', id, url: `${origin}/?profile=${id}` });
  await browserEvaluate(
    current,
    id,
    `(async () => {
    await window.dbReady;
    await window.fetchReady;
    const owner = 'browser-${id}';
    localStorage.setItem('cleanup-owner', owner);
    document.cookie = 'cleanup=' + owner + ';Path=/;Max-Age=86400;SameSite=Lax';
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('unicorn-profile-cleanup', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('kv');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('kv', 'readwrite');
        transaction.objectStore('kv').put(owner, 'owner');
        transaction.oncomplete = () => { database.close(); resolve(true); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    });
    const cache = await caches.open('unicorn-profile-cleanup');
    await cache.put('/cleanup-record', new Response(owner));
    await cache.put('/cleanup-payload', new Response('persistent site data '.repeat(16384)));
    await navigator.serviceWorker.register('/service-worker.js');
    await navigator.serviceWorker.ready;
    return true;
  })()`,
  );
  expect(await fetchCachedResource(current, id)).toBeGreaterThan(250_000);
}

function readSiteData(current: Harness, id: number): Promise<SiteData> {
  return browserEvaluate(
    current,
    id,
    `(async () => {
    const databases = (await indexedDB.databases()).map(item => item.name).filter(Boolean).sort();
    let owner = null;
    if (databases.includes('unicorn-profile-cleanup')) {
      owner = await new Promise((resolve, reject) => {
        const request = indexedDB.open('unicorn-profile-cleanup', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const query = database.transaction('kv').objectStore('kv').get('owner');
          query.onsuccess = () => { database.close(); resolve(query.result ?? null); };
          query.onerror = () => { database.close(); reject(query.error); };
        };
      });
    }
    const cached = await caches.match('/cleanup-record');
    return {
      cookie: document.cookie,
      local: localStorage.getItem('cleanup-owner'),
      database: owner,
      databases,
      cache: cached ? await cached.text() : null,
      cacheNames: (await caches.keys()).sort(),
      serviceWorkers: (await navigator.serviceWorker.getRegistrations()).map(item => item.scope).sort(),
    };
  })()`,
  );
}

function fetchCachedResource(current: Harness, id: number): Promise<number> {
  return browserEvaluate(
    current,
    id,
    "fetch('/cacheable-resource', {cache: 'force-cache'}).then(response => response.text()).then(text => text.length)",
  );
}

function nativeState(current: Harness, id: number) {
  return current.app.evaluate(async (_electron, browserId) => {
    const contents = (
      globalThis as unknown as { __unicornTest: NativeRuntime }
    ).__unicornTest.manager.getWebContents(browserId);
    return {
      url: contents.getURL(),
      cacheBytes: await contents.session.getCacheSize(),
      historyEntries: contents.navigationHistory.length(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
    };
  }, id);
}

async function expectDevice(current: Harness, id: number, preset: 'desktop' | 'mobile' | 'tablet') {
  const device = DEVICES[preset];
  expect((await snapshot(current)).browsers.find((browser) => browser.id === id)?.device).toEqual(device);
  expect(
    await browserEvaluate(
      current,
      id,
      '({width:innerWidth,ratio:devicePixelRatio,touch:navigator.maxTouchPoints>0})',
    ),
  ).toEqual({
    width: device.width,
    ratio: device.scaleFactor,
    touch: device.touch,
  });
}

async function expectSiblingUnchanged(current: Harness) {
  expect(await readSiteData(current, 2)).toEqual(originalSites[1]);
  const sibling = (await snapshot(current)).browsers.find((browser) => browser.id === 2)!;
  expect(sibling).toMatchObject({
    state: originalBrowsers[1]!.state,
    url: originalBrowsers[1]!.url,
    device: originalBrowsers[1]!.device,
    history: originalBrowsers[1]!.history,
    proxy: { id: originalBrowsers[1]!.proxy!.id },
  });
  await expectDevice(current, 2, 'tablet');
  expect(fixtures.directRequests()).toBe(0);
}

test('storage inspection reports real profile bytes without stopping a browser or changing its data', async () => {
  const current = harness!;
  const native = await nativeState(current, 1);
  expect(native.cacheBytes).toBeGreaterThan(0);
  const result = await invoke(current, { type: 'profile', id: 1, action: 'storage' });
  expect(Number.isSafeInteger(result.storageBytes)).toBe(true);
  expect(result.storageBytes).toBeGreaterThan(0);
  expect(result.snapshot.browsers[0]).toMatchObject({
    state: originalBrowsers[0]!.state,
    url: originalBrowsers[0]!.url,
    history: originalBrowsers[0]!.history,
    proxy: { id: originalBrowsers[0]!.proxy!.id },
  });
  expect(await readSiteData(current, 1)).toEqual(originalSites[0]);
  await expectDevice(current, 1, 'mobile');
  await expectSiblingUnchanged(current);
});

test('clearing cookies preserves other site data, history, device emulation and the sibling profile', async () => {
  const current = harness!;
  const result = await invoke(current, { type: 'profile', id: 1, action: 'cookies' });
  expect(result.snapshot.browsers[0]).toMatchObject({
    state: 'STOPPED',
    url: originalBrowsers[0]!.url,
    history: originalBrowsers[0]!.history,
  });
  expect((await nativeState(current, 1)).url).toBe('about:blank');
  await invoke(current, { type: 'navigate', id: 1, url: `${origin}/policy/no-links` });
  expect(await readSiteData(current, 1)).toEqual({ ...originalSites[0], cookie: '' });
  await expectDevice(current, 1, 'mobile');
  await expectSiblingUnchanged(current);
});

test('clearing HTTP cache forces a fresh response while preserving CacheStorage and other profile data', async () => {
  const current = harness!;
  const cacheRequests = () =>
    fixtures.requests.filter((request) => request.path === '/cacheable-resource').length;
  const before = cacheRequests();
  expect((await nativeState(current, 1)).cacheBytes).toBeGreaterThan(0);
  await fetchCachedResource(current, 1);
  expect(cacheRequests(), 'The fresh response should be reused from the real HTTP cache').toBe(before);

  const result = await invoke(current, { type: 'profile', id: 1, action: 'cache' });
  expect(result.snapshot.browsers[0]).toMatchObject({
    state: 'STOPPED',
    history: originalBrowsers[0]!.history,
  });
  expect((await nativeState(current, 1)).cacheBytes).toBe(0);
  expect(await readSiteData(current, 1)).toEqual(originalSites[0]);
  await expectDevice(current, 1, 'mobile');
  await expectSiblingUnchanged(current);
  expect((await nativeState(current, 2)).cacheBytes).toBeGreaterThan(0);
  await fetchCachedResource(current, 2);
  expect(cacheRequests(), 'Clearing Browser 1 must preserve Browser 2 HTTP cache').toBe(before);

  await invoke(current, { type: 'navigate', id: 1, url: `${origin}/policy/no-links` });
  await fetchCachedResource(current, 1);
  expect(cacheRequests()).toBe(before + 1);
  expect(
    fixtures.requests
      .filter((request) => request.path === '/cacheable-resource')
      .every((request) => request.proxied),
  ).toBe(true);
});

test('clearing history clears saved entries and native back/forward controls without deleting site data', async () => {
  const current = harness!;
  await invoke(current, { type: 'navigate', id: 1, url: `${origin}/internal` });
  expect((await nativeState(current, 1)).canGoBack).toBe(true);
  expect((await snapshot(current)).browsers[0]!.history.length).toBeGreaterThan(1);
  const result = await invoke(current, { type: 'profile', id: 1, action: 'history' });
  expect(result.snapshot.browsers[0]).toMatchObject({
    state: 'STOPPED',
    url: `${origin}/internal`,
    history: [],
    canGoBack: false,
    canGoForward: false,
  });
  expect(await nativeState(current, 1)).toMatchObject({
    url: `${origin}/internal`,
    historyEntries: 1,
    canGoBack: false,
    canGoForward: false,
  });
  expect(await readSiteData(current, 1)).toEqual(originalSites[0]);
  await expectDevice(current, 1, 'mobile');
  await invoke(current, { type: 'browser', id: 1, action: 'back' });
  expect((await nativeState(current, 1)).url).toBe(`${origin}/internal`);
  await expectSiblingUnchanged(current);
});

test('clearing permissions enforces default-deny website requests while preserving stored data and emulation', async () => {
  const current = harness!;
  const permissions = () =>
    browserEvaluate(
      current,
      1,
      `(async () => ({
    notification: await Notification.requestPermission(),
    geolocation: await new Promise(resolve => navigator.geolocation.getCurrentPosition(
      () => resolve('granted'), error => resolve(error.code), {timeout: 3000}
    )),
  }))()`,
    );
  // There is no grant control: the documented permission reset restores the same default-deny policy.
  expect(await permissions()).toEqual({ notification: 'denied', geolocation: 1 });
  const result = await invoke(current, { type: 'profile', id: 1, action: 'permissions' });
  expect(result.snapshot.browsers[0]).toMatchObject({
    state: 'STOPPED',
    history: originalBrowsers[0]!.history,
  });
  expect(await permissions()).toEqual({ notification: 'denied', geolocation: 1 });
  expect(await readSiteData(current, 1)).toEqual(originalSites[0]);
  await expectDevice(current, 1, 'mobile');
  await expectSiblingUnchanged(current);
});

test('full reset clears cookies, local storage, IndexedDB, CacheStorage, service workers and history, restores desktop, and persists', async () => {
  const current = harness!;
  const directory = current.directory;
  await browserEvaluate(current, 1, "window.open('/popup', 'cleanup-popup');true");
  await expect.poll(async () => (await snapshot(current)).browsers[0]!.popups.length).toBe(1);
  const result = await invoke(current, { type: 'profile', id: 1, action: 'reset' });
  expect(result.snapshot.browsers[0]).toMatchObject({
    state: 'STOPPED',
    url: '',
    title: 'Profile reset',
    history: [],
    popups: [],
    canGoBack: false,
    canGoForward: false,
  });
  expect(await nativeState(current, 1)).toMatchObject({
    url: 'about:blank',
    cacheBytes: 0,
    canGoBack: false,
    canGoForward: false,
  });
  await expectDevice(current, 1, 'desktop');
  await expectSiblingUnchanged(current);

  const empty: SiteData = {
    cookie: '',
    local: null,
    database: null,
    databases: [],
    cache: null,
    cacheNames: [],
    serviceWorkers: [],
  };
  await invoke(current, { type: 'navigate', id: 1, url: `${origin}/policy/no-links` });
  expect(await readSiteData(current, 1)).toEqual(empty);
  await closeHarness(harness);
  harness = undefined;
  harness = await launchUnicorn(fixtures, { directory, settings: { browserCount: 2 } });
  for (const id of [1, 2]) await invoke(harness, { type: 'navigate', id, url: `${origin}/policy/no-links` });
  expect(await readSiteData(harness, 1)).toEqual(empty);
  expect(await readSiteData(harness, 2)).toEqual(originalSites[1]);
  await expectDevice(harness, 1, 'desktop');
  await expectDevice(harness, 2, 'tablet');
  expect(fixtures.directRequests()).toBe(0);
});
