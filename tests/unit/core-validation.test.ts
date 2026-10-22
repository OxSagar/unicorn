import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, DEVICES } from '../../src/shared/defaults';
import {
  validateBounds,
  validateCommand,
  validateDevice,
  validateSettings,
} from '../../src/main/core/validation';
import { inOperatingWindow, PauseController, retryDelay } from '../../src/main/core/timing';
import { normalizeUrl } from '../../src/main/core/scope';

describe('privileged IPC input validation', () => {
  it('accepts valid default settings and returns an independent object', () => {
    const settings = validateSettings(DEFAULT_SETTINGS);
    expect(settings).toEqual(DEFAULT_SETTINGS);
    settings.timings.landingWaitMs = 4;
    expect(DEFAULT_SETTINGS.timings.landingWaitMs).toBe(20000);
  });
  it.each([
    { browserCount: 21 },
    { browserCount: 0 },
    { browserCount: 1.5 },
    { dailyNavigationLimit: Infinity },
    { dailyRequestLimit: 0 },
    { dailyRequestLimit: 1000001 },
    { excludedLinkPatterns: [''] },
    { excludedLinkPatterns: ['x'.repeat(513)] },
    { excludedLinkPatterns: Array.from({ length: 51 }, () => '*logout*') },
    { minimizeToTray: 'true' },
    { retryLimit: 6 },
    { proxyTimeoutMs: 1 },
    { proxyRefreshMinutes: 0 },
    { resourceLimitMb: 0 },
    { logRetentionDays: -1 },
    { authorizedDomains: ['*'] },
    { theme: 'system' },
    { startAtLogin: 'true' },
    { surprise: true },
  ])('rejects settings outside the validated boundary', (override) =>
    expect(() => validateSettings({ ...DEFAULT_SETTINGS, ...override })).toThrow(),
  );
  it('requires explicit test scope and test-environment confirmation for a schedule', () => {
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, schedule: { ...DEFAULT_SETTINGS.schedule, enabled: true } }),
    ).toThrow(/requires/);
    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        stagingConfirmed: true,
        authorizedDomains: ['example.com'],
        schedule: { ...DEFAULT_SETTINGS.schedule, enabled: true },
      }).schedule.enabled,
    ).toBe(true);
  });
  it.each([
    'snapshot',
    'clear-queue',
    'refresh-proxies',
    'validate-proxies',
    'export-logs',
    'export-results',
    'import-urls',
    'open-release-page',
  ])('validates argument-free command %s', (type) => {
    expect(validateCommand({ type })).toEqual({ type });
    expect(() => validateCommand({ type, path: '/etc/passwd' })).toThrow();
  });
  it.each([
    'back',
    'forward',
    'reload',
    'stop-loading',
    'close',
    'start',
    'pause',
    'resume',
    'stop',
    'devtools',
  ])('validates browser action %s', (action) =>
    expect(validateCommand({ type: 'browser', id: 1, action })).toEqual({ type: 'browser', id: 1, action }),
  );
  it.each(['start', 'pause', 'resume', 'stop'])('validates global action %s', (action) =>
    expect(validateCommand({ type: 'global', action })).toEqual({ type: 'global', action }),
  );
  it.each(['cache', 'cookies', 'permissions', 'history', 'reset', 'storage'])(
    'validates profile action %s',
    (action) =>
      expect(validateCommand({ type: 'profile', id: 2, action })).toEqual({ type: 'profile', id: 2, action }),
  );
  it.each(['inspect', 'close'])('validates popup action %s', (action) =>
    expect(validateCommand({ type: 'popup', browserId: 1, popupId: 23, action })).toEqual({
      type: 'popup',
      browserId: 1,
      popupId: 23,
      action,
    }),
  );
  it('validates create, navigate, device, settings, queue, and diagnostic branches', () => {
    expect(validateCommand({ type: 'create', count: 20 })).toEqual({ type: 'create', count: 20 });
    expect(validateCommand({ type: 'navigate', id: 1, url: 'https://example.com' })).toHaveProperty(
      'url',
      'https://example.com',
    );
    expect(validateCommand({ type: 'device', ids: [1, 1, 2], device: DEVICES.mobile })).toHaveProperty(
      'ids',
      [1, 2],
    );
    expect(validateCommand({ type: 'settings', settings: DEFAULT_SETTINGS })).toHaveProperty(
      'settings.browserCount',
      4,
    );
    expect(validateCommand({ type: 'job', id: 'test-job', action: 'remove' })).toHaveProperty(
      'id',
      'test-job',
    );
    expect(validateCommand({ type: 'diagnostic', id: 2 })).toEqual({ type: 'diagnostic', id: 2 });
    expect(
      validateCommand({ type: 'edit-job', id: 'pending', url: 'https://example.com/a', browserId: 2 }),
    ).toEqual({ type: 'edit-job', id: 'pending', url: 'https://example.com/a', browserId: 2 });
    expect(() =>
      validateCommand({ type: 'edit-job', id: 'pending', url: 'https://example.com/a', browserId: 21 }),
    ).toThrow();
    expect(() =>
      validateCommand({
        type: 'edit-job',
        id: 'pending',
        url: 'https://example.com/a',
        browserId: 2,
        path: '/etc/passwd',
      }),
    ).toThrow();
  });
  it.each(['same', 'round-robin', 'balanced', 'manual'])('validates distribution %s', (mode) => {
    expect(
      validateCommand({
        type: 'distribute',
        urls: ['https://example.com'],
        ids: [1],
        mode,
        manual: { '0': 1 },
      }),
    ).toHaveProperty('mode', mode);
  });
  it.each([
    null,
    [],
    'snapshot',
    {},
    { type: 'shell', command: 'start cmd.exe' },
    { type: 'navigate', id: 0, url: 'https://example.com' },
    { type: 'global', action: 'execute' },
    { type: 'device', ids: [], device: DEVICES.desktop },
    { type: 'distribute', ids: [1], urls: [], mode: 'same' },
  ])('rejects malformed or unknown commands', (command) => expect(() => validateCommand(command)).toThrow());
  it('rejects unbounded viewport size and NaN', () => {
    expect(() => validateDevice({ ...DEVICES.desktop, width: Infinity })).toThrow();
    expect(() => validateDevice({ ...DEVICES.desktop, scaleFactor: NaN })).toThrow();
    expect(() => validateDevice({ ...DEVICES.desktop, nodeIntegration: true })).toThrow();
  });
  it('validates native layout integers, duplicates, and extra fields', () => {
    const bounds = { id: 1, x: 0, y: 100, width: 400, height: 300, visible: true };
    expect(validateBounds([bounds])).toEqual([bounds]);
    expect(() => validateBounds([bounds, bounds])).toThrow();
    expect(() => validateBounds([{ ...bounds, width: 1e12 }])).toThrow();
    expect(() => validateBounds([{ ...bounds, x: 0.5 }])).toThrow();
  });
  it.each([
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0177.0.0.1/',
    'https://[::ffff:127.0.0.1]/',
    'https://[0:0:0:0:0:ffff:7f00:1]/',
    'https://0xa000001/',
    'https://2852039166/',
  ])('rejects alternative encodings of private IP %s', (url) => expect(() => normalizeUrl(url)).toThrow());
});

describe('asynchronous timing and scheduling', () => {
  afterEach(() => vi.useRealTimers());
  it('does not consume dwell time while paused', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const timer = new PauseController();
    let finished = false;
    const task = timer.wait(1000).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(300);
    timer.pause();
    await vi.advanceTimersByTimeAsync(5000);
    expect(finished).toBe(false);
    timer.resume();
    await vi.advanceTimersByTimeAsync(699);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await task;
    expect(finished).toBe(true);
  });
  it('cancels all waits and aborts attached operations', async () => {
    vi.useFakeTimers();
    const timer = new PauseController();
    const pending = timer.wait(10000);
    const rejected = expect(pending).rejects.toThrow('Emergency stop');
    timer.cancel('Emergency stop');
    await rejected;
    expect(timer.signal.aborted).toBe(true);
    await expect(timer.wait(10)).rejects.toThrow('Emergency stop');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('starts paused wait durations only after resume', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const timer = new PauseController();
    timer.pause();
    let done = false;
    const task = timer.wait(100).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(false);
    timer.resume();
    await vi.advanceTimersByTimeAsync(100);
    await task;
    expect(done).toBe(true);
  });
  it('caps retry delays', () =>
    expect([0, 1, 2, 10, 100].map((attempt) => retryDelay(attempt))).toEqual([
      1000, 2000, 4000, 30000, 30000,
    ]));
  it('supports overnight operating windows and all-day configuration', () => {
    expect(inOperatingWindow(new Date(2026, 9, 22, 23), 22, 6)).toBe(true);
    expect(inOperatingWindow(new Date(2026, 9, 22, 5), 22, 6)).toBe(true);
    expect(inOperatingWindow(new Date(2026, 9, 22, 12), 22, 6)).toBe(false);
    expect(inOperatingWindow(new Date(2026, 9, 22, 23, 59), 0, 24)).toBe(true);
  });
});
