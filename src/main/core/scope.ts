import { isIP } from 'node:net';
import type { AppSettings } from '../../shared/types';
import { isPublicIp } from './proxy';

export const hasControlCharacters = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

export function isLoopback(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
}

export function normalizeUrl(input: string, options: { allowLocalhost?: boolean } = {}): string {
  if (typeof input !== 'string' || input.length > 8192 || hasControlCharacters(input))
    throw new Error('Enter a valid URL without control characters');
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Enter a complete HTTPS URL');
  }
  if (url.username || url.password) throw new Error('URLs containing credentials are not permitted');
  const local = isLoopback(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && options.allowLocalhost))
    throw new Error('Only HTTPS URLs are allowed; HTTP is limited to enabled localhost fixtures');
  if (local && !options.allowLocalhost) throw new Error('Localhost fixtures are disabled');
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(bare) && !local && !isPublicIp(bare))
    throw new Error('Private network destinations are not supported');
  url.hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  if (url.href.length > 8192) throw new Error('The normalized URL exceeds the 8,192-character limit');
  return url.href;
}

/** Exact hosts by default; '*.example.com' explicitly authorizes subdomains only. */
export function normalizeDomain(input: string): string {
  if (
    typeof input !== 'string' ||
    input.length > 253 ||
    /[\s/@?#\\]/.test(input) ||
    hasControlCharacters(input)
  )
    throw new Error('Authorized scope must contain a hostname, not a URL or path');
  const wildcard = input.startsWith('*.');
  const domain = wildcard ? input.slice(2) : input;
  if (!domain || domain.includes('*')) throw new Error('Wildcard scope must be written as *.example.com');
  if (domain.includes(':') && !(domain.startsWith('[') && domain.endsWith(']')))
    throw new Error('Authorized scope accepts hostnames without ports');
  let parsed: URL;
  try {
    parsed = new URL(`https://${domain}`);
  } catch {
    throw new Error('Invalid authorized hostname');
  }
  if (parsed.port || parsed.username || parsed.password || parsed.pathname !== '/')
    throw new Error('Authorized scope accepts hostnames without ports');
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const bare = host.replace(/^\[|\]$/g, '');
  if (!host || (!isIP(bare) && host !== 'localhost' && !host.includes('.')))
    throw new Error('Enter a fully qualified hostname');
  if (wildcard && (isIP(bare) || isLoopback(host) || !host.includes('.')))
    throw new Error('Wildcard scope needs a domain with at least two labels');
  return `${wildcard ? '*.' : ''}${host}`;
}

export function isApproved(url: string, domains: readonly string[]): boolean {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    return domains.some((raw) => {
      try {
        const domain = normalizeDomain(raw);
        return domain.startsWith('*.')
          ? host.endsWith(domain.slice(1)) && host !== domain.slice(2)
          : host === domain;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function assertApproved(
  input: string,
  settings: Pick<AppSettings, 'authorizedDomains' | 'allowLocalhost'>,
): string {
  const url = normalizeUrl(input, settings);
  if (!isApproved(url, settings.authorizedDomains))
    throw new Error(`Destination is outside the authorized test scope: ${new URL(url).hostname}`);
  return url;
}

export interface BudgetSnapshot {
  day: string;
  counts: Record<string, number>;
}
/** Daily navigation attempts are counted before dispatch; failed requests still consume budget. */
export class DomainBudget {
  private day = '';
  private counts = new Map<string, number>();
  constructor(
    snapshot?: BudgetSnapshot,
    private readonly now: () => number = Date.now,
  ) {
    if (
      snapshot &&
      typeof snapshot.day === 'string' &&
      snapshot.counts &&
      typeof snapshot.counts === 'object'
    ) {
      this.day = snapshot.day;
      for (const [key, value] of Object.entries(snapshot.counts))
        if (Number.isSafeInteger(value) && value >= 0) this.counts.set(key, value);
    }
    this.rollover();
  }
  private rollover(): void {
    const current = new Date(this.now()).toISOString().slice(0, 10);
    if (this.day !== current) {
      this.day = current;
      this.counts.clear();
    }
  }
  consume(url: string, limit: number): number {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('Daily navigation limit must be a positive integer');
    this.rollover();
    const domain = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    if (!this.counts.has(domain) && this.counts.size >= 10000)
      throw new Error('Daily domain tracking limit reached; review the test scope before continuing');
    const current = this.counts.get(domain) ?? 0;
    if (current >= limit) throw new Error(`Daily navigation limit reached for ${domain}`);
    this.counts.set(domain, current + 1);
    return limit - current - 1;
  }
  snapshot(): BudgetSnapshot {
    this.rollover();
    return { day: this.day, counts: Object.fromEntries(this.counts) };
  }
}
