import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { UnicornController } from '../../src/main/controller';
import { BrowserManager } from '../../src/main/browser/manager';
import { ActivityLog, initialData, LocalStore, type StoredData } from '../../src/main/storage';
import { DEFAULT_SETTINGS, DEVICES } from '../../src/shared/defaults';
import type { AppCommand, BrowserSnapshot, DeviceConfig, TestJob } from '../../src/shared/types';
import { SiteRestrictionError } from '../../src/main/network/site-restriction';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: {
    getVersion: () => 'controller-test',
    getAppMetrics: () => [],
    setLoginItemSettings: vi.fn(),
  },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../src/main/browser/manager', () => ({ BrowserManager: vi.fn() }));

const INTERVAL = 60_000;
const FIRST = 'https://authorized.test/first';
const SECOND = 'https://authorized.test/second';
const OTHER = 'https://other.test/page';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Only the native browser boundary is simulated; the queue, clock, scope, and controller are real. */
class BrowserDouble {
  private browsers = new Map<number, BrowserSnapshot>();
  private holds = new Map<string, ReturnType<typeof deferred>>();
  private inFlight = new Map<number, ReturnType<typeof deferred>>();
  readonly failures = new Map<string, Error>();
  readonly waiting = new Set<string>();

  private browser(id: number): BrowserSnapshot {
    const browser = this.browsers.get(id);
    if (!browser) throw new Error(`Browser ${id} is not open`);
    return browser;
  }

  hold(url: string) {
    const completion = deferred();
    this.holds.set(url, completion);
    return completion;
  }

  readonly create = vi.fn(async (count: number) => {
    for (const id of this.browsers.keys())
      if (id > count) {
        await this.stop(id);
        this.browsers.delete(id);
      }
    for (let id = 1; id <= count; id++)
      if (!this.browsers.has(id))
        this.browsers.set(id, {
          id,
          name: `Browser ${id}`,
          state: 'CREATED',
          url: '',
          title: 'Ready',
          device: { ...DEVICES.desktop },
          loading: false,
          canGoBack: false,
          canGoForward: false,
          stage: 'Idle',
          elapsedMs: 0,
          jsErrors: 0,
          networkErrors: 0,
          history: [],
          popups: [],
        });
  });

  readonly snapshots = vi.fn(() => structuredClone([...this.browsers.values()]));
  readonly checkHealth = vi.fn();

  readonly runQa = vi.fn(async (id: number, url: string) => {
    const browser = this.browser(id);
    browser.url = url;
    browser.state = 'RUNNING';
    try {
      if (this.waiting.has(url)) {
        browser.state = 'WAITING_FOR_PROXY';
        throw new Error('Waiting for an eligible proxy');
      }
      const error = this.failures.get(url);
      if (error) throw error;
      const hold = this.holds.get(url);
      if (hold) {
        this.holds.delete(url);
        this.inFlight.set(id, hold);
        await hold.promise;
      }
      browser.state = 'COMPLETED';
    } catch (error) {
      if (browser.state !== 'WAITING_FOR_PROXY') browser.state = 'ERROR';
      throw error;
    } finally {
      this.inFlight.delete(id);
    }
  });

  readonly pause = vi.fn(async (id: number) => {
    this.browser(id).state = 'PAUSED';
  });

  readonly resume = vi.fn(async (id: number) => {
    this.browser(id).state = this.inFlight.has(id) ? 'RUNNING' : 'READY';
  });

  readonly stop = vi.fn(async (id: number) => {
    this.inFlight.get(id)?.reject(new Error('Stopped by user'));
    this.browser(id).state = 'STOPPED';
  });

  readonly applyDevice = vi.fn(async (ids: number[], device: DeviceConfig, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    for (const id of ids) {
      await this.stop(id);
      signal?.throwIfAborted();
      this.browser(id).device = structuredClone(device);
    }
  });

  readonly action = vi.fn(async (id: number, action: string) => {
    if (action === 'pause') await this.pause(id);
    else if (action === 'resume') await this.resume(id);
    else if (action === 'stop' || action === 'close') {
      await this.stop(id);
      if (action === 'close') this.browsers.delete(id);
    } else throw new Error(`Unexpected browser action in controller test: ${action}`);
  });

  readonly shutdown = vi.fn(async () => {
    await Promise.all([...this.browsers.keys()].map((id) => this.stop(id)));
    this.browsers.clear();
  });
}

const controllers = new Set<UnicornController>();

function state(browserCount = 2): StoredData {
  const data = initialData();
  data.settings.browserCount = browserCount;
  data.settings.authorizedDomains = ['authorized.test', 'other.test'];
  data.settings.stagingConfirmed = true;
  data.settings.schedule = {
    enabled: true,
    intervalMinutes: 1,
    startHour: 0,
    endHour: 24,
    resumeAfterRestart: false,
  };
  return data;
}

function historicalJob(id: string, browserId: number, url: string): TestJob {
  return {
    id,
    browserId,
    url,
    status: 'completed',
    createdAt: Date.now() - 120_000,
    finishedAt: Date.now() - 60_000,
  };
}

async function setup(data = state()) {
  const manager = new BrowserDouble();
  vi.mocked(BrowserManager).mockImplementation(function () {
    return manager as unknown as BrowserManager;
  });
  const window = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
  let saved = structuredClone(data);
  const store = new LocalStore('/unused-controller-test');
  vi.spyOn(store, 'save').mockImplementation(async (value) => {
    saved = structuredClone(value);
  });
  const logs = new ActivityLog('/unused-controller-test');
  vi.spyOn(logs, 'add').mockImplementation(() => undefined);
  vi.spyOn(logs, 'flush').mockResolvedValue();
  const controller = new UnicornController(window, data, store, logs, {
    userData: store.directory,
    proxies: [],
  });
  controllers.add(controller);
  await controller.initialize();
  return {
    controller,
    manager,
    store,
    logs,
    options: vi.mocked(BrowserManager).mock.calls.at(-1)![0],
    saved: () => structuredClone(saved),
    urls: () => manager.runQa.mock.calls.map(([, url]) => url),
    assign: async (id: number, urls: string[]) =>
      controller.command({ type: 'distribute', ids: [id], urls, mode: 'round-robin' }),
    close: async () => {
      await controller.shutdown();
      controllers.delete(controller);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
});

afterEach(async () => {
  for (const controller of controllers) await controller.shutdown();
  controllers.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('reviewed count, device, paste, distribute, Start workflow', () => {
  const REVIEWED = 'https://reviewed.example/landing';
  const prepare = async (
    controller: UnicornController,
    text = REVIEWED,
    count = 1,
    device: 'desktop' | 'mobile' | 'tablet' = 'desktop',
  ) => (await controller.command({ type: 'simple-distribute', text, count, device })).snapshot.preparedRun!;
  const start = (controller: UnicornController, reviewId: string) =>
    controller.command({ type: 'simple-start', reviewId, confirmed: true });

  it('upgrades a full legacy queue and redistributes after restart without losing old work or restoring approval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'unicorn-simple-upgrade-'));
    try {
      const data = state(2);
      const legacy = Array.from({ length: 1000 }, (_, index) => ({
        ...historicalJob(`legacy-${index}`, 1, `https://authorized.test/legacy-${index}`),
        status: 'pending' as const,
      }));
      data.jobs = structuredClone(legacy);
      data.settings.schedule.resumeAfterRestart = true;
      data.scheduleTemplates = [{ browserId: 2, url: SECOND }];
      const original = await setup(data);
      const first = await prepare(original.controller, REVIEWED, 20, 'mobile');
      expect(original.controller.snapshot().jobs).toHaveLength(20);
      expect(original.controller.snapshot().preservedJobs).toEqual(legacy);
      await original.close();
      const disk = new LocalStore(directory);
      await disk.save(original.saved());
      const restored = await disk.load();
      expect(restored.simpleJobIds).toEqual(first.jobIds);
      expect(restored.preservedJobs).toEqual(legacy);
      const restarted = await setup(restored);
      await vi.advanceTimersByTimeAsync(INTERVAL * 2);
      expect(restarted.urls()).toEqual([]);
      expect(restarted.controller.snapshot().preparedRun).toBeNull();
      await expect(start(restarted.controller, first.id)).rejects.toThrow(/Distribute/);
      const next = await prepare(restarted.controller, 'https://another.example/new', 1, 'tablet');
      expect(next.jobIds).toHaveLength(1);
      expect(restarted.controller.snapshot().jobs).toHaveLength(1);
      expect(restarted.controller.snapshot().preservedJobs).toEqual(legacy);
      await start(restarted.controller, next.id);
      await vi.advanceTimersByTimeAsync(0);
      expect(restarted.urls()).toEqual(['https://another.example/new']);
      expect(restarted.controller.snapshot().settings.authorizedDomains).toEqual([
        'authorized.test',
        'other.test',
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('prepares exact immutable choices without navigation, device writes, or stored approval changes', async () => {
    const data = state(4);
    const old = { ...historicalJob('saved-pending', 1, FIRST), status: 'pending' as const };
    data.jobs = [old];
    const before = structuredClone(data.settings);
    const { controller, manager, options } = await setup(data);
    const plan = await prepare(controller, `${REVIEWED}\nhttps://second.example/`, 3, 'tablet');
    expect(plan).toMatchObject({
      count: 3,
      device: 'tablet',
      browserIds: [1, 2, 3],
      domains: ['reviewed.example', 'second.example'],
      status: 'ready',
    });
    expect(plan.jobIds).toHaveLength(3);
    expect(manager.create).toHaveBeenCalledTimes(1);
    expect(manager.applyDevice).not.toHaveBeenCalled();
    expect(manager.runQa).not.toHaveBeenCalled();
    expect(controller.snapshot().preservedJobs.find((job) => job.id === old.id)).toEqual(old);
    expect(options.settings(1)).toEqual(before);
    plan.domains.push('evil.test');
    plan.browserIds.push(20);
    plan.device = 'mobile';
    plan.count = 20;
    expect(controller.snapshot().preparedRun).toMatchObject({
      count: 3,
      device: 'tablet',
      browserIds: [1, 2, 3],
      domains: ['reviewed.example', 'second.example'],
    });
    expect(controller.snapshot().settings).toEqual(before);
  });

  it('runs only reviewed jobs once under ephemeral exact-host defaults and preserves hidden settings/templates', async () => {
    const data = state(4);
    data.settings.timings.landingWaitMs = 3_600_000;
    data.settings.retryLimit = 5;
    data.settings.schedule.resumeAfterRestart = true;
    data.scheduleTemplates = [{ browserId: 4, url: FIRST }];
    data.nextRunAt = Date.now() - 1;
    const old = { ...historicalJob('legacy', 1, FIRST), status: 'pending' as const };
    data.jobs = [old];
    const before = structuredClone(data.settings);
    const { controller, manager, options, urls, saved } = await setup(data);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(urls()).toEqual([]);
    const held = manager.hold(REVIEWED);
    const plan = await prepare(controller, REVIEWED, 1, 'mobile');
    await start(controller, plan.id);
    expect(manager.applyDevice).toHaveBeenCalledWith([1], DEVICES.mobile, expect.any(AbortSignal));
    expect(options.settings(1)).toMatchObject({
      authorizedDomains: ['reviewed.example'],
      stagingConfirmed: true,
      retryLimit: 2,
      schedule: { enabled: false },
    });
    expect(options.settings(1).timings).toEqual(DEFAULT_SETTINGS.timings);
    expect(options.settings(2)).toEqual({ ...before, browserCount: 1 });
    expect(controller.snapshot().settings).toEqual({ ...before, browserCount: 1 });
    held.resolve();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(urls()).toEqual([REVIEWED]);
    expect(controller.snapshot().preparedRun?.status).toBe('finished');
    expect(controller.snapshot().preservedJobs.find((job) => job.id === old.id)).toEqual(old);
    expect(options.settings(1)).toEqual({ ...before, browserCount: 1 });
    expect(saved().scheduleTemplates).toEqual([{ browserId: 4, url: FIRST }]);
    await expect(start(controller, plan.id)).rejects.toThrow(/Distribute/);
    expect(urls()).toEqual([REVIEWED]);
  });

  it('preserves inactive saved recurrence when emergency Stop is used before any distribution', async () => {
    const data = state(2);
    data.settings.schedule.resumeAfterRestart = true;
    data.scheduleTemplates = [{ browserId: 2, url: SECOND }];
    data.nextRunAt = Date.now() - 1;
    const before = structuredClone(data);
    const { controller, urls, saved } = await setup(data);
    await controller.command({ type: 'global', action: 'stop' });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(controller.snapshot().settings).toEqual(before.settings);
    expect(saved().scheduleTemplates).toEqual(before.scheduleTemplates);
    expect(saved().nextRunAt).toBe(before.nextRunAt);
    expect(urls()).toEqual([]);
    expect(controller.snapshot().scheduler.running).toBe(false);
  });

  it('replaces only the previous unstarted review and rejects a stale count/device token', async () => {
    const data = state(1);
    data.jobs = [{ ...historicalJob('legacy', 1, FIRST), status: 'pending' }];
    const { controller, manager, urls } = await setup(data);
    const original = await prepare(controller, REVIEWED, 1, 'desktop');
    const next = await prepare(controller, REVIEWED, 3, 'tablet');
    expect(next.id).not.toBe(original.id);
    expect(controller.snapshot().jobs.filter((job) => original.jobIds.includes(job.id))).toEqual([]);
    expect(controller.snapshot().preservedJobs.some((job) => job.id === 'legacy')).toBe(true);
    expect(manager.create).toHaveBeenLastCalledWith(3);
    await expect(start(controller, original.id)).rejects.toThrow(/current review/);
    await start(controller, next.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([REVIEWED, REVIEWED, REVIEWED]);
    expect(manager.snapshots().map((browser) => browser.device.preset)).toEqual([
      'tablet',
      'tablet',
      'tablet',
    ]);
  });

  it('Stop wins asynchronous profile creation without deleting saved jobs or preferences', async () => {
    const data = state(1);
    data.jobs = [{ ...historicalJob('legacy', 1, FIRST), status: 'pending' }];
    data.scheduleTemplates = [{ browserId: 1, url: FIRST }];
    const { controller, manager, urls } = await setup(data);
    const creation = deferred();
    const create = manager.create.getMockImplementation()!;
    manager.create.mockImplementationOnce(async (count) => {
      await creation.promise;
      await create(count);
    });
    const preparing = prepare(controller, REVIEWED, 3);
    const rejected = expect(preparing).rejects.toThrow(/cancelled/);
    await controller.command({ type: 'global', action: 'stop' });
    creation.resolve();
    await rejected;
    expect(controller.snapshot().preparedRun).toBeNull();
    expect(controller.snapshot().jobs.map((job) => job.id)).toEqual(['legacy']);
    expect(controller.snapshot().settings.schedule.enabled).toBe(true);
    expect(data.scheduleTemplates).toEqual([{ browserId: 1, url: FIRST }]);
    expect(urls()).toEqual([]);
  });

  it('Stop cancels an in-flight device application before any host authority or navigation is granted', async () => {
    const { controller, manager, options, urls } = await setup(state(2));
    const plan = await prepare(controller, REVIEWED, 1, 'mobile');
    const device = deferred();
    manager.applyDevice.mockImplementationOnce(async (_ids, _device, signal) => {
      await device.promise;
      signal?.throwIfAborted();
    });
    const starting = start(controller, plan.id);
    const rejected = expect(starting).rejects.toThrow(/stopped/);
    expect(options.settings(1).authorizedDomains).toEqual([]);
    await controller.command({ type: 'global', action: 'stop' });
    expect(options.settings(1).authorizedDomains).toEqual([]);
    device.resolve();
    await rejected;
    expect(urls()).toEqual([]);
    expect(controller.snapshot().settings.browserCount).toBe(2);
    expect(controller.snapshot().jobs.every((job) => job.status === 'cancelled')).toBe(true);
    const again = await prepare(controller, REVIEWED, 1, 'tablet');
    await start(controller, again.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([REVIEWED]);
    expect(controller.snapshot().preparedRun?.status).toBe('finished');
  });

  it('records Pause during device setup without pausing the native operation, then resumes through Start', async () => {
    const { controller, manager, urls } = await setup(state(1));
    const plan = await prepare(controller, REVIEWED);
    const device = deferred();
    manager.applyDevice.mockImplementationOnce(async () => {
      await device.promise;
    });
    const starting = start(controller, plan.id);
    await controller.command({ type: 'global', action: 'pause' });
    expect(manager.pause).not.toHaveBeenCalled();
    device.resolve();
    await starting;
    expect(controller.snapshot().scheduler).toMatchObject({ running: true, paused: true });
    expect(urls()).toEqual([]);
    await start(controller, plan.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([REVIEWED]);
    expect(controller.snapshot().preparedRun?.status).toBe('finished');
  });

  it('keeps idle, ready and finished workspaces editable after Pause and clears pause when a batch finishes', async () => {
    const { controller, manager, urls } = await setup(state(2));
    await controller.command({ type: 'global', action: 'pause' });
    expect(controller.snapshot().scheduler).toMatchObject({ running: false, paused: false });
    expect(manager.pause).not.toHaveBeenCalled();

    const plan = await prepare(controller, FIRST);
    await controller.command({ type: 'global', action: 'pause' });
    expect(controller.snapshot().preparedRun?.status).toBe('ready');
    expect(controller.snapshot().scheduler.paused).toBe(false);
    expect(manager.pause).not.toHaveBeenCalled();

    const held = manager.hold(FIRST);
    await start(controller, plan.id);
    await controller.command({ type: 'global', action: 'pause' });
    expect(controller.snapshot().scheduler.paused).toBe(true);
    expect(manager.pause).toHaveBeenCalledExactlyOnceWith(1);
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().preparedRun?.status).toBe('finished');
    expect(controller.snapshot().scheduler).toMatchObject({ running: false, paused: false });

    await controller.command({ type: 'global', action: 'pause' });
    expect(controller.snapshot().scheduler.paused).toBe(false);
    expect(manager.pause).toHaveBeenCalledTimes(1);
    const next = await prepare(controller, SECOND, 2, 'mobile');
    expect(next.status).toBe('ready');
    expect(urls()).toEqual([FIRST]);
  });

  it('resumes only the already-reviewed remainder through Start after a global pause', async () => {
    const data = state(1);
    data.jobs = [{ ...historicalJob('legacy', 1, OTHER), status: 'pending' }];
    const { controller, manager, urls } = await setup(data);
    const held = manager.hold(FIRST);
    const plan = await prepare(controller, `${FIRST}\n${SECOND}`, 1);
    await start(controller, plan.id);
    await controller.command({ type: 'global', action: 'pause' });
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([FIRST]);
    await start(controller, plan.id);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(urls()).toEqual([FIRST, SECOND]);
    expect(controller.snapshot().preservedJobs.find((job) => job.id === 'legacy')?.status).toBe('pending');
  });

  it('continues proxy-wait work only after an eligible endpoint appears and never accepts unrelated jobs', async () => {
    const data = state(1);
    data.jobs = [{ ...historicalJob('legacy', 1, SECOND), status: 'pending' }];
    const { controller, manager, urls } = await setup(data);
    manager.waiting.add(FIRST);
    const plan = await prepare(controller, FIRST);
    await start(controller, plan.id);
    await vi.advanceTimersByTimeAsync(6000);
    expect(urls()).toEqual([FIRST]);
    expect(controller.snapshot().preparedRun?.status).toBe('running');
    manager.waiting.delete(FIRST);
    controller.pool.merge([
      {
        id: 'fixture',
        ip: '127.0.0.1',
        port: 9001,
        protocol: 'http',
        country: 'US',
        countryName: 'United States',
        status: 'available',
        failures: 0,
        source: 'fixture',
      },
    ]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(urls()).toEqual([FIRST, FIRST]);
    expect(controller.snapshot().preparedRun?.status).toBe('finished');
    expect(controller.snapshot().preservedJobs.find((job) => job.id === 'legacy')?.status).toBe('pending');
  });

  it('cancels only a failed review profile remainder, preserves saved work, and permits a fresh reviewed run', async () => {
    const data = state(1);
    data.jobs = [{ ...historicalJob('legacy', 1, SECOND), status: 'pending' }];
    data.scheduleTemplates = [{ browserId: 1, url: SECOND }];
    const { controller, manager, urls } = await setup(data);
    manager.failures.set(FIRST, new Error('HTTP 403: access requires manual review'));
    const plan = await prepare(controller, `${FIRST}\n${SECOND}`, 1);
    await start(controller, plan.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.snapshot().preparedRun?.status).toBe('finished');
    expect(
      controller
        .snapshot()
        .jobs.filter((job) => plan.jobIds.includes(job.id))
        .map((job) => job.status),
    ).toEqual(['failed', 'cancelled']);
    expect(controller.snapshot().preservedJobs.find((job) => job.id === 'legacy')?.status).toBe('pending');
    expect(data.scheduleTemplates).toEqual([{ browserId: 1, url: SECOND }]);
    expect(data.settings.schedule.enabled).toBe(true);
    manager.failures.clear();
    const again = await prepare(controller, REVIEWED);
    await start(controller, again.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([FIRST, REVIEWED]);
    expect(controller.snapshot().preparedRun?.status).toBe('finished');
  });

  it('finishes a restricted batch when a stopped sibling has already fulfilled its native QA promise', async () => {
    const { controller, manager, urls } = await setup(state(2));
    manager.failures.set(FIRST, new SiteRestrictionError('HTTP 403', FIRST));
    const plan = await prepare(
      controller,
      `${FIRST}\n${SECOND}\nhttps://other.test/later-one\nhttps://other.test/later-two`,
      2,
    );
    await start(controller, plan.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([FIRST, SECOND]);
    expect(controller.snapshot().jobs.some((job) => ['pending', 'running'].includes(job.status))).toBe(false);
    expect(controller.snapshot().preparedRun?.status).toBe('finished');
    expect(controller.snapshot().scheduler.running).toBe(false);
  });

  it('simple Stop revokes only the reviewed batch while preserving saved queues and recurrence preferences', async () => {
    const data = state(1);
    data.jobs = [{ ...historicalJob('legacy', 1, OTHER), status: 'pending' }];
    data.scheduleTemplates = [{ browserId: 1, url: OTHER }];
    const { controller, manager, options, saved } = await setup(data);
    manager.hold(FIRST);
    const plan = await prepare(controller, `${FIRST}\n${SECOND}`);
    await start(controller, plan.id);
    await controller.command({ type: 'global', action: 'stop' });
    await vi.advanceTimersByTimeAsync(500);
    expect(controller.snapshot().preservedJobs.find((job) => job.id === 'legacy')?.status).toBe('pending');
    expect(
      controller
        .snapshot()
        .jobs.filter((job) => plan.jobIds.includes(job.id))
        .every((job) => job.status === 'cancelled'),
    ).toBe(true);
    expect(saved().settings.schedule.enabled).toBe(true);
    expect(saved().scheduleTemplates).toEqual([{ browserId: 1, url: OTHER }]);
    expect(controller.snapshot().scheduler.running).toBe(false);
    expect(options.settings(1).authorizedDomains).toEqual(data.settings.authorizedDomains);
    await expect(start(controller, plan.id)).rejects.toThrow(/Distribute/);
  });
});

describe('explicit queue runs and recurrence', () => {
  it('preserves state and flushes logs when native shutdown reports a cleanup error', async () => {
    const { controller, manager, store, logs, assign } = await setup();
    await assign(1, [FIRST]);
    manager.shutdown.mockRejectedValueOnce(new Error('Native cookies flush timed out'));
    await expect(controller.shutdown()).rejects.toThrow(/cleanup errors/);
    expect(store.save).toHaveBeenCalled();
    expect(logs.flush).toHaveBeenCalled();
    expect(vi.mocked(store.save).mock.calls.at(-1)?.[0].jobs[0]?.url).toBe(FIRST);
  });
  it('editing a reviewed pending assignment requires a new Start and updates its browser safely', async () => {
    const { controller, manager, assign, urls } = await setup();
    const held = manager.hold(FIRST);
    await assign(1, [FIRST, SECOND]);
    await controller.command({ type: 'browser', id: 1, action: 'start' });
    const pending = controller.snapshot().jobs.find((job) => job.url === SECOND)!;
    await controller.command({ type: 'edit-job', id: pending.id, url: OTHER, browserId: 2 });
    held.resolve();
    await vi.advanceTimersByTimeAsync(INTERVAL);
    const edited = controller.snapshot().jobs.find((job) => job.url === OTHER)!;
    expect(edited).toMatchObject({ browserId: 2, status: 'pending' });
    expect(edited.id).not.toBe(pending.id);
    expect(urls()).toEqual([FIRST, FIRST]);
    await controller.command({ type: 'browser', id: 2, action: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([FIRST, FIRST, OTHER]);
    await expect(
      controller.command({ type: 'edit-job', id: edited.id, url: FIRST, browserId: 1 }),
    ).rejects.toThrow(/pending/);
  });

  it('rejects unsafe, duplicate or closed-browser queue edits without changing the original job', async () => {
    const { controller, assign } = await setup();
    await assign(1, [FIRST, SECOND]);
    const original = controller.snapshot().jobs[0]!;
    await expect(
      controller.command({ type: 'edit-job', id: original.id, url: 'https://outside.test/', browserId: 1 }),
    ).rejects.toThrow(/scope/);
    await expect(
      controller.command({ type: 'edit-job', id: original.id, url: SECOND, browserId: 1 }),
    ).rejects.toThrow(/already/);
    await expect(
      controller.command({ type: 'edit-job', id: original.id, url: OTHER, browserId: 3 }),
    ).rejects.toThrow(/Reopen/);
    expect(controller.snapshot().jobs[0]).toEqual(original);
  });

  it('counts page and subresource requests against one persisted per-host daily quota', async () => {
    const data = state();
    data.settings.dailyRequestLimit = 2;
    await setup(data);
    const options = vi.mocked(BrowserManager).mock.calls.at(-1)![0];
    options.requestAllowed!('https://authorized.test/page');
    options.requestAllowed!('https://authorized.test/asset.js');
    expect(() => options.requestAllowed!('https://authorized.test/fetch')).toThrow(SiteRestrictionError);
    expect(() => options.requestAllowed!('https://other.test/asset')).not.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    expect(data.requestBudget?.counts).toEqual({ 'authorized.test': 2, 'other.test': 1 });
  });

  it('repeats only the selected current jobs, keeping historical and unstarted URLs out of the run', async () => {
    const data = state();
    const old = historicalJob('historic', 1, 'https://authorized.test/old-run');
    data.jobs = [old];
    const { controller, manager, assign, urls } = await setup(data);
    await assign(1, [FIRST, SECOND]);
    await assign(2, [OTHER]);
    await controller.command({ type: 'browser', id: 1, action: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual([FIRST, SECOND]);

    await vi.advanceTimersByTimeAsync(INTERVAL * 2);

    expect(urls()).toEqual([FIRST, SECOND, FIRST, SECOND, FIRST, SECOND]);
    expect(manager.runQa.mock.calls.every(([id]) => id === 1)).toBe(true);
    expect(controller.snapshot().jobs.filter((job) => job.id === old.id)).toEqual([old]);
    expect(controller.snapshot().jobs.find((job) => job.url === OTHER)?.status).toBe('pending');
  });

  it('replaces the selected browser’s recurring URLs without replacing another browser’s run', async () => {
    const { controller, manager, assign, urls } = await setup();
    await assign(1, [FIRST]);
    await assign(2, [OTHER]);
    await controller.command({ type: 'global', action: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    await assign(1, [SECOND]);
    await controller.command({ type: 'browser', id: 1, action: 'start' });
    await vi.advanceTimersByTimeAsync(0);

    const beforeRecurrence = manager.runQa.mock.calls.length;
    await vi.advanceTimersByTimeAsync(INTERVAL);

    expect(manager.runQa.mock.calls.slice(beforeRecurrence)).toEqual(
      expect.arrayContaining([
        [1, SECOND],
        [2, OTHER],
      ]),
    );
    expect(manager.runQa.mock.calls).toHaveLength(beforeRecurrence + 2);
    expect(urls().filter((url) => url === FIRST)).toHaveLength(1);
  });

  it.each(['during a run', 'between recurring runs'] as const)(
    'keeps newly assigned URLs pending when they were added %s without another Start',
    async (when) => {
      const { controller, manager, assign, urls } = await setup(state(1));
      const first = manager.hold(FIRST);
      await assign(1, [FIRST]);
      await controller.command({ type: 'global', action: 'start' });
      if (when === 'between recurring runs') {
        first.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }

      await assign(1, [SECOND]);
      first.resolve();
      await vi.advanceTimersByTimeAsync(INTERVAL * 2);

      expect(urls()).toEqual([FIRST, FIRST, FIRST]);
      expect(controller.snapshot().jobs.find((job) => job.url === SECOND)?.status).toBe('pending');
      await controller.command({ type: 'browser', id: 1, action: 'start' });
      await vi.advanceTimersByTimeAsync(0);
      expect(urls()).toEqual([FIRST, FIRST, FIRST, SECOND]);
    },
  );

  it('accepts newly reviewed jobs when Start is pressed again during an active one-time run', async () => {
    const data = state(1);
    data.settings.schedule.enabled = false;
    const { controller, manager, assign, urls } = await setup(data);
    const first = manager.hold(FIRST);
    await assign(1, [FIRST]);
    await controller.command({ type: 'global', action: 'start' });
    await assign(1, [SECOND]);

    await controller.command({ type: 'browser', id: 1, action: 'start' });
    first.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(urls()).toEqual([FIRST, SECOND]);
    expect(controller.snapshot().jobs.every((job) => job.status === 'completed')).toBe(true);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(urls()).toEqual([FIRST, SECOND]);
  });

  it.each(['during a run', 'after a run'] as const)(
    'clearing the queue %s disables recurrence and preserves completed history',
    async (when) => {
      const data = state(1);
      const old = historicalJob('historic', 1, 'https://authorized.test/old-run');
      data.jobs = [old];
      const { controller, manager, assign, urls } = await setup(data);
      const first = manager.hold(FIRST);
      await assign(1, [FIRST, SECOND]);
      await controller.command({ type: 'global', action: 'start' });
      if (when === 'after a run') {
        first.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await assign(1, ['https://authorized.test/unstarted']);
      }

      await controller.command({ type: 'clear-queue' });
      first.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const snapshot = controller.snapshot();
      expect(snapshot.jobs.some((job) => job.status === 'pending')).toBe(false);
      expect(snapshot.jobs.find((job) => job.id === old.id)).toEqual(old);
      expect(snapshot.jobs.find((job) => job.url === FIRST)?.status).toBe('completed');
      expect(snapshot.settings.schedule.enabled).toBe(false);
      expect(snapshot.scheduler).toEqual({ running: false, paused: false, nextRunAt: null });
      const completedUrls = urls();

      await vi.advanceTimersByTimeAsync(INTERVAL * 3);

      expect(urls()).toEqual(completedUrls);
    },
  );

  it('keeps emergency-stopped recurrence disabled after restart while preserving pending work for review', async () => {
    const data = state(1);
    data.settings.schedule.resumeAfterRestart = true;
    const original = await setup(data);
    await original.assign(1, [FIRST]);
    await original.controller.command({ type: 'global', action: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    await original.assign(1, [SECOND]);
    await original.controller.command({ type: 'global', action: 'stop' });
    await original.close();

    const restarted = await setup(original.saved());
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);

    expect(restarted.urls()).toEqual([]);
    expect(restarted.controller.snapshot().settings.schedule.enabled).toBe(false);
    expect(restarted.controller.snapshot().scheduler.running).toBe(false);
    expect(restarted.controller.snapshot().jobs.find((job) => job.url === FIRST)?.status).toBe('completed');
    expect(restarted.controller.snapshot().jobs.find((job) => job.url === SECOND)?.status).toBe('pending');
    await restarted.controller.command({ type: 'global', action: 'start' });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(restarted.urls()).toEqual([SECOND]);
  });

  it.each([
    { label: 'global Stop', command: { type: 'global', action: 'stop' } },
    { label: 'Clear pending', command: { type: 'clear-queue' } },
  ] satisfies Array<{ label: string; command: AppCommand }>)(
    'keeps recurrence off when $label arrives while an earlier settings Save awaits native cleanup',
    async ({ command }) => {
      const { controller, manager, assign, urls, saved } = await setup(state(1));
      await assign(1, [FIRST]);
      await controller.command({ type: 'global', action: 'start' });
      await vi.advanceTimersByTimeAsync(0);
      expect(urls()).toEqual([FIRST]);

      const next = controller.snapshot().settings;
      next.theme = 'light';
      next.dailyRequestLimit = 4321;
      next.schedule = { ...next.schedule, enabled: true, intervalMinutes: 3, startHour: 5, endHour: 21 };
      const cleanup = deferred();
      const stop = manager.stop.getMockImplementation()!;
      manager.stop.mockImplementationOnce(async (id) => {
        await cleanup.promise;
        await stop(id);
      });

      const saving = controller.command({ type: 'settings', settings: next });
      await controller.command(command);
      expect(controller.snapshot().settings.schedule.enabled).toBe(false);
      cleanup.resolve();
      await saving;

      expect(controller.snapshot().settings).toEqual({
        ...next,
        schedule: { ...next.schedule, enabled: false },
      });
      expect(controller.snapshot().scheduler).toEqual({ running: false, paused: false, nextRunAt: null });
      await vi.advanceTimersByTimeAsync(INTERVAL * 4);
      expect(urls()).toEqual([FIRST]);
      expect(saved().settings).toEqual(controller.snapshot().settings);
      expect(saved().scheduleTemplates).toEqual([]);
      expect(saved().nextRunAt).toBeNull();
    },
  );

  it('allows a new settings Save after Stop to deliberately enable recurrence again', async () => {
    const { controller } = await setup(state(1));
    await controller.command({ type: 'global', action: 'stop' });
    const next = controller.snapshot().settings;
    next.schedule = { ...next.schedule, enabled: true, intervalMinutes: 3 };

    await controller.command({ type: 'settings', settings: next });

    expect(controller.snapshot().settings.schedule).toEqual(next.schedule);
    expect(controller.snapshot().scheduler).toEqual({
      running: true,
      paused: false,
      nextRunAt: Date.now() + INTERVAL * 3,
    });
  });
});

describe('browser queue lifecycle', () => {
  it.each([
    { label: 'closing a browser', command: { type: 'browser', id: 2, action: 'close' } },
    { label: 'reducing the browser count', command: { type: 'create', count: 1 } },
    { label: 'stopping one browser', command: { type: 'browser', id: 2, action: 'stop' } },
  ] satisfies Array<{ label: string; command: AppCommand }>)(
    '$label cancels its unfinished queue and prevents recurrence, including after reopening',
    async ({ command }) => {
      const { controller, manager, assign, urls } = await setup();
      manager.hold(FIRST);
      await assign(1, [OTHER]);
      await assign(2, [FIRST, SECOND]);
      await controller.command({ type: 'global', action: 'start' });
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.snapshot().jobs.find((job) => job.url === SECOND)?.status).toBe('pending');

      await controller.command(command);
      await vi.advanceTimersByTimeAsync(0);

      const cancelled = controller.snapshot().jobs.filter((job) => job.browserId === 2);
      expect(cancelled).toHaveLength(2);
      expect(cancelled.every((job) => job.status === 'cancelled')).toBe(true);
      expect(cancelled.every((job) => job.finishedAt && job.error)).toBe(true);
      await vi.advanceTimersByTimeAsync(INTERVAL);
      await controller.command({ type: 'create', count: 2 });
      await vi.advanceTimersByTimeAsync(INTERVAL);

      expect(urls().filter((url) => url === FIRST)).toHaveLength(1);
      expect(urls()).not.toContain(SECOND);
      expect(urls().filter((url) => url === OTHER)).toHaveLength(3);
      expect(controller.snapshot().jobs.some((job) => job.browserId === 2 && job.status === 'pending')).toBe(
        false,
      );
    },
  );

  it.each(['global', 'browser'] as const)(
    '%s pause keeps the next job pending even if the current job finishes during the pause',
    async (scope) => {
      const { controller, manager, assign, urls } = await setup(state(1));
      const first = manager.hold(FIRST);
      const unstarted = 'https://authorized.test/assigned-while-paused';
      await assign(1, [FIRST, SECOND]);
      await controller.command({ type: 'global', action: 'start' });
      await controller.command(
        scope === 'global'
          ? { type: 'global', action: 'pause' }
          : { type: 'browser', id: 1, action: 'pause' },
      );
      await assign(1, [unstarted]);
      // Completion can already be in flight when Pause reaches the native browser.
      first.resolve();
      await vi.advanceTimersByTimeAsync(INTERVAL * 3);

      expect(urls()).toEqual([FIRST]);
      expect(controller.snapshot().jobs.find((job) => job.url === SECOND)?.status).toBe('pending');
      if (scope === 'global') expect(controller.snapshot().scheduler.paused).toBe(true);
      await controller.command(
        scope === 'global'
          ? { type: 'global', action: 'resume' }
          : { type: 'browser', id: 1, action: 'resume' },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(urls()).toEqual([FIRST, SECOND]);
      expect(controller.snapshot().jobs.find((job) => job.url === SECOND)?.status).toBe('completed');
      expect(controller.snapshot().jobs.find((job) => job.url === unstarted)?.status).toBe('pending');
      await vi.advanceTimersByTimeAsync(INTERVAL);
      expect(urls()).toEqual([FIRST, SECOND, FIRST, SECOND]);
      expect(controller.snapshot().jobs.find((job) => job.url === unstarted)?.status).toBe('pending');
    },
  );
});

describe('failed jobs and restricted hosts', () => {
  it('uses the actual restricted host after a redirect or external QA stage', async () => {
    const { controller, manager, assign, urls } = await setup(state(3));
    const blockedPending = 'https://other.test/pending';
    await assign(2, [OTHER]);
    await controller.command({ type: 'browser', id: 2, action: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    await assign(2, [blockedPending]);
    await assign(3, [SECOND]);
    await controller.command({ type: 'browser', id: 3, action: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    manager.failures.set(
      FIRST,
      new SiteRestrictionError('HTTP 403: testing requires manual review', 'https://other.test/restricted'),
    );
    await assign(1, [FIRST]);
    await controller.command({ type: 'browser', id: 1, action: 'start' });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(controller.snapshot().jobs.find((job) => job.url === blockedPending)?.status).toBe('cancelled');
    expect(urls().filter((url) => url === OTHER)).toHaveLength(1);
    expect(urls().filter((url) => url === FIRST)).toHaveLength(1);
    expect(urls().filter((url) => url === SECOND)).toHaveLength(3);
  });

  it('stops another active browser already on the restricted host', async () => {
    const { controller, manager, assign } = await setup();
    manager.hold(OTHER);
    await assign(2, [OTHER]);
    await controller.command({ type: 'browser', id: 2, action: 'start' });
    manager.failures.set(
      FIRST,
      new SiteRestrictionError('Challenge detected; manual review required', OTHER),
    );
    await assign(1, [FIRST]);
    await controller.command({ type: 'browser', id: 1, action: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.stop).toHaveBeenCalledWith(2);
    expect(controller.snapshot().jobs.find((job) => job.url === OTHER)?.status).toBe('cancelled');
  });

  it.each([
    'HTTP 401: testing paused; proxy rotation will not bypass this response',
    'HTTP 403: testing paused; proxy rotation will not bypass this response',
    'HTTP 429: testing paused; proxy rotation will not bypass this response',
    'Challenge detected; manual review required',
    'Rate limit reached',
    'Daily navigation limit reached',
  ])('stops pending and recurring work for the affected host after %s', async (message) => {
    const { controller, manager, assign, urls } = await setup(state(3));
    const previouslyCompleted = 'https://authorized.test/previously-completed';
    const otherProfilePending = 'https://authorized.test/other-profile-pending';
    await assign(3, [previouslyCompleted]);
    await controller.command({ type: 'browser', id: 3, action: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    await assign(1, [FIRST, SECOND]);
    await assign(3, [otherProfilePending]);
    await assign(2, [OTHER]);
    await controller.command({ type: 'browser', id: 2, action: 'start' });
    await vi.advanceTimersByTimeAsync(0);
    manager.failures.set(FIRST, new Error(message));

    await controller.command({ type: 'browser', id: 1, action: 'start' });
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = controller.snapshot();
    expect(snapshot.jobs.find((job) => job.url === FIRST)).toMatchObject({
      status: 'failed',
      error: message,
    });
    for (const url of [SECOND, otherProfilePending])
      expect(snapshot.jobs.find((job) => job.url === url)).toMatchObject({
        status: 'cancelled',
        error: expect.stringMatching(/review|restrict/i),
      });
    expect(snapshot.jobs.find((job) => job.url === previouslyCompleted)?.status).toBe('completed');

    await vi.advanceTimersByTimeAsync(INTERVAL * 2);

    expect(urls().filter((url) => new URL(url).hostname === 'authorized.test')).toEqual([
      previouslyCompleted,
      FIRST,
    ]);
    expect(urls().filter((url) => url === OTHER)).toHaveLength(3);
  });

  it('does not retry an ordinary failed job on a later schedule while another profile can continue', async () => {
    const { controller, manager, assign, urls } = await setup();
    await assign(1, [FIRST]);
    await assign(2, [SECOND]);
    manager.failures.set(FIRST, new Error('Page changed during scroll inspection'));
    await controller.command({ type: 'global', action: 'start' });
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);

    expect(urls().filter((url) => url === FIRST)).toHaveLength(1);
    expect(urls().filter((url) => url === SECOND)).toHaveLength(3);
    expect(controller.snapshot().jobs.find((job) => job.url === FIRST)?.status).toBe('failed');
  });
});
