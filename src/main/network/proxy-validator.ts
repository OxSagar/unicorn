import { session, type Session } from 'electron';
import { isIP } from 'node:net';
import { COUNTRIES, type CountryCode, type ProxyRecord } from '../../shared/types';
import { BLOCKED_PROXY, proxyRule } from './session-gate';

interface Slot {
  id: number;
  busy: boolean;
  retired?: string;
  session?: Session;
}
const slots: Slot[] = Array.from({ length: 4 }, (_, id) => ({ id, busy: false }));
const pending = new Set<() => void>();
const CLEANUP_TIMEOUT_MS = 2000;

function wakeWaiters(): void {
  for (const wake of [...pending]) wake();
}

function retire(slot: Slot, reason: string): void {
  slot.retired ??= reason;
  wakeWaiters();
}

/** Observes settlement without trusting an Electron/native promise to honor AbortSignal. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (success: boolean, value: unknown) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', abort);
      if (success) resolve(value as T);
      else reject(value);
    };
    const abort = () => finish(false, signal.reason ?? new Error('Proxy validation cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => finish(true, value),
      (error) => finish(false, error),
    );
    if (signal.aborted) abort();
  });
}

async function nativeOperation<T>(
  slot: Slot,
  signal: AbortSignal,
  name: string,
  work: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let settled = false;
  const operation = work();
  void operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    return await untilAborted(operation, signal);
  } catch (error) {
    // An old setProxy/resolve/close IPC may still finish later. This partition must never be reused.
    if (!settled) retire(slot, `${name} did not settle before cancellation`);
    throw error;
  }
}

function track<T>(work: Promise<T>, outstanding: Set<Promise<unknown>>): Promise<T> {
  outstanding.add(work);
  void work.then(
    () => outstanding.delete(work),
    () => outstanding.delete(work),
  );
  return work;
}

async function reserve(signal: AbortSignal): Promise<Slot> {
  for (;;) {
    signal.throwIfAborted();
    const slot = slots.find((item) => !item.busy && !item.retired);
    if (slot) {
      slot.busy = true;
      return slot;
    }
    if (slots.every((item) => item.retired))
      throw new Error(
        'All proxy-validation sessions are unavailable after native network failures; restart Unicorn to recover.',
      );
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        pending.delete(wake);
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        pending.delete(wake);
        reject(signal.reason);
      };
      pending.add(wake);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }
}

export async function validateProxy(
  proxy: ProxyRecord,
  timeoutMs: number,
  signal?: AbortSignal,
  diagnosticUrl = 'https://ipwho.is/',
): Promise<{ exitIp: string; country: CountryCode; latencyMs: number }> {
  if (!isIP(proxy.ip) || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65535)
    throw new Error('Invalid proxy endpoint');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Proxy validation timeout must be between 1 and 60,000 milliseconds');
  const endpoint = new URL(diagnosticUrl);
  const fixture =
    proxy.source === 'fixture' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(fixture && endpoint.protocol === 'http:'))
    throw new Error('Proxy verification requires HTTPS');
  if (endpoint.username || endpoint.password || endpoint.hash)
    throw new Error('Proxy diagnostic URL must not contain credentials or a fragment');
  const cancellation = new AbortController();
  const combined = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
  const timeout = setTimeout(
    () => cancellation.abort(new Error(`Proxy validation timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  let slot: Slot | undefined;
  let ses: Session | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bodyComplete = false;
  const outstanding = new Set<Promise<unknown>>();
  let allowed = false;
  const started = performance.now();
  let result: { exitIp: string; country: CountryCode; latencyMs: number } | undefined;
  let failed = false;
  let failure: unknown;
  try {
    slot = await reserve(combined);
    combined.throwIfAborted();
    ses =
      slot.session ??
      (slot.session = session.fromPartition(`unicorn-validator-${slot.id}`, { cache: false }));
    const current = ses;
    current.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: !allowed || combined.aborted || details.url !== endpoint.href });
    });
    await nativeOperation(slot, combined, 'Connection cleanup', () => current.closeAllConnections());
    await nativeOperation(slot, combined, 'Proxy configuration', () =>
      current.setProxy({
        mode: 'fixed_servers',
        proxyRules: proxyRule(proxy),
        proxyBypassRules: '<-loopback>',
      }),
    );
    combined.throwIfAborted();
    const resolution = await nativeOperation(slot, combined, 'Proxy resolution', () =>
      current.resolveProxy(endpoint.href),
    );
    combined.throwIfAborted();
    if (/\bDIRECT\b/i.test(resolution) || !/^(PROXY|HTTPS|SOCKS5) /i.test(resolution))
      throw new Error('Proxy verification resolved to an unsafe connection');
    allowed = true;
    const lease = slot;
    const request = current
      .fetch(endpoint.href, {
        signal: combined,
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
      })
      .then(async (response) => {
        if (combined.aborted) {
          try {
            await response.body?.cancel();
          } catch (error) {
            retire(lease, 'Cancelled diagnostic response did not close');
            throw error;
          }
          throw combined.reason;
        }
        return response;
      });
    const response = await untilAborted(track(request, outstanding), combined);
    if (!response.ok) throw new Error(`Proxy diagnostic returned HTTP ${response.status}`);
    reader = response.body?.getReader();
    if (!reader) throw new Error('Proxy diagnostic returned an empty body');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await untilAborted(track(reader.read(), outstanding), combined);
      if (chunk.done) {
        bodyComplete = true;
        break;
      }
      bytes += chunk.value.byteLength;
      if (bytes > 32768) {
        throw new Error('Proxy diagnostic response exceeds limit');
      }
      chunks.push(chunk.value);
    }
    const text = Buffer.concat(chunks, bytes).toString('utf8');
    const data = JSON.parse(text) as Record<string, unknown>;
    if (!data || data.success !== true || typeof data.ip !== 'string' || !isIP(data.ip))
      throw new Error('Proxy diagnostic returned invalid exit IP');
    if (typeof data.country_code !== 'string' || !COUNTRIES.includes(data.country_code as CountryCode))
      throw new Error('Proxy exit country is not permitted');
    if (data.country_code !== proxy.country)
      throw new Error(`Proxy country changed: expected ${proxy.country}, observed ${data.country_code}`);
    result = {
      exitIp: data.ip,
      country: data.country_code as CountryCode,
      latencyMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    allowed = false;
    clearTimeout(timeout);
    cancellation.abort(new Error('Proxy validation finished'));
    if (reader && !bodyComplete) {
      try {
        track(reader.cancel(), outstanding);
      } catch {
        /* The reader may already be closed. */
      }
    }
    if (slot && ses) {
      const current = ses;
      const cleanup = new AbortController();
      const cleanupTimeout = setTimeout(
        () => cleanup.abort(new Error('Proxy validation cleanup timed out')),
        CLEANUP_TIMEOUT_MS,
      );
      try {
        if (!slot.retired) {
          await nativeOperation(slot, cleanup.signal, 'Cleanup proxy configuration', () =>
            current.setProxy({
              mode: 'fixed_servers',
              proxyRules: BLOCKED_PROXY,
              proxyBypassRules: '<-loopback>',
            }),
          );
          await nativeOperation(slot, cleanup.signal, 'Cleanup connection close', () =>
            current.closeAllConnections(),
          );
          await nativeOperation(slot, cleanup.signal, 'Cleanup storage reset', () =>
            current.clearStorageData(),
          );
          // Ordinary fetch aborts settle during completed cleanup and do not retire healthy slots.
          // An ignored abort/close must settle before the same session can validate another endpoint.
          await untilAborted(Promise.allSettled([...outstanding]), cleanup.signal);
        } else {
          await untilAborted(current.closeAllConnections(), cleanup.signal);
        }
      } catch (error) {
        retire(slot, 'Validation cleanup did not complete safely');
        // The request gate remains closed forever for this retired partition.
        void Promise.resolve()
          .then(() => current.closeAllConnections())
          .catch(() => undefined);
        if (!failed) {
          failed = true;
          failure = error;
        }
      } finally {
        clearTimeout(cleanupTimeout);
      }
    } else if (slot) {
      retire(slot, 'Validation session could not initialize');
    }
    if (slot) {
      slot.busy = false;
      wakeWaiters();
    }
  }
  if (failed) throw failure;
  return result!;
}
