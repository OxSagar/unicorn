import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { BLOCKED_PROXY, proxyRule, SessionGate } from '../../src/main/network/session-gate';
import type { ProxyRecord } from '../../src/shared/types';
import { SiteRestrictionError } from '../../src/main/network/site-restriction';

afterEach(() => vi.useRealTimers());

const proxy: ProxyRecord = {
  id: 'test',
  ip: '203.0.113.7',
  port: 8080,
  protocol: 'http',
  country: 'US',
  countryName: 'United States',
  status: 'available',
  failures: 0,
  source: 'fixture',
};
type Request = (
  details: { id: number; url: string; resourceType: string; webContentsId: number },
  done: (response: { cancel?: boolean }) => void,
) => void;
type Headers = (
  details: { resourceType: string; statusCode: number; url: string },
  done: (response: object) => void,
) => void;
type Failure = (details: { id: number; error: string; resourceType: string; webContentsId: number }) => void;

function setup() {
  let request: Request = () => undefined;
  let headers: Headers | null = null;
  let failure: Failure | null = null;
  let requestId = 0;
  const fake = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setSpellCheckerEnabled: vi.fn(),
    setProxy: vi.fn(
      async (_config: { mode: string; proxyRules: string; proxyBypassRules: string }): Promise<void> =>
        undefined,
    ),
    closeAllConnections: vi.fn(async (): Promise<void> => undefined),
    forceReloadProxyConfig: vi.fn(async (): Promise<void> => undefined),
    resolveProxy: vi.fn(async () => 'PROXY 203.0.113.7:8080'),
    fetch: vi.fn(async () => {
      throw new Error('Assignment must never send a diagnostic request');
    }),
    webRequest: {
      onBeforeRequest: vi.fn((_filter: object, handler: Request) => {
        request = handler;
      }),
      onBeforeSendHeaders: vi.fn(),
      onHeadersReceived: vi.fn((handler: Headers | null) => {
        headers = handler;
      }),
      onErrorOccurred: vi.fn((handler: Failure | null) => {
        failure = handler;
      }),
      onCompleted: vi.fn(),
    },
  };
  const hooks = {
    approveRequest: vi.fn(),
    approveNavigation: vi.fn(),
    onFailure: vi.fn(),
    onRestricted: vi.fn(),
    onPolicyRestricted: vi.fn(),
  };
  const gate = new SessionGate(fake as unknown as Session, hooks);
  return {
    fake,
    hooks,
    gate,
    request: (url: string, resourceType = 'mainFrame', id = ++requestId, webContentsId = 7) =>
      new Promise<{ cancel?: boolean }>((resolve) =>
        request({ id, url, resourceType, webContentsId }, resolve),
      ),
    failure: (id: number, error: string, webContentsId = 7, resourceType = 'mainFrame') =>
      failure?.({ id, error, resourceType, webContentsId }),
    response: (statusCode: number) =>
      headers?.({ statusCode, resourceType: 'mainFrame', url: 'https://authorized.test/' }, () => undefined),
  };
}

describe('session network gate', () => {
  it('blocks every remote request before a proxy is assigned', async () => {
    const { request } = setup();
    expect(await request('https://authorized.test/')).toEqual({ cancel: true });
    expect(await request('wss://authorized.test/socket', 'webSocket')).toEqual({ cancel: true });
  });
  it('uses fixed servers, explicitly subtracts implicit loopback bypass, and never includes DIRECT', async () => {
    const { gate, fake, request } = setup();
    await gate.assign(proxy, new AbortController().signal, true);
    expect(fake.setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: 'http://203.0.113.7:8080',
      proxyBypassRules: '<-loopback>',
    });
    expect(fake.forceReloadProxyConfig).toHaveBeenCalledOnce();
    expect(fake.closeAllConnections.mock.invocationCallOrder[0]).toBeLessThan(
      fake.setProxy.mock.invocationCallOrder[0]!,
    );
    expect(fake.setProxy.mock.invocationCallOrder[0]).toBeLessThan(
      fake.forceReloadProxyConfig.mock.invocationCallOrder[0]!,
    );
    expect(fake.forceReloadProxyConfig.mock.invocationCallOrder[0]).toBeLessThan(
      fake.resolveProxy.mock.invocationCallOrder[0]!,
    );
    expect(await request('https://authorized.test/')).toEqual({});
    await gate.block();
    expect(fake.setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: BLOCKED_PROXY,
      proxyBypassRules: '<-loopback>',
    });
    expect(await request('https://authorized.test/')).toEqual({ cancel: true });
    expect(fake.closeAllConnections).toHaveBeenCalledTimes(2);
    expect(fake.fetch).not.toHaveBeenCalled();
  });
  it.each([
    '',
    'DIRECT',
    'PROXY 127.0.0.1:9',
    'PROXY 203.0.113.8:8080',
    'PROXY 203.0.113.7:8081',
    'HTTPS 203.0.113.7:8080',
    'SOCKS5 203.0.113.7:8080',
    'PROXY 203.0.113.7:8080; DIRECT',
    'PROXY 203.0.113.7:8080; PROXY 203.0.113.8:8080',
  ])('rejects a stale, different, or unsafe Chromium route: %s', async (resolution) => {
    const { gate, fake, request } = setup();
    fake.resolveProxy.mockResolvedValue(resolution);
    await expect(gate.assign(proxy, new AbortController().signal, false)).rejects.toThrow(
      `Unsafe proxy resolution: expected PROXY 203.0.113.7:8080; Chromium returned ${resolution || '(empty)'}`,
    );
    expect(gate.isEnabled).toBe(false);
    expect(await request('https://authorized.test/')).toEqual({ cancel: true });
    expect(fake.setProxy).toHaveBeenCalledTimes(1);
    expect(fake.fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['http', 'PROXY', '203.0.113.7', '203.0.113.7'],
    ['https', 'HTTPS', '203.0.113.7', '203.0.113.7'],
    ['socks5', 'SOCKS5', '203.0.113.7', '203.0.113.7'],
    ['http', 'PROXY', '2001:db8::7', '[2001:db8::7]'],
    ['https', 'HTTPS', '2001:db8::7', '[2001:db8::7]'],
    ['socks5', 'SOCKS5', '2001:db8::7', '[2001:db8::7]'],
  ] as const)('accepts only the reserved %s endpoint at %s %s', async (protocol, token, ip, host) => {
    const { gate, fake } = setup();
    const route = `${token} ${host}:8080`;
    fake.resolveProxy.mockResolvedValue(route);
    await expect(gate.assign({ ...proxy, protocol, ip }, new AbortController().signal, false)).resolves.toBe(
      route,
    );
    expect(gate.isEnabled).toBe(true);
  });
  it('does not accept a SOCKS4 route for an assigned SOCKS5 endpoint', async () => {
    const { gate, fake } = setup();
    fake.resolveProxy.mockResolvedValue('SOCKS 203.0.113.7:8080');
    await expect(
      gate.assign({ ...proxy, protocol: 'socks5' }, new AbortController().signal, false),
    ).rejects.toThrow('expected SOCKS5 203.0.113.7:8080; Chromium returned SOCKS 203.0.113.7:8080');
    expect(gate.isEnabled).toBe(false);
  });
  it('does not re-enable requests if a stop races with proxy resolution', async () => {
    const { gate, fake, request } = setup();
    let finish!: (result: string) => void;
    fake.resolveProxy.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const assign = gate.assign(proxy, new AbortController().signal, true);
    const rejection = expect(assign).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const block = gate.block();
    finish('PROXY 203.0.113.7:8080');
    await rejection;
    await block;
    expect(await request('https://authorized.test/')).toEqual({ cancel: true });
  });
  it('does not enable networking when cancellation happens during proxy resolution', async () => {
    const { gate, fake } = setup();
    const abort = new AbortController();
    fake.resolveProxy.mockImplementation(async () => {
      abort.abort(new Error('Cancelled'));
      return 'PROXY 203.0.113.7:8080';
    });
    await expect(gate.assign(proxy, abort.signal, true)).rejects.toThrow('Cancelled');
    expect(gate.isEnabled).toBe(false);
  });
  it('identifies current main-frame failures and ignores delayed errors from a previous route', async () => {
    const { gate, hooks, request, failure } = setup();
    await gate.assign(proxy, new AbortController().signal, false);
    await request('https://authorized.test/old', 'mainFrame', 101, 7);
    await gate.block();
    await gate.assign(proxy, new AbortController().signal, false);
    await request('https://authorized.test/new', 'mainFrame', 102, 7);
    failure(101, 'net::ERR_PROXY_CONNECTION_FAILED');
    expect(hooks.onFailure).not.toHaveBeenCalled();
    failure(102, 'net::ERR_PROXY_CONNECTION_FAILED');
    expect(hooks.onFailure).toHaveBeenCalledExactlyOnceWith('net::ERR_PROXY_CONNECTION_FAILED', true, 7);
  });
  it.each(['closeAllConnections', 'setProxy', 'forceReloadProxyConfig'] as const)(
    'permanently rejects the same session after timed-out %s completes late, including after reopening',
    async (method) => {
      vi.useFakeTimers();
      const { gate, fake, hooks, request } = setup();
      let complete!: () => void;
      fake[method].mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      );
      const assignment = gate.assign(proxy, new AbortController().signal, true);
      const failure = assignment.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(8000);
      const error = await failure;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `assign.${method} (elapsed 8000 ms; generation 2; current generation 2): Browser operation timed out after 8000 ms`,
      );
      expect(gate.isEnabled).toBe(false);
      await expect(gate.assign(proxy, new AbortController().signal, true)).rejects.toBe(error);
      gate.dispose();
      const reopened = new SessionGate(fake as unknown as Session, hooks);
      await expect(reopened.assign(proxy, new AbortController().signal, true)).rejects.toBe(error);
      complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(reopened.isEnabled).toBe(false);
      expect(await request('https://authorized.test/')).toEqual({ cancel: true });
      expect(fake.setProxy).toHaveBeenCalledTimes(method === 'closeAllConnections' ? 0 : 1);
      expect(fake.resolveProxy).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(['setProxy', 'closeAllConnections'] as const)(
    'identifies an initial block.%s stall before any proxy assignment or page exists',
    async (method) => {
      vi.useFakeTimers();
      const { gate, fake, request } = setup();
      let complete!: () => void;
      fake[method].mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      );
      const failure = gate.block().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(8000);
      const error = await failure;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `block.${method} (elapsed 8000 ms; generation 2; current generation 2): Browser operation timed out after 8000 ms`,
      );
      expect(fake.forceReloadProxyConfig).not.toHaveBeenCalled();
      expect(fake.resolveProxy).not.toHaveBeenCalled();
      expect(await request('https://authorized.test/')).toEqual({ cancel: true });
      complete();
      await vi.advanceTimersByTimeAsync(0);
      await expect(gate.assign(proxy, new AbortController().signal, false)).rejects.toBe(error);
      expect(gate.isEnabled).toBe(false);
      expect(fake.fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(['closeAllConnections', 'forceReloadProxyConfig'] as const)(
    'poisons unsettled %s when an operation is aborted',
    async (method) => {
      const { gate, fake } = setup();
      const abort = new AbortController();
      let complete!: () => void;
      fake[method].mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      );
      const assignment = gate.assign(proxy, abort.signal, false);
      const failure = expect(assignment).rejects.toThrow('Stopped during native configuration');
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      abort.abort(new Error('Stopped during native configuration'));
      await failure;
      await expect(gate.assign(proxy, new AbortController().signal, false)).rejects.toThrow(
        `assign.${method}`,
      );
      await expect(gate.assign(proxy, new AbortController().signal, false)).rejects.toThrow(
        'restart Unicorn',
      );
      complete();
      await Promise.resolve();
      expect(gate.isEnabled).toBe(false);
      expect(fake.setProxy).toHaveBeenCalledTimes(method === 'closeAllConnections' ? 0 : 1);
      expect(fake.resolveProxy).not.toHaveBeenCalled();
    },
  );
  it('preserves the original failure context when Stop supersedes an in-flight native reload', async () => {
    vi.useFakeTimers();
    const { gate, fake, request } = setup();
    const abort = new AbortController();
    let complete!: () => void;
    fake.forceReloadProxyConfig.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const assignment = gate.assign(proxy, abort.signal, false).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(125);
    const stopped = gate.block().catch((error: unknown) => error);
    expect(await request('https://authorized.test/')).toEqual({ cancel: true });
    expect(fake.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(fake.setProxy).toHaveBeenCalledTimes(1);
    abort.abort(new Error('Stopped during native configuration'));
    const error = await assignment;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'assign.forceReloadProxyConfig (elapsed 125 ms; generation 2; current generation 3): Stopped during native configuration',
    );
    expect(await stopped).toBe(error);
    expect(fake.setProxy).toHaveBeenCalledTimes(1);
    expect(fake.closeAllConnections).toHaveBeenCalledTimes(2);
    complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(gate.isEnabled).toBe(false);
    expect(fake.resolveProxy).not.toHaveBeenCalled();
    expect(await request('https://authorized.test/')).toEqual({ cancel: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps requests blocked when Stop races with a native reload that later completes', async () => {
    const { gate, fake, request } = setup();
    let complete!: () => void;
    fake.forceReloadProxyConfig.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const assignment = gate.assign(proxy, new AbortController().signal, false);
    const rejection = expect(assignment).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    const stopped = gate.block();
    expect(await request('https://authorized.test/')).toEqual({ cancel: true });
    complete();
    await rejection;
    await stopped;
    expect(gate.isEnabled).toBe(false);
    expect(fake.setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: BLOCKED_PROXY,
      proxyBypassRules: '<-loopback>',
    });
    expect(await request('https://authorized.test/')).toEqual({ cancel: true });
  });
  it('checks top-level and child-frame scope and rejects local-file access', async () => {
    const { gate, hooks, request } = setup();
    await gate.assign(proxy, new AbortController().signal, false);
    hooks.approveNavigation.mockImplementation(() => {
      throw new Error('Out of scope');
    });
    expect(await request('https://unapproved.test/')).toEqual({ cancel: true });
    expect(await request('https://unapproved.test/', 'subFrame')).toEqual({ cancel: true });
    expect(await request('file:///private.txt', 'script')).toEqual({ cancel: true });
    expect(hooks.onFailure).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 429])(
    'blocks subsequent requests on HTTP %s without rotating proxies',
    async (status) => {
      const { gate, hooks, request, response, fake } = setup();
      await gate.assign(proxy, new AbortController().signal, true);
      response(status);
      expect(hooks.onRestricted).toHaveBeenCalledWith(status, 'https://authorized.test/');
      expect(await request('https://authorized.test/')).toEqual({ cancel: true });
      expect(fake.setProxy).toHaveBeenCalledTimes(1);
    },
  );
  it('keeps persistent worker requests denied after the view is disposed', async () => {
    const { gate, request } = setup();
    await gate.assign(proxy, new AbortController().signal, false);
    await gate.block();
    gate.dispose();
    expect(await request('https://authorized.test/service-worker', 'other')).toEqual({ cancel: true });
  });
  it('blocks unapproved third-party ad resources during synthetic QA but permits manual proxied resources', async () => {
    const { gate, hooks, request } = setup();
    hooks.approveNavigation.mockImplementation((url: string) => {
      if (!url.startsWith('https://authorized.test/')) throw new Error('Unapproved resource host');
    });
    await gate.assign(proxy, new AbortController().signal, true);
    expect(await request('https://ads.unapproved.test/tag.js', 'script')).toEqual({ cancel: true });
    expect(await request('wss://ads.unapproved.test/socket', 'webSocket')).toEqual({ cancel: true });
    expect(await request('wss://authorized.test/socket', 'webSocket')).toEqual({});
    expect(hooks.approveNavigation).toHaveBeenLastCalledWith('https://authorized.test/socket', false);
    await gate.block();
    await gate.assign(proxy, new AbortController().signal, false);
    expect(await request('https://ads.unapproved.test/tag.js', 'script')).toEqual({});
  });
  it('uses IPv6 brackets and supported SOCKS5 syntax', () => {
    expect(proxyRule({ ...proxy, ip: '2001:4860:4860::8888', protocol: 'socks5' })).toBe(
      'socks5://[2001:4860:4860::8888]:8080',
    );
  });
  it('checks the request budget for manual subresources and WebSockets before navigation approval', async () => {
    const { gate, hooks, request } = setup();
    const order: string[] = [];
    hooks.approveRequest.mockImplementation(() => {
      order.push('request');
    });
    hooks.approveNavigation.mockImplementation(() => {
      order.push('navigation');
    });
    await gate.assign(proxy, new AbortController().signal, false);
    expect(await request('https://authorized.test/')).toEqual({});
    expect(order).toEqual(['request', 'navigation']);
    expect(await request('https://assets.test/app.js', 'script')).toEqual({});
    expect(await request('wss://assets.test/socket', 'webSocket')).toEqual({});
    expect(hooks.approveRequest.mock.calls.map(([url]) => url)).toEqual([
      'https://authorized.test/',
      'https://assets.test/app.js',
      'https://assets.test/socket',
    ]);
    expect(hooks.approveNavigation).toHaveBeenCalledTimes(1);
  });
  it.each(['approveRequest', 'approveNavigation'] as const)(
    'preserves the exact policy error from %s and closes the entire gate',
    async (hook) => {
      const { gate, hooks, request } = setup();
      const error = new SiteRestrictionError(
        'Daily request limit reached for redirected.test',
        'https://redirected.test/page',
      );
      hooks[hook].mockImplementation(() => {
        throw error;
      });
      await gate.assign(proxy, new AbortController().signal, true);
      expect(await request('https://redirected.test/page')).toEqual({ cancel: true });
      expect(hooks.onPolicyRestricted).toHaveBeenCalledWith(error);
      expect(error.restrictedHost).toBe('redirected.test');
      expect(gate.isEnabled).toBe(false);
      expect(await request('https://authorized.test/another-resource', 'script')).toEqual({ cancel: true });
    },
  );
});
