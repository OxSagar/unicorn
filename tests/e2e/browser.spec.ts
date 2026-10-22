import { test, expect } from '@playwright/test';
import os from 'node:os';
import { createFixtures, type BrowserFixtures } from '../fixtures/servers';
import { launchUnicorn, closeHarness, invoke, snapshot, browserEvaluate, type Harness } from './helpers';
import { DEVICES } from '../../src/shared/defaults';

let fixtures: BrowserFixtures;
let harness: Harness | undefined;
test.beforeAll(async () => {
  fixtures = await createFixtures(20);
});
test.afterAll(async () => {
  await fixtures.close();
});
test.afterEach(async () => {
  await closeHarness(harness);
  harness = undefined;
});

test('real JavaScript, Fetch, IndexedDB, CacheStorage, service worker and isolated privileged APIs', async () => {
  harness = await launchUnicorn(fixtures);
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/` });
  expect(await browserEvaluate(harness, 1, 'window.fixtureReady')).toBe(true);
  expect(await browserEvaluate(harness, 1, 'window.fetchReady')).toEqual({ javascript: true });
  expect(await browserEvaluate(harness, 1, 'window.dbReady')).toBe(true);
  expect(
    await browserEvaluate(
      harness,
      1,
      "(async()=>{const cache=await caches.open('qa');await cache.put('/test',new Response('stored'));return await (await cache.match('/test')).text()})()",
    ),
  ).toBe('stored');
  expect(
    await browserEvaluate(
      harness,
      1,
      "navigator.serviceWorker.register('/service-worker.js').then(()=>navigator.serviceWorker.ready).then(()=>true)",
    ),
  ).toBe(true);
  expect(
    await browserEvaluate(
      harness,
      1,
      '({require:typeof require, process:typeof process, bridge:typeof window.unicorn})',
    ),
  ).toEqual({ require: 'undefined', process: 'undefined', bridge: 'undefined' });
  expect(await harness.app.evaluate(({ app }) => app.commandLine.hasSwitch('no-sandbox'))).toBe(false);
});

test('profile storage is isolated and survives an application restart', async () => {
  harness = await launchUnicorn(fixtures);
  const directory = harness.directory;
  await invoke(harness, { type: 'create', count: 2 });
  await Promise.all(
    [1, 2].map((id) => invoke(harness!, { type: 'navigate', id, url: `${fixtures.httpOrigin}/` })),
  );
  await browserEvaluate(
    harness,
    1,
    "localStorage.setItem('owner','first');document.cookie='unicorn=first;Path=/;Max-Age=86400';'ok'",
  );
  await browserEvaluate(
    harness,
    1,
    "new Promise((resolve,reject)=>{const r=indexedDB.open('unicorn-fixture',1);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('kv','readwrite');tx.objectStore('kv').put('persisted','owner');tx.oncomplete=()=>{db.close();resolve(true)};tx.onerror=()=>reject(tx.error)}})",
  );
  expect(
    await browserEvaluate(harness, 2, "({value:localStorage.getItem('owner'),cookies:document.cookie})"),
  ).toEqual({ value: null, cookies: '' });
  await closeHarness(harness);
  harness = undefined;
  harness = await launchUnicorn(fixtures, { directory });
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/` });
  expect(await browserEvaluate(harness, 1, "localStorage.getItem('owner')")).toBe('first');
  expect(await browserEvaluate<string>(harness, 1, 'document.cookie')).toContain('unicorn=first');
  expect(
    await browserEvaluate(
      harness,
      1,
      "new Promise((resolve,reject)=>{const r=indexedDB.open('unicorn-fixture',1);r.onsuccess=()=>{const db=r.result;const q=db.transaction('kv').objectStore('kv').get('owner');q.onsuccess=()=>{db.close();resolve(q.result)};q.onerror=()=>reject(q.error)}})",
    ),
  ).toBe('persisted');
});

test('desktop, mobile and tablet change real viewport, DPR and touch behavior without clearing storage', async () => {
  harness = await launchUnicorn(fixtures);
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/` });
  await browserEvaluate(harness, 1, "localStorage.setItem('device-test','retained')");
  for (const preset of ['desktop', 'mobile', 'tablet'] as const) {
    await invoke(harness, { type: 'device', ids: [1], device: DEVICES[preset] });
    const result = await browserEvaluate<{
      width: number;
      ratio: number;
      touch: number;
      ua: string;
      stored: string;
    }>(
      harness,
      1,
      "({width:innerWidth,ratio:devicePixelRatio,touch:navigator.maxTouchPoints,ua:navigator.userAgent,stored:localStorage.getItem('device-test')})",
    );
    expect(result.width).toBe(DEVICES[preset].width);
    expect(result.ratio).toBe(DEVICES[preset].scaleFactor);
    expect(result.touch > 0).toBe(DEVICES[preset].touch);
    expect(result.stored).toBe('retained');
    if (preset === 'mobile') expect(result.ua).toContain('Mobile');
  }
});

test('permitted popups retain parent session and proxy and can be dismissed', async () => {
  harness = await launchUnicorn(fixtures);
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpOrigin}/` });
  await invoke(harness, { type: 'device', ids: [1], device: DEVICES.mobile });
  await browserEvaluate(
    harness,
    1,
    "localStorage.setItem('popup-owner','parent');document.querySelector('#popup').click();true",
  );
  await expect.poll(async () => (await snapshot(harness!)).browsers[0]?.popups.length).toBe(1);
  const popup = (await snapshot(harness)).browsers[0]!.popups[0]!;
  await expect
    .poll(() => harness!.app.evaluate(({ webContents }, id) => webContents.fromId(id)?.getURL(), popup.id))
    .toBe(`${fixtures.httpOrigin}/popup`);
  const child = await harness.app.evaluate(async ({ webContents }, popupId) => {
    const manager = (
      globalThis as unknown as {
        __unicornTest: { manager: { getWebContents(id: number): Electron.WebContents } };
      }
    ).__unicornTest.manager;
    const contents = webContents.fromId(popupId);
    if (!contents) throw new Error('The approved popup was not created');
    return {
      sameSession: contents.session === manager.getWebContents(1).session,
      route: await contents.session.resolveProxy(contents.getURL()),
      webRtcPolicy: contents.getWebRTCIPHandlingPolicy(),
      page: await contents.executeJavaScript(
        "({ready:window.fixtureReady,owner:localStorage.getItem('popup-owner'),require:typeof require,process:typeof process,bridge:typeof window.unicorn})",
      ),
      fetch: await contents.executeJavaScript('window.fetchReady'),
    };
  }, popup.id);
  expect(child.sameSession).toBe(true);
  expect(child.route).toBe(`PROXY 127.0.0.1:${fixtures.proxies[0]!.record.port}`);
  expect(child.webRtcPolicy).toBe('disable_non_proxied_udp');
  expect(child.page).toEqual({
    ready: true,
    owner: 'parent',
    require: 'undefined',
    process: 'undefined',
    bridge: 'undefined',
  });
  expect(child.fetch).toEqual({ javascript: true });
  await expect
    .poll(() =>
      harness!.app.evaluate(
        ({ webContents }, id) =>
          webContents
            .fromId(id)
            ?.executeJavaScript(
              '({width:innerWidth,ratio:devicePixelRatio,touch:navigator.maxTouchPoints>0})',
            ),
        popup.id,
      ),
    )
    .toEqual({ width: DEVICES.mobile.width, ratio: DEVICES.mobile.scaleFactor, touch: true });
  expect(fixtures.requests.some((request) => request.path === '/popup' && request.proxied)).toBe(true);
  expect(fixtures.directRequests()).toBe(0);
  await invoke(harness, { type: 'popup', browserId: 1, popupId: popup.id, action: 'close' });
  expect((await snapshot(harness)).browsers[0]?.popups).toEqual([]);
  await expect
    .poll(() =>
      harness!.app.evaluate(({ webContents }, id) => webContents.fromId(id)?.isDestroyed() ?? true, popup.id),
    )
    .toBe(true);

  // Dismissal must also work before a slow child has a document or a CDP target.
  await browserEvaluate(harness, 1, "window.open('/slow','pending-popup');true");
  await expect.poll(async () => (await snapshot(harness!)).browsers[0]?.popups.length).toBe(1);
  const pending = (await snapshot(harness)).browsers[0]!.popups[0]!;
  await invoke(harness, { type: 'popup', browserId: 1, popupId: pending.id, action: 'close' });
  expect((await snapshot(harness)).browsers[0]?.popups).toEqual([]);
  expect(await browserEvaluate(harness, 1, 'window.fixtureReady')).toBe(true);
});

test('authorized QA stages complete, collect errors and skip unapproved external links', async () => {
  harness = await launchUnicorn(fixtures);
  await invoke(harness, {
    type: 'distribute',
    urls: [`${fixtures.httpOrigin}/?error=1`],
    ids: [1],
    mode: 'same',
  });
  await invoke(harness, { type: 'global', action: 'start' });
  await expect
    .poll(async () => (await snapshot(harness!)).jobs[0]?.status, { timeout: 20000 })
    .toBe('completed');
  const result = await snapshot(harness);
  expect(result.browsers[0]?.state).toBe('COMPLETED');
  expect(result.browsers[0]?.jsErrors).toBeGreaterThan(0);
  expect(fixtures.requests.some((request) => request.path === '/internal')).toBe(true);
  expect(fixtures.requests.some((request) => request.path === '/sponsored')).toBe(false);
  expect(result.logs.some((log) => /external|unapproved/i.test(log.message))).toBe(true);
});

test('HTTPS is certificate verified through CONNECT and WebSockets execute in Chromium', async () => {
  test.skip(
    !fixtures.httpsOrigin && process.platform !== 'win32',
    'Run prepare-cert and trust the certificate to execute HTTPS validation.',
  );
  expect(
    fixtures.httpsOrigin,
    'Windows acceptance requires a prepared trusted fixture certificate',
  ).toBeTruthy();
  harness = await launchUnicorn(fixtures);
  await invoke(harness, { type: 'navigate', id: 1, url: `${fixtures.httpsOrigin}/` });
  expect(await browserEvaluate(harness, 1, 'window.fixtureReady')).toBe(true);
  const ws = await browserEvaluate(
    harness,
    1,
    "new Promise((resolve,reject)=>{const ws=new WebSocket(location.origin.replace('https:','wss:')+'/socket');ws.onmessage=e=>{resolve(e.data);ws.close()};ws.onerror=()=>reject(new Error('WebSocket failed'));setTimeout(()=>reject(new Error('WebSocket timeout')),5000)})",
  );
  expect(ws).toBe('unicorn-websocket-ok');
  expect(fixtures.proxies[0]!.tunnels).toBeGreaterThan(0);
  expect((await snapshot(harness)).browsers[0]?.proxy?.exitIp).toBe('8.8.0.1');
});

for (const count of [1, 5, 10, 15, 20])
  test(`${count} real sessions navigate concurrently through unique proxies`, async ({
    browserName: _browserName,
  }, testInfo) => {
    test.setTimeout(180000);
    harness = await launchUnicorn(fixtures);
    await invoke(harness, { type: 'create', count });
    const before = fixtures.directRequests();
    const started = Date.now();
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        invoke(harness!, {
          type: 'navigate',
          id: index + 1,
          url: `${fixtures.httpOrigin}/?session=${index + 1}`,
        }),
      ),
    );
    const state = await snapshot(harness);
    expect(state.browsers).toHaveLength(count);
    expect(state.browsers.every((browser) => browser.state === 'RUNNING' && browser.proxy)).toBe(true);
    expect(new Set(state.browsers.map((browser) => browser.proxy!.id)).size).toBe(count);
    expect(new Set(state.browsers.map((browser) => browser.proxy!.exitIp)).size).toBe(count);
    expect(fixtures.directRequests()).toBe(before);
    for (const browser of state.browsers)
      expect(await browserEvaluate(harness, browser.id, 'window.fixtureReady')).toBe(true);
    const uiStart = Date.now();
    await invoke(harness, { type: 'snapshot' });
    const uiRoundtripMs = Date.now() - uiStart;
    expect(uiRoundtripMs).toBeLessThan(5000);
    const metrics = await harness.app.evaluate(({ app }) =>
      app.getAppMetrics().map((metric) => ({
        type: metric.type,
        cpu: metric.cpu.percentCPUUsage,
        workingSetKb: metric.memory.workingSetSize,
      })),
    );
    await testInfo.attach(`concurrency-${count}.json`, {
      body: JSON.stringify(
        {
          count,
          loadMs: Date.now() - started,
          uiRoundtripMs,
          platform: process.platform,
          hardware: {
            osRelease: os.release(),
            osVersion: os.version(),
            cpuModel: os.cpus()[0]?.model,
            logicalCpuCount: os.cpus().length,
            totalMemoryMb: Math.round(os.totalmem() / 1048576),
          },
          metrics,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    await testInfo.attach(`dashboard-${count}.png`, {
      body: await harness.page.screenshot(),
      contentType: 'image/png',
    });
  });

test('all browser counts 1–20 can be created, resized and closed with no orphaned views', async () => {
  test.setTimeout(180000);
  harness = await launchUnicorn(fixtures);
  for (let count = 1; count <= 20; count++) {
    await invoke(harness, { type: 'create', count });
    expect((await snapshot(harness)).browsers).toHaveLength(count);
  }
  for (let count = 19; count >= 1; count--) {
    await invoke(harness, { type: 'create', count });
    expect((await snapshot(harness)).browsers).toHaveLength(count);
  }
  const contents = await harness.app.evaluate(
    ({ webContents }) => webContents.getAllWebContents().filter((content) => !content.isDestroyed()).length,
  );
  expect(contents).toBeLessThanOrEqual(3);
});
