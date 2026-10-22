import type { AppSettings, TimingSettings } from '../../shared/types';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { distribute, importUrls } from './distribution';
import { normalizeDomain, normalizeUrl } from './scope';

/** Preparing a batch never grants authority or performs a network request. */
export function prepareSimpleDistribution(text: string, count: number, allowLocalhost = false) {
  if (typeof text !== 'string' || text.length > 2_000_000)
    throw new Error('Pasted links are limited to 2,000,000 characters');
  if (!Number.isInteger(count) || count < 1 || count > 20)
    throw new Error('Choose between 1 and 20 browsers');
  const urls = [...new Set(importUrls(text, 'txt').map((url) => normalizeUrl(url, { allowLocalhost })))];
  if (!urls.length || urls.length > 1000) throw new Error('Paste between 1 and 1,000 unique URLs');
  const domains = [
    ...new Set(
      urls.map((url) => {
        const host = new URL(url).hostname;
        if (host.includes('*'))
          throw new Error('Paste exact website hosts; wildcard hosts are not supported');
        return normalizeDomain(host);
      }),
    ),
  ];
  if (domains.length > 200) throw new Error('One batch supports up to 200 exact website hosts');
  const browserIds = Array.from({ length: count }, (_, index) => index + 1);
  const assignedUrls = Array.from(
    { length: Math.max(urls.length, count) },
    (_, index) => urls[index % urls.length]!,
  );
  const jobs = distribute({
    urls: assignedUrls,
    ids: browserIds,
    mode: 'round-robin',
    allowLocalhost,
    allowDuplicates: true,
  });
  return { urls, domains, browserIds, jobs };
}

/** The overlay is ephemeral. Saved settings, scope, and profile devices remain unchanged. */
export function simpleRunSettings(
  saved: AppSettings,
  domains: readonly string[],
  fixtureTimings?: TimingSettings,
): AppSettings {
  return {
    ...structuredClone(saved),
    authorizedDomains: [...domains],
    stagingConfirmed: true,
    dailyNavigationLimit: Math.min(saved.dailyNavigationLimit, DEFAULT_SETTINGS.dailyNavigationLimit),
    dailyRequestLimit: Math.min(saved.dailyRequestLimit, DEFAULT_SETTINGS.dailyRequestLimit),
    resourceLimitMb: Math.min(saved.resourceLimitMb, DEFAULT_SETTINGS.resourceLimitMb),
    retryLimit: DEFAULT_SETTINGS.retryLimit,
    closePopupsAfterRun: true,
    timings: structuredClone(fixtureTimings ?? DEFAULT_SETTINGS.timings),
    schedule: structuredClone(DEFAULT_SETTINGS.schedule),
  };
}
