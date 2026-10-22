import { app, dialog, shell, type BrowserWindow } from 'electron';
import { readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  AppCommand,
  AppSettings,
  AppSnapshot,
  CommandResult,
  PerformanceSnapshot,
  ProxyRecord,
} from '../shared/types';
import { BrowserManager } from './browser/manager';
import { ProxyPool, parseProxyScrape, proxyScrapeUrl } from './core/proxy';
import { assertApproved, DomainBudget } from './core/scope';
import { distribute, importUrls } from './core/distribution';
import { inOperatingWindow } from './core/timing';
import { validateSettings } from './core/validation';
import { validateProxy } from './network/proxy-validator';
import { ActivityLog, LocalStore, type StoredData } from './storage';

export interface TestConfiguration {
  userData: string;
  settings?: Partial<AppSettings>;
  proxies: ProxyRecord[];
  diagnosticUrl: string;
}
export class UnicornController {
  readonly manager: BrowserManager;
  readonly pool: ProxyPool;
  private budget: DomainBudget;
  private active = new Map<number, Promise<void>>();
  private stopped = new Set<number>();
  private paused = false;
  private scheduleArmed = false;
  private closing = false;
  private sendTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private refreshPromise?: Promise<void>;
  private lastFetchAttempt = 0;
  private providerRetryAt = 0;
  private lastResourceWarning = 0;
  private poolOptions = { uniqueExitIps: true, validationTtlMs: 30000, maxAttempts: 6 };
  private provider: AppSnapshot['provider'] = {
    lastFetchedAt: null,
    retrieved: 0,
    eligible: 0,
    fetching: false,
  };
  private performance: PerformanceSnapshot = {
    cpuPercent: 0,
    memoryMb: 0,
    totalMemoryMb: 0,
    freeMemoryMb: 0,
    processes: 0,
    uptimeSeconds: 0,
    sampledAt: 0,
  };

  constructor(
    private window: BrowserWindow,
    private data: StoredData,
    private store: LocalStore,
    private logs: ActivityLog,
    private test?: TestConfiguration,
  ) {
    this.budget = new DomainBudget(data.budget);
    this.scheduleArmed = data.settings.schedule.enabled && data.settings.schedule.resumeAfterRestart;
    this.poolOptions.uniqueExitIps = data.settings.uniqueExitIps;
    this.pool = new ProxyPool(
      (record, signal) =>
        validateProxy(record, this.data.settings.proxyTimeoutMs, signal, test?.diagnosticUrl),
      this.poolOptions,
    );
    this.manager = new BrowserManager({
      window,
      settings: () => this.data.settings,
      proxies: {
        acquire: async (id, signal) => {
          if (!this.pool.list().length && !test) await this.refreshProxies();
          return this.pool.acquire(id, signal);
        },
        release: (id, reason) => {
          this.pool.release(id, reason);
          this.changed();
        },
      },
      log: (level, category, message, id) => {
        this.logs.add(level, category, message, id);
        if (category === 'navigation' && message.startsWith('Page navigation completed'))
          this.data.totals.navigations++;
        if (category === 'javascript') this.data.totals.jsErrors++;
        if (category === 'network' && level !== 'info') this.data.totals.networkErrors++;
        this.changed();
      },
      changed: () => this.changed(),
      emergencyStop: () => {
        void this.command({ type: 'global', action: 'stop' }).catch((error) =>
          this.logs.add('error', 'stop', String(error)),
        );
      },
      navigationAllowed: (url) => {
        this.budget.consume(url, this.data.settings.dailyNavigationLimit);
        this.persistSoon();
      },
      profileData: {
        load: (id) => this.data.profiles[id] ?? {},
        save: (id, profile) => {
          this.data.profiles[id] = profile;
          this.persistSoon();
        },
      },
      diagnosticsDir: path.join(store.directory, 'diagnostics'),
    });
  }

  async initialize(): Promise<void> {
    if (this.test) {
      this.pool.merge(this.test.proxies);
      this.provider = {
        lastFetchedAt: Date.now(),
        retrieved: this.test.proxies.length,
        eligible: this.test.proxies.length,
        fetching: false,
      };
    } else {
      try {
        const cache = JSON.parse(
          await readFile(path.join(this.store.directory, 'proxy-cache.json'), 'utf8'),
        ) as { at: number; data: unknown };
        if (Date.now() - cache.at < this.data.settings.proxyRefreshMinutes * 60000) {
          const parsed = parseProxyScrape(cache.data);
          this.pool.merge(parsed.records);
          this.provider = {
            lastFetchedAt: cache.at,
            retrieved: parsed.retrieved,
            eligible: parsed.records.length,
            fetching: false,
          };
        }
      } catch {
        /* A missing or invalid cache triggers a fresh provider request. */
      }
    }
    await this.manager.create(this.data.settings.browserCount);
    this.logs.add(
      'info',
      'application',
      `Unicorn ${app.getVersion()} started; ${this.data.settings.browserCount} persistent browser profiles restored.`,
    );
    this.samplePerformance();
    this.pollTimer = setInterval(() => {
      this.samplePerformance();
      this.tick();
      this.changed();
    }, 2000);
    this.pollTimer.unref();
    if (!this.test && !this.provider.lastFetchedAt) void this.refreshProxies();
    if (this.scheduleArmed && !this.data.nextRunAt) this.data.nextRunAt = Date.now() + 5000;
    this.changed();
  }

  snapshot(): AppSnapshot {
    return {
      version: app.getVersion(),
      settings: structuredClone(this.data.settings),
      browsers: this.manager.snapshots(),
      proxies: this.pool.list(),
      jobs: structuredClone(this.data.jobs),
      logs: this.logs.list(),
      performance: { ...this.performance },
      provider: { ...this.provider },
      totals: { ...this.data.totals },
      scheduler: {
        running: this.active.size > 0 || this.scheduleArmed,
        paused: this.paused,
        nextRunAt: this.scheduleArmed ? this.data.nextRunAt : null,
      },
    };
  }
  changed(): void {
    if (this.closing || this.sendTimer) return;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = undefined;
      if (!this.window.isDestroyed()) this.window.webContents.send('unicorn:snapshot', this.snapshot());
    }, 100);
  }
  private persistSoon(): void {
    if (this.closing || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.data.budget = this.budget.snapshot();
      void this.store.save(this.data).catch((error) => this.logs.add('error', 'storage', String(error)));
    }, 500);
  }
  private samplePerformance(): void {
    const metrics = app.getAppMetrics();
    this.performance = {
      cpuPercent: Math.round(metrics.reduce((sum, item) => sum + item.cpu.percentCPUUsage, 0) * 10) / 10,
      memoryMb: Math.round(metrics.reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024),
      totalMemoryMb: Math.round(os.totalmem() / 1048576),
      freeMemoryMb: Math.round(os.freemem() / 1048576),
      processes: metrics.length,
      uptimeSeconds: Math.floor(process.uptime()),
      sampledAt: Date.now(),
    };
    if (
      this.performance.memoryMb > this.data.settings.resourceLimitMb &&
      Date.now() - this.lastResourceWarning > 60000
    ) {
      this.lastResourceWarning = Date.now();
      this.logs.add(
        'warn',
        'performance',
        'Configured memory budget exceeded. New QA jobs will wait; existing profiles remain open.',
      );
    }
  }

  async refreshProxies(): Promise<void> {
    if (this.test || this.closing) return;
    if (this.refreshPromise) return this.refreshPromise;
    if (Date.now() < this.providerRetryAt || Date.now() - this.lastFetchAttempt < 60000) {
      this.provider.error = 'Provider refresh is cooling down; retry after at least one minute.';
      this.changed();
      return;
    }
    this.lastFetchAttempt = Date.now();
    this.provider.fetching = true;
    this.changed();
    this.refreshPromise = (async () => {
      try {
        const response = await fetch(
          proxyScrapeUrl({ timeoutMs: this.data.settings.proxyTimeoutMs, limit: 2000 }),
          {
            signal: AbortSignal.timeout(20000),
            headers: { Accept: 'application/json', 'User-Agent': 'Unicorn-QA/1.0' },
            redirect: 'error',
          },
        );
        if (response.status === 429) {
          this.providerRetryAt =
            Date.now() +
            Math.max(
              60000,
              Math.min(3600000, Number(response.headers.get('retry-after') ?? 60) * 1000 || 60000),
            );
          throw new Error('ProxyScrape rate limit reached; provider cooldown applied.');
        }
        if (!response.ok) throw new Error(`ProxyScrape returned HTTP ${response.status}`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('ProxyScrape returned an empty response');
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('ProxyScrape response exceeds 4 MB');
          }
          chunks.push(part.value);
        }
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const parsed = parseProxyScrape(raw);
        this.pool.merge(parsed.records);
        this.provider = {
          lastFetchedAt: Date.now(),
          retrieved: parsed.retrieved,
          eligible: parsed.records.length,
          fetching: false,
        };
        await writeFile(
          path.join(this.store.directory, 'proxy-cache.json'),
          JSON.stringify({ at: this.provider.lastFetchedAt, data: raw }),
          { mode: 0o600 },
        );
        this.logs.add(
          'info',
          'proxy',
          `ProxyScrape supplied ${parsed.retrieved} records; ${parsed.records.length} eligible endpoints retained. Exit country and HTTPS validation happen before allocation.`,
        );
      } catch (error) {
        this.provider.error = String(error);
        this.logs.add('warn', 'proxy', String(error));
      } finally {
        this.provider.fetching = false;
        this.refreshPromise = undefined;
        this.changed();
      }
    })();
    return this.refreshPromise;
  }

  private begin(ids: number[]): void {
    if (!this.data.settings.stagingConfirmed || !this.data.settings.authorizedDomains.length)
      throw new Error(
        'Configure the authorized domains and confirm a staging or test-ad environment before QA.',
      );
    if (this.performance.memoryMb > this.data.settings.resourceLimitMb)
      throw new Error(
        'The memory budget is exceeded. Close browsers or raise the configured budget before starting another job.',
      );
    if (!ids.some((id) => this.data.jobs.some((job) => job.browserId === id && job.status === 'pending')))
      throw new Error('Distribute URLs to create pending test jobs first.');
    this.paused = false;
    this.scheduleArmed = this.data.settings.schedule.enabled;
    for (const id of ids) {
      if (this.active.has(id)) {
        void this.manager.resume(id).catch((error) => this.logs.add('warn', 'job', String(error), id));
        continue;
      }
      this.stopped.delete(id);
      const operation = this.worker(id).finally(() => {
        this.active.delete(id);
        this.persistSoon();
        this.changed();
        if (!this.active.size && this.scheduleArmed)
          this.data.nextRunAt = Date.now() + this.data.settings.schedule.intervalMinutes * 60000;
      });
      this.active.set(id, operation);
    }
    this.changed();
  }
  private async worker(id: number): Promise<void> {
    while (!this.closing && !this.stopped.has(id) && !this.paused) {
      const job = this.data.jobs.find((item) => item.browserId === id && item.status === 'pending');
      if (!job || this.performance.memoryMb > this.data.settings.resourceLimitMb) break;
      job.status = 'running';
      job.error = undefined;
      this.persistSoon();
      this.changed();
      try {
        assertApproved(job.url, this.data.settings);
        await this.manager.runQa(id, job.url);
        job.status = 'completed';
        job.finishedAt = Date.now();
        this.data.totals.completed++;
      } catch (error) {
        job.error = error instanceof Error ? error.message : String(error);
        if (this.stopped.has(id) || this.closing) job.status = 'cancelled';
        else if (this.manager.snapshots().find((item) => item.id === id)?.state === 'WAITING_FOR_PROXY') {
          job.status = 'pending';
          break;
        } else {
          job.status = 'failed';
          this.data.totals.failed++;
        }
        job.finishedAt = Date.now();
        this.logs.add('warn', 'job', job.error, id);
        break;
      }
    }
  }
  private tick(): void {
    if (this.closing || this.paused) return;
    if (
      !this.test &&
      Date.now() - (this.provider.lastFetchedAt ?? 0) > this.data.settings.proxyRefreshMinutes * 60000
    )
      void this.refreshProxies();
    if (!this.scheduleArmed || this.active.size || !this.data.nextRunAt || Date.now() < this.data.nextRunAt)
      return;
    const schedule = this.data.settings.schedule;
    if (!inOperatingWindow(new Date(), schedule.startHour, schedule.endHour)) return;
    if (!this.data.jobs.some((job) => job.status === 'pending')) {
      const templates = new Map<string, (typeof this.data.jobs)[number]>();
      for (const job of this.data.jobs)
        if (job.status === 'completed') templates.set(`${job.browserId}\n${job.url}`, job);
      this.data.jobs = this.data.jobs.slice(-500);
      for (const job of templates.values())
        this.data.jobs.push({
          id: randomUUID(),
          browserId: job.browserId,
          url: job.url,
          createdAt: Date.now(),
          status: 'pending',
        });
    }
    this.data.nextRunAt = Date.now() + schedule.intervalMinutes * 60000;
    try {
      this.begin(this.manager.snapshots().map((item) => item.id));
    } catch (error) {
      this.logs.add('warn', 'schedule', String(error));
    }
  }

  async command(command: AppCommand): Promise<CommandResult> {
    let message: string | undefined;
    let importedUrls: string[] | undefined;
    let storageBytes: number | undefined;
    let diagnostic: Record<string, unknown> | undefined;
    switch (command.type) {
      case 'snapshot':
        break;
      case 'create':
        for (const item of this.manager.snapshots()) if (item.id > command.count) this.stopped.add(item.id);
        await this.manager.create(command.count);
        this.data.settings.browserCount = command.count;
        break;
      case 'navigate':
        this.stopped.add(command.id);
        await this.manager.navigate(command.id, command.url);
        break;
      case 'browser':
        if (command.action === 'start') this.begin([command.id]);
        else {
          if (command.action === 'stop' || command.action === 'close') this.stopped.add(command.id);
          await this.manager.action(command.id, command.action);
        }
        break;
      case 'global': {
        const ids = this.manager.snapshots().map((item) => item.id);
        if (command.action === 'start') this.begin(ids);
        else if (command.action === 'pause') {
          this.paused = true;
          await Promise.all(ids.map((id) => this.manager.pause(id)));
        } else if (command.action === 'resume') {
          this.paused = false;
          await Promise.all(ids.map((id) => this.manager.resume(id)));
          const pendingIds = ids.filter(
            (id) =>
              !this.active.has(id) &&
              this.data.jobs.some((job) => job.browserId === id && job.status === 'pending'),
          );
          if (pendingIds.length) this.begin(pendingIds);
        } else {
          this.scheduleArmed = false;
          this.paused = false;
          this.data.nextRunAt = null;
          for (const id of ids) this.stopped.add(id);
          await Promise.all(ids.map((id) => this.manager.stop(id)));
        }
        break;
      }
      case 'device':
        await this.manager.applyDevice(command.ids, command.device);
        break;
      case 'distribute': {
        const open = new Set(this.manager.snapshots().map((item) => item.id));
        if (command.ids.some((id) => !open.has(id)))
          throw new Error('Reopen the selected browser before assigning a URL');
        for (const url of command.urls) assertApproved(url, this.data.settings);
        const jobs = distribute({
          ...command,
          existing: this.data.jobs,
          allowLocalhost: this.data.settings.allowLocalhost,
        });
        if (
          jobs.length + this.data.jobs.filter((job) => ['pending', 'running'].includes(job.status)).length >
          1000
        )
          throw new Error('Queue limit is 1,000 active jobs');
        this.data.jobs = [
          ...this.data.jobs.filter((job) => !['pending', 'running'].includes(job.status)).slice(-500),
          ...this.data.jobs.filter((job) => ['pending', 'running'].includes(job.status)),
          ...jobs,
        ];
        message = `${jobs.length} test jobs assigned. Review the queue, then start.`;
        break;
      }
      case 'job':
        this.data.jobs = this.data.jobs.filter((job) => job.id !== command.id || job.status === 'running');
        break;
      case 'clear-queue':
        this.data.jobs = this.data.jobs.filter((job) => job.status !== 'pending');
        break;
      case 'settings': {
        const next = validateSettings(command.settings);
        if (this.active.size) throw new Error('Stop active QA jobs before changing test settings.');
        await Promise.all(this.manager.snapshots().map((item) => this.manager.stop(item.id)));
        this.poolOptions.uniqueExitIps = next.uniqueExitIps;
        this.data.settings = next;
        this.scheduleArmed = next.schedule.enabled;
        this.paused = false;
        this.data.nextRunAt = next.schedule.enabled
          ? Date.now() + next.schedule.intervalMinutes * 60000
          : null;
        app.setLoginItemSettings({ openAtLogin: next.startAtLogin });
        await this.manager.create(next.browserCount);
        message = 'Settings saved.';
        break;
      }
      case 'refresh-proxies':
        await this.refreshProxies();
        break;
      case 'validate-proxies': {
        void this.pool
          .validateAvailable(4)
          .then((records) => {
            this.logs.add('info', 'proxy', `${records.length} reserve proxies passed validation.`);
            this.changed();
          })
          .catch((error) => this.logs.add('warn', 'proxy', String(error)));
        message = 'Validating up to four reserve proxies. Results will appear in the proxy pool.';
        break;
      }
      case 'profile':
        if (command.action !== 'storage') this.stopped.add(command.id);
        storageBytes = await this.manager.profile(command.id, command.action);
        break;
      case 'popup':
        this.manager.popup(command.browserId, command.popupId, command.action);
        break;
      case 'diagnostic':
        diagnostic = await this.manager.diagnostic(command.id);
        break;
      case 'import-urls': {
        const choice = await dialog.showOpenDialog(this.window, {
          properties: ['openFile'],
          filters: [{ name: 'URL lists', extensions: ['txt', 'csv'] }],
        });
        if (!choice.canceled && choice.filePaths[0]) {
          if ((await stat(choice.filePaths[0])).size > 2 * 1024 * 1024)
            throw new Error('URL import is limited to 2 MB');
          importedUrls = importUrls(
            await readFile(choice.filePaths[0], 'utf8'),
            path.extname(choice.filePaths[0]).toLowerCase() === '.csv' ? 'csv' : 'txt',
          );
        }
        break;
      }
      case 'export-logs':
      case 'export-results': {
        const choice = await dialog.showSaveDialog(this.window, {
          defaultPath: `Unicorn-${command.type === 'export-logs' ? 'activity' : 'results'}-${new Date().toISOString().slice(0, 10)}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (!choice.canceled && choice.filePath) {
          const value =
            command.type === 'export-logs'
              ? this.logs.list(2000)
              : {
                  exportedAt: new Date().toISOString(),
                  totals: this.data.totals,
                  jobs: this.data.jobs,
                  performance: this.performance,
                };
          await writeFile(choice.filePath, JSON.stringify(value, null, 2));
          message = 'Export saved to the chosen file.';
        }
        break;
      }
      case 'open-release-page':
        await shell.openExternal('https://github.com/OxSagar/unicorn/releases');
        break;
    }
    if (command.type !== 'snapshot') this.persistSoon();
    this.changed();
    return { snapshot: this.snapshot(), message, importedUrls, storageBytes, diagnostic };
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.scheduleArmed = false;
    clearInterval(this.pollTimer);
    clearTimeout(this.sendTimer);
    clearTimeout(this.saveTimer);
    for (const id of this.active.keys()) this.stopped.add(id);
    await this.manager.shutdown();
    await Promise.allSettled(this.active.values());
    this.data.budget = this.budget.snapshot();
    this.logs.add('info', 'application', 'Browser sessions and logs flushed; application stopped.');
    await this.store.save(this.data);
    await this.logs.flush();
  }
}
