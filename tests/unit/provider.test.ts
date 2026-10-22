import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UnicornController } from '../../src/main/controller';
import { BrowserManager } from '../../src/main/browser/manager';
import { ActivityLog, initialData, LocalStore } from '../../src/main/storage';
import type { ProxyRecord } from '../../src/shared/types';

vi.mock('electron', () => ({
  app: { getVersion: () => 'provider-test', getAppMetrics: () => [] },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('../../src/main/browser/manager', () => ({ BrowserManager: vi.fn() }));

const MINUTE = 60_000;
const BODY_LIMIT = 4 * 1024 * 1024;
const initialTime = new Date('2026-10-22T12:00:00.000Z');
const directories = new Set<string>();
const controllers = new Set<UnicornController>();
let network: ReturnType<typeof vi.fn<typeof fetch>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const record = (ip = '8.8.8.8') => ({
  ip,
  port: 8080,
  protocol: 'http',
  alive: true,
  ip_data: { countryCode: 'US' },
});
const envelope = (ip = '8.8.8.8') => ({ proxies: [record(ip)], nextpage: false });
const jsonResponse = (data: unknown = envelope()) =>
  new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

function reserveRecords(statuses: ProxyRecord['status'][]): ProxyRecord[] {
  return statuses.map((status, index) => ({
    id: `http://8.8.4.${index + 1}:8080`,
    ip: `8.8.4.${index + 1}`,
    port: 8080,
    protocol: 'http',
    country: 'US',
    countryName: 'United States',
    status,
    lastChecked: status === 'available' ? Date.now() : null,
    latencyMs: status === 'available' ? 10 : null,
    failures: status === 'failed' ? 1 : 0,
    source: 'proxyscrape',
    ...(status === 'assigned' ? { assignedTo: index + 1 } : {}),
  }));
}

/** Mock only native views and network transport; the controller, parser, pool, cache, and log are real. */
async function setup(options: { browserCount?: number; testMode?: boolean } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'unicorn-provider-'));
  directories.add(directory);
  const manager = {
    checkHealth: vi.fn(),
    create: vi.fn(async (_count: number) => undefined),
    snapshots: vi.fn(() => []),
    shutdown: vi.fn(async () => undefined),
  };
  vi.mocked(BrowserManager).mockImplementation(function () {
    return manager as unknown as BrowserManager;
  });
  const window = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
  const store = new LocalStore(directory);
  const logs = new ActivityLog(directory);
  await logs.initialize(7);
  const data = initialData();
  if (options.browserCount !== undefined) data.settings.browserCount = options.browserCount;
  // The default exercises the production provider path without changing its URL.
  const controller = new UnicornController(
    window,
    data,
    store,
    logs,
    options.testMode
      ? { userData: directory, proxies: [], diagnosticUrl: 'https://fixture.invalid/diagnostic' }
      : undefined,
  );
  controllers.add(controller);
  const cachePath = path.join(directory, 'proxy-cache.json');
  return {
    controller,
    logs,
    cachePath,
    cache: () => readFile(cachePath, 'utf8'),
    proxyCallbacks: vi.mocked(BrowserManager).mock.calls.at(-1)![0].proxies,
  };
}

async function seeded() {
  const fixture = await setup();
  network.mockResolvedValueOnce(jsonResponse());
  await fixture.controller.refreshProxies();
  const before = fixture.controller.snapshot();
  const cacheBefore = await fixture.cache();
  await vi.advanceTimersByTimeAsync(MINUTE);
  return { ...fixture, before, cacheBefore };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(initialTime);
  network = vi.fn<typeof fetch>().mockRejectedValue(new Error('Unexpected provider request'));
  vi.stubGlobal('fetch', network);
});

afterEach(async () => {
  for (const controller of controllers) await controller.shutdown();
  controllers.clear();
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ProxyScrape control-plane refresh', () => {
  it('uses the fixed HTTPS provider, rejects redirects, filters records, and persists the successful response', async () => {
    const { controller, cache } = await setup();
    const raw = {
      proxies: [
        record(),
        { ...record('1.1.1.1'), ip_data: { countryCode: 'AU' } },
        { ...record('9.9.9.9'), alive: false },
        { ...record('127.0.0.1'), ip_data: { countryCode: 'US' } },
        { ...record('8.8.4.4'), protocol: 'socks5', ip_data: { countryCode: 'JP' } },
      ],
      nextpage: false,
    };
    network.mockResolvedValueOnce(jsonResponse(raw));
    await controller.refreshProxies();

    expect(network).toHaveBeenCalledTimes(1);
    const [input, options] = network.mock.calls[0];
    const requested = new URL(String(input));
    expect(requested.origin).toBe('https://api.proxyscrape.com');
    expect(requested.pathname).toBe('/v4/free-proxy-list/get');
    expect(requested.searchParams.get('format')).toBe('json');
    expect(requested.searchParams.get('protocol')).toBe('http,socks5');
    expect(requested.searchParams.get('limit')).toBe('2000');
    expect(options?.redirect).toBe('error');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(controller.snapshot().provider).toMatchObject({
      lastFetchedAt: initialTime.getTime(),
      retrieved: 5,
      eligible: 2,
      fetching: false,
    });
    expect(controller.pool.list().map(({ ip, status }) => ({ ip, status }))).toEqual([
      { ip: '8.8.8.8', status: 'unverified' },
      { ip: '8.8.4.4', status: 'unverified' },
    ]);
    expect(JSON.parse(await cache())).toEqual({ at: initialTime.getTime(), data: raw });
  });

  it.each([
    ['HTML outage page', '<html><title>Site Unavailable</title></html>'],
    ['truncated JSON', '{"proxies":['],
    ['API error envelope', JSON.stringify({ success: false, error: 'Temporarily unavailable' })],
    ['null JSON', 'null'],
    ['wrong list type', JSON.stringify({ proxies: { ip: '8.8.8.8' } })],
  ])('preserves the usable pool and on-disk cache after a %s', async (_label, body) => {
    const { controller, logs, before, cacheBefore, cache } = await seeded();
    network.mockResolvedValueOnce(new Response(body));
    await controller.refreshProxies();
    expect(controller.pool.list()).toEqual(before.proxies);
    expect(controller.snapshot().provider).toMatchObject({
      lastFetchedAt: before.provider.lastFetchedAt,
      retrieved: before.provider.retrieved,
      eligible: before.provider.eligible,
      fetching: false,
      error: expect.any(String),
    });
    expect(await cache()).toBe(cacheBefore);
    expect(logs.list().some((entry) => entry.category === 'proxy' && entry.level === 'warn')).toBe(true);
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 500, 503])(
    'preserves cached endpoints on HTTP %i without an immediate retry',
    async (status) => {
      const { controller, before, cache, cacheBefore } = await seeded();
      network.mockResolvedValueOnce(new Response('Upstream failure', { status }));
      await controller.refreshProxies();
      expect(controller.snapshot().provider.error).toContain(`HTTP ${status}`);
      expect(controller.pool.list()).toEqual(before.proxies);
      expect(await cache()).toBe(cacheBefore);
      for (let index = 0; index < 20; index++) await controller.refreshProxies();
      expect(network).toHaveBeenCalledTimes(2);
    },
  );

  it('recovers from a malformed response only after the request cooldown', async () => {
    const { controller } = await setup();
    network.mockResolvedValueOnce(new Response('{')).mockResolvedValueOnce(jsonResponse());
    await controller.refreshProxies();
    expect(controller.snapshot().provider.error).toBeTruthy();
    await controller.refreshProxies();
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    await controller.refreshProxies();
    expect(network).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await controller.refreshProxies();
    expect(network).toHaveBeenCalledTimes(2);
    expect(controller.snapshot().provider.error).toBeUndefined();
    expect(controller.pool.list()).toHaveLength(1);
  });

  it('coalesces a burst of callers and permits at most one new request each minute', async () => {
    const { controller } = await setup();
    const pending = deferred<Response>();
    network.mockReturnValueOnce(pending.promise).mockImplementation(async () => jsonResponse());
    const requests = Array.from({ length: 30 }, () => controller.refreshProxies());
    expect(network).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().provider.fetching).toBe(true);
    pending.resolve(jsonResponse());
    await Promise.all(requests);
    expect(controller.snapshot().provider.fetching).toBe(false);
    await Promise.all(Array.from({ length: 30 }, () => controller.refreshProxies()));
    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    await controller.refreshProxies();
    expect(network).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(Array.from({ length: 30 }, () => controller.refreshProxies()));
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['120', 2 * MINUTE],
    ['0', MINUTE],
    ['-5', MINUTE],
    ['not-a-date', MINUTE],
    ['9999999', 60 * MINUTE],
  ])('respects HTTP 429 Retry-After %s within the bounded cooldown', async (retryAfter, delay) => {
    const { controller, before, cacheBefore, cache } = await seeded();
    network
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': retryAfter } }))
      .mockResolvedValueOnce(jsonResponse(envelope('1.1.1.1')));
    await controller.refreshProxies();
    expect(controller.snapshot().provider.error).toMatch(/rate limit.*cooldown/i);
    expect(controller.pool.list()).toEqual(before.proxies);
    expect(await cache()).toBe(cacheBefore);
    await vi.advanceTimersByTimeAsync(delay - 1);
    await controller.refreshProxies();
    expect(network).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await controller.refreshProxies();
    expect(network).toHaveBeenCalledTimes(3);
    expect(controller.snapshot().provider.error).toBeUndefined();
    expect(controller.pool.list().map(({ ip }) => ip)).toEqual(['1.1.1.1']);
  });

  it('honors an HTTP-date Retry-After without retrying at the default one-minute interval', async () => {
    const { controller } = await setup();
    const retryAt = new Date(Date.now() + 5 * MINUTE).toUTCString();
    network
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': retryAt } }))
      .mockResolvedValueOnce(jsonResponse());
    await controller.refreshProxies();
    for (let minute = 1; minute < 5; minute++) {
      await vi.advanceTimersByTimeAsync(MINUTE);
      await controller.refreshProxies();
      expect(network).toHaveBeenCalledTimes(1);
    }
    await vi.advanceTimersByTimeAsync(MINUTE);
    await controller.refreshProxies();
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('settles a stalled response at the deadline, preserves cache, and bounds retry frequency', async () => {
    const { controller, before, cacheBefore, cache } = await seeded();
    let requestSignal: AbortSignal | undefined;
    network.mockImplementationOnce(
      (_input, options) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = options?.signal ?? undefined;
          requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason), { once: true });
        }),
    );
    const request = controller.refreshProxies();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(controller.snapshot().provider.fetching).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await request;
    expect(requestSignal?.aborted).toBe(true);
    expect(controller.snapshot().provider).toMatchObject({ fetching: false, error: expect.any(String) });
    expect(controller.pool.list()).toEqual(before.proxies);
    expect(await cache()).toBe(cacheBefore);
    await controller.refreshProxies();
    expect(network).toHaveBeenCalledTimes(2);
  });

  it('applies the deadline to a stalled body after successful response headers', async () => {
    const { controller, before, cacheBefore, cache } = await seeded();
    network.mockImplementationOnce(async (_input, options) => {
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('{"proxies":['));
          options?.signal?.addEventListener('abort', () => stream.error(options.signal?.reason), {
            once: true,
          });
        },
      });
      return new Response(body);
    });
    const request = controller.refreshProxies();
    await vi.advanceTimersByTimeAsync(20_000);
    await request;
    expect(controller.snapshot().provider.fetching).toBe(false);
    expect(controller.snapshot().provider.error).toBeTruthy();
    expect(controller.pool.list()).toEqual(before.proxies);
    expect(await cache()).toBe(cacheBefore);
  });

  it.each([undefined, '1'])(
    'enforces received bytes even when Content-Length is %s',
    async (lengthHeader) => {
      const { controller, before, cacheBefore, cache } = await seeded();
      const cancel = vi.fn(async () => undefined);
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(stream) {
            pulls++;
            stream.enqueue(new Uint8Array(pulls === 1 ? BODY_LIMIT : 1));
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      network.mockResolvedValueOnce(
        new Response(body, { headers: lengthHeader ? { 'content-length': lengthHeader } : undefined }),
      );
      await controller.refreshProxies();
      expect(pulls).toBe(2);
      expect(cancel).toHaveBeenCalled();
      expect(controller.snapshot().provider).toMatchObject({
        fetching: false,
        error: expect.stringMatching(/4 MB/),
      });
      expect(controller.pool.list()).toEqual(before.proxies);
      expect(await cache()).toBe(cacheBefore);
    },
  );

  it('accepts a complete valid body at the exact byte limit', async () => {
    const { controller } = await setup();
    const content = JSON.stringify(envelope());
    network.mockResolvedValueOnce(
      new Response(content + ' '.repeat(BODY_LIMIT - Buffer.byteLength(content))),
    );
    await controller.refreshProxies();
    expect(controller.snapshot().provider.error).toBeUndefined();
    expect(controller.pool.list()).toHaveLength(1);
  });

  it('keeps refresh responsive when cancellation of an oversized body does not settle', async () => {
    const { controller, before, cacheBefore, cache } = await seeded();
    const cancellation = deferred<void>();
    const cancel = vi.fn(() => cancellation.promise);
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new Uint8Array(BODY_LIMIT + 1));
      },
      cancel,
    });
    network.mockResolvedValueOnce(new Response(body));
    let settled = false;
    const request = controller.refreshProxies().then(() => {
      settled = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(25_000);
      expect(cancel).toHaveBeenCalled();
      expect(settled).toBe(true);
      expect(controller.snapshot().provider.fetching).toBe(false);
      expect(controller.pool.list()).toEqual(before.proxies);
      expect(await cache()).toBe(cacheBefore);
    } finally {
      cancellation.resolve();
      await request;
    }
  });

  it('preserves a fresh cache loaded on startup when an explicit refresh fails', async () => {
    const { controller, cachePath, cache } = await setup();
    const savedAt = Date.now() - MINUTE;
    const saved = JSON.stringify({ at: savedAt, data: envelope() });
    await writeFile(cachePath, saved);
    await controller.initialize();
    expect(network).not.toHaveBeenCalled();
    expect(controller.snapshot().provider.lastFetchedAt).toBe(savedAt);
    const endpoints = controller.pool.list();
    network.mockResolvedValueOnce(new Response('<html>Maintenance</html>', { status: 503 }));
    await controller.refreshProxies();
    expect(controller.pool.list()).toEqual(endpoints);
    expect(controller.snapshot().provider.lastFetchedAt).toBe(savedAt);
    expect(await cache()).toBe(saved);
  });

  it('rejects missing bodies and oversized record lists without wiping the last successful pool', async () => {
    const { controller, before, cacheBefore, cache } = await seeded();
    network.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await controller.refreshProxies();
    expect(controller.snapshot().provider.error).toMatch(/empty response/);
    expect(controller.pool.list()).toEqual(before.proxies);
    await vi.advanceTimersByTimeAsync(MINUTE);
    network.mockResolvedValueOnce(jsonResponse({ proxies: Array.from({ length: 60_001 }, () => null) }));
    await controller.refreshProxies();
    expect(controller.snapshot().provider.error).toMatch(/supported size/);
    expect(controller.pool.list()).toEqual(before.proxies);
    expect(await cache()).toBe(cacheBefore);
  });

  it('does not start another provider request after shutdown', async () => {
    const { controller } = await setup();
    await controller.shutdown();
    controllers.delete(controller);
    await controller.refreshProxies();
    expect(network).not.toHaveBeenCalled();
  });
});

describe('automatic proxy reserve replenishment', () => {
  it.each([
    ['empty', []],
    ['entirely failed', ['failed', 'failed']],
  ] as const)(
    'waits for one refresh before allocating an %s reserve to concurrent callers',
    async (_label, statuses) => {
      const { controller, proxyCallbacks } = await setup();
      vi.spyOn(controller.pool, 'list').mockReturnValue(reserveRecords([...statuses]));
      const allocate = vi.spyOn(controller.pool, 'acquire').mockResolvedValue(null);
      const response = deferred<Response>();
      network.mockReturnValueOnce(response.promise);
      const signal = new AbortController().signal;
      const requests = [1, 2, 3].map((id) => proxyCallbacks.acquire(id, signal));
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(network).toHaveBeenCalledTimes(1);
        expect(allocate).not.toHaveBeenCalled();
      } finally {
        response.resolve(jsonResponse());
        await Promise.all(requests);
      }
      expect(allocate).toHaveBeenCalledTimes(3);
      for (const id of [1, 2, 3]) expect(allocate).toHaveBeenCalledWith(id, signal);
      expect(controller.snapshot().provider).toMatchObject({ fetching: false, eligible: 1 });
    },
  );

  it.each([
    { browserCount: 1, statuses: ['available', 'unverified', 'available'], refresh: true },
    { browserCount: 1, statuses: ['available', 'unverified', 'available', 'unverified'], refresh: false },
    { browserCount: 8, statuses: Array.from({ length: 7 }, () => 'unverified'), refresh: true },
    { browserCount: 8, statuses: Array.from({ length: 8 }, () => 'available'), refresh: false },
    { browserCount: 1, statuses: ['available', 'failed', 'assigned', 'validating'], refresh: true },
  ] satisfies Array<{ browserCount: number; statuses: ProxyRecord['status'][]; refresh: boolean }>)(
    'replenishes $statuses for $browserCount browsers only below the usable-reserve threshold',
    async ({ browserCount, statuses, refresh }) => {
      const { controller, proxyCallbacks } = await setup({ browserCount });
      const reserve = reserveRecords(statuses);
      vi.spyOn(controller.pool, 'list').mockReturnValue(reserve);
      const allocate = vi.spyOn(controller.pool, 'acquire').mockResolvedValue(reserve[0]);
      const response = deferred<Response>();
      network.mockReturnValueOnce(response.promise);
      let allocationsFinished = false;
      const requests = Promise.all([1, 2, 3].map((id) => proxyCallbacks.acquire(id))).then(() => {
        allocationsFinished = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(allocationsFinished, 'Usable capacity must not wait for the background provider request').toBe(
          true,
        );
        expect(allocate).toHaveBeenCalledTimes(3);
        expect(network).toHaveBeenCalledTimes(refresh ? 1 : 0);
      } finally {
        const activeRefresh = controller.snapshot().provider.fetching
          ? controller.refreshProxies()
          : Promise.resolve();
        response.resolve(jsonResponse());
        await Promise.all([requests, activeRefresh]);
      }
    },
  );

  it('replenishes after a transport-failure release while an ordinary healthy release stays quiet', async () => {
    const { controller, proxyCallbacks } = await setup();
    vi.spyOn(controller.pool, 'list').mockReturnValue(reserveRecords(Array(10).fill('available')));
    const release = vi.spyOn(controller.pool, 'release');
    await proxyCallbacks.release(1);
    expect(network).not.toHaveBeenCalled();

    const response = deferred<Response>();
    network.mockReturnValueOnce(response.promise);
    try {
      await proxyCallbacks.release(1, 'Proxy tunnel reset');
      await proxyCallbacks.release(2, 'Proxy connection refused');
      expect(release).toHaveBeenCalledWith(1, 'Proxy tunnel reset');
      expect(release).toHaveBeenCalledWith(2, 'Proxy connection refused');
      expect(network).toHaveBeenCalledTimes(1);
      expect(controller.snapshot().provider.fetching).toBe(true);
    } finally {
      const activeRefresh = controller.refreshProxies();
      response.resolve(jsonResponse());
      await activeRefresh;
    }
  });

  it('replenishes a low fresh cached reserve on background ticks without bypassing an in-flight request or Retry-After', async () => {
    const { controller, cachePath } = await setup();
    await writeFile(cachePath, JSON.stringify({ at: Date.now(), data: envelope() }));
    const allocate = vi.spyOn(controller.pool, 'acquire').mockResolvedValue(null);
    await controller.initialize();
    expect(network).not.toHaveBeenCalled();

    const response = deferred<Response>();
    network.mockReturnValueOnce(response.promise);
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      expect(network).toHaveBeenCalledTimes(1);
      expect(controller.snapshot().provider.fetching).toBe(true);
      expect(allocate).not.toHaveBeenCalled();
    } finally {
      const activeRefresh = controller.snapshot().provider.fetching
        ? controller.refreshProxies()
        : Promise.resolve();
      response.resolve(new Response(null, { status: 429, headers: { 'retry-after': '120' } }));
      await activeRefresh;
    }
    const diagnostic = controller.snapshot().provider.error;
    expect(diagnostic).toContain('rate limit');
    network.mockResolvedValueOnce(jsonResponse(envelope('1.1.1.1')));
    await vi.advanceTimersByTimeAsync(2 * MINUTE - 1);
    expect(network).toHaveBeenCalledTimes(1);
    expect(controller.snapshot().provider.error).toBe(diagnostic);
    await vi.advanceTimersByTimeAsync(1);
    expect(network).toHaveBeenCalledTimes(2);
    await controller.refreshProxies();
    expect(controller.snapshot().provider.error).toBeUndefined();
    expect(controller.pool.list().map((proxy) => proxy.ip)).toEqual(['1.1.1.1']);
  });

  it.each([
    { status: 503, retryAfter: undefined, cooldown: MINUTE },
    { status: 429, retryAfter: '120', cooldown: 2 * MINUTE },
  ])(
    'honors the shared cooldown after HTTP $status without replacing its diagnostic',
    async ({ status, retryAfter, cooldown }) => {
      const { controller, proxyCallbacks } = await setup();
      vi.spyOn(controller.pool, 'list').mockReturnValue(reserveRecords(['available']));
      vi.spyOn(controller.pool, 'acquire').mockResolvedValue(null);
      network.mockResolvedValueOnce(
        new Response(null, { status, headers: retryAfter ? { 'retry-after': retryAfter } : undefined }),
      );
      await controller.refreshProxies();
      const diagnostic = controller.snapshot().provider.error;
      expect(diagnostic).toContain(status === 429 ? 'rate limit' : 'HTTP 503');
      for (let index = 0; index < 10; index++) {
        await proxyCallbacks.acquire(index + 1);
        await proxyCallbacks.release(index + 1, 'Proxy connection reset');
      }
      await vi.advanceTimersByTimeAsync(cooldown - 1);
      await proxyCallbacks.acquire(1);
      await proxyCallbacks.release(1, 'Proxy connection reset');
      expect(network).toHaveBeenCalledTimes(1);
      expect(controller.snapshot().provider.error).toBe(diagnostic);

      await vi.advanceTimersByTimeAsync(1);
      const response = deferred<Response>();
      network.mockReturnValueOnce(response.promise);
      try {
        await proxyCallbacks.acquire(1);
        expect(network).toHaveBeenCalledTimes(2);
      } finally {
        const activeRefresh = controller.snapshot().provider.fetching
          ? controller.refreshProxies()
          : Promise.resolve();
        response.resolve(jsonResponse());
        await activeRefresh;
      }
      expect(controller.snapshot().provider.error).toBeUndefined();
    },
  );

  it.each(['test mode', 'closing'] as const)(
    'does not contact the provider from automatic callbacks in %s',
    async (mode) => {
      const { controller, proxyCallbacks } = await setup({ testMode: mode === 'test mode' });
      if (mode === 'test mode') await controller.initialize();
      else {
        await controller.shutdown();
        controllers.delete(controller);
      }
      vi.spyOn(controller.pool, 'list').mockReturnValue(reserveRecords(['failed']));
      vi.spyOn(controller.pool, 'acquire').mockResolvedValue(null);
      for (let index = 0; index < 3; index++) {
        await proxyCallbacks.acquire(index + 1);
        await proxyCallbacks.release(index + 1, 'Proxy connection reset');
      }
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(network).not.toHaveBeenCalled();
    },
  );
});
