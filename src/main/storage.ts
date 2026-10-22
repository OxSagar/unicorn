import { mkdir, readFile, rename, writeFile, appendFile, stat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { ActivityEvent, AppSettings, BrowserSnapshot, DeviceConfig, TestJob } from '../shared/types';
import {
  assertApproved,
  hasControlCharacters,
  normalizeDomain,
  normalizeUrl,
  type BudgetSnapshot,
} from './core/scope';
import { validateDevice, validateSettings } from './core/validation';

export interface StoredProfile {
  device?: DeviceConfig;
  history?: BrowserSnapshot['history'];
}
export interface StoredData {
  schemaVersion: 1;
  settings: AppSettings;
  profiles: Record<number, StoredProfile>;
  jobs: TestJob[];
  scheduleTemplates: Array<{ browserId: number; url: string }>;
  budget?: BudgetSnapshot;
  totals: { completed: number; failed: number; navigations: number; jsErrors: number; networkErrors: number };
  nextRunAt: number | null;
}
export function initialData(): StoredData {
  return {
    schemaVersion: 1,
    settings: structuredClone(DEFAULT_SETTINGS),
    profiles: {},
    jobs: [],
    scheduleTemplates: [],
    totals: { completed: 0, failed: 0, navigations: 0, jsErrors: 0, networkErrors: 0 },
    nextRunAt: null,
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function browserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 20;
}

function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
}

function restoreProfiles(input: unknown, settings: AppSettings): Record<number, StoredProfile> {
  const profiles: Record<number, StoredProfile> = {};
  if (!object(input)) return profiles;
  for (let id = 1; id <= 20; id++) {
    const record = input[String(id)];
    if (!object(record)) continue;
    const profile: StoredProfile = {};
    try {
      if (record.device !== undefined) profile.device = validateDevice(record.device);
    } catch {
      // A damaged device preference must not discard the browser's valid history or other profiles.
    }
    if (Array.isArray(record.history)) {
      profile.history = [];
      for (const entry of record.history.slice(-200)) {
        if (
          !object(entry) ||
          typeof entry.url !== 'string' ||
          typeof entry.title !== 'string' ||
          !timestamp(entry.at)
        )
          continue;
        try {
          profile.history.push({
            url: normalizeUrl(entry.url, settings),
            title: entry.title.slice(0, 512),
            at: entry.at,
          });
        } catch {
          // History is display data; unsafe or corrupted URLs are not restored into controls.
        }
      }
    }
    profiles[id] = profile;
  }
  return profiles;
}

function restoreJobs(input: unknown, settings: AppSettings): TestJob[] {
  if (!Array.isArray(input)) return [];
  const jobs: TestJob[] = [];
  const ids = new Set<string>();
  for (const record of input.slice(-1000)) {
    if (
      !object(record) ||
      typeof record.id !== 'string' ||
      !record.id.length ||
      record.id.length > 128 ||
      hasControlCharacters(record.id) ||
      ids.has(record.id) ||
      !browserId(record.browserId) ||
      typeof record.url !== 'string' ||
      typeof record.status !== 'string' ||
      !['pending', 'running', 'completed', 'failed', 'cancelled'].includes(record.status) ||
      !timestamp(record.createdAt)
    )
      continue;
    try {
      const job: TestJob = {
        id: record.id,
        browserId: record.browserId,
        url: normalizeUrl(record.url, settings),
        status: record.status === 'running' ? 'pending' : (record.status as TestJob['status']),
        createdAt: record.createdAt,
      };
      if (timestamp(record.finishedAt)) job.finishedAt = record.finishedAt;
      if (typeof record.error === 'string') job.error = redactMessage(record.error);
      if (record.status === 'running') {
        delete job.finishedAt;
        job.error = 'Interrupted run recovered; awaiting eligible restart.';
      }
      jobs.push(job);
      ids.add(job.id);
    } catch {
      // Invalid queue rows are isolated from valid settings and jobs.
    }
  }
  return jobs;
}

function restoreTemplates(input: unknown, settings: AppSettings): StoredData['scheduleTemplates'] {
  if (!Array.isArray(input)) return [];
  const templates: StoredData['scheduleTemplates'] = [];
  for (const record of input.slice(0, 1000)) {
    if (
      !object(record) ||
      !browserId(record.browserId) ||
      record.browserId > settings.browserCount ||
      typeof record.url !== 'string'
    )
      continue;
    try {
      templates.push({ browserId: record.browserId, url: assertApproved(record.url, settings) });
    } catch {
      // Recurrence may only restore explicitly saved, currently authorized destinations.
    }
  }
  return templates;
}

function restoreBudget(input: unknown): BudgetSnapshot | undefined {
  if (
    !object(input) ||
    typeof input.day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(input.day) ||
    !object(input.counts)
  )
    return undefined;
  const counts = new Map<string, number>();
  for (const [domain, count] of Object.entries(input.counts)) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) continue;
    try {
      const normalized = normalizeDomain(domain);
      if (!normalized.startsWith('*.')) counts.set(normalized, Math.max(count, counts.get(normalized) ?? 0));
    } catch {
      // An invalid counter cannot create a usable destination or affect another domain.
    }
  }
  return { day: input.day, counts: Object.fromEntries(counts) };
}

/** A single serialized writer and same-directory atomic rename protect small local settings. */
export class LocalStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  async load(): Promise<StoredData> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const info = await stat(path.join(this.directory, 'state.json'));
      if (info.size > 64 * 1024 * 1024) throw new Error('Saved state exceeds the supported size');
      const parsed: unknown = JSON.parse(await readFile(path.join(this.directory, 'state.json'), 'utf8'));
      if (!object(parsed) || parsed.schemaVersion !== 1) throw new Error('Unsupported settings schema');
      const settings = validateSettings(parsed.settings);
      const value = initialData();
      value.settings = settings;
      value.profiles = restoreProfiles(parsed.profiles, settings);
      value.jobs = restoreJobs(parsed.jobs, settings);
      value.scheduleTemplates = restoreTemplates(parsed.scheduleTemplates, settings);
      value.budget = restoreBudget(parsed.budget);
      const totals = parsed.totals;
      const fields = ['completed', 'failed', 'navigations', 'jsErrors', 'networkErrors'] as const;
      if (
        object(totals) &&
        fields.every(
          (key) => typeof totals[key] === 'number' && Number.isSafeInteger(totals[key]) && totals[key] >= 0,
        )
      )
        for (const key of fields) value.totals[key] = totals[key] as number;
      value.nextRunAt = timestamp(parsed.nextRunAt) ? parsed.nextRunAt : null;
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rename(
          path.join(this.directory, 'state.json'),
          path.join(this.directory, `state.corrupt-${Date.now()}-${randomUUID()}.json`),
        ).catch(() => undefined);
      }
      return initialData();
    }
  }
  save(data: StoredData): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    const task = this.pending
      .catch(() => undefined)
      .then(async () => {
        const temp = path.join(this.directory, 'state.json.tmp');
        await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 });
        await rename(temp, path.join(this.directory, 'state.json'));
      });
    this.pending = task;
    return task;
  }
  flush(): Promise<void> {
    return this.pending;
  }
}

export function redactMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s)]+/gi, (raw) => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[redacted URL]';
      }
    })
    .slice(0, 2000);
}
export class ActivityLog {
  private records: ActivityEvent[] = [];
  private pending: Promise<void> = Promise.resolve();
  private pendingWrites = 0;
  private backlogReported = false;
  private bytes = 0;
  private enabled = true;
  constructor(private readonly directory: string) {}
  async initialize(retentionDays: number): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const name of ['activity.jsonl', 'activity.1.jsonl', 'activity.2.jsonl']) {
        const file = path.join(this.directory, name);
        const info = await stat(file).catch(() => undefined);
        if (info?.isFile() && Date.now() - info.mtimeMs > retentionDays * 86400000) await rm(file);
      }
      this.bytes =
        (await stat(path.join(this.directory, 'activity.jsonl')).catch(() => undefined))?.size ?? 0;
    } catch (error) {
      this.stopDiskLogging(error);
    }
  }
  private remember(record: ActivityEvent): void {
    this.records.push(record);
    if (this.records.length > 2000) this.records.splice(0, this.records.length - 2000);
  }
  private stopDiskLogging(error: unknown): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.remember({
      id: randomUUID(),
      at: Date.now(),
      level: 'error',
      category: 'storage',
      message: redactMessage(`Disk logging stopped: ${String(error)}`),
    });
  }
  private async rotate(source: string, destination: string): Promise<void> {
    try {
      await rename(path.join(this.directory, source), path.join(this.directory, destination));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  add(level: ActivityEvent['level'], category: string, message: string, browserId?: number): void {
    const record: ActivityEvent = {
      id: randomUUID(),
      at: Date.now(),
      level,
      category: category.slice(0, 80),
      message: redactMessage(message),
      browserId,
    };
    this.remember(record);
    if (!this.enabled) return;
    // A stalled disk cannot turn an event flood into an unbounded chain of retained promises.
    if (this.pendingWrites >= 4096) {
      if (!this.backlogReported) {
        this.backlogReported = true;
        this.remember({
          id: randomUUID(),
          at: Date.now(),
          level: 'warn',
          category: 'storage',
          message:
            'Disk log backlog is full; new events are retained in bounded in-memory history until writes catch up.',
        });
      }
      return;
    }
    this.pendingWrites++;
    const content = `${JSON.stringify(record)}\n`;
    const size = Buffer.byteLength(content);
    this.pending = this.pending
      .then(async () => {
        if (!this.enabled) return;
        if (this.bytes + size > 5 * 1024 * 1024) {
          await rm(path.join(this.directory, 'activity.2.jsonl'), { force: true });
          await this.rotate('activity.1.jsonl', 'activity.2.jsonl');
          await this.rotate('activity.jsonl', 'activity.1.jsonl');
          this.bytes = 0;
        }
        await appendFile(path.join(this.directory, 'activity.jsonl'), content, { mode: 0o600 });
        this.bytes += size;
      })
      .catch((error) => this.stopDiskLogging(error))
      .finally(() => {
        this.pendingWrites--;
        if (this.pendingWrites === 0) this.backlogReported = false;
      });
  }
  list(limit = 500): ActivityEvent[] {
    const count = Number.isFinite(limit) ? Math.min(2000, Math.max(0, Math.floor(limit))) : 0;
    return count
      ? this.records
          .slice(-count)
          .reverse()
          .map((record) => ({ ...record }))
      : [];
  }
  flush(): Promise<void> {
    return this.pending;
  }
}
