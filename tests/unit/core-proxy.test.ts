import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPublicIp, parseProxyScrape, ProxyPool, proxyScrapeUrl } from '../../src/main/core/proxy';
import { COUNTRIES, type ProxyRecord } from '../../src/shared/types';

function record(index = 1): ProxyRecord {
  return {
    id: `http://8.8.8.${index}:8080`,
    ip: `8.8.8.${index}`,
    port: 8080,
    protocol: 'http',
    country: 'US',
    countryName: 'United States',
    status: 'available',
    failures: 0,
    source: 'proxyscrape',
  };
}
afterEach(() => vi.unstubAllGlobals());

describe('ProxyScrape country metadata and endpoint parsing', () => {
  it('requests the JSON contract and all eight ISO countries, including Austria', () => {
    const url = new URL(proxyScrapeUrl());
    expect(url.origin + url.pathname).toBe('https://api.proxyscrape.com/v4/free-proxy-list/get');
    expect(url.searchParams.get('request')).toBe('get_proxies');
    expect(url.searchParams.get('country')).toBe('US,GB,CA,FR,DE,JP,IT,AT');
    expect(url.searchParams.get('protocol')).toBe('http,socks5');
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.has('timeout')).toBe(false);
  });

  it('marks eligible API records available without copying provider health or observed-exit fields', () => {
    const result = parseProxyScrape({
      proxies: [
        {
          ip: '8.8.8.8',
          port: 80,
          protocol: 'http',
          alive: false,
          ssl: false,
          ip_data: { countryCode: 'AT' },
          exitIp: '9.9.9.9',
          latencyMs: 5,
          lastChecked: 42,
        },
      ],
      nextpage: true,
    });
    expect(result.records).toEqual([
      {
        id: 'http://8.8.8.8:80',
        ip: '8.8.8.8',
        port: 80,
        protocol: 'http',
        country: 'AT',
        countryName: 'Austria',
        status: 'available',
        failures: 0,
        source: 'proxyscrape',
      },
    ]);
    expect(result.nextPage).toBe(true);
  });

  it.each(COUNTRIES)('accepts API-reported %s in either documented country shape', (country) => {
    const result = parseProxyScrape([
      { ip: '8.8.8.8', port: '1080', protocol: 'socks5', country_code: country.toLowerCase() },
      { ip: '8.8.4.4', port: 8080, protocol: 'http', ip_data: { countryCode: country } },
    ]);
    expect(result.records.map((proxy) => proxy.country)).toEqual([country, country]);
  });

  it('rejects wrong countries, UK, absent geography, SOCKS4 and malformed ports', () => {
    const base = { ip: '8.8.8.8', port: 8080, protocol: 'http', country_code: 'US' };
    const rows = [
      { ...base, country_code: 'AU' },
      { ...base, country_code: 'UK' },
      { ...base, country_code: undefined },
      { ...base, protocol: 'socks4' },
      { ...base, port: 65536 },
      { ...base, port: 1.5 },
      { ...base, port: '80x' },
    ];
    expect(parseProxyScrape(rows)).toMatchObject({ records: [], retrieved: 7, rejected: 7 });
  });

  it('deduplicates numeric endpoints across protocol and equivalent IPv6 spelling', () => {
    const base = { port: 8080, country_code: 'US' };
    const result = parseProxyScrape([
      { ...base, ip: '8.8.8.8', protocol: 'http' },
      { ...base, ip: '8.8.8.8', protocol: 'socks5' },
      { ...base, ip: '2606:4700:4700::1111', protocol: 'socks5' },
      { ...base, ip: '2606:4700:4700:0000:0000:0000:0000:1111', protocol: 'http' },
    ]);
    expect(result.records).toHaveLength(2);
    expect(result.records[1]?.id).toBe('socks5://[2606:4700:4700::1111]:8080');
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
    '2001:0DB8::1',
    '2001:0000::1',
    'bad.example',
  ])('rejects nonpublic proxy %s', (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each([null, '1.2.3.4:80', { proxies: {} }, { error: 'rate limited' }])(
    'rejects malformed provider bodies',
    (value) => expect(() => parseProxyScrape(value)).toThrow(),
  );
});

describe('direct atomic endpoint leases', () => {
  it('reserves synchronously before promise delivery without making a network request', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Allocation must not contact a diagnostic service');
    });
    vi.stubGlobal('fetch', fetch);
    const pool = new ProxyPool();
    pool.merge([record()]);
    const first = pool.acquire(1);
    expect(pool.assigned(1)).toMatchObject({ status: 'assigned', assignedTo: 1 });
    const second = pool.acquire(2);
    expect(await second).toBeNull();
    expect(await first).toMatchObject({ country: 'US', assignedTo: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('atomically serves twenty profiles even when each issues five concurrent requests', async () => {
    const pool = new ProxyPool();
    pool.merge(Array.from({ length: 20 }, (_, index) => record(index + 1)));
    const requests = Array.from({ length: 100 }, (_, index) => pool.acquire((index % 20) + 1));
    expect(pool.list().filter((proxy) => proxy.status === 'assigned')).toHaveLength(20);
    const results = await Promise.all(requests);
    expect(new Set(results.map((proxy) => proxy?.id)).size).toBe(20);
    for (let id = 1; id <= 20; id++) expect(pool.assigned(id)?.assignedTo).toBe(id);
  });

  it('coalesces same-browser acquisition and keeps its lease on a later acquisition', async () => {
    const pool = new ProxyPool();
    pool.merge([record(), record(2)]);
    const first = pool.acquire(1);
    expect(pool.acquire(1)).toBe(first);
    const assigned = await first;
    expect(await pool.acquire(1)).toEqual(assigned);
    expect(pool.list().filter((proxy) => proxy.status === 'assigned')).toHaveLength(1);
  });

  it('allows different ports on the same IP without an observed-exit uniqueness check', async () => {
    const pool = new ProxyPool();
    pool.merge([record(), { ...record(), port: 8081 }]);
    const leases = await Promise.all([pool.acquire(1), pool.acquire(2)]);
    expect(leases.map((lease) => lease?.port)).toEqual([8080, 8081]);
    expect(leases.every((lease) => lease && !('exitIp' in lease))).toBe(true);
  });

  it('does not trust duplicate record IDs, protocol aliases, assignment flags, or stale health metadata', async () => {
    const pool = new ProxyPool();
    const untrusted = {
      ...record(),
      id: 'forged',
      status: 'assigned',
      assignedTo: 19,
      failures: 999,
      countryName: 'Forged label',
      exitIp: '9.9.9.9',
      lastChecked: 100,
      latencyMs: 1,
    };
    pool.merge([untrusted as ProxyRecord, { ...record(), protocol: 'socks5', id: 'second' }]);
    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0]).toMatchObject({
      id: record().id,
      status: 'available',
      failures: 0,
      countryName: 'United States',
    });
    expect(pool.list()[0]).not.toHaveProperty('assignedTo');
    for (const key of ['exitIp', 'lastChecked', 'latencyMs']) expect(pool.list()[0]).not.toHaveProperty(key);
    expect(await pool.acquire(1)).not.toBeNull();
    expect(await pool.acquire(2)).toBeNull();
  });

  it('rejects malformed and nonpublic production records while permitting explicit loopback fixtures', () => {
    const pool = new ProxyPool();
    pool.merge([
      null,
      {},
      { ...record(), ip: '127.0.0.1' },
      { ...record(), port: -1 },
      { ...record(), country: 'AU' },
      { ...record(), protocol: 'socks4' },
      { ...record(), source: 'other' },
    ] as unknown as ProxyRecord[]);
    expect(pool.list()).toEqual([]);
    pool.merge([{ ...record(), ip: '127.0.0.1', source: 'fixture', country: 'AT' }]);
    expect(pool.list()[0]).toMatchObject({
      id: 'http://127.0.0.1:8080',
      country: 'AT',
      countryName: 'Austria',
    });
  });

  it.each([0, 21, -1, 1.5, Number.NaN])('rejects browser ID %s without reserving an endpoint', async (id) => {
    const pool = new ProxyPool();
    pool.merge([record()]);
    await expect(pool.acquire(id)).rejects.toThrow('Invalid browser ID');
    expect(pool.list()[0]?.status).toBe('available');
  });

  it('rejects an already-aborted request without taking a lease', async () => {
    const pool = new ProxyPool();
    pool.merge([record()]);
    const abort = new AbortController();
    abort.abort(new Error('Stopped'));
    await expect(pool.acquire(1, abort.signal)).rejects.toThrow('Stopped');
    expect(pool.assigned(1)).toBeUndefined();
  });

  it('releases a same-turn cancelled acquisition without quarantining the endpoint', async () => {
    const pool = new ProxyPool();
    pool.merge([record()]);
    const abort = new AbortController();
    const result = pool.acquire(1, abort.signal);
    const rejection = expect(result).rejects.toThrow('Stopped');
    abort.abort(new Error('Stopped'));
    expect(pool.assigned(1)).toBeUndefined();
    expect(pool.list()[0]).toMatchObject({ status: 'available', failures: 0 });
    await rejection;
    expect(await pool.acquire(2)).toMatchObject({ assignedTo: 2 });
  });

  it('prevents a released allocation from being delivered after Stop', async () => {
    const pool = new ProxyPool();
    pool.merge([record()]);
    const result = pool.acquire(1);
    const rejection = expect(result).rejects.toThrow('cancelled');
    pool.release(1);
    await rejection;
    expect(pool.assigned(1)).toBeUndefined();
    expect(pool.list()[0]?.status).toBe('available');
  });

  it('does not let an old cancellation or promise cleanup release a replacement lease', async () => {
    const pool = new ProxyPool();
    pool.merge([record()]);
    const old = new AbortController();
    const first = pool.acquire(1, old.signal);
    const rejection = expect(first).rejects.toThrow();
    pool.release(1);
    const replacement = pool.acquire(1);
    old.abort();
    await rejection;
    expect(await replacement).toMatchObject({ assignedTo: 1 });
    expect(pool.assigned(1)?.assignedTo).toBe(1);
  });

  it('leaves a delivered lease owned until explicit release closes its network operation', async () => {
    const pool = new ProxyPool();
    pool.merge([record()]);
    const abort = new AbortController();
    await pool.acquire(1, abort.signal);
    abort.abort();
    expect(pool.assigned(1)?.assignedTo).toBe(1);
    expect(await pool.acquire(2)).toBeNull();
    pool.release(1);
    expect(await pool.acquire(2)).not.toBeNull();
  });

  it('preserves pending and active leases and their metadata during provider refresh', async () => {
    const pool = new ProxyPool();
    pool.merge([record()]);
    const result = pool.acquire(1);
    pool.merge([{ ...record(), country: 'AT', protocol: 'socks5' }, record(2)]);
    expect(await result).toMatchObject({ id: record().id, country: 'US', assignedTo: 1 });
    expect(pool.list()).toHaveLength(2);
    expect(await pool.acquire(2)).toMatchObject({ id: record(2).id });
    pool.merge([]);
    expect(pool.list()).toHaveLength(2);
  });

  it('quarantines only an actual reported transport failure and becomes eligible after cooldown', async () => {
    let now = 1000;
    const pool = new ProxyPool({ now: () => now, quarantineMs: 100 });
    pool.merge([record()]);
    await pool.acquire(1);
    pool.release(1, 'ERR_PROXY_CONNECTION_FAILED');
    pool.release(1, 'Duplicate cleanup must not count twice');
    expect(pool.list()[0]).toMatchObject({ status: 'failed', failures: 1 });
    expect(await pool.acquire(2)).toBeNull();
    now += 99;
    expect(await pool.acquire(2)).toBeNull();
    now += 1;
    expect(pool.list()[0]?.status).toBe('available');
    expect(await pool.acquire(2)).toMatchObject({ status: 'assigned', failures: 1, error: undefined });
  });

  it('keeps endpoint cooldown across omission, reappearance, protocol and ID changes in refreshes', async () => {
    let now = 1000;
    const pool = new ProxyPool({ now: () => now, quarantineMs: 100 });
    pool.merge([record()]);
    await pool.acquire(1);
    pool.release(1, 'Connection refused');
    pool.merge([]);
    pool.merge([{ ...record(), protocol: 'socks5', id: 'changed', country: 'AT' }]);
    expect(pool.list()[0]).toMatchObject({ status: 'failed', country: 'AT', failures: 1 });
    expect(await pool.acquire(2)).toBeNull();
    now += 100;
    expect(await pool.acquire(2)).toMatchObject({ protocol: 'socks5', country: 'AT' });
  });

  it('returns copies so callers cannot change provider records or active leases', async () => {
    const pool = new ProxyPool();
    const source = record();
    pool.merge([source]);
    source.ip = '9.9.9.9';
    const assigned = await pool.acquire(1);
    assigned!.assignedTo = 20;
    pool.list()[0]!.status = 'available';
    expect(pool.assigned(1)).toMatchObject({ ip: '8.8.8.1', assignedTo: 1, status: 'assigned' });
  });
});
