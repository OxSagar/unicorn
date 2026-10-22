import { session, type Session } from 'electron';
import { isIP } from 'node:net';
import { COUNTRIES, type CountryCode, type ProxyRecord } from '../../shared/types';
import { BLOCKED_PROXY, proxyRule } from './session-gate';

interface Slot {
  id: number;
  busy: boolean;
  session?: Session;
}
const slots: Slot[] = Array.from({ length: 4 }, (_, id) => ({ id, busy: false }));
const pending: Array<() => void> = [];

async function reserve(signal: AbortSignal): Promise<Slot> {
  for (;;) {
    signal.throwIfAborted();
    const slot = slots.find((item) => !item.busy);
    if (slot) {
      slot.busy = true;
      return slot;
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        const index = pending.indexOf(wake);
        if (index >= 0) pending.splice(index, 1);
        reject(signal.reason);
      };
      pending.push(wake);
      signal.addEventListener('abort', abort, { once: true });
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
  const endpoint = new URL(diagnosticUrl);
  const fixture =
    proxy.source === 'fixture' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !(fixture && endpoint.protocol === 'http:'))
    throw new Error('Proxy verification requires HTTPS');
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  const slot = await reserve(combined);
  const ses =
    slot.session ?? (slot.session = session.fromPartition(`unicorn-validator-${slot.id}`, { cache: false }));
  let allowed = false;
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    callback({ cancel: !allowed || details.url !== endpoint.href });
  });
  const started = performance.now();
  try {
    await ses.closeAllConnections();
    await ses.setProxy({
      mode: 'fixed_servers',
      proxyRules: proxyRule(proxy),
      proxyBypassRules: '<-loopback>',
    });
    combined.throwIfAborted();
    const resolution = await ses.resolveProxy(endpoint.href);
    if (/\bDIRECT\b/i.test(resolution)) throw new Error('Proxy verification resolved to a direct connection');
    allowed = true;
    const response = await ses.fetch(endpoint.href, {
      signal: combined,
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(`Proxy diagnostic returned HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Proxy diagnostic returned an empty body');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 32768) {
        await reader.cancel();
        throw new Error('Proxy diagnostic response exceeds limit');
      }
      chunks.push(chunk.value);
    }
    const text = Buffer.concat(chunks, bytes).toString('utf8');
    const data = JSON.parse(text) as Record<string, unknown>;
    if (data.success !== true || typeof data.ip !== 'string' || !isIP(data.ip))
      throw new Error('Proxy diagnostic returned invalid exit IP');
    if (typeof data.country_code !== 'string' || !COUNTRIES.includes(data.country_code as CountryCode))
      throw new Error('Proxy exit country is not permitted');
    if (data.country_code !== proxy.country)
      throw new Error(`Proxy country changed: expected ${proxy.country}, observed ${data.country_code}`);
    return {
      exitIp: data.ip,
      country: data.country_code as CountryCode,
      latencyMs: Math.round(performance.now() - started),
    };
  } finally {
    allowed = false;
    await ses
      .setProxy({ mode: 'fixed_servers', proxyRules: BLOCKED_PROXY, proxyBypassRules: '<-loopback>' })
      .catch(() => undefined);
    await ses.closeAllConnections().catch(() => undefined);
    await ses.clearStorageData().catch(() => undefined);
    slot.busy = false;
    pending.shift()?.();
  }
}
