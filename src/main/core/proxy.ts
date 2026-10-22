import { isIP } from 'node:net';
import { COUNTRIES, type CountryCode, type ProxyRecord } from '../../shared/types';

const countryNames: Record<CountryCode, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  FR: 'France',
  DE: 'Germany',
  JP: 'Japan',
  IT: 'Italy',
  AT: 'Austria',
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const allowedCountry = (value: unknown): value is CountryCode =>
  typeof value === 'string' && (COUNTRIES as readonly string[]).includes(value);
const canonicalIp = (ip: string): string =>
  isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.slice(1, -1) : ip;

/** Numeric public endpoints are a schema constraint, not a network health check. */
export function isPublicIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return (
      a !== 0 &&
      a !== 10 &&
      a !== 127 &&
      a! < 224 &&
      !(a === 169 && b === 254) &&
      !(a === 172 && b! >= 16 && b! <= 31) &&
      !(a === 192 && b === 168) &&
      !(a === 100 && b! >= 64 && b! <= 127) &&
      !(a === 198 && (b === 18 || b === 19)) &&
      !(a === 192 && b === 0) &&
      !(a === 198 && b === 51 && c === 100) &&
      !(a === 203 && b === 0 && c === 113)
    );
  }
  if (family === 6) {
    const address = canonicalIp(ip);
    // Exclude mapped IPv4 addresses and special-use ranges; use numeric IPv4 directly.
    return (
      /^[23]/.test(address) &&
      !address.startsWith('2001:db8:') &&
      !address.startsWith('2001:0:') &&
      !address.startsWith('2001::')
    );
  }
  return false;
}

export function proxyScrapeUrl(options: { limit?: number; skip?: number } = {}): string {
  const url = new URL('https://api.proxyscrape.com/v4/free-proxy-list/get');
  url.search = new URLSearchParams({
    request: 'get_proxies',
    proxy_format: 'protocolipport',
    format: 'json',
    protocol: 'http,socks5',
    country: COUNTRIES.join(','),
    limit: String(Math.min(2000, Math.max(1, options.limit ?? 2000))),
    skip: String(Math.max(0, options.skip ?? 0)),
  }).toString();
  return url.toString();
}

/** Accept the v4 envelope and the provider's flat JSON mirror, using reported country metadata. */
export function parseProxyScrape(data: unknown): {
  records: ProxyRecord[];
  retrieved: number;
  rejected: number;
  nextPage: boolean;
} {
  const envelope = object(data);
  const rows = Array.isArray(data) ? data : envelope.proxies;
  if (!Array.isArray(rows)) throw new Error('ProxyScrape returned an invalid JSON proxy list');
  if (rows.length > 60000) throw new Error('ProxyScrape response exceeds the supported size');
  const records: ProxyRecord[] = [];
  const endpoints = new Set<string>();
  for (const raw of rows) {
    const row = object(raw);
    const geo = object(row.ip_data);
    const ip = typeof row.ip === 'string' ? row.ip : '';
    const port = typeof row.port === 'string' && /^\d{1,5}$/.test(row.port) ? Number(row.port) : row.port;
    const protocol = row.protocol;
    const countryValue = typeof row.country_code === 'string' ? row.country_code : geo.countryCode;
    const country = typeof countryValue === 'string' ? countryValue.toUpperCase() : '';
    if (
      !isPublicIp(ip) ||
      !Number.isInteger(port) ||
      Number(port) < 1 ||
      Number(port) > 65535 ||
      !allowedCountry(country) ||
      !['http', 'socks5'].includes(String(protocol))
    )
      continue;
    const address = canonicalIp(ip);
    const endpoint = `${address}:${port}`;
    if (endpoints.has(endpoint)) continue;
    endpoints.add(endpoint);
    records.push({
      id: `${protocol}://${isIP(address) === 6 ? `[${address}]` : address}:${port}`,
      ip: address,
      port: Number(port),
      protocol: protocol as 'http' | 'socks5',
      country,
      countryName: countryNames[country],
      status: 'available',
      failures: 0,
      source: 'proxyscrape',
    });
  }
  return {
    records,
    retrieved: rows.length,
    rejected: rows.length - records.length,
    nextPage: envelope.nextpage === true,
  };
}

export interface ProxyPoolOptions {
  quarantineMs?: number;
  now?: () => number;
}
interface Quarantine {
  until: number;
  failures: number;
  error: string;
}
const clone = (record: ProxyRecord): ProxyRecord => ({ ...record });
const endpointKey = (record: ProxyRecord) => `${record.ip}:${record.port}`;
const validBrowserId = (id: number) => Number.isInteger(id) && id >= 1 && id <= 20;
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled');
}

function incomingRecord(input: unknown): ProxyRecord | undefined {
  const value = object(input);
  if (
    typeof value.ip !== 'string' ||
    !isIP(value.ip) ||
    typeof value.port !== 'number' ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535 ||
    !allowedCountry(value.country) ||
    !['http', 'https', 'socks5'].includes(String(value.protocol)) ||
    !['proxyscrape', 'fixture'].includes(String(value.source)) ||
    (value.source !== 'fixture' && !isPublicIp(value.ip))
  )
    return undefined;
  const ip = canonicalIp(value.ip);
  return {
    id: `${value.protocol}://${isIP(ip) === 6 ? `[${ip}]` : ip}:${value.port}`,
    ip,
    port: value.port,
    protocol: value.protocol as ProxyRecord['protocol'],
    country: value.country,
    countryName: countryNames[value.country],
    status: 'available',
    failures: 0,
    source: value.source as ProxyRecord['source'],
  };
}

/** Direct endpoint leases are reserved synchronously. This class performs no network operations. */
export class ProxyPool {
  private records = new Map<string, ProxyRecord>();
  private assignedIds = new Map<number, string>();
  private leasedEndpoints = new Map<string, number>();
  private pending = new Map<number, Promise<ProxyRecord | null>>();
  private generations = new Map<number, number>();
  private quarantined = new Map<string, Quarantine>();
  private readonly now: () => number;
  private readonly quarantineMs: number;

  constructor(options: ProxyPoolOptions = {}) {
    this.now = options.now ?? Date.now;
    this.quarantineMs = options.quarantineMs ?? 60000;
    if (!Number.isFinite(this.quarantineMs) || this.quarantineMs < 0 || this.quarantineMs > 3600000)
      throw new Error('Proxy cooldown must be between zero and one hour');
  }

  private expireCooldowns(): void {
    const now = this.now();
    for (const [endpoint, cooldown] of this.quarantined)
      if (cooldown.until <= now) this.quarantined.delete(endpoint);
    for (const record of this.records.values())
      if (record.status === 'failed' && !this.quarantined.has(endpointKey(record))) {
        record.status = 'available';
        record.error = undefined;
      }
  }

  merge(incoming: ProxyRecord[]): void {
    this.expireCooldowns();
    const next = new Map<string, ProxyRecord>();
    const endpoints = new Set<string>();
    // A refresh cannot revoke a live lease or change that browser's recorded endpoint/country.
    for (const id of this.assignedIds.values()) {
      const record = this.records.get(id);
      if (record) {
        next.set(id, record);
        endpoints.add(endpointKey(record));
      }
    }
    for (const input of incoming.slice(0, 60000)) {
      const candidate = incomingRecord(input);
      if (!candidate) continue;
      const endpoint = endpointKey(candidate);
      if (endpoints.has(endpoint)) continue;
      endpoints.add(endpoint);
      const old = this.records.get(candidate.id);
      const cooldown = this.quarantined.get(endpoint);
      next.set(candidate.id, {
        ...candidate,
        status: cooldown ? 'failed' : 'available',
        failures: Math.max(old?.failures ?? 0, cooldown?.failures ?? 0),
        error: cooldown?.error,
      });
    }
    this.records = next;
  }

  list(): ProxyRecord[] {
    this.expireCooldowns();
    return [...this.records.values()].map(clone);
  }

  assigned(browserId: number): ProxyRecord | undefined {
    const id = this.assignedIds.get(browserId);
    const record = id ? this.records.get(id) : undefined;
    return record ? clone(record) : undefined;
  }

  acquire(browserId: number, signal?: AbortSignal): Promise<ProxyRecord | null> {
    if (!validBrowserId(browserId)) return Promise.reject(new Error('Invalid browser ID'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Operation cancelled'));
    const underway = this.pending.get(browserId);
    if (underway) return underway;
    this.expireCooldowns();
    const assignedId = this.assignedIds.get(browserId);
    let record = assignedId ? this.records.get(assignedId) : undefined;
    if (!record)
      for (const candidate of this.records.values()) {
        if (candidate.status !== 'available' || this.leasedEndpoints.has(endpointKey(candidate))) continue;
        if (!record || candidate.failures < record.failures) record = candidate;
      }
    if (!record) return Promise.resolve(null);

    const selected = record;
    const generation = this.generations.get(browserId) ?? 0;
    selected.status = 'assigned';
    selected.assignedTo = browserId;
    selected.error = undefined;
    this.assignedIds.set(browserId, selected.id);
    this.leasedEndpoints.set(endpointKey(selected), browserId);
    const cancel = () => {
      if (
        (this.generations.get(browserId) ?? 0) === generation &&
        this.assignedIds.get(browserId) === selected.id
      )
        this.release(browserId);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    // Keep the Promise API while preventing a same-turn Stop from receiving a stale lease.
    const promise = Promise.resolve().then(() => {
      try {
        aborted(signal);
        if (
          (this.generations.get(browserId) ?? 0) !== generation ||
          this.assignedIds.get(browserId) !== selected.id
        )
          throw new Error('Proxy allocation was cancelled');
        return clone(selected);
      } finally {
        signal?.removeEventListener('abort', cancel);
        if (this.pending.get(browserId) === promise) this.pending.delete(browserId);
      }
    });
    this.pending.set(browserId, promise);
    return promise;
  }

  release(browserId: number, reason?: string): void {
    if (!validBrowserId(browserId)) return;
    this.generations.set(browserId, (this.generations.get(browserId) ?? 0) + 1);
    this.pending.delete(browserId);
    const id = this.assignedIds.get(browserId);
    const record = id ? this.records.get(id) : undefined;
    this.assignedIds.delete(browserId);
    if (!record) return;
    const endpoint = endpointKey(record);
    if (this.leasedEndpoints.get(endpoint) === browserId) this.leasedEndpoints.delete(endpoint);
    record.assignedTo = undefined;
    record.status = reason ? 'failed' : 'available';
    record.error = reason;
    if (reason) {
      record.failures += 1;
      this.quarantined.set(endpoint, {
        until: this.now() + this.quarantineMs,
        failures: record.failures,
        error: reason,
      });
    }
  }
}
