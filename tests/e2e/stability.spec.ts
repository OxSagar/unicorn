import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { AppSnapshot } from '../../src/shared/types';
import { createFixtures } from '../fixtures/servers';
import { launchUnicorn, closeHarness, invoke, browserEvaluate, type Harness } from './helpers';

interface StabilitySample {
  elapsedMs: number;
  phase: 'warmup' | 'scheduled' | 'stopped';
  jobs: Record<'completed' | 'failed' | 'cancelled' | 'pending' | 'running', number>;
  leases: Array<{ browserId: number; proxyId: string; exitIp?: string }>;
  performance: AppSnapshot['performance'];
  uiRoundtripMs: number;
}

test('twenty profiles complete three real minute-interval QA cycles from one Start command', async ({
  browserName: _browserName,
}, testInfo) => {
  test.setTimeout(300000);
  const fixtures = await createFixtures(20);
  const ids = Array.from({ length: 20 }, (_, index) => index + 1);
  const markers = ids.map((id) => `unicorn-stability:${randomUUID()}:${id}`);
  const schedule = {
    enabled: true,
    intervalMinutes: 1,
    startHour: 0,
    endHour: 24,
    resumeAfterRestart: false,
  };
  const samples: StabilitySample[] = [];
  const markerChecks: Array<{ cycle: number; elapsedMs: number; values: string[] }> = [];
  let harness: Harness | undefined;
  let latest: AppSnapshot | undefined;
  const startedAt = Date.now();
  let manualStarts = 0;

  async function sample(phase: StabilitySample['phase']): Promise<AppSnapshot> {
    const requestAt = performance.now();
    const state = (await invoke(harness!, { type: 'snapshot' })).snapshot;
    const uiRoundtripMs = performance.now() - requestAt;
    latest = state;
    const leases = state.proxies
      .filter((proxy) => proxy.assignedTo !== undefined)
      .map((proxy) => ({ browserId: proxy.assignedTo!, proxyId: proxy.id, exitIp: proxy.exitIp }));
    samples.push({
      elapsedMs: Date.now() - startedAt,
      phase,
      jobs: {
        completed: state.jobs.filter((job) => job.status === 'completed').length,
        failed: state.jobs.filter((job) => job.status === 'failed').length,
        cancelled: state.jobs.filter((job) => job.status === 'cancelled').length,
        pending: state.jobs.filter((job) => job.status === 'pending').length,
        running: state.jobs.filter((job) => job.status === 'running').length,
      },
      leases,
      performance: state.performance,
      uiRoundtripMs,
    });
    expect(new Set(leases.map((lease) => lease.browserId)).size).toBe(leases.length);
    expect(new Set(leases.map((lease) => lease.proxyId)).size).toBe(leases.length);
    expect(leases.every((lease) => Boolean(lease.exitIp))).toBe(true);
    expect(new Set(leases.map((lease) => lease.exitIp)).size).toBe(leases.length);
    expect(uiRoundtripMs, 'The trusted dashboard bridge must remain responsive').toBeLessThan(5000);
    expect(state.jobs.filter((job) => ['failed', 'cancelled'].includes(job.status))).toEqual([]);
    expect(fixtures.directRequests()).toBe(0);
    return state;
  }

  try {
    if (process.platform === 'win32')
      expect(
        fixtures.httpsOrigin,
        'Windows stability acceptance requires the trusted HTTPS fixture',
      ).toBeTruthy();
    const origin = fixtures.httpsOrigin ?? fixtures.httpOrigin;
    const url = `${origin}/policy/no-internal`;
    harness = await launchUnicorn(fixtures, {
      settings: {
        browserCount: 20,
        retryLimit: 0,
        schedule,
        timings: {
          landingWaitMs: 3000,
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
    // Seed actual origin storage independently in every persistent profile before
    // scheduling. These manual navigations create no QA jobs or recurring work.
    await Promise.all(ids.map((id) => invoke(harness!, { type: 'navigate', id, url })));
    await Promise.all(
      ids.map((id, index) =>
        browserEvaluate(
          harness!,
          id,
          `localStorage.setItem('unicorn-stability-marker', ${JSON.stringify(markers[index])});true`,
        ),
      ),
    );
    const warmup = await sample('warmup');
    expect(warmup.jobs).toEqual([]);
    expect(samples[0].leases).toHaveLength(20);
    await invoke(harness, { type: 'distribute', urls: [url], ids, mode: 'same' });
    await invoke(harness, { type: 'global', action: 'start' });
    manualStarts++;

    const deadline = Date.now() + 220000;
    let checkedCycles = 0;
    while (Date.now() < deadline) {
      const state = await sample('scheduled');
      const completed = state.jobs.filter((job) => job.status === 'completed').length;
      if (completed >= (checkedCycles + 1) * ids.length) {
        const values = await Promise.all(
          ids.map((id) =>
            browserEvaluate<string>(harness!, id, "localStorage.getItem('unicorn-stability-marker')"),
          ),
        );
        checkedCycles++;
        markerChecks.push({ cycle: checkedCycles, elapsedMs: Date.now() - startedAt, values });
        expect(values).toEqual(markers);
      }
      if (completed >= 60) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    }
    expect(latest?.jobs.filter((job) => job.status === 'completed')).toHaveLength(60);
    expect(latest?.jobs).toHaveLength(60);
    expect(manualStarts).toBe(1);
    expect(markerChecks).toHaveLength(3);

    // The timestamp gaps prove recurrence used real sixty-second intervals,
    // without changing a clock, invoking the scheduler directly, or extra Starts.
    for (const id of ids) {
      const runs = latest!.jobs
        .filter((job) => job.browserId === id)
        .sort((a, b) => a.createdAt - b.createdAt);
      expect(runs).toHaveLength(3);
      expect(runs.every((job) => job.status === 'completed' && Number.isFinite(job.finishedAt))).toBe(true);
      for (let cycle = 1; cycle < runs.length; cycle++)
        expect(runs[cycle].createdAt - runs[cycle - 1].finishedAt!).toBeGreaterThanOrEqual(60000);
    }
    expect(fixtures.requests.filter((request) => request.path === '/policy/no-internal')).toHaveLength(80);
    expect(samples.at(-1)!.performance.heartbeatCount).toBeGreaterThan(samples[0].performance.heartbeatCount);
    expect(samples.at(-1)!.performance.sampledAt).toBeGreaterThan(samples[0].performance.sampledAt);
    expect(samples.every((value) => Number.isFinite(value.performance.cpuPercent))).toBe(true);
    expect(samples.every((value) => value.performance.memoryMb > 0)).toBe(true);

    await invoke(harness, { type: 'global', action: 'stop' });
    const stopped = await sample('stopped');
    expect(stopped.proxies.every((proxy) => proxy.assignedTo === undefined)).toBe(true);
    expect(stopped.browsers.every((browser) => browser.state === 'STOPPED')).toBe(true);
  } finally {
    try {
      await testInfo.attach('twenty-profile-three-cycle-stability.json', {
        body: JSON.stringify(
          {
            scope: 'Three real scheduled cycles; not a 24-hour endurance or stable-memory claim',
            platform: process.platform,
            hardware: {
              osRelease: os.release(),
              osVersion: os.version(),
              cpuModel: os.cpus()[0]?.model,
              logicalCpuCount: os.cpus().length,
              totalMemoryMb: Math.round(os.totalmem() / 1048576),
            },
            schedule,
            manualStarts,
            elapsedMs: Date.now() - startedAt,
            samples,
            markerChecks,
            jobs: latest?.jobs,
            directRequests: fixtures.directRequests(),
            proxyTraffic: fixtures.proxies.map((proxy) => ({
              id: proxy.record.id,
              requests: proxy.requests,
              tunnels: proxy.tunnels,
            })),
          },
          null,
          2,
        ),
        contentType: 'application/json',
      });
    } finally {
      try {
        await closeHarness(harness);
      } finally {
        await fixtures.close();
      }
    }
  }
});
