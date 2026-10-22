import { mkdir, readFile, rename, writeFile, appendFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import type { ActivityEvent, AppSettings, BrowserSnapshot, DeviceConfig, TestJob } from '../shared/types';
import type { BudgetSnapshot } from './core/scope';
import { validateSettings } from './core/validation';

export interface StoredProfile {
  device?: DeviceConfig;
  history?: BrowserSnapshot['history'];
}
export interface StoredData {
  schemaVersion: 1;
  settings: AppSettings;
  profiles: Record<number, StoredProfile>;
  jobs: TestJob[];
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
    totals: { completed: 0, failed: 0, navigations: 0, jsErrors: 0, networkErrors: 0 },
    nextRunAt: null,
  };
}

/** A single serialized writer and same-directory atomic rename protect small local settings. */
export class LocalStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly directory: string) {}
  async load(): Promise<StoredData> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(
        await readFile(path.join(this.directory, 'state.json'), 'utf8'),
      ) as StoredData;
      if (parsed.schemaVersion !== 1) throw new Error('Unsupported settings schema');
      const settings = validateSettings(parsed.settings);
      const value = initialData();
      value.settings = settings;
      value.profiles = parsed.profiles && typeof parsed.profiles === 'object' ? parsed.profiles : {};
      value.jobs = Array.isArray(parsed.jobs)
        ? parsed.jobs
            .slice(-1000)
            .filter(
              (job) =>
                typeof job.id === 'string' &&
                Number.isInteger(job.browserId) &&
                job.browserId >= 1 &&
                job.browserId <= 20 &&
                typeof job.url === 'string' &&
                ['pending', 'running', 'completed', 'failed', 'cancelled'].includes(job.status),
            )
            .map((job) =>
              job.status === 'running'
                ? {
                    ...job,
                    status: 'pending' as const,
                    error: 'Interrupted run recovered; awaiting eligible restart.',
                  }
                : job,
            )
        : [];
      value.budget = parsed.budget;
      if (parsed.totals && Object.values(parsed.totals).every((n) => Number.isSafeInteger(n) && n >= 0))
        value.totals = parsed.totals;
      value.nextRunAt = typeof parsed.nextRunAt === 'number' ? parsed.nextRunAt : null;
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await rename(
          path.join(this.directory, 'state.json'),
          path.join(this.directory, `state.corrupt-${Date.now()}.json`),
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
  private bytes = 0;
  private enabled = true;
  constructor(private readonly directory: string) {}
  async initialize(retentionDays: number): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of ['activity.jsonl', 'activity.1.jsonl', 'activity.2.jsonl']) {
      const file = path.join(this.directory, name);
      const info = await stat(file).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > retentionDays * 86400000) await rm(file);
    }
    this.bytes = (await stat(path.join(this.directory, 'activity.jsonl')).catch(() => undefined))?.size ?? 0;
  }
  add(level: ActivityEvent['level'], category: string, message: string, browserId?: number): void {
    const record: ActivityEvent = {
      id: crypto.randomUUID(),
      at: Date.now(),
      level,
      category,
      message: redactMessage(message),
      browserId,
    };
    this.records.push(record);
    if (this.records.length > 2000) this.records.splice(0, this.records.length - 2000);
    if (!this.enabled) return;
    const content = `${JSON.stringify(record)}\n`;
    this.pending = this.pending
      .then(async () => {
        if (this.bytes > 5 * 1024 * 1024) {
          await rm(path.join(this.directory, 'activity.2.jsonl'), { force: true });
          await rename(
            path.join(this.directory, 'activity.1.jsonl'),
            path.join(this.directory, 'activity.2.jsonl'),
          ).catch(() => undefined);
          await rename(
            path.join(this.directory, 'activity.jsonl'),
            path.join(this.directory, 'activity.1.jsonl'),
          ).catch(() => undefined);
          this.bytes = 0;
        }
        await appendFile(path.join(this.directory, 'activity.jsonl'), content, { mode: 0o600 });
        this.bytes += Buffer.byteLength(content);
      })
      .catch((error) => {
        this.enabled = false;
        this.records.push({
          id: crypto.randomUUID(),
          at: Date.now(),
          level: 'error',
          category: 'storage',
          message: `Disk logging stopped: ${redactMessage(String(error))}`,
        });
      });
  }
  list(limit = 500): ActivityEvent[] {
    return this.records.slice(-limit).reverse();
  }
  flush(): Promise<void> {
    return this.pending;
  }
}
