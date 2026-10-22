export const COUNTRIES = ['US', 'GB', 'CA', 'FR', 'DE', 'JP', 'IT', 'AT'] as const;
export type CountryCode = (typeof COUNTRIES)[number];
export type ProxyProtocol = 'http' | 'https' | 'socks5';
export type BrowserState =
  | 'CREATED'
  | 'WAITING_FOR_PROXY'
  | 'ASSIGNING_PROXY'
  | 'READY'
  | 'NAVIGATING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'PAUSED'
  | 'PROXY_FAILED'
  | 'RETRY_WAIT'
  | 'STOPPED'
  | 'ERROR';
export type DevicePreset = 'desktop' | 'mobile' | 'tablet' | 'custom';
export interface DeviceConfig {
  preset: DevicePreset;
  width: number;
  height: number;
  scaleFactor: number;
  mobile: boolean;
  touch: boolean;
  landscape: boolean;
}
export interface ProxyRecord {
  id: string;
  ip: string;
  port: number;
  protocol: ProxyProtocol;
  country: CountryCode;
  countryName: string;
  status: 'available' | 'assigned' | 'failed';
  failures: number;
  error?: string;
  assignedTo?: number;
  source: 'proxyscrape' | 'fixture';
}
export interface BrowserSnapshot {
  id: number;
  name: string;
  state: BrowserState;
  url: string;
  title: string;
  device: DeviceConfig;
  proxy?: ProxyRecord;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  stage: string;
  startedAt?: number;
  elapsedMs: number;
  jsErrors: number;
  networkErrors: number;
  lastError?: string;
  history: Array<{ url: string; title: string; at: number }>;
  popups: Array<{ id: number; url: string; title: string }>;
}
export type DistributionMode = 'same' | 'round-robin' | 'balanced' | 'manual';
export interface TestJob {
  id: string;
  browserId: number;
  url: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  finishedAt?: number;
  error?: string;
}
export interface PreparedRun {
  id: string;
  count: number;
  device: 'desktop' | 'mobile' | 'tablet';
  domains: string[];
  jobIds: string[];
  browserIds: number[];
  urls: string[];
  createdAt: number;
  status: 'ready' | 'running' | 'finished';
}
export interface TimingSettings {
  landingWaitMs: number;
  landingScrollMs: number;
  internalWaitMs: number;
  internalScrollMs: number;
  externalWaitMs: number;
  externalScrollMs: number;
  navigationTimeoutMs: number;
  maxScrollPx: number;
}
export interface AppSettings {
  browserCount: number;
  authorizedDomains: string[];
  stagingConfirmed: boolean;
  dailyNavigationLimit: number;
  dailyRequestLimit: number;
  excludedLinkPatterns: string[];
  retryLimit: number;
  proxyRefreshMinutes: number;
  allowLocalhost: boolean;
  closePopupsAfterRun: boolean;
  theme: 'dark' | 'light';
  closeToTray: boolean;
  minimizeToTray: boolean;
  startAtLogin: boolean;
  resourceLimitMb: number;
  logRetentionDays: number;
  timings: TimingSettings;
  schedule: {
    enabled: boolean;
    intervalMinutes: number;
    startHour: number;
    endHour: number;
    resumeAfterRestart: boolean;
  };
}
export interface ActivityEvent {
  id: string;
  at: number;
  level: 'info' | 'warn' | 'error';
  category: string;
  message: string;
  browserId?: number;
}
export interface PerformanceSnapshot {
  cpuPercent: number;
  memoryMb: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
  processes: number;
  uptimeSeconds: number;
  sampledAt: number;
  heartbeatCount: number;
  eventLoopDelayMs: number;
  peakEventLoopDelayMs: number;
}
export interface AppSnapshot {
  version: string;
  settings: AppSettings;
  browsers: BrowserSnapshot[];
  proxies: ProxyRecord[];
  jobs: TestJob[];
  preservedJobs: TestJob[];
  preparedRun: PreparedRun | null;
  logs: ActivityEvent[];
  performance: PerformanceSnapshot;
  provider: {
    lastFetchedAt: number | null;
    retrieved: number;
    eligible: number;
    error?: string;
    fetching: boolean;
  };
  totals: { completed: number; failed: number; navigations: number; jsErrors: number; networkErrors: number };
  scheduler: { running: boolean; paused: boolean; nextRunAt: number | null };
}
export interface ViewBounds {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}
export type AppCommand =
  | { type: 'snapshot' }
  | { type: 'simple-distribute'; text: string; count: number; device: 'desktop' | 'mobile' | 'tablet' }
  | { type: 'simple-start'; reviewId: string; confirmed: true }
  | { type: 'create'; count: number }
  | { type: 'navigate'; id: number; url: string }
  | {
      type: 'browser';
      id: number;
      action:
        | 'back'
        | 'forward'
        | 'reload'
        | 'stop-loading'
        | 'close'
        | 'start'
        | 'pause'
        | 'resume'
        | 'stop'
        | 'devtools';
    }
  | { type: 'global'; action: 'start' | 'pause' | 'resume' | 'stop' }
  | { type: 'device'; ids: number[]; device: DeviceConfig }
  | {
      type: 'distribute';
      urls: string[];
      ids: number[];
      mode: DistributionMode;
      manual?: Record<string, number>;
      allowDuplicates?: boolean;
    }
  | { type: 'job'; id: string; action: 'remove' }
  | { type: 'edit-job'; id: string; url: string; browserId: number }
  | { type: 'clear-queue' }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'refresh-proxies' }
  | {
      type: 'profile';
      id: number;
      action: 'cache' | 'cookies' | 'permissions' | 'history' | 'reset' | 'storage';
    }
  | { type: 'popup'; browserId: number; popupId: number; action: 'inspect' | 'close' }
  | { type: 'export-logs' }
  | { type: 'export-results' }
  | { type: 'import-urls' }
  | { type: 'diagnostic'; id: number }
  | { type: 'open-release-page' };
export interface CommandResult {
  snapshot: AppSnapshot;
  message?: string;
  importedUrls?: string[];
  storageBytes?: number;
  diagnostic?: Record<string, unknown>;
}
export interface UnicornApi {
  security: { sandboxed: boolean; contextIsolated: boolean };
  invoke(command: AppCommand): Promise<CommandResult>;
  subscribe(listener: (snapshot: AppSnapshot) => void): () => void;
  layout(bounds: ViewBounds[]): void;
}
declare global {
  interface Window {
    unicorn: UnicornApi;
  }
}
