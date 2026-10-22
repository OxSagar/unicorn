import type { Session } from 'electron';
import type { ProxyRecord } from '../../shared/types';
import { withDeadline } from '../browser/deadline';

export const BLOCKED_PROXY = 'http://127.0.0.1:9';

export function proxyRule(proxy: ProxyRecord): string {
  const host = proxy.ip.includes(':') ? `[${proxy.ip}]` : proxy.ip;
  return `${proxy.protocol}://${host}:${proxy.port}`;
}

export interface GateHooks {
  approveNavigation(url: string, mainFrame: boolean): void;
  onFailure(message: string, mainFrame: boolean): void;
  onRestricted(status: number, url: string): void;
}

/** A session stays blocked before assignment, on pause/stop, and after failure. */
export class SessionGate {
  private enabled = false;
  private chain: Promise<void> = Promise.resolve();
  private headersEnabled = false;
  private generation = 0;

  constructor(
    readonly session: Session,
    private readonly hooks: GateHooks,
  ) {
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    session.setSpellCheckerEnabled(false);
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (details.url === 'about:blank') return callback({});
      if (!this.enabled) return callback({ cancel: true });
      try {
        const protocol = new URL(details.url).protocol;
        if (!['https:', 'http:', 'wss:', 'ws:', 'blob:', 'data:'].includes(protocol)) {
          return callback({ cancel: true });
        }
        if (
          details.resourceType === 'mainFrame' ||
          details.resourceType === 'subFrame' ||
          (this.headersEnabled && ['https:', 'http:', 'wss:', 'ws:'].includes(protocol))
        ) {
          const scopeUrl = details.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
          this.hooks.approveNavigation(scopeUrl, details.resourceType === 'mainFrame');
        }
        callback({});
      } catch (error) {
        this.hooks.onFailure(
          error instanceof Error ? error.message : String(error),
          details.resourceType === 'mainFrame',
        );
        callback({ cancel: true });
      }
    });
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const requestHeaders = { ...details.requestHeaders };
      if (this.headersEnabled) requestHeaders['X-Unicorn-Synthetic-Test'] = '1';
      callback({ requestHeaders });
    });
    session.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType === 'mainFrame' && [401, 403, 429].includes(details.statusCode)) {
        this.enabled = false;
        this.hooks.onRestricted(details.statusCode, details.url);
      }
      callback({});
    });
    session.webRequest.onErrorOccurred((details) => {
      if (this.enabled && !['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT'].includes(details.error)) {
        this.hooks.onFailure(details.error, details.resourceType === 'mainFrame');
      }
    });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.chain.catch(() => undefined).then(task);
    this.chain = run;
    return run;
  }

  async block(): Promise<void> {
    this.generation++;
    this.enabled = false;
    this.headersEnabled = false;
    await this.serial(async () => {
      await withDeadline(
        this.session.setProxy({
          mode: 'fixed_servers',
          proxyRules: BLOCKED_PROXY,
          proxyBypassRules: '<-loopback>',
        }),
        8000,
      );
      await withDeadline(this.session.closeAllConnections(), 8000);
    });
  }

  async assign(proxy: ProxyRecord, signal: AbortSignal, synthetic: boolean): Promise<void> {
    const generation = ++this.generation;
    this.enabled = false;
    await this.serial(async () => {
      signal.throwIfAborted();
      await withDeadline(this.session.closeAllConnections(), 8000, signal);
      await withDeadline(
        this.session.setProxy({
          mode: 'fixed_servers',
          proxyRules: proxyRule(proxy),
          proxyBypassRules: '<-loopback>',
        }),
        8000,
        signal,
      );
      signal.throwIfAborted();
      const resolution = await withDeadline(
        this.session.resolveProxy('https://unicorn.invalid/'),
        8000,
        signal,
      );
      signal.throwIfAborted();
      if (generation !== this.generation)
        throw new Error('Proxy assignment was superseded by a network stop');
      if (/\bDIRECT\b/i.test(resolution) || !/^(PROXY|HTTPS|SOCKS5) /i.test(resolution)) {
        throw new Error(`Unsafe proxy resolution: ${resolution}`);
      }
      this.headersEnabled = synthetic;
      this.enabled = true;
    });
  }

  dispose(): void {
    this.generation++;
    this.enabled = false;
    // Keep the deny request handler for persisted service workers after a view closes.
    this.session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (_details, callback) =>
      callback({ cancel: true }),
    );
    this.session.webRequest.onBeforeSendHeaders(null);
    this.session.webRequest.onHeadersReceived(null);
    this.session.webRequest.onErrorOccurred(null);
  }
}
