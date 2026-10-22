import { test, expect } from '@playwright/test';
import { createFixtures, type BrowserFixtures } from '../fixtures/servers';
import { launchUnicorn, closeHarness, invoke, snapshot, browserEvaluate, type Harness } from './helpers';
import { CHALLENGE_MESSAGE } from '../../src/main/qa/challenge';

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

for (const endpoint of ['challenge-title', 'challenge-widget', 'challenge-delayed'])
  test(`${endpoint} stops QA without interaction, proxy rotation or an active lease`, async () => {
    harness = await launchUnicorn(fixtures, {
      settings: {
        retryLimit: 2,
        timings: {
          landingWaitMs: 1500,
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
    await invoke(harness, {
      type: 'distribute',
      urls: [`${fixtures.httpOrigin}/${endpoint}`],
      ids: [1],
      mode: 'same',
    });
    await invoke(harness, { type: 'global', action: 'start' });
    await expect.poll(async () => (await snapshot(harness!)).jobs[0]?.status).toBe('failed');
    const state = await snapshot(harness);
    expect(state.jobs[0]?.error).toBe(CHALLENGE_MESSAGE);
    expect(state.browsers[0]?.state).toBe('ERROR');
    expect(state.proxies.every((proxy) => proxy.assignedTo === undefined && proxy.failures === 0)).toBe(true);
    expect(fixtures.proxies.slice(1).every((proxy) => proxy.requests + proxy.tunnels === 0)).toBe(true);
    expect(await browserEvaluate(harness, 1, 'window.challengeInteractions')).toBe(0);
    expect(
      await browserEvaluate(
        harness,
        1,
        "fetch('/after-challenge').then(() => 'unexpected request', () => 'blocked')",
      ),
    ).toBe('blocked');
    expect(fixtures.requests.some((request) => request.path === '/after-challenge')).toBe(false);
  });

test('a hidden widget does not classify an ordinary fixture as a visible challenge', async () => {
  harness = await launchUnicorn(fixtures);
  await invoke(harness, {
    type: 'distribute',
    urls: [`${fixtures.httpOrigin}/challenge-hidden`],
    ids: [1],
    mode: 'same',
  });
  await invoke(harness, { type: 'global', action: 'start' });
  await expect.poll(async () => (await snapshot(harness!)).jobs[0]?.status).toBe('completed');
  expect(await browserEvaluate(harness, 1, 'window.challengeInteractions')).toBe(0);
});
