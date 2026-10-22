import { randomUUID } from 'node:crypto';
import type { DistributionMode, TestJob } from '../../shared/types';
import { normalizeUrl } from './scope';

/** RFC 4180 quoting, including escaped quotes and embedded newlines; first URL column is used. */
export function importUrls(text: string, format?: 'txt' | 'csv'): string[] {
  if (typeof text !== 'string' || text.length > 5 * 1024 * 1024) throw new Error('URL import exceeds 5 MB');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  const firstLine = input.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const isCsv =
    format === 'csv' ||
    (format !== 'txt' &&
      (firstLine.startsWith('"') ||
        firstLine
          .split(',')
          .some((value) => ['url', 'link', 'address'].includes(value.trim().toLowerCase()))));
  if (!isCsv) {
    const result = input
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => value && !value.startsWith('#'));
    if (result.length > 5000) throw new Error('Import supports up to 5,000 URLs');
    return result;
  }
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted || field.length === 0) quoted = !quoted;
      else field += char;
    } else if (char === ',' && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (rows.length > 5000) throw new Error('Import supports up to 5,000 URLs');
    } else field += char;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field');
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows[0]?.map((value) => value.trim().toLowerCase()) ?? [];
  const urlColumn = header.findIndex((value) => ['url', 'link', 'address'].includes(value));
  const body = urlColumn >= 0 ? rows.slice(1) : rows;
  const result = body
    .map((fields) => (fields[urlColumn >= 0 ? urlColumn : 0] ?? '').trim())
    .filter((value) => value && !value.startsWith('#'));
  if (result.length > 5000) throw new Error('Import supports up to 5,000 URLs');
  return result;
}

export interface DistributionOptions {
  urls: string[];
  ids: number[];
  mode: DistributionMode;
  existing?: TestJob[];
  manual?: Record<string, number>;
  allowDuplicates?: boolean;
  allowLocalhost?: boolean;
  now?: number;
}
export function distribute(options: DistributionOptions): TestJob[] {
  const { urls, mode, existing = [], allowDuplicates = false } = options;
  const ids = [...new Set(options.ids)];
  if (!ids.length || ids.some((id) => !Number.isInteger(id) || id < 1 || id > 20))
    throw new Error('Select valid browser IDs from 1 to 20');
  if (!urls.length || urls.length > 5000) throw new Error('Provide between 1 and 5,000 URLs');
  if (!['same', 'round-robin', 'balanced', 'manual'].includes(mode))
    throw new Error('Unknown distribution mode');
  if (mode === 'same' && urls.length !== 1) throw new Error('Same URL to all requires exactly one URL');
  const normalized = urls.map((url) => normalizeUrl(url, options));
  const pending = existing.filter((job) => job.status === 'pending' || job.status === 'running');
  const queued = new Set(pending.map((job) => `${job.browserId}\n${job.url}`));
  const pendingUrls = new Set(pending.map((job) => job.url));
  const inputSeen = new Set<string>();
  const loads = new Map(ids.map((id) => [id, pending.filter((job) => job.browserId === id).length]));
  const jobs: TestJob[] = [];
  let roundRobin = 0;
  normalized.forEach((url, index) => {
    if (!allowDuplicates && inputSeen.has(url)) return;
    if (!allowDuplicates && mode !== 'same' && pendingUrls.has(url)) return;
    inputSeen.add(url);
    let targets: number[];
    if (mode === 'same') targets = ids;
    else if (mode === 'manual') {
      const target =
        options.manual?.[String(index)] ?? options.manual?.[url] ?? options.manual?.[urls[index]!];
      if (!target || !ids.includes(target)) throw new Error(`Choose a selected browser for URL ${index + 1}`);
      targets = [target];
    } else if (mode === 'balanced')
      targets = [
        [...ids].sort((a, b) => loads.get(a)! - loads.get(b)! || ids.indexOf(a) - ids.indexOf(b))[0]!,
      ];
    else targets = [ids[roundRobin++ % ids.length]!];
    for (const browserId of targets) {
      const key = `${browserId}\n${url}`;
      if (!allowDuplicates && queued.has(key)) continue;
      queued.add(key);
      jobs.push({
        id: randomUUID(),
        browserId,
        url,
        status: 'pending',
        createdAt: options.now ?? Date.now(),
      });
      loads.set(browserId, loads.get(browserId)! + 1);
      if (pending.length + jobs.length > 5000) throw new Error('Pending queue is limited to 5,000 jobs');
    }
  });
  return jobs;
}
