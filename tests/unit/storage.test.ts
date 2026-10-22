import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityLog, initialData, LocalStore, redactMessage } from '../../src/main/storage';
import { DEFAULT_SETTINGS, DEVICES } from '../../src/shared/defaults';
import type { TestJob } from '../../src/shared/types';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'unicorn-storage-test-'));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const job = (id: string, status: TestJob['status']): TestJob => ({
  id,
  status,
  browserId: 1,
  url: 'https://example.com/',
  createdAt: Date.now(),
});

describe('persistent state writer and recovery', () => {
  it('loads independent defaults into a new directory', async () => {
    const store = new LocalStore(directory);
    const first = await store.load();
    expect(first).toEqual(initialData());
    first.settings.timings.landingWaitMs = 1;
    expect(DEFAULT_SETTINGS.timings.landingWaitMs).toBe(20000);
  });

  it('migrates rc.1 validation options without losing profiles, advanced settings, queues or counters', async () => {
    const state = initialData();
    state.settings = {
      ...state.settings,
      browserCount: 3,
      authorizedDomains: ['example.com'],
      stagingConfirmed: true,
      dailyNavigationLimit: 456,
      dailyRequestLimit: 45678,
      excludedLinkPatterns: ['*/logout*'],
      retryLimit: 4,
      proxyRefreshMinutes: 17,
      allowLocalhost: true,
      theme: 'light',
      closeToTray: true,
      minimizeToTray: true,
      startAtLogin: true,
      resourceLimitMb: 16384,
      logRetentionDays: 31,
      timings: { ...state.settings.timings, landingScrollMs: 1234, navigationTimeoutMs: 21000 },
      schedule: { enabled: true, intervalMinutes: 17, startHour: 22, endHour: 6, resumeAfterRestart: true },
    };
    state.profiles[2] = {
      device: {
        ...DEVICES.desktop,
        preset: 'custom',
        width: 1365,
        height: 1024,
        scaleFactor: 1.25,
        touch: true,
      },
      history: [{ url: 'https://example.com/retained?query=1', title: 'Retained page', at: 1234 }],
    };
    state.jobs = [job('reviewed', 'pending'), { ...job('completed', 'completed'), finishedAt: Date.now() }];
    state.scheduleTemplates = [{ browserId: 2, url: 'https://example.com/recurring' }];
    state.budget = { day: '2026-10-22', counts: { 'example.com': 7 } };
    state.requestBudget = { day: '2026-10-22', counts: { 'example.com': 79 } };
    state.totals = { completed: 12, failed: 2, navigations: 30, jsErrors: 1, networkErrors: 4 };
    state.nextRunAt = Date.now() + 60000;
    const legacy = { ...state, settings: { ...state.settings, proxyTimeoutMs: 45000, uniqueExitIps: false } };
    await writeFile(join(directory, 'state.json'), JSON.stringify(legacy));
    await mkdir(join(directory, 'Partitions', 'browser-02'), { recursive: true });
    await writeFile(join(directory, 'Partitions', 'browser-02', 'marker'), 'existing Chromium data');

    const store = new LocalStore(directory);
    const restored = await store.load();
    expect(restored).toEqual(state);
    expect(restored.settings).not.toHaveProperty('proxyTimeoutMs');
    expect(restored.settings).not.toHaveProperty('uniqueExitIps');
    expect((await readdir(directory)).filter((name) => name.startsWith('state.corrupt-'))).toEqual([]);
    expect(await readFile(join(directory, 'Partitions', 'browser-02', 'marker'), 'utf8')).toBe(
      'existing Chromium data',
    );
    await store.save(restored);
    expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'))).toEqual(state);
    expect(await store.load()).toEqual(state);
  });

  it('does not make unknown stored settings permissive while migrating retired validation fields', async () => {
    const state = initialData();
    const content = JSON.stringify({
      ...state,
      settings: { ...state.settings, proxyTimeoutMs: 12000, uniqueExitIps: true, unknownPrivilege: true },
    });
    await writeFile(join(directory, 'state.json'), content);
    expect((await new LocalStore(directory).load()).settings).toEqual(DEFAULT_SETTINGS);
    const archived = (await readdir(directory)).find((name) => name.startsWith('state.corrupt-'))!;
    expect(await readFile(join(directory, archived), 'utf8')).toBe(content);
  });

  it('serializes concurrent saves and captures data when save is requested', async () => {
    const store = new LocalStore(directory);
    const data = await store.load();
    const operations: Promise<void>[] = [];
    for (let completed = 1; completed <= 40; completed++) {
      data.totals.completed = completed;
      operations.push(store.save(data));
    }
    data.totals.completed = 999;
    await Promise.all(operations);
    await store.flush();
    expect(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).totals.completed).toBe(40);
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await store.load()).totals.completed).toBe(40);
  });

  it('keeps the last committed state on write failure and permits a later successful save', async () => {
    const store = new LocalStore(directory);
    const data = await store.load();
    data.totals.completed = 1;
    await store.save(data);
    const before = await readFile(join(directory, 'state.json'), 'utf8');
    await mkdir(join(directory, 'state.json.tmp'));
    data.totals.completed = 2;
    await expect(store.save(data)).rejects.toThrow();
    await expect(store.flush()).rejects.toThrow();
    expect(await readFile(join(directory, 'state.json'), 'utf8')).toBe(before);
    await rm(join(directory, 'state.json.tmp'), { recursive: true });
    data.totals.completed = 3;
    await store.save(data);
    expect((await store.load()).totals.completed).toBe(3);
  });

  it('recovers interrupted running jobs as pending without enabling automatic restart', async () => {
    const state = initialData();
    state.jobs = [job('pending', 'pending'), job('interrupted', 'running'), job('done', 'completed')];
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    const restored = await new LocalStore(directory).load();
    expect(restored.jobs.map((item) => item.status)).toEqual(['pending', 'pending', 'completed']);
    expect(restored.jobs[1]?.error).toContain('Interrupted');
    expect(restored.settings.schedule.resumeAfterRestart).toBe(false);
    expect(restored.jobs[0]?.id).toBe('pending');
    expect(restored.jobs[2]?.id).toBe('done');
  });

  it('preserves a corrupt settings file and leaves profile directories intact', async () => {
    const state = initialData();
    state.settings.browserCount = 21;
    const content = JSON.stringify(state);
    await writeFile(join(directory, 'state.json'), content);
    await mkdir(join(directory, 'Partitions', 'browser-01'), { recursive: true });
    await writeFile(join(directory, 'Partitions', 'browser-01', 'marker'), 'profile must survive');
    const restored = await new LocalStore(directory).load();
    expect(restored.settings).toEqual(DEFAULT_SETTINGS);
    const archived = (await readdir(directory)).filter((name) => name.startsWith('state.corrupt-'));
    expect(archived).toHaveLength(1);
    expect(await readFile(join(directory, archived[0]!), 'utf8')).toBe(content);
    expect(await readFile(join(directory, 'Partitions', 'browser-01', 'marker'), 'utf8')).toBe(
      'profile must survive',
    );
  });

  it('preserves malformed JSON as evidence instead of deleting it', async () => {
    await writeFile(join(directory, 'state.json'), '{partially written');
    await new LocalStore(directory).load();
    const archived = (await readdir(directory)).find((name) => name.startsWith('state.corrupt-'))!;
    expect(await readFile(join(directory, archived), 'utf8')).toBe('{partially written');
  });

  it('ignores malformed queue records without discarding valid settings and jobs', async () => {
    const state = {
      ...initialData(),
      settings: { ...DEFAULT_SETTINGS, browserCount: 2 },
      jobs: [
        null,
        42,
        {},
        job('valid', 'pending'),
        { ...job('bad-id', 'pending'), browserId: 99 },
        { ...job('bad-status', 'pending'), status: { toString: null } },
      ],
    };
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    const restored = await new LocalStore(directory).load();
    expect(restored.settings.browserCount).toBe(2);
    expect(restored.jobs.map((item) => item.id)).toEqual(['valid']);
  });

  it('bounds restored queues and never restores a running state directly', async () => {
    const state = initialData();
    state.jobs = Array.from({ length: 1500 }, (_, index) => job(`job-${index}`, 'running'));
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    const restored = await new LocalStore(directory).load();
    expect(restored.jobs.length).toBeLessThanOrEqual(1000);
    expect(restored.jobs.every((item) => item.status === 'pending')).toBe(true);
  });

  it('rejects corrupt device and history fields while preserving other valid profiles', async () => {
    const state = {
      ...initialData(),
      profiles: {
        1: {
          device: { ...DEVICES.mobile, width: 0 },
          history: [
            null,
            { url: 'javascript:alert(1)', title: 'unsafe', at: 1 },
            { url: 'https://example.com/', title: 'valid', at: 1000 },
          ],
        },
        2: { device: DEVICES.tablet, history: [] },
        99: { device: DEVICES.desktop },
      },
    };
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    const restored = await new LocalStore(directory).load();
    expect(restored.profiles[1]?.device).toBeUndefined();
    expect(
      restored.profiles[1]?.history?.every((item) => item && item.url.startsWith('https://')) ?? true,
    ).toBe(true);
    expect(restored.profiles[2]?.device).toEqual(DEVICES.tablet);
    expect(restored.profiles[99]).toBeUndefined();
  });

  it('does not accept empty totals as valid counters', async () => {
    await writeFile(join(directory, 'state.json'), JSON.stringify({ ...initialData(), totals: {} }));
    expect((await new LocalStore(directory).load()).totals).toEqual(initialData().totals);
  });

  it('restores only complete safe counters and rejects unusable schedule timestamps', async () => {
    const state = {
      ...initialData(),
      nextRunAt: -1,
      totals: { ...initialData().totals, completed: 5, failed: '6' },
    };
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    const restored = await new LocalStore(directory).load();
    expect(restored.totals).toEqual(initialData().totals);
    expect(restored.nextRunAt).toBeNull();
    const nextRunAt = Date.now() + 60000;
    await writeFile(
      join(directory, 'state.json'),
      JSON.stringify({ ...state, nextRunAt, totals: { ...initialData().totals, completed: 7, failed: 2 } }),
    );
    const valid = await new LocalStore(directory).load();
    expect(valid.totals.completed).toBe(7);
    expect(valid.nextRunAt).toBe(nextRunAt);
  });

  it('restores explicit recurring intent within current scope and excludes closed browsers', async () => {
    const state = {
      ...initialData(),
      settings: { ...DEFAULT_SETTINGS, browserCount: 2, authorizedDomains: ['example.com'] },
      scheduleTemplates: [
        null,
        {},
        { browserId: 1, url: 'https://EXAMPLE.com:443/path' },
        { browserId: 1, url: 'https://example.com/path' },
        { browserId: 3, url: 'https://example.com/closed' },
        { browserId: 2, url: 'https://elsewhere.example/unauthorized' },
        { browserId: 2, url: 'https://secret@example.com/' },
        { browserId: 2, url: 'file:///private' },
      ],
    };
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    expect((await new LocalStore(directory).load()).scheduleTemplates).toEqual([
      { browserId: 1, url: 'https://example.com/path' },
      { browserId: 1, url: 'https://example.com/path' },
    ]);
  });

  it('does not turn historical jobs into recurrence when upgrading an older state file', async () => {
    const state = { ...initialData(), jobs: [job('historical', 'completed')], scheduleTemplates: undefined };
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    const restored = await new LocalStore(directory).load();
    expect(restored.jobs).toHaveLength(1);
    expect(restored.scheduleTemplates).toEqual([]);
  });

  it('bounds restored recurring templates to the queue limit', async () => {
    const state = initialData();
    state.settings.authorizedDomains = ['example.com'];
    state.scheduleTemplates = Array.from({ length: 1500 }, (_, index) => ({
      browserId: 1,
      url: `https://example.com/${index}`,
    }));
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    expect((await new LocalStore(directory).load()).scheduleTemplates).toHaveLength(1000);
  });

  it('preserves safe daily counters and keeps the higher count for normalized duplicate hosts', async () => {
    const state = {
      ...initialData(),
      budget: {
        day: '2026-10-22',
        counts: {
          'EXAMPLE.com': 8,
          'example.com': 2,
          'valid.test': 5,
          'bad.test': -1,
          '*.example.com': 10,
          'bad/host': 7,
        },
      },
    };
    await writeFile(join(directory, 'state.json'), JSON.stringify(state));
    expect((await new LocalStore(directory).load()).budget).toEqual({
      day: '2026-10-22',
      counts: { 'example.com': 8, 'valid.test': 5 },
    });
  });
});

describe('bounded diagnostic logs', () => {
  it('redacts URL credentials, queries, and fragments before storage', async () => {
    const log = new ActivityLog(directory);
    await log.initialize(7);
    log.add('warn', 'network', 'Failed https://username:p%40ss@example.com/path?token=secret#private');
    await log.flush();
    const text = await readFile(join(directory, 'activity.jsonl'), 'utf8');
    expect(text).toContain('https://example.com/path');
    for (const sensitive of ['username', 'p%40ss', 'token', 'secret', 'private'])
      expect(text).not.toContain(sensitive);
    expect(redactMessage('x'.repeat(10000))).toHaveLength(2000);
  });

  it('bounds in-memory history and returns copies with valid limit semantics', async () => {
    const log = new ActivityLog(directory);
    await log.initialize(7);
    for (let index = 0; index < 2100; index++) log.add('info', 'test', `Event ${index}`);
    await log.flush();
    expect(log.list(3000)).toHaveLength(2000);
    expect(log.list(0).length).toBe(0);
    expect(log.list(-1).length).toBe(0);
    expect(log.list(Number.NaN).length).toBe(0);
    const newest = log.list(1);
    expect(newest[0]?.message).toBe('Event 2099');
    newest[0]!.message = 'mutated';
    expect(log.list(1)[0]?.message).toBe('Event 2099');
  });

  it('rotates to exactly two previous files at the size boundary', async () => {
    await writeFile(join(directory, 'activity.jsonl'), Buffer.alloc(5 * 1024 * 1024 + 1, 'x'));
    await writeFile(join(directory, 'activity.1.jsonl'), 'previous-one\n');
    await writeFile(join(directory, 'activity.2.jsonl'), 'previous-two\n');
    const log = new ActivityLog(directory);
    await log.initialize(7);
    log.add('info', 'test', 'Rotation trigger');
    await log.flush();
    expect((await stat(join(directory, 'activity.1.jsonl'))).size).toBe(5 * 1024 * 1024 + 1);
    expect(await readFile(join(directory, 'activity.2.jsonl'), 'utf8')).toBe('previous-one\n');
    expect(JSON.parse(await readFile(join(directory, 'activity.jsonl'), 'utf8')).message).toBe(
      'Rotation trigger',
    );
    expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(3);
  });

  it('removes expired log generations without touching other files', async () => {
    await writeFile(join(directory, 'activity.1.jsonl'), 'expired');
    await writeFile(join(directory, 'keep.txt'), 'keep');
    const expired = new Date(Date.now() - 8 * 86400000);
    await utimes(join(directory, 'activity.1.jsonl'), expired, expired);
    const log = new ActivityLog(directory);
    await log.initialize(7);
    await log.flush();
    expect(await readdir(directory)).not.toContain('activity.1.jsonl');
    expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('keep');
  });

  it('stops queued disk writes after failure and emits one bounded diagnostic', async () => {
    await mkdir(join(directory, 'activity.jsonl'));
    const log = new ActivityLog(directory);
    await log.initialize(7);
    for (let index = 0; index < 100; index++) log.add('info', 'test', `Before failure ${index}`);
    await log.flush();
    const failures = log.list(2000).filter((record) => record.category === 'storage');
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain('Disk logging stopped');
    log.add('info', 'test', 'After failure remains visible in memory');
    await log.flush();
    expect(log.list(2000).filter((record) => record.category === 'storage')).toHaveLength(1);
    expect(log.list(1)[0]?.message).toBe('After failure remains visible in memory');
  });

  it('bounds pending disk writes during a synchronous event flood and resumes after draining', async () => {
    const log = new ActivityLog(directory);
    await log.initialize(7);
    for (let index = 0; index < 4500; index++) log.add('info', 'test', `Flood ${index}`);
    await log.flush();
    expect(log.list(2000)).toHaveLength(2000);
    expect(log.list(2000).filter((record) => record.category === 'storage')).toHaveLength(1);
    const lines = (await readFile(join(directory, 'activity.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(4096);
    log.add('info', 'test', 'Disk recovered after backlog drained');
    await log.flush();
    expect(await readFile(join(directory, 'activity.jsonl'), 'utf8')).toContain(
      'Disk recovered after backlog drained',
    );
  });

  it('keeps logging in memory when the log directory cannot initialize', async () => {
    const blocked = join(directory, 'not-a-directory');
    await writeFile(blocked, 'file');
    const log = new ActivityLog(blocked);
    await log.initialize(7);
    log.add('info', 'test', 'Visible without a writable directory');
    await log.flush();
    expect(log.list(1)[0]?.message).toBe('Visible without a writable directory');
    expect(log.list(2000).filter((record) => record.category === 'storage')).toHaveLength(1);
  });
});
