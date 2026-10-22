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
};
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const allowedCountry = (value: unknown): value is CountryCode =>
  typeof value === 'string' && (COUNTRIES as readonly string[]).includes(value);

/** Only numeric IP endpoints are accepted: proxy hostname resolution cannot leak DNS. */
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
    const address = ip.toLowerCase();
    // Exclude mapped IPv4 addresses: a plain numeric IPv4 endpoint is unambiguous.
    return /^[23]/.test(address) && !address.startsWith('2001:db8:') && !address.startsWith('2001:0:');
  }
  return false;
}

export function proxyScrapeUrl(options: { timeoutMs?: number; limit?: number; skip?: number } = {}): string {
  const url = new URL('https://api.proxyscrape.com/v4/free-proxy-list/get');
  url.search = new URLSearchParams({
    request: 'get_proxies',
    proxy_format: 'protocolipport',
    format: 'json',
    protocol: 'http,socks5',
    country: COUNTRIES.join(','),
    timeout: String(Math.min(60000, Math.max(1000, options.timeoutMs ?? 10000))),
    limit: String(Math.min(2000, Math.max(1, options.limit ?? 2000))),
    skip: String(Math.max(0, options.skip ?? 0)),
  }).toString();
  return url.toString();
}

/** Accept the live v4 envelope and the provider's documented flat JSON mirror. */
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
      !['http', 'socks5'].includes(String(protocol)) ||
      row.alive === false
    )
      continue;
    const endpoint = `${ip}:${port}`;
    if (endpoints.has(endpoint)) continue;
    endpoints.add(endpoint);
    records.push({
      id: `${protocol}://${isIP(ip) === 6 ? `[${ip}]` : ip}:${port}`,
      ip,
      port: Number(port),
      protocol: protocol as 'http' | 'socks5',
      country,
      countryName: countryNames[country],
      status: 'unverified',
      lastChecked: null,
      latencyMs: null,
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

export interface ProxyValidation {
  exitIp: string;
  country: CountryCode;
  latencyMs: number;
}
export type ProxyValidator = (record: ProxyRecord, signal?: AbortSignal) => Promise<ProxyValidation>;
export interface ProxyPoolOptions {
  uniqueExitIps?: boolean;
  validationTtlMs?: number;
  quarantineMs?: number;
  maxAttempts?: number;
  now?: () => number;
}
interface Reservation {
  endpoint: string;
  controller: AbortController;
  generation: number;
}
const clone = (record: ProxyRecord): ProxyRecord => ({ ...record });
const endpointKey = (record: ProxyRecord) => `${record.ip.toLowerCase()}:${record.port}`;
function aborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason instanceof Error ? signal.reason : new Error('Operation cancelled');
}

/** Reservations happen synchronously before any await, making allocation atomic in the main process. */
export class ProxyPool {
  private records = new Map<string, ProxyRecord>();
  private reservations = new Map<number, Reservation>();
  private assignedIds = new Map<number, string>();
  private pending = new Map<number, Promise<ProxyRecord | null>>();
  private generations = new Map<number, number>();
  private quarantinedUntil = new Map<string, number>();
  private warming?: Promise<ProxyRecord[]>;
  private nextInternalId = -1;
  private readonly now: () => number;
  constructor(
    private readonly validator: ProxyValidator,
    private readonly options: ProxyPoolOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  merge(incoming: ProxyRecord[]): void {
    const next = new Map<string, ProxyRecord>();
    // Active leases cannot be replaced by a provider refresh, including while validating.
    const leased = new Set(this.assignedIds.values());
    for (const [id, record] of this.records)
      if (leased.has(id) || record.assignedTo !== undefined || record.status === 'validating')
        next.set(id, record);
    for (const candidate of incoming.slice(0, 60000)) {
      if (
        !allowedCountry(candidate.country) ||
        !isIP(candidate.ip) ||
        !Number.isInteger(candidate.port) ||
        candidate.port < 1 ||
        candidate.port > 65535 ||
        !['http', 'https', 'socks5'].includes(candidate.protocol) ||
        (candidate.source !== 'fixture' && !isPublicIp(candidate.ip))
      )
        continue;
      const old = this.records.get(candidate.id);
      next.set(
        candidate.id,
        old ?? {
          ...candidate,
          status: 'unverified',
          assignedTo: undefined,
          exitIp: undefined,
          lastChecked: null,
          latencyMs: null,
        },
      );
    }
    this.records = next;
    for (const key of this.quarantinedUntil.keys())
      if (!this.records.has(key)) this.quarantinedUntil.delete(key);
  }

  list(): ProxyRecord[] {
    return [...this.records.values()].map(clone);
  }
  assigned(browserId: number): ProxyRecord | undefined {
    const id = this.assignedIds.get(browserId);
    const record = id ? this.records.get(id) : undefined;
    return record ? clone(record) : undefined;
  }

  acquire(browserId: number, signal?: AbortSignal): Promise<ProxyRecord | null> {
    if (!Number.isInteger(browserId) || browserId < 1 || browserId > 20)
      return Promise.reject(new Error('Invalid browser ID'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Operation cancelled'));
    const active = this.assigned(browserId);
    if (active) return Promise.resolve(active);
    const underway = this.pending.get(browserId);
    if (underway) return underway;
    const generation = this.generations.get(browserId) ?? 0;
    const promise = this.acquireNext(browserId, generation, signal).finally(() => {
      if (this.pending.get(browserId) === promise) this.pending.delete(browserId);
    });
    this.pending.set(browserId, promise);
    return promise;
  }

  /** Reserve validation slots independently of real browser IDs; keep batch leases until all finish. */
  validateAvailable(limit = 4, signal?: AbortSignal): Promise<ProxyRecord[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      return Promise.reject(new Error('Reserve validation supports 1–20 slots'));
    if (this.warming) return this.warming;
    const internalIds = Array.from({ length: limit }, () => this.nextInternalId--);
    const operation = Promise.all(internalIds.map((id) => this.acquireNext(id, 0, signal)))
      .then((results) => results.filter((result): result is ProxyRecord => result !== null))
      .finally(() => {
        for (const id of internalIds) {
          this.release(id);
          this.generations.delete(id);
        }
        if (this.warming === operation) this.warming = undefined;
      });
    this.warming = operation;
    return operation;
  }

  private async acquireNext(
    browserId: number,
    generation: number,
    signal?: AbortSignal,
  ): Promise<ProxyRecord | null> {
    const candidates = [...this.records.values()].sort(
      (a, b) => a.failures - b.failures || (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity),
    );
    let attempts = 0;
    for (const record of candidates) {
      aborted(signal);
      if ((this.generations.get(browserId) ?? 0) !== generation)
        throw new Error('Proxy allocation was cancelled');
      if (
        record.assignedTo !== undefined ||
        record.status === 'validating' ||
        (this.quarantinedUntil.get(record.id) ?? 0) > this.now()
      )
        continue;
      const endpoint = endpointKey(record);
      if (
        [...this.reservations.values()].some((r) => r.endpoint === endpoint) ||
        [...this.assignedIds.values()].some((id) => {
          const item = this.records.get(id);
          return item && endpointKey(item) === endpoint;
        })
      )
        continue;
      if (attempts++ >= (this.options.maxAttempts ?? 12)) break;
      const controller = new AbortController();
      const cancel = () => controller.abort(signal?.reason ?? new Error('Operation cancelled'));
      signal?.addEventListener('abort', cancel, { once: true });
      this.reservations.set(browserId, { endpoint, controller, generation });
      record.status = 'validating';
      try {
        const cached =
          (this.options.validationTtlMs ?? 0) > 0 &&
          record.lastChecked !== null &&
          this.now() - record.lastChecked <= (this.options.validationTtlMs ?? 0) &&
          record.exitIp;
        const validation = cached
          ? { exitIp: record.exitIp!, country: record.country, latencyMs: record.latencyMs! }
          : await this.validator(clone(record), controller.signal);
        aborted(controller.signal);
        if ((this.generations.get(browserId) ?? 0) !== generation)
          throw new Error('Proxy allocation was cancelled');
        if (!allowedCountry(validation.country) || validation.country !== record.country)
          throw new Error('Verified exit country differs from the eligible provider country');
        if (!isIP(validation.exitIp) || (record.source !== 'fixture' && !isPublicIp(validation.exitIp)))
          throw new Error('Diagnostic endpoint returned an invalid public exit IP');
        if (!Number.isFinite(validation.latencyMs) || validation.latencyMs < 0)
          throw new Error('Proxy validation returned an invalid latency');
        if (
          (this.options.uniqueExitIps ?? true) &&
          [...this.assignedIds.values()].some((id) => this.records.get(id)?.exitIp === validation.exitIp)
        )
          throw new Error('Exit IP already belongs to another active browser');
        Object.assign(record, {
          status: browserId > 0 ? 'assigned' : 'available',
          assignedTo: browserId > 0 ? browserId : undefined,
          exitIp: validation.exitIp,
          lastChecked: this.now(),
          latencyMs: validation.latencyMs,
          error: undefined,
        });
        this.assignedIds.set(browserId, record.id);
        return clone(record);
      } catch (error) {
        const cancelled = controller.signal.aborted || (this.generations.get(browserId) ?? 0) !== generation;
        if (record.status === 'validating') record.status = cancelled ? 'unverified' : 'failed';
        if (!cancelled) {
          record.failures += 1;
          record.error = error instanceof Error ? error.message : String(error);
          this.quarantinedUntil.set(record.id, this.now() + (this.options.quarantineMs ?? 60000));
        } else throw error;
      } finally {
        signal?.removeEventListener('abort', cancel);
        if (this.reservations.get(browserId)?.controller === controller) this.reservations.delete(browserId);
      }
    }
    return null;
  }

  release(browserId: number, reason?: string): void {
    this.generations.set(browserId, (this.generations.get(browserId) ?? 0) + 1);
    this.reservations.get(browserId)?.controller.abort(new Error('Proxy lease released'));
    this.reservations.delete(browserId);
    this.pending.delete(browserId);
    const id = this.assignedIds.get(browserId);
    const record = id ? this.records.get(id) : undefined;
    this.assignedIds.delete(browserId);
    if (!record) return;
    record.assignedTo = undefined;
    record.status = reason ? 'failed' : 'available';
    if (reason) {
      record.failures += 1;
      record.error = reason;
      this.quarantinedUntil.set(record.id, this.now() + (this.options.quarantineMs ?? 60000));
    }
  }
}
