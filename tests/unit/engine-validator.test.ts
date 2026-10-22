import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyRecord } from '../../src/shared/types';

const electron = vi.hoisted(() => ({ fromPartition: vi.fn() }));
vi.mock('electron', () => ({ session: { fromPartition: electron.fromPartition } }));

const proxy: ProxyRecord = {
  id: 'fixture',
  ip: '127.0.0.1',
  port: 8080,
  protocol: 'http',
  country: 'US',
  countryName: 'United States',
  source: 'fixture',
  status: 'unverified',
  lastChecked: null,
  latencyMs: null,
  failures: 0,
};
const endpoint = 'https://diagnostic.test/';
const blockedProxy = 'http://127.0.0.1:9';
type RequestGate = (details: { url: string }, callback: (result: { cancel: boolean }) => void) => void;
type ProxyConfig = { mode: string; proxyRules: string; proxyBypassRules: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const success = () =>
  new Response(JSON.stringify({ success: true, ip: '8.8.8.8', country_code: 'US' }), {
    headers: { 'content-type': 'application/json' },
  });

function sessionFixture() {
  let gate: RequestGate = (_details, callback) => callback({ cancel: true });
  return {
    setProxy: vi.fn(async (_config: ProxyConfig) => undefined),
    closeAllConnections: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    resolveProxy: vi.fn(async (_url: string) => 'PROXY 127.0.0.1:8080'),
    fetch: vi.fn(async (_url: string, _options: { signal: AbortSignal }) => success()),
    webRequest: {
      onBeforeRequest: vi.fn((_filter: object, handler: RequestGate) => {
        gate = handler;
      }),
    },
    blocked(url = endpoint): boolean {
      let blocked = true;
      gate({ url }, (result) => {
        blocked = result.cancel;
      });
      return blocked;
    },
  };
}
type FixtureSession = ReturnType<typeof sessionFixture>;
let instances: FixtureSession[];
let customize: (fixture: FixtureSession, index: number) => void;
let validateProxy: typeof import('../../src/main/network/proxy-validator').validateProxy;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  instances = [];
  customize = () => undefined;
  electron.fromPartition.mockReset().mockImplementation(() => {
    const fixture = sessionFixture();
    customize(fixture, instances.length);
    instances.push(fixture);
    return fixture;
  });
  ({ validateProxy } = await import('../../src/main/network/proxy-validator'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('bounded native proxy validation', () => {
  it('validates through a fixed proxy, restricts diagnostics, cleans up, and reuses healthy slots', async () => {
    customize = (fixture) =>
      fixture.fetch.mockImplementation(async () => {
        expect(fixture.blocked()).toBe(false);
        expect(fixture.blocked('https://elsewhere.test/')).toBe(true);
        return success();
      });
    const result = await validateProxy(proxy, 1000, undefined, endpoint);
    expect(result).toMatchObject({ exitIp: '8.8.8.8', country: 'US' });
    expect(instances[0].setProxy).toHaveBeenNthCalledWith(1, {
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:8080',
      proxyBypassRules: '<-loopback>',
    });
    expect(instances[0].setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: blockedProxy,
      proxyBypassRules: '<-loopback>',
    });
    expect(instances[0].blocked()).toBe(true);
    expect(instances[0].clearStorageData).toHaveBeenCalledTimes(1);
    await validateProxy(proxy, 1000, undefined, endpoint);
    expect(electron.fromPartition).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['close', 'configure', 'resolve'] as const)(
    'retires a timed-out native %s operation without reusing its partition',
    async (phase) => {
      const stalled = deferred<undefined>();
      customize = (fixture, index) => {
        if (index) return;
        if (phase === 'close') fixture.closeAllConnections.mockImplementationOnce(() => stalled.promise);
        if (phase === 'configure') fixture.setProxy.mockImplementationOnce(() => stalled.promise);
        if (phase === 'resolve')
          fixture.resolveProxy.mockImplementationOnce(() =>
            stalled.promise.then(() => 'PROXY 127.0.0.1:8080'),
          );
      };
      const first = validateProxy(proxy, 50, undefined, endpoint);
      const rejected = expect(first).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(50);
      await rejected;
      expect(instances[0].fetch).not.toHaveBeenCalled();
      await validateProxy(proxy, 1000, undefined, endpoint);
      expect(electron.fromPartition.mock.calls.map((call) => call[0])).toEqual([
        'unicorn-validator-0',
        'unicorn-validator-1',
      ]);
      stalled.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(instances[0].blocked()).toBe(true);
      expect(instances[0].fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('settles Stop promptly when native proxy configuration ignores cancellation', async () => {
    customize = (fixture) => fixture.setProxy.mockImplementationOnce(() => new Promise(() => undefined));
    const abort = new AbortController();
    const operation = validateProxy(proxy, 60000, abort.signal, endpoint);
    const rejected = expect(operation).rejects.toThrow('Emergency stop');
    await vi.advanceTimersByTimeAsync(0);
    abort.abort(new Error('Emergency stop'));
    await rejected;
    expect(instances[0].blocked()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports all retired slots immediately and wakes queued callers instead of hanging', async () => {
    customize = (fixture) => fixture.setProxy.mockImplementationOnce(() => new Promise(() => undefined));
    const operations = Array.from({ length: 4 }, () => validateProxy(proxy, 50, undefined, endpoint));
    const failures = operations.map((operation) => expect(operation).rejects.toThrow('timed out'));
    const waiting = expect(validateProxy(proxy, 60000, undefined, endpoint)).rejects.toThrow(
      'All proxy-validation sessions are unavailable',
    );
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([...failures, waiting]);
    await expect(validateProxy(proxy, 60000, undefined, endpoint)).rejects.toThrow('restart Unicorn');
    expect(electron.fromPartition).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reuses a healthy slot after many ordinary abort-aware network timeouts', async () => {
    customize = (fixture) =>
      fixture.fetch.mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
          }),
      );
    for (let attempt = 0; attempt < 8; attempt++) {
      const rejection = expect(validateProxy(proxy, 50, undefined, endpoint)).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
    }
    expect(electron.fromPartition).toHaveBeenCalledTimes(1);
    expect(instances[0].clearStorageData).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels a stalled response body and reuses the slot after the reader settles', async () => {
    customize = (fixture) =>
      fixture.fetch.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>()));
    const rejection = expect(validateProxy(proxy, 50, undefined, endpoint)).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    await validateProxy(proxy, 1000, undefined, endpoint);
    expect(electron.fromPartition).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retires a fetch that ignores abort and completed connection cleanup within a bounded grace period', async () => {
    const stalled = deferred<Response>();
    customize = (fixture, index) => {
      if (!index) fixture.fetch.mockImplementationOnce(() => stalled.promise);
    };
    let finished = false;
    const operation = validateProxy(proxy, 50, undefined, endpoint).finally(() => {
      finished = true;
    });
    const rejection = expect(operation).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(2049);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    await validateProxy(proxy, 1000, undefined, endpoint);
    expect(electron.fromPartition).toHaveBeenCalledTimes(2);
    stalled.resolve(success());
    await vi.advanceTimersByTimeAsync(0);
    expect(instances[0].blocked()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['configure', 'close', 'storage'] as const)(
    'bounds a stalled cleanup %s and retires the unsafe session',
    async (phase) => {
      customize = (fixture, index) => {
        if (index) return;
        if (phase === 'configure')
          fixture.setProxy.mockImplementation(async (config) => {
            if (config.proxyRules === blockedProxy) await new Promise(() => undefined);
          });
        if (phase === 'close')
          fixture.closeAllConnections
            .mockResolvedValueOnce(undefined)
            .mockImplementationOnce(() => new Promise(() => undefined));
        if (phase === 'storage')
          fixture.clearStorageData.mockImplementationOnce(() => new Promise(() => undefined));
      };
      const operation = validateProxy(proxy, 1000, undefined, endpoint);
      const rejection = expect(operation).rejects.toThrow('cleanup timed out');
      await vi.advanceTimersByTimeAsync(2000);
      await rejection;
      await validateProxy(proxy, 1000, undefined, endpoint);
      expect(electron.fromPartition).toHaveBeenCalledTimes(2);
      expect(instances[0].blocked()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('removes cancelled reservation waiters without consuming another slot', async () => {
    const responses = Array.from({ length: 4 }, () => deferred<Response>());
    customize = (fixture, index) => fixture.fetch.mockImplementationOnce(() => responses[index].promise);
    const operations = Array.from({ length: 4 }, () => validateProxy(proxy, 1000, undefined, endpoint));
    const abort = new AbortController();
    const waiting = expect(validateProxy(proxy, 1000, abort.signal, endpoint)).rejects.toThrow(
      'Cancelled waiter',
    );
    await vi.advanceTimersByTimeAsync(0);
    abort.abort(new Error('Cancelled waiter'));
    await waiting;
    responses.forEach((response) => response.resolve(success()));
    await Promise.all(operations);
    expect(electron.fromPartition).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['DIRECT', 'PROXY 127.0.0.1:8080; DIRECT', ''])(
    'rejects unsafe proxy resolution %s before fetching',
    async (resolution) => {
      customize = (fixture) => fixture.resolveProxy.mockResolvedValue(resolution);
      await expect(validateProxy(proxy, 1000, undefined, endpoint)).rejects.toThrow('unsafe connection');
      expect(instances[0].fetch).not.toHaveBeenCalled();
      expect(instances[0].blocked()).toBe(true);
    },
  );

  it('rejects non-HTTPS diagnostics and credentials before reserving a session', async () => {
    await expect(validateProxy(proxy, 1000, undefined, 'http://diagnostic.test/')).rejects.toThrow('HTTPS');
    await expect(validateProxy(proxy, 1000, undefined, 'https://password@diagnostic.test/')).rejects.toThrow(
      'credentials',
    );
    expect(electron.fromPartition).not.toHaveBeenCalled();
  });

  it('bounds diagnostic bodies and preserves the next healthy validation', async () => {
    customize = (fixture) => fixture.fetch.mockResolvedValueOnce(new Response('x'.repeat(32769)));
    await expect(validateProxy(proxy, 1000, undefined, endpoint)).rejects.toThrow('exceeds limit');
    await validateProxy(proxy, 1000, undefined, endpoint);
    expect(electron.fromPartition).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
