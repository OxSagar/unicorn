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
  PreparedRun,
  ProxyRecord,
} from '../shared/types';
import { DEVICES } from '../shared/defaults';
import { BrowserManager } from './browser/manager';
import { ProxyPool, parseProxyScrape, proxyScrapeUrl } from './core/proxy';
import { assertApproved, DomainBudget } from './core/scope';
import { distribute, importUrls } from './core/distribution';
import { prepareSimpleDistribution, simpleRunSettings } from './core/simple-run';
import { inOperatingWindow } from './core/timing';
import { validateSettings } from './core/validation';
import { SiteRestrictionError } from './network/site-restriction';
import { withDeadline } from './browser/deadline';
import { ActivityLog, LocalStore, type StoredData } from './storage';

export interface TestConfiguration {
  userData: string;
  settings?: Partial<AppSettings>;
  proxies: ProxyRecord[];
}
interface SimpleExecution {
  reviewId: string;
  browserIds: Set<number>;
  jobIds: Set<string>;
  settings: AppSettings;
  revoked: boolean;
  starting: boolean;
}
export class UnicornController {
  readonly manager: BrowserManager;
  readonly pool: ProxyPool;
  private budget: DomainBudget;
  private requestBudget: DomainBudget;
  private active = new Map<number, Promise<void>>();
  private acceptedJobs = new Map<number, Set<string>>();
  private stopped = new Set<number>();
  private pausedIds = new Set<number>();
  private paused = false;
  private scheduleArmed = false;
  private scheduleCancellationGeneration = 0;
  private simpleGeneration = 0;
  private preparingSimple = false;
  private workspaceMutations = 0;
  private preparedRun: PreparedRun | null = null;
  private preparedAssignments: Array<{ id: string; browserId: number; url: string }> = [];
  private simpleRun?: SimpleExecution;
  private simpleStartAbort?: AbortController;
  private closing = false;
  private sendTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setInterval>;
  private refreshPromise?: Promise<void>;
  private lastFetchAttempt = 0;
  private providerRetryAt = 0;
  private lastResourceWarning = 0;
  private lastHeartbeatMonotonicMs?: number;
  private lastHeartbeatLogMonotonicMs?: number;
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
    heartbeatCount: 0,
    eventLoopDelayMs: 0,
    peakEventLoopDelayMs: 0,
  };

  constructor(
    private window: BrowserWindow,
    private data: StoredData,
    private store: LocalStore,
    private logs: ActivityLog,
    private test?: TestConfiguration,
  ) {
    this.budget = new DomainBudget(data.budget);
    this.requestBudget = new DomainBudget(data.requestBudget);
    // Opening the app never approves a saved queue or recurring schedule.
    // Preferences and templates remain available for an explicit legacy action.
    this.pool = new ProxyPool();
    this.manager = new BrowserManager({
      window,
      settings: (id) => this.settingsFor(id),
      proxies: {
        acquire: async (id, signal) => {
          signal?.throwIfAborted();
          const reserve = this.pool
            .list()
            .filter((record) => record.assignedTo === undefined && record.status === 'available').length;
          if (!reserve && !this.pool.assigned(id)) await withDeadline(this.replenishProxies(), 20000, signal);
          else if (reserve < Math.max(4, this.data.settings.browserCount)) void this.replenishProxies();
          return this.pool.acquire(id, signal);
        },
        release: (id, reason) => {
          this.pool.release(id, reason);
          if (reason) void this.replenishProxies();
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
      navigationAllowed: (url, id) => {
        try {
          this.budget.consume(url, this.settingsFor(id).dailyNavigationLimit);
        } catch (error) {
          throw new SiteRestrictionError(error instanceof Error ? error.message : String(error), url);
        }
        this.persistSoon();
      },
      requestAllowed: (url, id) => {
        try {
          this.requestBudget.consume(url, this.settingsFor(id).dailyRequestLimit);
        } catch {
          throw new SiteRestrictionError(`Daily request limit reached for ${new URL(url).hostname}`, url);
        }
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
      this.manager.checkHealth();
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
      preservedJobs: structuredClone(this.data.preservedJobs),
      preparedRun: structuredClone(this.preparedRun),
      logs: this.logs.list(),
      performance: { ...this.performance },
      provider: { ...this.provider },
      totals: { ...this.data.totals },
      scheduler: {
        running: this.active.size > 0 || this.scheduleArmed || this.preparedRun?.status === 'running',
        paused: this.paused,
        nextRunAt: this.scheduleArmed ? this.data.nextRunAt : null,
      },
    };
  }
  private settingsFor(id?: number): AppSettings {
    return id !== undefined && this.simpleRun?.browserIds.has(id)
      ? this.simpleRun.settings
      : this.data.settings;
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
      this.data.requestBudget = this.requestBudget.snapshot();
      void this.store.save(this.data).catch((error) => this.logs.add('error', 'storage', String(error)));
    }, 500);
  }
  private samplePerformance(): void {
    const metrics = app.getAppMetrics();
    const monotonicNow = globalThis.performance.now();
    const delay =
      this.lastHeartbeatMonotonicMs === undefined
        ? 0
        : Math.max(0, monotonicNow - this.lastHeartbeatMonotonicMs - 2000);
    this.lastHeartbeatMonotonicMs = monotonicNow;
    this.performance = {
      cpuPercent: Math.round(metrics.reduce((sum, item) => sum + item.cpu.percentCPUUsage, 0) * 10) / 10,
      memoryMb: Math.round(metrics.reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024),
      totalMemoryMb: Math.round(os.totalmem() / 1048576),
      freeMemoryMb: Math.round(os.freemem() / 1048576),
      processes: metrics.length,
      uptimeSeconds: Math.floor(process.uptime()),
      sampledAt: Date.now(),
      heartbeatCount: this.performance.heartbeatCount + 1,
      eventLoopDelayMs: Math.round(delay * 10) / 10,
      peakEventLoopDelayMs: Math.max(this.performance.peakEventLoopDelayMs, Math.round(delay * 10) / 10),
    };
    if (this.lastHeartbeatLogMonotonicMs === undefined) this.lastHeartbeatLogMonotonicMs = monotonicNow;
    if (monotonicNow - this.lastHeartbeatLogMonotonicMs >= 60000) {
      this.lastHeartbeatLogMonotonicMs = monotonicNow;
      this.logs.add(
        'info',
        'heartbeat',
        `Application heartbeat ${this.performance.heartbeatCount}; sampling delay ${this.performance.eventLoopDelayMs} ms; peak ${this.performance.peakEventLoopDelayMs} ms; ${this.active.size} active QA jobs.`,
      );
    }
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

  private canRefreshProxies(): boolean {
    return (
      !this.test &&
      !this.closing &&
      Date.now() >= this.providerRetryAt &&
      Date.now() - this.lastFetchAttempt >= 60000
    );
  }

  private replenishProxies(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    return this.canRefreshProxies() ? this.refreshProxies() : Promise.resolve();
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
      const request = new AbortController();
      const deadline = setTimeout(
        () => request.abort(new Error('ProxyScrape request timed out after 20 seconds')),
        20000,
      );
      try {
        const response = await withDeadline(
          fetch(proxyScrapeUrl({ limit: 2000 }), {
            signal: request.signal,
            headers: { Accept: 'application/json', 'User-Agent': 'Unicorn-QA/1.0' },
            redirect: 'error',
          }),
          21000,
          request.signal,
        );
        if (response.status === 429) {
          const retry = response.headers.get('retry-after')?.trim() ?? '60';
          const delay = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
          this.providerRetryAt =
            Date.now() + Math.max(60000, Math.min(3600000, Number.isFinite(delay) ? delay : 60000));
          throw new Error('ProxyScrape rate limit reached; provider cooldown applied.');
        }
        if (!response.ok) throw new Error(`ProxyScrape returned HTTP ${response.status}`);
        const reader = response.body?.getReader();
        if (!reader) throw new Error('ProxyScrape returned an empty response');
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const part = await withDeadline(reader.read(), 21000, request.signal);
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 4 * 1024 * 1024) {
            request.abort(new Error('ProxyScrape response exceeds 4 MB'));
            await withDeadline(reader.cancel(), 1000).catch(() => undefined);
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
          `ProxyScrape supplied ${parsed.retrieved} records; ${parsed.records.length} endpoints retained by API-reported country and available for direct assignment.`,
        );
      } catch (error) {
        this.provider.error = String(error);
        this.logs.add('warn', 'proxy', String(error));
      } finally {
        clearTimeout(deadline);
        request.abort();
        this.provider.fetching = false;
        this.refreshPromise = undefined;
        this.changed();
      }
    })();
    return this.refreshPromise;
  }

  private invalidateSimpleReview(reason: string): void {
    this.simpleGeneration++;
    this.simpleStartAbort?.abort(new Error(reason));
    if (this.preparedRun) this.preparedRun.status = 'finished';
    const reviewed = new Set(this.preparedRun?.jobIds ?? []);
    for (const job of this.data.jobs)
      if (reviewed.has(job.id) && job.status === 'pending') {
        job.status = 'cancelled';
        job.finishedAt = Date.now();
        job.error = reason;
      }
    if (this.simpleRun) {
      this.simpleRun.revoked = true;
      this.simpleRun.settings = {
        ...this.simpleRun.settings,
        stagingConfirmed: false,
        authorizedDomains: [],
      };
    }
  }

  private finishSimpleRun(): void {
    const run = this.simpleRun;
    if (!run || run.starting || [...run.browserIds].some((id) => this.active.has(id))) return;
    if (this.data.jobs.some((job) => run.jobIds.has(job.id) && ['pending', 'running'].includes(job.status)))
      return;
    // Every runQa promise has finished its native gated cleanup before reaching here.
    if (this.preparedRun?.id === run.reviewId) this.preparedRun.status = 'finished';
    this.simpleRun = undefined;
    if (!this.active.size && !this.scheduleArmed) this.paused = false;
    this.changed();
  }

  private async prepareSimple(command: Extract<AppCommand, { type: 'simple-distribute' }>): Promise<void> {
    if (this.active.size || this.simpleRun || this.preparedRun?.status === 'running')
      throw new Error('Stop the current batch before distributing new links.');
    if (
      this.manager
        .snapshots()
        .some((browser) =>
          ['NAVIGATING', 'RUNNING', 'PAUSED', 'ASSIGNING_PROXY', 'RETRY_WAIT'].includes(browser.state),
        )
    )
      throw new Error('Stop active browsers before distributing new links.');
    const plan = prepareSimpleDistribution(command.text, command.count, this.data.settings.allowLocalhost);
    const previous = new Set([...this.data.simpleJobIds, ...(this.preparedRun?.jobIds ?? [])]);
    const retained = this.data.jobs.filter((job) => !(previous.has(job.id) && job.status === 'pending'));
    const preserved = new Map(this.data.preservedJobs.map((job) => [job.id, job]));
    for (const job of retained) if (job.status === 'pending') preserved.set(job.id, job);
    if (preserved.size > 1000)
      throw new Error(
        'The preserved saved-work backlog is full. Export and review the older queue before adding more legacy work.',
      );
    if (retained.filter((job) => job.status === 'running').length + plan.jobs.length > 1000)
      throw new Error('Queue limit is 1,000 active jobs; saved pending work has been preserved.');
    const generation = ++this.simpleGeneration;
    this.preparingSimple = true;
    this.scheduleArmed = false;
    try {
      const openIds = this.manager.snapshots().map((browser) => browser.id);
      const target = Math.max(command.count, ...openIds);
      if (plan.browserIds.some((id) => !openIds.includes(id))) await this.manager.create(target);
      if (generation !== this.simpleGeneration || this.closing)
        throw new Error('Distribution was cancelled. Distribute again when ready.');
      this.data.jobs = [
        ...retained.filter((job) => !['pending', 'running'].includes(job.status)).slice(-500),
        ...retained.filter((job) => job.status === 'running'),
        ...plan.jobs,
      ];
      this.data.preservedJobs = [...preserved.values()];
      this.data.simpleJobIds = plan.jobs.map((job) => job.id);
      this.preparedAssignments = plan.jobs.map(({ id, browserId, url }) => ({ id, browserId, url }));
      this.preparedRun = {
        id: randomUUID(),
        count: command.count,
        device: command.device,
        domains: [...plan.domains],
        jobIds: plan.jobs.map((job) => job.id),
        browserIds: [...plan.browserIds],
        urls: [...plan.urls],
        createdAt: Date.now(),
        status: 'ready',
      };
    } finally {
      this.preparingSimple = false;
    }
  }

  private async startSimple(reviewId: string, confirmed: boolean): Promise<void> {
    const review = this.preparedRun;
    if (confirmed !== true || !review || review.id !== reviewId || review.status === 'finished')
      throw new Error('Distribute the links and explicitly approve the current review before Start.');
    if (review.status === 'running') {
      await this.resumeSimple();
      return;
    }
    if (this.active.size || this.simpleRun) throw new Error('Stop the current batch before Start.');
    const open = new Set(this.manager.snapshots().map((browser) => browser.id));
    if (
      this.preparedAssignments.length !== review.jobIds.length ||
      this.preparedAssignments.some((expected) => {
        const job = this.data.jobs.find((candidate) => candidate.id === expected.id);
        return (
          !job ||
          job.status !== 'pending' ||
          job.browserId !== expected.browserId ||
          job.url !== expected.url ||
          !open.has(job.browserId)
        );
      })
    )
      throw new Error('The reviewed assignments changed. Distribute again before Start.');
    const settings = simpleRunSettings(this.data.settings, review.domains, this.test?.settings?.timings);
    if (this.performance.memoryMb > settings.resourceLimitMb)
      throw new Error('The memory budget is exceeded. Stop other work before starting this batch.');
    const generation = this.simpleGeneration;
    const abort = new AbortController();
    this.simpleStartAbort = abort;
    const run: SimpleExecution = {
      reviewId: review.id,
      browserIds: new Set(review.browserIds),
      jobIds: new Set(review.jobIds),
      settings: { ...settings, stagingConfirmed: false, authorizedDomains: [] },
      revoked: false,
      starting: true,
    };
    this.simpleRun = run;
    review.status = 'running';
    this.scheduleArmed = false;
    this.paused = false;
    for (const id of review.browserIds) this.pausedIds.delete(id);
    this.changed();
    try {
      await this.manager.applyDevice(review.browserIds, { ...DEVICES[review.device] }, abort.signal);
      abort.signal.throwIfAborted();
      if (generation !== this.simpleGeneration || this.simpleRun !== run || this.closing)
        throw new Error('Start was cancelled. Distribute again when ready.');
      this.data.settings.browserCount = review.count;
      run.settings = settings;
      run.starting = false;
      const ready = review.browserIds.filter((id) => !this.pausedIds.has(id));
      if (!this.paused && ready.length) this.begin(ready, false, run.jobIds, run.reviewId);
    } catch (error) {
      if (this.simpleRun === run) {
        this.invalidateSimpleReview(error instanceof Error ? error.message : String(error));
        await Promise.allSettled(review.browserIds.map((id) => this.manager.stop(id)));
        run.starting = false;
        this.finishSimpleRun();
      }
      throw error;
    } finally {
      if (this.simpleStartAbort === abort) this.simpleStartAbort = undefined;
    }
  }

  private async resumeSimple(): Promise<void> {
    const run = this.simpleRun;
    if (!run || run.revoked) throw new Error('The reviewed batch is not ready to resume.');
    const ids = [...run.browserIds];
    if (run.starting) {
      this.paused = false;
      for (const id of ids) this.pausedIds.delete(id);
      return;
    }
    if (!this.paused && !ids.some((id) => this.pausedIds.has(id))) return;
    const generation = this.simpleGeneration;
    this.paused = false;
    for (const id of ids) this.pausedIds.delete(id);
    await Promise.all(ids.map((id) => this.manager.resume(id)));
    if (generation !== this.simpleGeneration || this.simpleRun !== run || run.revoked) return;
    const pending = ids.filter(
      (id) =>
        !this.active.has(id) &&
        this.data.jobs.some(
          (job) => job.browserId === id && job.status === 'pending' && run.jobIds.has(job.id),
        ),
    );
    if (pending.length) this.begin(pending, false, run.jobIds, run.reviewId);
    this.finishSimpleRun();
  }

  private begin(
    ids: number[],
    captureTemplates = true,
    eligibleJobs?: ReadonlySet<string>,
    simpleReviewId?: string,
  ): void {
    const simple = simpleReviewId ? this.simpleRun : undefined;
    if (
      simpleReviewId &&
      (!simple || simple.reviewId !== simpleReviewId || simple.revoked || simple.starting)
    )
      throw new Error('This batch no longer has permission to run.');
    if (!simple && this.preparedRun && this.preparedRun.status !== 'finished')
      throw new Error('Use Start on the reviewed batch to approve its exact website hosts.');
    const settings = simple?.settings ?? this.data.settings;
    if (!settings.stagingConfirmed || !settings.authorizedDomains.length)
      throw new Error(
        'Configure the authorized domains and confirm a staging or test-ad environment before QA.',
      );
    if (this.performance.memoryMb > settings.resourceLimitMb)
      throw new Error(
        'The memory budget is exceeded. Close browsers or raise the configured budget before starting another job.',
      );
    const selected = new Set(ids);
    const accepted =
      eligibleJobs ??
      new Set(
        this.data.jobs
          .filter((job) => selected.has(job.browserId) && job.status === 'pending')
          .map((job) => job.id),
      );
    if (
      !ids.some((id) =>
        this.data.jobs.some(
          (job) => job.browserId === id && job.status === 'pending' && accepted.has(job.id),
        ),
      )
    )
      throw new Error('Distribute URLs to create pending test jobs first.');
    this.paused = false;
    this.scheduleArmed = !simple && this.data.settings.schedule.enabled;
    if (captureTemplates) {
      this.data.scheduleTemplates = [
        ...this.data.scheduleTemplates.filter((job) => !selected.has(job.browserId)),
        ...this.data.jobs
          .filter((job) => selected.has(job.browserId) && job.status === 'pending' && accepted.has(job.id))
          .map(({ browserId, url }) => ({ browserId, url })),
      ].slice(0, 1000);
    }
    for (const id of ids) {
      this.pausedIds.delete(id);
      const eligible = this.active.has(id)
        ? (this.acceptedJobs.get(id) ?? new Set<string>())
        : new Set<string>();
      for (const job of this.data.jobs)
        if (job.browserId === id && job.status === 'pending' && accepted.has(job.id)) eligible.add(job.id);
      this.acceptedJobs.set(id, eligible);
      if (this.active.has(id)) {
        void this.manager.resume(id).catch((error) => this.logs.add('warn', 'job', String(error), id));
        continue;
      }
      this.stopped.delete(id);
      const operation = this.worker(id, eligible).finally(() => {
        this.active.delete(id);
        const run = this.simpleRun;
        if (run && this.stopped.has(id))
          for (const job of this.data.jobs)
            if (run.jobIds.has(job.id) && job.browserId === id && job.status === 'pending') {
              job.status = 'cancelled';
              job.finishedAt = Date.now();
              job.error = 'The browser stopped; distribute again to review its remaining links.';
            }
        this.finishSimpleRun();
        this.persistSoon();
        this.changed();
        if (!this.active.size && this.scheduleArmed)
          this.data.nextRunAt = Date.now() + this.data.settings.schedule.intervalMinutes * 60000;
      });
      this.active.set(id, operation);
    }
    this.changed();
  }
  private async worker(id: number, eligibleJobs: ReadonlySet<string>): Promise<void> {
    while (!this.closing && !this.stopped.has(id) && !this.paused && !this.pausedIds.has(id)) {
      const job = this.data.jobs.find(
        (item) => item.browserId === id && item.status === 'pending' && eligibleJobs.has(item.id),
      );
      if (!job || this.performance.memoryMb > this.settingsFor(id).resourceLimitMb) break;
      const simple = this.simpleRun?.jobIds.has(job.id) ? this.simpleRun : undefined;
      job.status = 'running';
      job.error = undefined;
      this.persistSoon();
      this.changed();
      try {
        assertApproved(job.url, this.settingsFor(id));
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
          this.pausedIds.add(id);
          if (!simple)
            this.data.scheduleTemplates = this.data.scheduleTemplates.filter(
              (template) => template.browserId !== id || template.url !== job.url,
            );
          if (
            error instanceof SiteRestrictionError ||
            /HTTP (401|403|429)|challenge detected|rate.?limit|daily navigation limit/i.test(job.error)
          ) {
            const host =
              error instanceof SiteRestrictionError ? error.restrictedHost : new URL(job.url).hostname;
            if (!simple)
              this.data.scheduleTemplates = this.data.scheduleTemplates.filter(
                (template) => new URL(template.url).hostname !== host,
              );
            for (const pending of this.data.jobs)
              if (
                pending.status === 'pending' &&
                (!simple || simple.jobIds.has(pending.id)) &&
                new URL(pending.url).hostname === host
              ) {
                pending.status = 'cancelled';
                pending.finishedAt = Date.now();
                pending.error = 'Host requires manual review after an access restriction.';
              }
            for (const browser of this.manager.snapshots()) {
              if (browser.id === id || !this.active.has(browser.id)) continue;
              if (simple && !simple.browserIds.has(browser.id)) continue;
              let currentHost: string;
              try {
                currentHost = new URL(browser.url).hostname;
              } catch {
                continue;
              }
              if (currentHost !== host) continue;
              this.stopped.add(browser.id);
              this.pausedIds.add(browser.id);
              this.acceptedJobs.delete(browser.id);
              void this.manager
                .stop(browser.id)
                .catch((failure) => this.logs.add('error', 'stop', String(failure), browser.id));
            }
          }
        }
        if (simple)
          for (const pending of this.data.jobs)
            if (simple.jobIds.has(pending.id) && pending.browserId === id && pending.status === 'pending') {
              pending.status = 'cancelled';
              pending.finishedAt = Date.now();
              pending.error =
                'The browser stopped after a failed job; distribute again to review the remaining links.';
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
      (Date.now() - (this.provider.lastFetchedAt ?? 0) > this.data.settings.proxyRefreshMinutes * 60000 ||
        this.pool.list().filter((record) => record.assignedTo === undefined && record.status === 'available')
          .length < Math.max(4, this.data.settings.browserCount))
    )
      void this.replenishProxies();
    const simple = this.simpleRun;
    if (simple) {
      if (simple.revoked || simple.starting || this.performance.memoryMb > simple.settings.resourceLimitMb)
        return;
      const available = this.pool
        .list()
        .filter((proxy) => proxy.status === 'available' && proxy.assignedTo === undefined).length;
      const pending = [...simple.browserIds].filter(
        (id) =>
          !this.active.has(id) &&
          !this.pausedIds.has(id) &&
          this.data.jobs.some(
            (job) => job.browserId === id && job.status === 'pending' && simple.jobIds.has(job.id),
          ),
      );
      if (available && pending.length)
        this.begin(pending.slice(0, available), false, simple.jobIds, simple.reviewId);
      this.finishSimpleRun();
      return;
    }
    if (!this.scheduleArmed || this.active.size || !this.data.nextRunAt || Date.now() < this.data.nextRunAt)
      return;
    const schedule = this.data.settings.schedule;
    if (!inOperatingWindow(new Date(), schedule.startHour, schedule.endHour)) return;
    const open = new Set(
      this.manager
        .snapshots()
        .map((item) => item.id)
        .filter((id) => !this.pausedIds.has(id)),
    );
    const accepted = new Set<string>();
    const ids = new Set<number>();
    let pendingCount = this.data.jobs.filter((job) => ['pending', 'running'].includes(job.status)).length;
    this.data.jobs = [
      ...this.data.jobs.filter((job) => !['pending', 'running'].includes(job.status)).slice(-500),
      ...this.data.jobs.filter((job) => ['pending', 'running'].includes(job.status)),
    ];
    for (const template of this.data.scheduleTemplates.filter((job) => open.has(job.browserId))) {
      let job = this.data.jobs.find(
        (item) =>
          item.status === 'pending' &&
          item.browserId === template.browserId &&
          item.url === template.url &&
          !accepted.has(item.id),
      );
      if (!job && pendingCount < 1000) {
        job = {
          id: randomUUID(),
          browserId: template.browserId,
          url: template.url,
          createdAt: Date.now(),
          status: 'pending',
        };
        this.data.jobs.push(job);
        pendingCount++;
      }
      if (job) {
        accepted.add(job.id);
        ids.add(job.browserId);
      }
    }
    this.data.nextRunAt = Date.now() + schedule.intervalMinutes * 60000;
    this.persistSoon();
    if (!accepted.size) return;
    void this.replenishProxies();
    try {
      this.begin([...ids], false, accepted);
    } catch (error) {
      this.logs.add('warn', 'schedule', String(error));
    }
  }

  private cancelBrowserQueue(ids: number[], reason: string): void {
    const selected = new Set(ids);
    for (const id of ids) {
      this.stopped.add(id);
      this.pausedIds.add(id);
      this.acceptedJobs.delete(id);
    }
    for (const job of this.data.jobs)
      if (selected.has(job.browserId) && job.status === 'pending') {
        job.status = 'cancelled';
        job.finishedAt = Date.now();
        job.error = reason;
      }
    this.data.scheduleTemplates = this.data.scheduleTemplates.filter((job) => !selected.has(job.browserId));
  }

  private reviewedPending(ids: number[]): Set<string> {
    const selected = new Set(ids);
    return new Set(
      this.data.jobs
        .filter(
          (job) =>
            selected.has(job.browserId) &&
            job.status === 'pending' &&
            this.acceptedJobs.get(job.browserId)?.has(job.id),
        )
        .map((job) => job.id),
    );
  }

  async command(command: AppCommand): Promise<CommandResult> {
    const simple = command.type === 'simple-distribute' || command.type === 'simple-start';
    const passive =
      [
        'snapshot',
        'refresh-proxies',
        'diagnostic',
        'export-logs',
        'export-results',
        'import-urls',
        'open-release-page',
        'popup',
      ].includes(command.type) ||
      (command.type === 'profile' && command.action === 'storage');
    const control =
      command.type === 'global' ||
      (command.type === 'browser' && ['start', 'pause', 'resume', 'stop', 'close'].includes(command.action));
    if (simple && (this.preparingSimple || this.workspaceMutations))
      throw new Error('Wait for the current browser operation to finish before Distribute or Start.');
    if (
      !passive &&
      !simple &&
      !control &&
      (this.preparingSimple || (this.simpleRun && !this.simpleRun.revoked))
    )
      throw new Error('Stop the reviewed batch before changing its workspace.');
    if (!passive && !simple && !control && this.preparedRun?.status === 'ready')
      this.invalidateSimpleReview('The workspace changed. Distribute again before Start.');
    if (!passive) this.workspaceMutations++;
    try {
      return await this.executeCommand(command);
    } finally {
      if (!passive) this.workspaceMutations--;
    }
  }

  private async executeCommand(command: AppCommand): Promise<CommandResult> {
    let message: string | undefined;
    let importedUrls: string[] | undefined;
    let storageBytes: number | undefined;
    let diagnostic: Record<string, unknown> | undefined;
    switch (command.type) {
      case 'snapshot':
        break;
      case 'simple-distribute':
        await this.prepareSimple(command);
        message = `${this.preparedRun!.jobIds.length} jobs distributed. Start approves only the listed website hosts for this batch.`;
        break;
      case 'simple-start':
        await this.startSimple(command.reviewId, command.confirmed);
        message = 'The reviewed batch is running once.';
        break;
      case 'create':
        this.cancelBrowserQueue(
          this.manager
            .snapshots()
            .filter((item) => item.id > command.count)
            .map((item) => item.id),
          'Browser closed by workspace resize.',
        );
        await this.manager.create(command.count);
        this.data.settings.browserCount = command.count;
        break;
      case 'navigate':
        this.stopped.add(command.id);
        await this.manager.navigate(command.id, command.url);
        break;
      case 'browser':
        if (command.action === 'start') {
          if (this.simpleRun) await this.resumeSimple();
          else this.begin([command.id]);
        } else {
          if (command.action === 'stop' || command.action === 'close') {
            if (this.simpleRun?.starting) this.invalidateSimpleReview('Browser stopped during Start.');
            if (this.simpleRun?.browserIds.has(command.id)) {
              this.stopped.add(command.id);
              this.pausedIds.add(command.id);
              for (const job of this.data.jobs)
                if (
                  job.browserId === command.id &&
                  this.simpleRun.jobIds.has(job.id) &&
                  job.status === 'pending'
                ) {
                  job.status = 'cancelled';
                  job.finishedAt = Date.now();
                  job.error = 'Browser stopped by user.';
                }
            } else this.cancelBrowserQueue([command.id], 'Browser stopped by user.');
          }
          if (command.action === 'pause') this.pausedIds.add(command.id);
          if (
            command.action === 'pause' &&
            this.simpleRun?.starting &&
            this.simpleRun.browserIds.has(command.id)
          )
            break;
          if (command.action === 'resume' && this.simpleRun) {
            await this.resumeSimple();
            break;
          }
          if (command.action === 'resume') this.pausedIds.delete(command.id);
          await this.manager.action(command.id, command.action);
          if (command.action === 'resume' && !this.active.has(command.id)) {
            const reviewed = this.reviewedPending([command.id]);
            if (reviewed.size) this.begin([command.id], false, reviewed);
          }
          this.finishSimpleRun();
        }
        break;
      case 'global': {
        const ids = this.manager.snapshots().map((item) => item.id);
        if (command.action === 'start') {
          if (this.simpleRun) await this.resumeSimple();
          else this.begin(ids);
        } else if (command.action === 'pause') {
          const working = this.manager
            .snapshots()
            .filter(
              (browser) =>
                this.active.has(browser.id) ||
                browser.loading ||
                browser.proxy ||
                [
                  'WAITING_FOR_PROXY',
                  'ASSIGNING_PROXY',
                  'NAVIGATING',
                  'RUNNING',
                  'RETRY_WAIT',
                  'PAUSED',
                ].includes(browser.state),
            );
          if (!this.active.size && !this.scheduleArmed && !this.simpleRun && !working.length) {
            this.paused = false;
            break;
          }
          this.paused = true;
          await Promise.all(
            working
              .map((browser) => browser.id)
              .filter(
                (id) => !this.simpleRun || (!this.simpleRun.starting && this.simpleRun.browserIds.has(id)),
              )
              .map((id) => this.manager.pause(id)),
          );
        } else if (command.action === 'resume') {
          if (this.simpleRun) {
            await this.resumeSimple();
            break;
          }
          this.paused = false;
          for (const id of ids) this.pausedIds.delete(id);
          await Promise.all(ids.map((id) => this.manager.resume(id)));
          const pendingIds = ids.filter((id) => !this.active.has(id));
          const reviewed = this.reviewedPending(pendingIds);
          if (reviewed.size) this.begin(pendingIds, false, reviewed);
        } else {
          const simpleMode =
            !!this.preparedRun || this.preparingSimple || (!this.scheduleArmed && !this.active.size);
          this.scheduleCancellationGeneration++;
          this.scheduleArmed = false;
          if (simpleMode) this.invalidateSimpleReview('Batch stopped by user.');
          else {
            this.data.settings.schedule.enabled = false;
            this.data.scheduleTemplates = [];
            this.data.nextRunAt = null;
          }
          this.acceptedJobs.clear();
          this.paused = false;
          for (const id of ids) this.stopped.add(id);
          try {
            await Promise.all(ids.map((id) => this.manager.stop(id)));
          } finally {
            this.finishSimpleRun();
          }
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
        const resourceLoads: Record<number, number> = {};
        if (command.mode === 'balanced') {
          const metrics = new Map(app.getAppMetrics().map((item) => [item.pid, item]));
          for (const id of command.ids) {
            const sample = metrics.get(this.manager.getWebContents(id).getOSProcessId());
            if (sample)
              resourceLoads[id] =
                sample.cpu.percentCPUUsage / 25 + sample.memory.workingSetSize / (512 * 1024);
          }
        }
        const jobs = distribute({
          ...command,
          existing: this.data.jobs,
          resourceLoads,
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
      case 'edit-job': {
        const job = this.data.jobs.find((item) => item.id === command.id);
        if (!job || job.status !== 'pending') throw new Error('Only a pending job can be edited.');
        if (!this.manager.snapshots().some((browser) => browser.id === command.browserId))
          throw new Error('Reopen the destination browser before editing its assignment.');
        const url = assertApproved(command.url, this.data.settings);
        if (
          this.data.jobs.some(
            (item) =>
              item.id !== job.id &&
              ['pending', 'running'].includes(item.status) &&
              item.browserId === command.browserId &&
              item.url === url,
          )
        )
          throw new Error('This browser already has that URL in its active queue.');
        this.data.scheduleTemplates = this.data.scheduleTemplates.filter(
          (item) => item.browserId !== job.browserId || item.url !== job.url,
        );
        this.acceptedJobs.get(job.browserId)?.delete(job.id);
        job.id = randomUUID();
        job.url = url;
        job.browserId = command.browserId;
        job.error = undefined;
        job.finishedAt = undefined;
        message = 'Assignment updated. Review and Start the edited job when ready.';
        break;
      }
      case 'job':
        {
          const removed = this.data.jobs.find((job) => job.id === command.id && job.status !== 'running');
          if (removed)
            this.data.scheduleTemplates = this.data.scheduleTemplates.filter(
              (job) => job.browserId !== removed.browserId || job.url !== removed.url,
            );
        }
        this.data.jobs = this.data.jobs.filter((job) => job.id !== command.id || job.status === 'running');
        break;
      case 'clear-queue':
        this.scheduleCancellationGeneration++;
        this.data.jobs = this.data.jobs.filter((job) => job.status !== 'pending');
        this.data.scheduleTemplates = [];
        this.scheduleArmed = false;
        this.data.nextRunAt = null;
        this.data.settings.schedule.enabled = false;
        break;
      case 'settings': {
        const next = validateSettings(command.settings);
        if (this.active.size) throw new Error('Stop active QA jobs before changing test settings.');
        const cancellationGeneration = this.scheduleCancellationGeneration;
        await Promise.all(this.manager.snapshots().map((item) => this.manager.stop(item.id)));
        // A later Stop or Clear pending must win over this earlier Save while
        // native cleanup is pending. Preserve every other edited preference.
        if (cancellationGeneration !== this.scheduleCancellationGeneration) next.schedule.enabled = false;
        this.data.settings = next;
        this.cancelBrowserQueue(
          this.manager
            .snapshots()
            .filter((item) => item.id > next.browserCount)
            .map((item) => item.id),
          'Browser closed by settings.',
        );
        this.data.scheduleTemplates = this.data.scheduleTemplates.filter((job) => {
          try {
            assertApproved(job.url, next);
            return true;
          } catch {
            return false;
          }
        });
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
                  preservedJobs: this.data.preservedJobs,
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
    this.simpleGeneration++;
    this.simpleStartAbort?.abort(new Error('Application is closing'));
    if (this.simpleRun) {
      this.simpleRun.revoked = true;
      this.simpleRun.settings = {
        ...this.simpleRun.settings,
        stagingConfirmed: false,
        authorizedDomains: [],
      };
    }
    this.scheduleArmed = false;
    clearInterval(this.pollTimer);
    clearTimeout(this.sendTimer);
    clearTimeout(this.saveTimer);
    for (const id of this.active.keys()) this.stopped.add(id);
    const failures: unknown[] = [];
    try {
      await this.manager.shutdown();
    } catch (error) {
      failures.push(error);
    }
    try {
      await withDeadline(Promise.allSettled(this.active.values()), 30000);
    } catch (error) {
      failures.push(error);
    }
    this.data.budget = this.budget.snapshot();
    this.data.requestBudget = this.requestBudget.snapshot();
    this.logs.add(
      failures.length ? 'warn' : 'info',
      'application',
      failures.length
        ? 'Browser cleanup reported errors; preserving application state for recovery.'
        : 'Browser sessions flushed; application is stopping.',
    );
    for (const result of await Promise.allSettled([this.store.save(this.data), this.logs.flush()]))
      if (result.status === 'rejected') failures.push(result.reason);
    if (failures.length)
      throw new AggregateError(failures, 'Application shutdown encountered cleanup errors');
  }
}
