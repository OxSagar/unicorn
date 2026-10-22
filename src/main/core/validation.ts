import type { AppCommand, AppSettings, DeviceConfig, ViewBounds } from '../../shared/types';
import { hasControlCharacters, normalizeDomain } from './scope';

function record(input: unknown, name: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error(`${name} must be an object`);
  return input as Record<string, unknown>;
}
function keys(input: Record<string, unknown>, allowed: readonly string[], name: string): void {
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    throw new Error(`Unexpected field in ${name}`);
}
function number(value: unknown, name: string, min: number, max: number, integer = true): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new Error(`${name} must be ${integer ? 'an integer' : 'a number'} from ${min} to ${max}`);
  return value;
}
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
  return value;
}
function string(value: unknown, name: string, max = 8192): string {
  if (typeof value !== 'string' || !value.length || value.length > max || hasControlCharacters(value))
    throw new Error(`${name} must be valid text`);
  return value;
}
function enumeration<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (!allowed.includes(value as T)) throw new Error(`Invalid ${name}`);
  return value as T;
}
const id = (value: unknown) => number(value, 'Browser ID', 1, 20);
function ids(value: unknown): number[] {
  if (!Array.isArray(value) || !value.length || value.length > 20)
    throw new Error('Select between 1 and 20 browsers');
  return [...new Set(value.map(id))];
}

export function validateDevice(input: unknown): DeviceConfig {
  const value = record(input, 'device');
  keys(value, ['preset', 'width', 'height', 'scaleFactor', 'mobile', 'touch', 'landscape'], 'device');
  return {
    preset: enumeration(value.preset, ['desktop', 'mobile', 'tablet', 'custom'], 'device preset'),
    width: number(value.width, 'Viewport width', 200, 7680),
    height: number(value.height, 'Viewport height', 200, 7680),
    scaleFactor: number(value.scaleFactor, 'Device pixel ratio', 0.5, 4, false),
    mobile: boolean(value.mobile, 'Mobile viewport'),
    touch: boolean(value.touch, 'Touch'),
    landscape: boolean(value.landscape, 'Landscape'),
  };
}

export function validateSettings(input: unknown): AppSettings {
  const value = record(input, 'settings');
  keys(
    value,
    [
      'browserCount',
      'authorizedDomains',
      'stagingConfirmed',
      'dailyNavigationLimit',
      'dailyRequestLimit',
      'excludedLinkPatterns',
      'retryLimit',
      'proxyRefreshMinutes',
      'allowLocalhost',
      'closePopupsAfterRun',
      'theme',
      'closeToTray',
      'minimizeToTray',
      'startAtLogin',
      'resourceLimitMb',
      'logRetentionDays',
      'timings',
      'schedule',
    ],
    'settings',
  );
  if (!Array.isArray(value.authorizedDomains) || value.authorizedDomains.length > 200)
    throw new Error('Scope supports up to 200 domains');
  const domains = [
    ...new Set(value.authorizedDomains.map((domain) => normalizeDomain(string(domain, 'Domain', 253)))),
  ];
  const exclusions = value.excludedLinkPatterns ?? [];
  if (!Array.isArray(exclusions) || exclusions.length > 50)
    throw new Error('Provide up to 50 link exclusion patterns');
  const timings = record(value.timings, 'timings');
  const timingFields = [
    'landingWaitMs',
    'landingScrollMs',
    'internalWaitMs',
    'internalScrollMs',
    'externalWaitMs',
    'externalScrollMs',
    'navigationTimeoutMs',
    'maxScrollPx',
  ];
  keys(timings, timingFields, 'timings');
  const schedule = record(value.schedule, 'schedule');
  keys(schedule, ['enabled', 'intervalMinutes', 'startHour', 'endHour', 'resumeAfterRestart'], 'schedule');
  const settings: AppSettings = {
    browserCount: id(value.browserCount),
    authorizedDomains: domains,
    stagingConfirmed: boolean(value.stagingConfirmed, 'Staging confirmation'),
    dailyNavigationLimit: number(value.dailyNavigationLimit, 'Daily navigation limit', 1, 100000),
    dailyRequestLimit: number(value.dailyRequestLimit ?? 10000, 'Daily request limit', 1, 1000000),
    excludedLinkPatterns: [
      ...new Set(exclusions.map((pattern) => string(pattern, 'Link exclusion pattern', 512))),
    ],
    retryLimit: number(value.retryLimit, 'Retry limit', 0, 5),
    proxyRefreshMinutes: number(value.proxyRefreshMinutes, 'Proxy refresh interval', 1, 1440),
    allowLocalhost: boolean(value.allowLocalhost, 'Localhost fixtures'),
    closePopupsAfterRun: boolean(value.closePopupsAfterRun, 'Close popups'),
    theme: enumeration(value.theme, ['dark', 'light'], 'theme'),
    closeToTray: boolean(value.closeToTray, 'Close to tray'),
    minimizeToTray: boolean(value.minimizeToTray ?? false, 'Minimize to tray'),
    startAtLogin: boolean(value.startAtLogin, 'Start at login'),
    resourceLimitMb: number(value.resourceLimitMb, 'Resource limit', 512, 131072),
    logRetentionDays: number(value.logRetentionDays, 'Log retention', 1, 90),
    timings: {
      landingWaitMs: number(timings.landingWaitMs, 'Landing wait', 0, 3600000),
      landingScrollMs: number(timings.landingScrollMs, 'Landing scroll', 0, 3600000),
      internalWaitMs: number(timings.internalWaitMs, 'Internal wait', 0, 3600000),
      internalScrollMs: number(timings.internalScrollMs, 'Internal scroll', 0, 3600000),
      externalWaitMs: number(timings.externalWaitMs, 'External wait', 0, 3600000),
      externalScrollMs: number(timings.externalScrollMs, 'External scroll', 0, 3600000),
      navigationTimeoutMs: number(timings.navigationTimeoutMs, 'Navigation timeout', 1000, 180000),
      maxScrollPx: number(timings.maxScrollPx, 'Maximum scroll distance', 0, 1000000),
    },
    schedule: {
      enabled: boolean(schedule.enabled, 'Schedule enabled'),
      intervalMinutes: number(schedule.intervalMinutes, 'Schedule interval', 1, 10080),
      startHour: number(schedule.startHour, 'Start hour', 0, 23),
      endHour: number(schedule.endHour, 'End hour', 0, 24),
      resumeAfterRestart: boolean(schedule.resumeAfterRestart, 'Resume after restart'),
    },
  };
  if (settings.schedule.startHour === settings.schedule.endHour)
    throw new Error('Operating hours must define a nonempty interval; use 0–24 for all day');
  if (settings.schedule.enabled && (!settings.stagingConfirmed || !domains.length))
    throw new Error(
      'A schedule requires authorized domains and confirmation of a staging or test-ad environment',
    );
  return settings;
}

export function validateCommand(input: unknown): AppCommand {
  const value = record(input, 'command');
  const type = string(value.type, 'Command type', 40);
  const noArguments = [
    'snapshot',
    'clear-queue',
    'refresh-proxies',
    'export-logs',
    'export-results',
    'import-urls',
    'open-release-page',
  ];
  if (noArguments.includes(type)) {
    keys(value, ['type'], 'command');
    return { type } as AppCommand;
  }
  switch (type) {
    case 'simple-distribute':
      keys(value, ['type', 'text', 'count', 'device'], 'command');
      if (typeof value.text !== 'string' || !value.text.trim() || value.text.length > 2_000_000)
        throw new Error('Paste links using up to 2,000,000 characters');
      return {
        type,
        text: value.text,
        count: id(value.count),
        device: enumeration(value.device, ['desktop', 'mobile', 'tablet'], 'device preset'),
      };
    case 'simple-start':
      keys(value, ['type', 'reviewId', 'confirmed'], 'command');
      if (value.confirmed !== true) throw new Error('Start requires explicit website authorization');
      return { type, reviewId: string(value.reviewId, 'Review ID', 128), confirmed: true };
    case 'create':
      keys(value, ['type', 'count'], 'command');
      return { type, count: id(value.count) };
    case 'navigate':
      keys(value, ['type', 'id', 'url'], 'command');
      return { type, id: id(value.id), url: string(value.url, 'URL') };
    case 'browser':
      keys(value, ['type', 'id', 'action'], 'command');
      return {
        type,
        id: id(value.id),
        action: enumeration(
          value.action,
          [
            'back',
            'forward',
            'reload',
            'stop-loading',
            'close',
            'start',
            'pause',
            'resume',
            'stop',
            'devtools',
          ],
          'browser action',
        ),
      };
    case 'global':
      keys(value, ['type', 'action'], 'command');
      return {
        type,
        action: enumeration(value.action, ['start', 'pause', 'resume', 'stop'], 'global action'),
      };
    case 'device':
      keys(value, ['type', 'ids', 'device'], 'command');
      return { type, ids: ids(value.ids), device: validateDevice(value.device) };
    case 'settings':
      keys(value, ['type', 'settings'], 'command');
      return { type, settings: validateSettings(value.settings) };
    case 'distribute': {
      keys(value, ['type', 'urls', 'ids', 'mode', 'manual', 'allowDuplicates'], 'command');
      if (!Array.isArray(value.urls) || !value.urls.length || value.urls.length > 5000)
        throw new Error('Provide 1–5,000 URLs');
      const manual = value.manual === undefined ? undefined : record(value.manual, 'manual assignments');
      if (manual && Object.keys(manual).length > 5000) throw new Error('Too many manual assignments');
      return {
        type,
        urls: value.urls.map((url) => string(url, 'URL')),
        ids: ids(value.ids),
        mode: enumeration(value.mode, ['same', 'round-robin', 'balanced', 'manual'], 'distribution mode'),
        manual: manual
          ? Object.fromEntries(
              Object.entries(manual).map(([key, target]) => [string(key, 'Assignment key'), id(target)]),
            )
          : undefined,
        allowDuplicates:
          value.allowDuplicates === undefined
            ? false
            : boolean(value.allowDuplicates, 'Allow duplicate jobs'),
      };
    }
    case 'edit-job':
      keys(value, ['type', 'id', 'url', 'browserId'], 'command');
      return {
        type,
        id: string(value.id, 'Job ID', 128),
        url: string(value.url, 'URL'),
        browserId: id(value.browserId),
      };
    case 'job':
      keys(value, ['type', 'id', 'action'], 'command');
      return {
        type,
        id: string(value.id, 'Job ID', 128),
        action: enumeration(value.action, ['remove'], 'job action'),
      };
    case 'profile':
      keys(value, ['type', 'id', 'action'], 'command');
      return {
        type,
        id: id(value.id),
        action: enumeration(
          value.action,
          ['cache', 'cookies', 'permissions', 'history', 'reset', 'storage'],
          'profile action',
        ),
      };
    case 'popup':
      keys(value, ['type', 'browserId', 'popupId', 'action'], 'command');
      return {
        type,
        browserId: id(value.browserId),
        popupId: number(value.popupId, 'Popup ID', 1, Number.MAX_SAFE_INTEGER),
        action: enumeration(value.action, ['inspect', 'close'], 'popup action'),
      };
    case 'diagnostic':
      keys(value, ['type', 'id'], 'command');
      return { type, id: id(value.id) };
    default:
      throw new Error('Unknown command');
  }
}

export function validateBounds(input: unknown): ViewBounds[] {
  if (!Array.isArray(input) || input.length > 20) throw new Error('Invalid browser view layout');
  const seen = new Set<number>();
  return input.map((item) => {
    const value = record(item, 'view bounds');
    keys(value, ['id', 'x', 'y', 'width', 'height', 'visible'], 'view bounds');
    const browserId = id(value.id);
    if (seen.has(browserId)) throw new Error('Duplicate browser view bounds');
    seen.add(browserId);
    return {
      id: browserId,
      x: number(value.x, 'X', -32768, 32768),
      y: number(value.y, 'Y', -32768, 32768),
      width: number(value.width, 'Width', 0, 16384),
      height: number(value.height, 'Height', 0, 16384),
      visible: boolean(value.visible, 'Visible'),
    };
  });
}
