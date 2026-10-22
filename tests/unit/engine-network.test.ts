import { describe, expect, it, vi } from 'vitest';
import type { Session } from 'electron';
import { BLOCKED_PROXY, proxyRule, SessionGate } from '../../src/main/network/session-gate';
import type { ProxyRecord } from '../../src/shared/types';

const proxy: ProxyRecord = {
  id: 'test',
  ip: '203.0.113.7',
  port: 8080,
  protocol: 'http',
  country: 'US',
  countryName: 'United States',
  status: 'available',
  lastChecked: 1,
  latencyMs: 1,
  failures: 0,
  source: 'fixture',
};
type Request = (
  details: { url: string; resourceType: string },
  done: (response: { cancel?: boolean }) => void,
) => void;
type Headers = (
  details: { resourceType: string; statusCode: number; url: string },
  done: (response: object) => void,
) => void;

function setup() {
  let request: Request = () => undefined;
  let headers: Headers | null = null;
  const fake = {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setSpellCheckerEnabled: vi.fn(),
    setProxy: vi.fn(
      async (_config: { mode: string; proxyRules: string; proxyBypassRules: string }) => undefined,
    ),
    closeAllConnections: vi.fn(async () => undefined),
    resolveProxy: vi.fn(async () => 'PROXY 203.0.113.7:8080'),
    webRequest: {
      onBeforeRequest: vi.fn((_filter: object, handler: Request) => {
        request = handler;
      }),
      onBeforeSendHeaders: vi.fn(),
      onHeadersReceived: vi.fn((handler: Headers | null) => {
        headers = handler;
      }),
      onErrorOccurred: vi.fn(),
    },
  };
  const hooks = { approveNavigation: vi.fn(), onFailure: vi.fn(), onRestricted: vi.fn() };
  const gate = new SessionGate(fake as unknown as Session, hooks);
  return {
    fake,
    hooks,
    gate,
    request: (url: string, resourceType = 'mainFrame') =>
      new Promise<{ cancel?: boolean }>((resolve) => request({ url, resourceType }, resolve)),
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
    expect(await request('https://authorized.test/')).toEqual({});
    await gate.block();
    expect(fake.setProxy).toHaveBeenLastCalledWith({
      mode: 'fixed_servers',
      proxyRules: BLOCKED_PROXY,
      proxyBypassRules: '<-loopback>',
    });
    expect(await request('https://authorized.test/')).toEqual({ cancel: true });
    expect(fake.closeAllConnections).toHaveBeenCalledTimes(2);
  });
  it('rejects an unsafe Chromium direct proxy resolution', async () => {
    const { gate, fake } = setup();
    fake.resolveProxy.mockResolvedValue('DIRECT');
    await expect(gate.assign(proxy, new AbortController().signal, false)).rejects.toThrow('Unsafe proxy');
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
});
