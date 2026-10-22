import { describe, expect, it } from 'vitest';
import {
  isPublicIp,
  parseProxyScrape,
  ProxyPool,
  proxyScrapeUrl,
  type ProxyValidation,
} from '../../src/main/core/proxy';
import type { ProxyRecord } from '../../src/shared/types';

function record(index = 1): ProxyRecord {
  return {
    id: `http://8.8.8.${index}:8080`,
    ip: `8.8.8.${index}`,
    port: 8080,
    protocol: 'http',
    country: 'US',
    countryName: 'United States',
    status: 'unverified',
    lastChecked: null,
    latencyMs: null,
    failures: 0,
    source: 'proxyscrape',
  };
}
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { resolve, reject, promise };
};
const valid = (proxy: ProxyRecord): ProxyValidation => ({
  country: proxy.country,
  exitIp: proxy.ip,
  latencyMs: 12,
});

describe('ProxyScrape contract and filtering', () => {
  it('uses the provider updater JSON contract and the seven ISO countries', () => {
    const url = new URL(proxyScrapeUrl());
    expect(url.origin + url.pathname).toBe('https://api.proxyscrape.com/v4/free-proxy-list/get');
    expect(url.searchParams.get('request')).toBe('get_proxies');
    expect(url.searchParams.get('country')).toBe('US,GB,CA,FR,DE,JP,IT');
    expect(url.searchParams.get('protocol')).toBe('http,socks5');
    expect(url.searchParams.get('format')).toBe('json');
  });
  it('parses actual live v4 metadata and never considers it locally validated', () => {
    const result = parseProxyScrape({
      proxies: [
        { ip: '8.8.8.8', port: 80, protocol: 'http', ssl: true, alive: true, ip_data: { countryCode: 'US' } },
      ],
      nextpage: true,
    });
    expect(result.records[0]).toMatchObject({
      protocol: 'http',
      country: 'US',
      status: 'unverified',
      lastChecked: null,
    });
    expect(result.nextPage).toBe(true);
  });
  it('handles the official flat mirror and lowercase ISO codes', () => {
    expect(
      parseProxyScrape([{ ip: '8.8.4.4', port: '1080', protocol: 'socks5', country_code: 'gb' }]).records[0]
        ?.country,
    ).toBe('GB');
  });
  it('rejects wrong countries, UK, absent geography, SOCKS4, dead endpoints and malformed ports', () => {
    const base = { ip: '8.8.8.8', port: 8080, protocol: 'http', country_code: 'US' };
    const rows = [
      { ...base, country_code: 'CN' },
      { ...base, country_code: 'UK' },
      { ...base, country_code: undefined },
      { ...base, protocol: 'socks4' },
      { ...base, alive: false },
      { ...base, port: 65536 },
      { ...base, port: 1.5 },
      { ...base, port: '80x' },
    ];
    expect(parseProxyScrape(rows)).toMatchObject({ records: [], retrieved: 8, rejected: 8 });
  });
  it('deduplicates endpoints even when a second protocol is advertised', () => {
    const base = { ip: '8.8.8.8', port: 8080, country_code: 'US' };
    expect(
      parseProxyScrape([
        { ...base, protocol: 'http' },
        { ...base, protocol: 'socks5' },
      ]).records,
    ).toHaveLength(1);
  });
  it.each([
    '127.0.0.1',
    '10.1.1.1',
    '172.20.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.1.1',
    '224.1.1.1',
    '::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    'bad.example',
  ])('rejects nonpublic proxy %s', (ip) => expect(isPublicIp(ip)).toBe(false));
  it.each([null, '1.2.3.4:80', { proxies: {} }, { error: 'rate limited' }])(
    'rejects malformed provider bodies',
    (value) => expect(() => parseProxyScrape(value)).toThrow(),
  );
});

describe('atomic proxy leases', () => {
  it('reserves synchronously across concurrent requests', async () => {
    const gate = deferred<ProxyValidation>();
    const pool = new ProxyPool(() => gate.promise);
    pool.merge([record()]);
    const first = pool.acquire(1);
    const second = pool.acquire(2);
    expect(await second).toBeNull();
    gate.resolve(valid(record()));
    expect((await first)?.assignedTo).toBe(1);
  });
  it('deduplicates simultaneous acquisition for the same browser', async () => {
    const gate = deferred<ProxyValidation>();
    const pool = new ProxyPool(() => gate.promise);
    pool.merge([record()]);
    const one = pool.acquire(1);
    const again = pool.acquire(1);
    expect(one).toBe(again);
    gate.resolve(valid(record()));
    await one;
    expect(pool.assigned(1)?.id).toBe(record().id);
  });
  it('rejects duplicate exit IPs even when endpoints differ', async () => {
    const pool = new ProxyPool(async () => ({ exitIp: '9.9.9.9', country: 'US', latencyMs: 5 }));
    pool.merge([record(1), record(2)]);
    const results = await Promise.all([pool.acquire(1), pool.acquire(2)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(pool.list().filter((item) => item.status === 'assigned')).toHaveLength(1);
  });
  it('rejects an observed wrong-country exit', async () => {
    const pool = new ProxyPool(async () => ({ exitIp: '9.9.9.9', country: 'DE', latencyMs: 5 }));
    pool.merge([record()]);
    expect(await pool.acquire(1)).toBeNull();
    expect(pool.list()[0]?.error).toMatch(/country/);
  });
  it('rejects invalid validation output', async () => {
    const pool = new ProxyPool(async () => ({ exitIp: '127.0.0.1', country: 'US', latencyMs: 1 }));
    pool.merge([record()]);
    expect(await pool.acquire(1)).toBeNull();
    expect(pool.list()[0]?.status).toBe('failed');
  });
  it('prevents an allocation from resurrecting after browser closure', async () => {
    const gate = deferred<ProxyValidation>();
    const pool = new ProxyPool(() => gate.promise);
    pool.merge([record()]);
    const result = pool.acquire(1);
    const rejection = expect(result).rejects.toThrow(/released|cancelled/);
    pool.release(1);
    gate.resolve(valid(record()));
    await rejection;
    expect(pool.assigned(1)).toBeUndefined();
    expect(pool.list()[0]?.status).toBe('unverified');
  });
  it('honors cancellation even when a validator ignores the signal', async () => {
    const gate = deferred<ProxyValidation>();
    const pool = new ProxyPool(() => gate.promise);
    pool.merge([record()]);
    const controller = new AbortController();
    const result = pool.acquire(1, controller.signal);
    const rejection = expect(result).rejects.toThrow();
    controller.abort();
    gate.resolve(valid(record()));
    await rejection;
    expect(pool.assigned(1)).toBeUndefined();
  });
  it('preserves active leases during provider refresh', async () => {
    const pool = new ProxyPool(async (proxy) => valid(proxy));
    pool.merge([record(1)]);
    await pool.acquire(1);
    pool.merge([record(2)]);
    expect(pool.assigned(1)?.id).toBe(record(1).id);
    expect(pool.list()).toHaveLength(2);
  });
  it('quarantines failures and allows a bounded later retry', async () => {
    let now = 1000;
    let calls = 0;
    const pool = new ProxyPool(
      async (proxy) => {
        calls++;
        if (calls === 1) throw new Error('TLS rejected');
        return valid(proxy);
      },
      { now: () => now, quarantineMs: 100 },
    );
    pool.merge([record()]);
    expect(await pool.acquire(1)).toBeNull();
    expect(await pool.acquire(1)).toBeNull();
    expect(calls).toBe(1);
    now += 101;
    expect(await pool.acquire(1)).not.toBeNull();
    expect(calls).toBe(2);
  });
  it('bounds candidate validation attempts', async () => {
    let calls = 0;
    const pool = new ProxyPool(
      async () => {
        calls++;
        throw new Error('Unavailable');
      },
      { maxAttempts: 2 },
    );
    pool.merge([record(1), record(2), record(3)]);
    expect(await pool.acquire(1)).toBeNull();
    expect(calls).toBe(2);
  });
  it('releases and quarantines a transport failure without allocating elsewhere automatically', async () => {
    const pool = new ProxyPool(async (proxy) => valid(proxy));
    pool.merge([record()]);
    await pool.acquire(1);
    pool.release(1, 'ERR_PROXY_CONNECTION_FAILED');
    expect(pool.assigned(1)).toBeUndefined();
    expect(pool.list()[0]).toMatchObject({ status: 'failed', failures: 1 });
  });
  it('returns copies so UI consumers cannot change leases', async () => {
    const pool = new ProxyPool(async (proxy) => valid(proxy));
    pool.merge([record()]);
    const assigned = await pool.acquire(1);
    assigned!.assignedTo = 20;
    expect(pool.assigned(1)?.assignedTo).toBe(1);
    pool.list()[0]!.status = 'available';
    expect(pool.assigned(1)?.status).toBe('assigned');
  });
  it('validates reserves without sharing or releasing actual browser slots', async () => {
    const gate = deferred<ProxyValidation>();
    const pool = new ProxyPool(async (proxy) => (proxy.id === record(1).id ? gate.promise : valid(proxy)));
    pool.merge([record(1), record(2)]);
    const warm = pool.validateAvailable(1);
    const browser = await pool.acquire(1);
    expect(browser?.id).toBe(record(2).id);
    gate.resolve(valid(record(1)));
    await warm;
    expect(pool.assigned(1)?.id).toBe(record(2).id);
    expect(pool.list().find((proxy) => proxy.id === record(1).id)?.status).toBe('available');
  });
});
