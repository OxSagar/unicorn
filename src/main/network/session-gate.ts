import type { Session } from 'electron';
import type { ProxyRecord } from '../../shared/types';
import { withDeadline } from '../browser/deadline';
import { SiteRestrictionError } from './site-restriction';

export const BLOCKED_PROXY = 'http://127.0.0.1:9';

export function proxyRule(proxy: ProxyRecord): string {
  const host = proxy.ip.includes(':') ? `[${proxy.ip}]` : proxy.ip;
  return `${proxy.protocol}://${host}:${proxy.port}`;
}

export interface GateHooks {
  approveRequest?(url: string): void;
  approveNavigation(url: string, mainFrame: boolean): void;
  onFailure(message: string, mainFrame: boolean): void;
  onRestricted(status: number, url: string): void;
  onPolicyRestricted?(error: SiteRestrictionError): void;
}

interface GateSessionState {
  chain: Promise<void>;
  generation: number;
  poisoned?: Error;
}

// Electron keeps persistent Session objects when views close. A late native proxy
// mutation must never regain a usable request gate, even after the view is reopened.
const sessionStates = new WeakMap<Session, GateSessionState>();

/** A session stays blocked before assignment, on pause/stop, and after failure. */
export class SessionGate {
  private enabled = false;
  private readonly state: GateSessionState;
  private headersEnabled = false;
  private enabledGeneration?: number;

  constructor(
    readonly session: Session,
    private readonly hooks: GateHooks,
  ) {
    this.state = sessionStates.get(session) ?? { chain: Promise.resolve(), generation: 0 };
    sessionStates.set(session, this.state);
    this.state.generation++;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.setDevicePermissionHandler(() => false);
    session.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    session.setSpellCheckerEnabled(false);
    session.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      if (details.url === 'about:blank') return callback({});
      if (!this.isEnabled) return callback({ cancel: true });
      try {
        const protocol = new URL(details.url).protocol;
        if (!['https:', 'http:', 'wss:', 'ws:', 'blob:', 'data:'].includes(protocol)) {
          return callback({ cancel: true });
        }
        const scopeUrl = details.url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
        if (['https:', 'http:', 'wss:', 'ws:'].includes(protocol)) this.hooks.approveRequest?.(scopeUrl);
        if (
          details.resourceType === 'mainFrame' ||
          details.resourceType === 'subFrame' ||
          (this.headersEnabled && ['https:', 'http:', 'wss:', 'ws:'].includes(protocol))
        ) {
          this.hooks.approveNavigation(scopeUrl, details.resourceType === 'mainFrame');
        }
        callback({});
      } catch (error) {
        if (error instanceof SiteRestrictionError) {
          this.enabled = false;
          this.headersEnabled = false;
          this.hooks.onPolicyRestricted?.(error);
        }
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
      if (this.isEnabled && !['net::ERR_ABORTED', 'net::ERR_BLOCKED_BY_CLIENT'].includes(details.error)) {
        this.hooks.onFailure(details.error, details.resourceType === 'mainFrame');
      }
    });
  }

  get isEnabled(): boolean {
    return this.enabled && this.enabledGeneration === this.state.generation && !this.state.poisoned;
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.state.chain.catch(() => undefined).then(task);
    this.state.chain = run;
    return run;
  }

  private assertUsable(): void {
    if (this.state.poisoned) throw this.state.poisoned;
  }

  private async mutation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    let settled = false;
    const work = operation().then(
      (result) => {
        settled = true;
        return result;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    try {
      return await withDeadline(work, 8000, signal);
    } catch (error) {
      if (!settled) {
        this.enabled = false;
        this.headersEnabled = false;
        this.state.generation++;
        this.state.poisoned ??= new Error(
          `Session network configuration did not settle; restart Unicorn before reusing this browser profile: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        throw this.state.poisoned;
      }
      throw error;
    }
  }

  async block(): Promise<void> {
    this.state.generation++;
    this.enabled = false;
    this.headersEnabled = false;
    await this.serial(async () => {
      let failure = this.state.poisoned;
      if (!failure) {
        try {
          await this.mutation(() =>
            this.session.setProxy({
              mode: 'fixed_servers',
              proxyRules: BLOCKED_PROXY,
              proxyBypassRules: '<-loopback>',
            }),
          );
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
      }
      // Closing sockets is still safe after a poisoned setProxy, because assignment
      // is permanently disabled for this Session and no new route can be enabled.
      try {
        await this.mutation(() => this.session.closeAllConnections());
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
      if (failure) throw failure;
    });
  }

  async assign(proxy: ProxyRecord, signal: AbortSignal, synthetic: boolean): Promise<void> {
    const generation = ++this.state.generation;
    this.enabled = false;
    this.headersEnabled = false;
    await this.serial(async () => {
      this.assertUsable();
      signal.throwIfAborted();
      await this.mutation(() => this.session.closeAllConnections(), signal);
      await this.mutation(
        () =>
          this.session.setProxy({
            mode: 'fixed_servers',
            proxyRules: proxyRule(proxy),
            proxyBypassRules: '<-loopback>',
          }),
        signal,
      );
      signal.throwIfAborted();
      const resolution = await withDeadline(
        this.session.resolveProxy('https://unicorn.invalid/'),
        8000,
        signal,
      );
      signal.throwIfAborted();
      this.assertUsable();
      if (generation !== this.state.generation)
        throw new Error('Proxy assignment was superseded by a network stop');
      if (/\bDIRECT\b/i.test(resolution) || !/^(PROXY|HTTPS|SOCKS5) /i.test(resolution)) {
        throw new Error(`Unsafe proxy resolution: ${resolution}`);
      }
      this.headersEnabled = synthetic;
      this.enabledGeneration = generation;
      this.enabled = true;
    });
  }

  dispose(): void {
    this.state.generation++;
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
