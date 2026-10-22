import {
  app,
  dialog,
  session,
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
} from 'electron';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  ActivityEvent,
  AppSettings,
  BrowserSnapshot,
  BrowserState,
  DeviceConfig,
  ProxyRecord,
  ViewBounds,
} from '../../shared/types';
import { DEVICES } from '../../shared/defaults';
import { assertApproved } from '../core/scope';
import { canTransition, transition } from '../core/state';
import { validateDevice } from '../core/validation';
import { SessionGate } from '../network/session-gate';
import { isRetryableTransportError } from '../network/transport-error';
import { SiteRestrictionError } from '../network/site-restriction';
import { CHALLENGE_MESSAGE, detectChallenge } from '../qa/challenge';
import { RunControl } from '../qa/control';
import { runStages } from '../qa/stages';
import { applyDevice, fitDevice, readDiagnostic } from './device';
import { withDeadline } from './deadline';
import { RecoveryBudget, RendererCrashError } from './recovery';

type BrowserAction =
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
type ProfileAction = 'cache' | 'cookies' | 'permissions' | 'history' | 'reset' | 'storage';
interface ProfileData {
  device?: DeviceConfig;
  history?: BrowserSnapshot['history'];
}
export interface BrowserManagerOptions {
  window: BrowserWindow;
  settings: (browserId?: number) => AppSettings;
  proxies: {
    acquire(id: number, signal?: AbortSignal): Promise<ProxyRecord | null | undefined>;
    release(id: number, reason?: string): void | Promise<void>;
  };
  log: (level: ActivityEvent['level'], category: string, message: string, browserId?: number) => void;
  changed: () => void;
  navigationAllowed?: (url: string, browserId?: number) => void;
  requestAllowed?: (url: string, browserId?: number) => void;
  profileData?: { load(id: number): ProfileData; save(id: number, data: ProfileData): void };
  diagnosticsDir?: string;
  emergencyStop?: () => void;
}
interface Entry {
  snapshot: BrowserSnapshot;
  view: WebContentsView;
  session: Session;
  gate: SessionGate;
  children: Map<number, WebContentsView>;
  abort?: AbortController;
  attemptAbort?: AbortController;
  intentControl?: RunControl;
  control?: RunControl;
  active?: Promise<void>;
  bounds?: ViewBounds;
  inspectedPopup?: number;
  pausedState?: BrowserState;
  restricted?: Error;
  rendererFailure?: RendererCrashError;
  watchdogFailure?: Error;
  pauseRequested: boolean;
  recovering: boolean;
  healthAt: number;
  healthMisses: number;
  healthProbe?: { contents: WebContents; abort: AbortController };
  deviceChanging?: boolean;
  synthetic: boolean;
  closing: boolean;
  downloads: Set<Electron.DownloadItem>;
}
export class BrowserManager {
  private entries = new Map<number, Entry>();
  private creating: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private recoveryBudgets = new Map<number, RecoveryBudget>();
  constructor(private readonly options: BrowserManagerOptions) {}

  private log(entry: Entry, level: ActivityEvent['level'], category: string, message: string): void {
    this.options.log(level, category, message.slice(0, 1500), entry.snapshot.id);
  }
  private changed(): void {
    this.options.changed();
  }
  private entry(id: number): Entry {
    const entry = this.entries.get(id);
    if (!entry || entry.closing) throw new Error(`Browser ${id} is not open`);
    return entry;
  }
  private move(entry: Entry, state: BrowserState): void {
    if (entry.snapshot.state === state) return;
    entry.snapshot.state = transition(entry.snapshot.state, state);
    this.changed();
  }
  private save(entry: Entry): void {
    this.options.profileData?.save(entry.snapshot.id, {
      device: entry.snapshot.device,
      history: entry.snapshot.history,
    });
  }

  create(count: number): Promise<void> {
    if (!Number.isInteger(count) || count < 1 || count > 20)
      return Promise.reject(new Error('Choose between 1 and 20 browsers'));
    const operation = this.creating
      .catch(() => undefined)
      .then(async () => {
        if (this.shuttingDown) throw new Error('Application is shutting down');
        for (const id of [...this.entries.keys()]) if (id > count) await this.close(id);
        for (let id = 1; id <= count; id++) if (!this.entries.has(id)) await this.createOne(id);
        this.changed();
      });
    this.creating = operation;
    return operation;
  }

  private async createOne(id: number): Promise<void> {
    const data = this.options.profileData?.load(id) ?? {};
    let device = { ...DEVICES.desktop };
    if (data.device) {
      try {
        device = validateDevice(data.device);
      } catch {
        this.options.log(
          'warn',
          'profile',
          'Invalid saved device settings replaced with the desktop preset',
          id,
        );
      }
    }
    const history = Array.isArray(data.history)
      ? data.history
          .filter(
            (item) =>
              item &&
              typeof item.url === 'string' &&
              typeof item.title === 'string' &&
              Number.isFinite(item.at),
          )
          .slice(-200)
      : [];
    const ses = session.fromPartition(`persist:unicorn-browser-${String(id).padStart(2, '0')}`, {
      cache: true,
    });
    const holder: { entry?: Entry } = {};
    const gate = new SessionGate(ses, {
      approveRequest: (url) => this.options.requestAllowed?.(url, id),
      approveNavigation: (url, mainFrame) => {
        assertApproved(url, this.options.settings(id));
        if (mainFrame) this.options.navigationAllowed?.(url, id);
      },
      onFailure: (message, mainFrame, webContentsId) => {
        const entry = holder.entry;
        if (!entry || entry.closing) return;
        entry.snapshot.networkErrors++;
        if (mainFrame) entry.snapshot.lastError = message;
        this.log(entry, 'warn', 'network', message);
        if (mainFrame) this.failIdleNavigation(entry, message, webContentsId);
        this.changed();
      },
      onRestricted: (status, url) => {
        const entry = holder.entry;
        if (!entry || entry.closing) return;
        this.restrict(
          entry,
          new SiteRestrictionError(
            `HTTP ${status}: testing paused; proxy rotation will not bypass this response`,
            url,
          ),
        );
      },
      onPolicyRestricted: (error) => {
        const entry = holder.entry;
        if (entry && !entry.closing) this.restrict(entry, error);
      },
    });
    await gate.block();
    const view = this.newView(ses);
    const entry: Entry = {
      snapshot: {
        id,
        name: `Unicorn-Browser-${String(id).padStart(2, '0')}`,
        state: 'CREATED',
        url: '',
        title: 'Ready for an assigned URL',
        device,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        stage: 'Idle',
        elapsedMs: 0,
        jsErrors: 0,
        networkErrors: 0,
        history,
        popups: [],
      },
      view,
      session: ses,
      gate,
      children: new Map(),
      synthetic: false,
      closing: false,
      pauseRequested: false,
      recovering: false,
      healthAt: performance.now(),
      healthMisses: 0,
      downloads: new Set(),
    };
    holder.entry = entry;
    this.entries.set(id, entry);
    if (!this.recoveryBudgets.has(id)) this.recoveryBudgets.set(id, new RecoveryBudget());
    this.options.window.contentView.addChildView(view);
    view.setVisible(false);
    this.wireContents(entry, view.webContents, false);
    ses.on('will-download', (_event, item) => {
      if (!entry.gate.isEnabled || entry.synthetic) {
        item.cancel();
        this.log(entry, 'info', 'download', 'Download blocked during automated QA or inactive networking');
        return;
      }
      item.pause();
      entry.downloads.add(item);
      item.once('done', (_event, state) => {
        entry.downloads.delete(item);
        this.log(entry, 'info', 'download', `Download ${state}`);
      });
      void dialog
        .showSaveDialog(this.options.window, {
          title: 'Save browser download',
          defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())),
        })
        .then((result) => {
          if (result.canceled || !result.filePath || !entry.gate.isEnabled) item.cancel();
          else {
            item.setSavePath(result.filePath);
            item.resume();
          }
        })
        .catch(() => item.cancel());
    });
    // A fresh WebContentsView has no document/renderer target yet. Initialize a
    // local blank document while the request gate remains closed before CDP.
    await withDeadline(view.webContents.loadURL('about:blank'), 8000);
    await applyDevice(view.webContents, entry.snapshot.device);
    entry.snapshot.url = '';
    entry.snapshot.title = 'Ready for an assigned URL';
    this.log(
      entry,
      'info',
      'browser',
      'Persistent isolated browser created; network locked until proxy assignment',
    );
  }

  private remotePreferences(ses: Session): Electron.WebPreferences {
    return {
      session: ses,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      javascript: true,
      webviewTag: false,
      plugins: false,
      spellcheck: false,
      backgroundThrottling: false,
      safeDialogs: true,
      safeDialogsMessage: 'Repeated dialogs from this website are being suppressed.',
      navigateOnDragDrop: false,
    };
  }

  private newView(ses: Session, options: Electron.WebContentsViewConstructorOptions = {}): WebContentsView {
    const view = new WebContentsView({
      ...options,
      webPreferences: this.remotePreferences(ses),
    });
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    return view;
  }

  private wireContents(entry: Entry, contents: WebContents, child: boolean): void {
    const contentsId = contents.id;
    const current = () =>
      !entry.closing &&
      (child
        ? entry.children.get(contentsId)?.webContents === contents
        : entry.view.webContents === contents);
    contents.on('before-input-event', (event, input) => {
      if (!current()) return;
      if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 's') {
        event.preventDefault();
        if (this.options.emergencyStop) this.options.emergencyStop();
        else
          void Promise.all([...this.entries.keys()].map((id) => this.stop(id))).catch((error) =>
            this.options.log('error', 'browser', `Emergency stop encountered an error: ${String(error)}`),
          );
      }
    });
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('select-bluetooth-device', (event, _devices, callback) => {
      event.preventDefault();
      callback('');
    });
    contents.on('will-navigate', (event, url) => {
      try {
        if (!current()) throw new Error('The browser view was replaced');
        if (!entry.gate.isEnabled) throw new Error('Browser networking is paused');
        assertApproved(url, this.options.settings(entry.snapshot.id));
      } catch (error) {
        event.preventDefault();
        this.log(entry, 'warn', 'navigation', String(error));
      }
    });
    contents.on('will-redirect', (event, url) => {
      try {
        if (!current()) throw new Error('The browser view was replaced');
        assertApproved(url, this.options.settings(entry.snapshot.id));
      } catch (error) {
        event.preventDefault();
        this.log(entry, 'warn', 'navigation', `Redirect blocked: ${String(error)}`);
      }
    });
    contents.on('did-start-loading', () => {
      if (!current()) return;
      if (!child) {
        entry.snapshot.loading = true;
        this.changed();
      }
    });
    contents.on('did-stop-loading', () => {
      if (!current()) return;
      if (!child && !contents.isDestroyed()) {
        entry.snapshot.loading = false;
        entry.snapshot.canGoBack = contents.navigationHistory.canGoBack();
        entry.snapshot.canGoForward = contents.navigationHistory.canGoForward();
        this.changed();
      }
    });
    contents.on('did-navigate', (_event, url, httpResponseCode) => {
      if (!current()) return;
      if (child) {
        this.syncPopups(entry);
        return;
      }
      entry.snapshot.url = url;
      entry.snapshot.title = contents.getTitle();
      if (url !== 'about:blank' && ![401, 403, 429].includes(httpResponseCode)) {
        entry.snapshot.history.push({ url, title: contents.getTitle(), at: Date.now() });
        entry.snapshot.history = entry.snapshot.history.slice(-200);
        this.save(entry);
        this.log(entry, 'info', 'navigation', `Page navigation completed (HTTP ${httpResponseCode})`);
      }
      this.changed();
    });
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
      if (!current()) return;
      if (!child && mainFrame) {
        entry.snapshot.url = url;
        this.changed();
      }
    });
    contents.on('page-title-updated', (_event, title) => {
      if (!current()) return;
      if (child) this.syncPopups(entry);
      else {
        entry.snapshot.title = title;
        this.changed();
      }
    });
    contents.on('console-message', (details) => {
      if (!current()) return;
      if (details.level === 'error') {
        entry.snapshot.jsErrors++;
        this.log(
          entry,
          'error',
          'javascript',
          'Website reported a JavaScript console error; inspect the browser console for its contents',
        );
        this.changed();
      }
    });
    contents.on('render-process-gone', (_event, details) => {
      if (!current()) return;
      if (child) {
        const popup = entry.children.get(contentsId);
        if (!popup || popup.webContents !== contents) return;
        entry.children.delete(contentsId);
        this.options.window.contentView.removeChildView(popup);
        if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
        if (entry.inspectedPopup === contentsId) entry.inspectedPopup = undefined;
        this.syncPopups(entry);
        this.log(entry, 'error', 'crash', `Popup renderer exited: ${details.reason}; popup closed`);
        return;
      }
      // Old view callbacks must never interrupt its replacement or a newer operation.
      if (entry.view.webContents !== contents) return;
      const error = new RendererCrashError(details.reason, details.exitCode);
      entry.rendererFailure = error;
      entry.snapshot.lastError = (entry.restricted ?? error).message;
      this.cancelHealth(entry);
      if (entry.restricted) entry.abort?.abort(entry.restricted);
      else if (entry.attemptAbort) entry.attemptAbort.abort(error);
      else entry.abort?.abort(error);
      if (!entry.pauseRequested && canTransition(entry.snapshot.state, 'ERROR')) this.move(entry, 'ERROR');
      void this.lockNetwork(entry).catch((failure: unknown) =>
        this.log(entry, 'error', 'network', `Crash cleanup failed: ${String(failure)}`),
      );
      this.log(
        entry,
        'error',
        'crash',
        `${error.message}; profile retained. An eligible active QA job may recover within its retry budget.`,
      );
    });
    contents.on('unresponsive', () => {
      if (!current()) return;
      entry.healthAt = -Infinity;
      this.log(entry, 'warn', 'watchdog', 'Renderer is unresponsive; operation timeout remains active');
    });
    contents.setWindowOpenHandler((details) => {
      try {
        if (!current()) throw new Error('The browser view was replaced');
        if (!entry.gate.isEnabled || entry.children.size >= 8)
          throw new Error('Popup limit reached or networking is inactive');
        assertApproved(details.url, this.options.settings(entry.snapshot.id));
        this.log(entry, 'info', 'popup', 'Approved popup requested');
        return {
          action: 'allow',
          // These preferences are applied before Chromium creates the child.
          // Adopting a WebContents later cannot change its initial privileges.
          overrideBrowserWindowOptions: { webPreferences: this.remotePreferences(entry.session) },
          createWindow: (options) => {
            // Electron supplies its existing child in options.webContents. Creating
            // a different WebContents here breaks the native window.open handshake.
            const popup = this.newView(entry.session, options);
            const childContents = popup.webContents;
            const popupId = childContents.id;
            this.options.window.contentView.addChildView(popup);
            popup.setVisible(false);
            entry.children.set(popupId, popup);
            this.wireContents(entry, childContents, true);
            // CDP attachment during the synchronous creation callback can wait on
            // the same renderer that is waiting for window.open to return.
            childContents.once('dom-ready', () => {
              setImmediate(() => {
                if (entry.closing || childContents.isDestroyed() || !entry.children.has(popupId)) return;
                void applyDevice(childContents, entry.snapshot.device).catch((error: unknown) =>
                  this.log(entry, 'warn', 'device', String(error)),
                );
              });
            });
            childContents.once('destroyed', () => {
              entry.children.delete(popupId);
              if (entry.inspectedPopup === popupId) entry.inspectedPopup = undefined;
              this.syncPopups(entry);
            });
            this.syncPopups(entry);
            // Chromium can defer child creation for a background tab. In that
            // case there is no supplied guest to perform its initial navigation.
            if (!(options as Electron.WebContentsViewConstructorOptions).webContents)
              setImmediate(() => {
                if (entry.closing || childContents.isDestroyed() || !entry.gate.isEnabled) return;
                void withDeadline(
                  childContents.loadURL(details.url, {
                    httpReferrer: details.referrer,
                    postData: details.postBody?.data,
                  }),
                  this.options.settings(entry.snapshot.id).timings.navigationTimeoutMs,
                ).catch((error: unknown) => this.log(entry, 'warn', 'popup', String(error)));
              });
            return childContents;
          },
        };
      } catch (error) {
        this.log(entry, 'warn', 'popup', `Popup blocked: ${String(error)}`);
        return { action: 'deny' };
      }
    });
  }

  private syncPopups(entry: Entry): void {
    entry.snapshot.popups = [...entry.children.values()]
      .filter((view) => !view.webContents.isDestroyed())
      .map((view) => ({
        id: view.webContents.id,
        url: view.webContents.getURL(),
        title: view.webContents.getTitle() || 'Popup',
      }));
    this.changed();
  }

  snapshots(): BrowserSnapshot[] {
    return [...this.entries.values()]
      .sort((a, b) => a.snapshot.id - b.snapshot.id)
      .map((entry) => ({
        ...structuredClone(entry.snapshot),
        elapsedMs: entry.snapshot.startedAt
          ? Date.now() - entry.snapshot.startedAt
          : entry.snapshot.elapsedMs,
      }));
  }

  /** Main-process diagnostic/testing access; this object is never exposed over IPC. */
  getWebContents(id: number): WebContents {
    return this.entry(id).view.webContents;
  }

  private cancelHealth(entry: Entry): void {
    entry.healthProbe?.abort.abort(new Error('Renderer health check superseded'));
    entry.healthMisses = 0;
    entry.healthAt = performance.now();
  }

  private healthEligible(entry: Entry, contents = entry.view.webContents): boolean {
    return (
      !this.shuttingDown &&
      !entry.closing &&
      !entry.pauseRequested &&
      !entry.recovering &&
      !entry.restricted &&
      !entry.watchdogFailure &&
      entry.gate.isEnabled &&
      entry.view.webContents === contents &&
      !contents.isDestroyed() &&
      !contents.isCrashed() &&
      !contents.isLoading() &&
      !entry.snapshot.loading &&
      ['READY', 'RUNNING'].includes(entry.snapshot.state)
    );
  }

  /** Called by the controller's existing heartbeat; never creates a global polling timer. */
  checkHealth(): void {
    const now = performance.now();
    for (const entry of this.entries.values()) {
      if (!this.healthEligible(entry)) {
        if (entry.healthProbe || entry.healthMisses) this.cancelHealth(entry);
        continue;
      }
      if (entry.healthProbe || now - entry.healthAt < 10_000) continue;
      entry.healthAt = now;
      const probe = { contents: entry.view.webContents, abort: new AbortController() };
      entry.healthProbe = probe;
      void withDeadline(
        Promise.resolve().then(() => probe.contents.executeJavaScriptInIsolatedWorld(713, [{ code: '1' }])),
        5000,
        probe.abort.signal,
      )
        .then((result: unknown) => {
          if (result !== 1) throw new Error('Renderer health check returned an invalid response');
          if (entry.healthProbe === probe && this.healthEligible(entry, probe.contents))
            entry.healthMisses = 0;
        })
        .catch((error: unknown) => {
          if (probe.abort.signal.aborted || !this.healthEligible(entry, probe.contents)) return;
          entry.healthMisses++;
          this.log(
            entry,
            'warn',
            'watchdog',
            `Renderer health check failed (${entry.healthMisses}/2): ${String(error)}`,
          );
          if (entry.healthMisses < 2) return;
          const failure = new Error('Renderer failed two health checks; testing stopped for manual review');
          entry.watchdogFailure = failure;
          entry.snapshot.lastError = failure.message;
          entry.snapshot.stage = 'Renderer health check failed';
          entry.abort?.abort(failure);
          if (canTransition(entry.snapshot.state, 'ERROR')) this.move(entry, 'ERROR');
          void this.lockNetwork(entry).catch((cleanupError: unknown) =>
            this.log(entry, 'error', 'network', `Watchdog cleanup failed: ${String(cleanupError)}`),
          );
          this.changed();
        })
        .finally(() => {
          if (entry.healthProbe === probe) entry.healthProbe = undefined;
        });
    }
  }

  layout(bounds: ViewBounds[]): void {
    const windowBounds = this.options.window.getContentBounds();
    const received = new Set(bounds.map((item) => item.id));
    for (const entry of this.entries.values())
      if (!received.has(entry.snapshot.id)) {
        entry.view.setVisible(false);
        for (const child of entry.children.values()) child.setVisible(false);
      }
    for (const item of bounds) {
      const entry = this.entries.get(item.id);
      if (!entry) continue;
      if (!item.visible && (item.width < 1 || item.height < 1)) {
        if (entry.bounds) entry.bounds.visible = false;
        entry.view.setVisible(false);
        for (const child of entry.children.values()) child.setVisible(false);
        continue;
      }
      const x = Math.max(0, Math.round(item.x));
      const y = Math.max(0, Math.round(item.y));
      const width = Math.max(1, Math.min(Math.round(item.width), windowBounds.width - x));
      const height = Math.max(1, Math.min(Math.round(item.height), windowBounds.height - y));
      const sizeChanged = entry.bounds?.width !== width || entry.bounds?.height !== height;
      entry.bounds = { ...item, x, y, width, height };
      entry.view.setBounds({ x, y, width, height });
      entry.view.setVisible(item.visible && !entry.inspectedPopup);
      for (const [id, child] of entry.children) {
        child.setBounds({ x, y, width, height });
        child.setVisible(item.visible && entry.inspectedPopup === id);
      }
      if (sizeChanged && !entry.deviceChanging)
        void fitDevice(entry.view.webContents, entry.snapshot.device, width, height).catch(() => undefined);
    }
  }

  private async ready(
    entry: Entry,
    signal: AbortSignal,
    synthetic: boolean,
    control?: RunControl,
  ): Promise<void> {
    signal.throwIfAborted();
    if (entry.gate.isEnabled && entry.snapshot.proxy) return;
    this.move(entry, 'WAITING_FOR_PROXY');
    entry.snapshot.stage = 'Assigning an eligible proxy endpoint';
    this.move(entry, 'ASSIGNING_PROXY');
    const proxy = await this.options.proxies.acquire(entry.snapshot.id, signal);
    signal.throwIfAborted();
    if (!proxy) {
      this.move(entry, 'WAITING_FOR_PROXY');
      throw new Error('No eligible, unassigned proxy endpoint is currently available');
    }
    await control?.checkpoint();
    entry.snapshot.proxy = proxy;
    let resolution: string;
    try {
      resolution = await entry.gate.assign(proxy, signal, synthetic);
    } catch (error) {
      if (!control?.isPaused || signal.aborted) throw error;
      // A pause can supersede an in-flight Chromium proxy-configuration call.
      // Keep its reservation and complete the same assignment after resume.
      await control.checkpoint();
      resolution = await entry.gate.assign(proxy, signal, synthetic);
    }
    if (!entry.view.webContents.debugger.isAttached())
      await applyDevice(entry.view.webContents, entry.snapshot.device);
    this.move(entry, 'READY');
    this.log(
      entry,
      'info',
      'proxy',
      `${proxy.country} ${proxy.protocol.toUpperCase()} endpoint assigned using provider country metadata; Chromium route ${resolution}`,
    );
  }

  private async navigateReady(entry: Entry, url: string, control: RunControl): Promise<void> {
    const normalized = assertApproved(url, this.options.settings(entry.snapshot.id));
    await control.checkpoint();
    if (entry.restricted) throw entry.restricted;
    await this.ready(entry, control.signal, entry.synthetic, control);
    await control.checkpoint();
    this.move(entry, 'NAVIGATING');
    entry.snapshot.lastError = undefined;
    const timeoutMs = this.options.settings(entry.snapshot.id).timings.navigationTimeoutMs;
    const contents = entry.view.webContents;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          contents.stop();
          finish(new Error(`Navigation timed out after ${timeoutMs} ms`));
        }, timeoutMs);
        const abort = () => {
          if (!contents.isDestroyed()) contents.stop();
          finish(control.signal.reason ?? new Error('Cancelled'));
        };
        let finished = false;
        const finish = (error?: unknown) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          control.signal.removeEventListener('abort', abort);
          if (error) reject(error);
          else resolve();
        };
        control.signal.addEventListener('abort', abort, { once: true });
        if (control.signal.aborted) {
          abort();
          return;
        }
        try {
          contents.loadURL(normalized).then(() => finish(), finish);
        } catch (error) {
          finish(error);
        }
      });
    } catch (error) {
      if (control.isPaused && !control.signal.aborted) {
        await control.checkpoint();
        return this.navigateReady(entry, normalized, control);
      }
      throw error;
    }
    await control.checkpoint();
    if (entry.restricted) throw entry.restricted;
    if (entry.synthetic) await this.checkChallenge(entry, control);
    this.move(entry, 'RUNNING');
    entry.snapshot.url = contents.getURL();
    this.changed();
  }

  private async checkChallenge(entry: Entry, control: RunControl): Promise<void> {
    await control.checkpoint();
    if (entry.restricted) throw entry.restricted;
    if (!(await detectChallenge(entry.view.webContents, control.signal))) return;
    this.restrict(entry, new SiteRestrictionError(CHALLENGE_MESSAGE, entry.view.webContents.getURL()));
    throw entry.restricted;
  }

  private restrict(entry: Entry, error: SiteRestrictionError): void {
    entry.restricted = error;
    entry.snapshot.lastError = error.message;
    entry.snapshot.stage = 'Manual review required';
    this.log(entry, 'warn', 'authorization', error.message);
    // lockNetwork disables requests synchronously, including workers and popups,
    // and releases idle manual-page leases even when no operation is running.
    void this.lockNetwork(entry).catch((error: unknown) =>
      this.log(entry, 'error', 'network', String(error)),
    );
    entry.abort?.abort(error);
    if (canTransition(entry.snapshot.state, 'ERROR')) this.move(entry, 'ERROR');
    this.changed();
  }

  private failIdleNavigation(entry: Entry, message: string, webContentsId?: number): void {
    if (
      entry.closing ||
      this.shuttingDown ||
      entry.synthetic ||
      entry.active ||
      entry.abort ||
      entry.pauseRequested ||
      entry.restricted ||
      !entry.snapshot.proxy ||
      !entry.gate.isEnabled ||
      !['RUNNING', 'READY'].includes(entry.snapshot.state) ||
      entry.view.webContents.isDestroyed() ||
      webContentsId !== entry.view.webContents.id ||
      !isRetryableTransportError(message)
    )
      return;
    this.cancelHealth(entry);
    entry.snapshot.stage = 'Navigation failed';
    this.move(entry, 'ERROR');
    // block() closes the request gate synchronously. Publishing cleanup as the
    // active operation makes a subsequent Navigate/Stop wait before reusing a lease.
    const cleanup = this.lockNetwork(entry, message);
    entry.active = cleanup;
    void cleanup
      .catch((error: unknown) =>
        this.log(entry, 'error', 'network', `Idle navigation cleanup failed: ${String(error)}`),
      )
      .finally(() => {
        if (entry.active === cleanup) entry.active = undefined;
        this.changed();
      });
  }

  private operation(
    entry: Entry,
    synthetic: boolean,
    task: (control: RunControl) => Promise<void>,
  ): Promise<void> {
    entry.abort?.abort(new Error('Replaced by a new browser operation'));
    this.cancelHealth(entry);
    const previous = entry.active;
    const abort = new AbortController();
    const intentControl = new RunControl(abort.signal);
    entry.abort = abort;
    entry.intentControl = intentControl;
    entry.pauseRequested = false;
    const run = (async () => {
      try {
        await previous?.catch(() => undefined);
        abort.signal.throwIfAborted();
        await this.lockNetwork(entry);
        abort.signal.throwIfAborted();
        if (entry.closing) throw new Error('Browser was closed');
        this.move(entry, 'STOPPED');
        if (entry.pauseRequested) {
          // Pause may arrive while the previous operation or native gate is
          // settling. Keep the new intent visibly resumable before checkpoint.
          entry.pausedState = 'WAITING_FOR_PROXY';
          this.move(entry, 'WAITING_FOR_PROXY');
          this.move(entry, 'PAUSED');
        }
        // Only a fresh explicit intent may clear a previous restriction. Automatic
        // renderer attempts below never clear it or replace the lifetime signal.
        entry.restricted = undefined;
        entry.rendererFailure = undefined;
        entry.watchdogFailure = undefined;
        entry.synthetic = synthetic;
        entry.snapshot.startedAt = Date.now();
        if (entry.view.webContents.isDestroyed() || entry.view.webContents.isCrashed())
          await this.repairRenderer(entry, intentControl);
        let retries = 0;
        for (;;) {
          await intentControl.checkpoint();
          abort.signal.throwIfAborted();
          if (entry.restricted) throw entry.restricted;
          const attemptAbort = new AbortController();
          entry.attemptAbort = attemptAbort;
          entry.rendererFailure = undefined;
          entry.recovering = false;
          const control = new RunControl(AbortSignal.any([abort.signal, attemptAbort.signal]));
          if (entry.pauseRequested) control.pause();
          entry.control = control;
          try {
            await task(control);
            await intentControl.checkpoint();
            if (entry.restricted) throw entry.restricted;
            if (entry.rendererFailure) throw entry.rendererFailure;
            if (synthetic) {
              this.move(entry, 'COMPLETED');
              if (this.options.settings(entry.snapshot.id).closePopupsAfterRun) this.closePopups(entry);
              await this.lockNetwork(entry);
            }
            break;
          } catch (error) {
            const failure =
              entry.restricted ??
              (abort.signal.aborted ? abort.signal.reason : undefined) ??
              entry.rendererFailure ??
              error;
            if (!synthetic || abort.signal.aborted || entry.closing || entry.restricted) throw failure;
            const decision = this.recoveryBudgets
              .get(entry.snapshot.id)!
              .reserve(failure, retries, this.options.settings(entry.snapshot.id).retryLimit);
            if (!decision.allowed) {
              if (failure instanceof RendererCrashError)
                this.log(
                  entry,
                  'warn',
                  'recovery',
                  `Automatic renderer recovery stopped: ${decision.reason}`,
                );
              throw failure;
            }
            // A failed or poisoned native gate is terminal. lockNetwork still
            // releases the lease in its finally block and never changes Session.
            await this.lockNetwork(entry);
            abort.signal.throwIfAborted();
            if (entry.restricted) throw entry.restricted;
            retries = decision.retry;
            entry.attemptAbort = undefined;
            entry.recovering = true;
            entry.control = intentControl;
            entry.snapshot.stage = `Renderer recovery ${retries}`;
            if (entry.pauseRequested) entry.pausedState = 'RETRY_WAIT';
            else {
              this.move(entry, 'STOPPED');
              this.move(entry, 'WAITING_FOR_PROXY');
              this.move(entry, 'RETRY_WAIT');
            }
            this.log(
              entry,
              'warn',
              'recovery',
              `Restarting the accepted QA job after renderer exit; retry ${retries}`,
            );
            await intentControl.wait(decision.delayMs);
            await this.repairRenderer(entry, intentControl);
          } finally {
            attemptAbort.abort(new Error('Renderer attempt finished'));
            if (entry.attemptAbort === attemptAbort) entry.attemptAbort = undefined;
          }
        }
      } catch (error) {
        const failure = entry.restricted ?? error;
        entry.snapshot.lastError = failure instanceof Error ? failure.message : String(failure);
        // Endpoint health is learned from the actual page request. A terminal
        // transport failure must enter cooldown even when no retry is permitted.
        const proxyFailure =
          !abort.signal.aborted &&
          !entry.restricted &&
          entry.snapshot.state === 'NAVIGATING' &&
          isRetryableTransportError(failure)
            ? entry.snapshot.lastError
            : undefined;
        if (
          entry.snapshot.state !== 'WAITING_FOR_PROXY' &&
          !entry.closing &&
          canTransition(entry.snapshot.state, 'ERROR')
        )
          this.move(
            entry,
            abort.signal.aborted &&
              !entry.restricted &&
              !entry.watchdogFailure &&
              !(failure instanceof RendererCrashError)
              ? 'STOPPED'
              : 'ERROR',
          );
        await this.lockNetwork(entry, proxyFailure).catch((cleanupError: unknown) => {
          this.log(entry, 'error', 'network', `Network cleanup also failed: ${String(cleanupError)}`);
        });
        throw failure;
      } finally {
        entry.snapshot.elapsedMs = entry.snapshot.startedAt ? Date.now() - entry.snapshot.startedAt : 0;
        entry.snapshot.startedAt = undefined;
        entry.session.flushStorageData();
        await withDeadline(entry.session.cookies.flushStore(), 8000).catch((error: unknown) => {
          this.log(entry, 'error', 'storage', `Cookie flush did not complete: ${String(error)}`);
        });
        this.save(entry);
        if (entry.abort === abort) {
          entry.control = undefined;
          entry.intentControl = undefined;
          entry.abort = undefined;
          entry.attemptAbort = undefined;
          entry.recovering = false;
        }
        this.changed();
      }
    })();
    entry.active = run;
    void run
      .finally(() => {
        if (entry.active === run) entry.active = undefined;
      })
      .catch(() => undefined);
    return run;
  }

  private async repairRenderer(entry: Entry, control: RunControl): Promise<void> {
    await control.checkpoint();
    if (entry.closing || this.shuttingDown) throw new Error('Browser was closed');
    if (entry.restricted) throw entry.restricted;
    await this.lockNetwork(entry);
    await control.checkpoint();
    if (entry.restricted) throw entry.restricted;
    this.closePopups(entry);
    this.cancelHealth(entry);
    const previous = entry.view;
    const url = entry.snapshot.url;
    const title = entry.snapshot.title;
    const view = this.newView(entry.session);
    // Publish identity before closing the old view: its late events cannot affect this view.
    entry.view = view;
    this.options.window.contentView.addChildView(view);
    view.setVisible(false);
    this.wireContents(entry, view.webContents, false);
    this.options.window.contentView.removeChildView(previous);
    if (!previous.webContents.isDestroyed()) previous.webContents.close({ waitForBeforeUnload: false });
    try {
      await withDeadline(view.webContents.loadURL('about:blank'), 8000, control.signal);
      await withDeadline(applyDevice(view.webContents, entry.snapshot.device), 10_000, control.signal);
      await control.checkpoint();
      if (entry.restricted) throw entry.restricted;
      if (view.webContents.isCrashed())
        throw entry.rendererFailure ?? new Error('Replacement renderer exited');
      entry.snapshot.url = url;
      entry.snapshot.title = title;
      entry.snapshot.loading = false;
      entry.snapshot.canGoBack = false;
      entry.snapshot.canGoForward = false;
      if (entry.bounds) {
        view.setBounds(entry.bounds);
        view.setVisible(entry.bounds.visible);
      }
      this.log(
        entry,
        'info',
        'recovery',
        'Renderer recreated with its original isolated profile and device; networking remains locked',
      );
    } catch (error) {
      // A late CDP operation may still settle; retiring this view prevents it from
      // changing a newer operation's target. The persistent Session remains denied.
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
      throw error;
    }
  }

  async navigate(id: number, url: string): Promise<void> {
    const normalized = assertApproved(url, this.options.settings(id));
    const entry = this.entry(id);
    return this.operation(entry, false, async (control) => {
      entry.snapshot.stage = 'Manual browsing';
      await this.navigateReady(entry, normalized, control);
    });
  }

  async runQa(id: number, url: string): Promise<void> {
    const normalized = assertApproved(url, this.options.settings(id));
    const entry = this.entry(id);
    return this.operation(entry, true, async (control) => {
      await runStages(normalized, {
        contents: entry.view.webContents,
        settings: () => this.options.settings(id),
        control,
        navigate: async (destination) => {
          for (let attempt = 0; ; attempt++) {
            try {
              await this.navigateReady(entry, destination, control);
              return;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (
                control.signal.aborted ||
                entry.restricted ||
                !isRetryableTransportError(error) ||
                attempt >= this.options.settings(id).retryLimit
              )
                throw error;
              await this.lockNetwork(entry, message);
              this.move(entry, 'PROXY_FAILED');
              this.move(entry, 'RETRY_WAIT');
              entry.snapshot.stage = `Network retry ${attempt + 1}`;
              await control.wait(Math.min(30000, 1000 * 2 ** attempt));
            }
          }
        },
        stage: (stage) => {
          entry.snapshot.stage = stage;
          this.changed();
        },
        checkChallenge: () => this.checkChallenge(entry, control),
        capture: async (stage) => this.capture(entry, stage, control.signal),
        log: (message) => this.log(entry, 'info', 'qa', message),
      });
    });
  }

  private async lockNetwork(entry: Entry, failure?: string): Promise<void> {
    try {
      await entry.gate.block();
    } finally {
      for (const item of entry.downloads) item.cancel();
      if (!entry.view.webContents.isDestroyed()) entry.view.webContents.stop();
      for (const child of entry.children.values())
        if (!child.webContents.isDestroyed()) child.webContents.stop();
      await this.options.proxies.release(entry.snapshot.id, failure);
      entry.snapshot.proxy = undefined;
    }
  }

  async pause(id: number): Promise<void> {
    const entry = this.entry(id);
    if (entry.pauseRequested || (!entry.active && !canTransition(entry.snapshot.state, 'PAUSED'))) return;
    entry.pauseRequested = true;
    entry.pausedState = canTransition('PAUSED', entry.snapshot.state)
      ? entry.snapshot.state
      : 'WAITING_FOR_PROXY';
    entry.intentControl?.pause();
    entry.control?.pause();
    this.cancelHealth(entry);
    // Pause test time and all session requests. The assignment remains reserved.
    await entry.gate.block();
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.stop();
    if (!entry.pauseRequested || entry.closing) return;
    if (!canTransition(entry.snapshot.state, 'PAUSED')) {
      this.move(entry, 'STOPPED');
      this.move(entry, 'WAITING_FOR_PROXY');
    }
    this.move(entry, 'PAUSED');
  }

  async resume(id: number): Promise<void> {
    const entry = this.entry(id);
    if (!entry.pauseRequested || entry.snapshot.state !== 'PAUSED') return;
    if (entry.restricted) throw entry.restricted;
    const signal = entry.control?.signal ?? new AbortController().signal;
    if (entry.snapshot.proxy && !entry.recovering)
      await entry.gate.assign(entry.snapshot.proxy, signal, entry.synthetic);
    if (!entry.pauseRequested || entry.closing || entry.abort?.signal.aborted) return;
    entry.pauseRequested = false;
    const previous = entry.pausedState ?? 'RUNNING';
    this.move(entry, previous);
    entry.intentControl?.resume();
    entry.control?.resume();
    this.cancelHealth(entry);
  }

  async stop(id: number): Promise<void> {
    const entry = this.entry(id);
    entry.pauseRequested = false;
    entry.abort?.abort(new Error('Stopped by user'));
    this.cancelHealth(entry);
    let failure: unknown;
    await entry.gate.block().catch((error: unknown) => {
      failure = error;
    });
    await entry.active?.catch(() => undefined);
    await this.lockNetwork(entry).catch((error: unknown) => {
      failure ??= error;
    });
    this.closePopups(entry);
    this.move(entry, 'STOPPED');
    entry.snapshot.stage = 'Stopped';
    entry.snapshot.loading = false;
    if (failure) throw failure;
  }

  async action(id: number, action: BrowserAction): Promise<void> {
    const entry = this.entry(id);
    if (action === 'pause') return this.pause(id);
    if (action === 'resume') return this.resume(id);
    if (action === 'stop') return this.stop(id);
    if (action === 'close') return this.close(id);
    if (action === 'stop-loading') {
      entry.view.webContents.stop();
      return;
    }
    if (action === 'devtools') {
      entry.view.webContents.openDevTools({ mode: 'detach' });
      return;
    }
    if (action === 'start' || action === 'reload') {
      if (!entry.snapshot.url) throw new Error('Assign a URL before starting the browser');
      return this.navigate(id, entry.snapshot.url);
    }
    const history = entry.view.webContents.navigationHistory;
    const index = history.getActiveIndex() + (action === 'back' ? -1 : 1);
    const target = history.getEntryAtIndex(index);
    if (!target) return;
    assertApproved(target.url, this.options.settings(id));
    if (entry.active) throw new Error('Pause or stop the active QA run before changing browser history');
    const controller = new AbortController();
    await this.ready(entry, controller.signal, false);
    history.goToIndex(index);
  }

  async applyDevice(ids: number[], device: DeviceConfig, signal?: AbortSignal): Promise<void> {
    for (const id of ids) {
      signal?.throwIfAborted();
      const entry = this.entry(id);
      if (entry.active) throw new Error('Stop active testing before changing its device configuration');
      if (signal) {
        await this.applyReviewedDevice(entry, device, signal);
        continue;
      }
      const scale = entry.bounds
        ? Math.min(1, entry.bounds.width / device.width, entry.bounds.height / device.height)
        : 1;
      await applyDevice(entry.view.webContents, device, scale);
      for (const popup of entry.children.values()) await applyDevice(popup.webContents, device);
      entry.snapshot.device = { ...device };
      this.save(entry);
      this.log(
        entry,
        'info',
        'device',
        `${device.preset} device applied (${device.width} × ${device.height})`,
      );
    }
    this.changed();
  }

  private async applyReviewedDevice(entry: Entry, device: DeviceConfig, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const run = this.operation(entry, false, async (control) => {
      const activeSignal = AbortSignal.any([signal, control.signal]);
      activeSignal.throwIfAborted();
      const view = entry.view;
      entry.deviceChanging = true;
      const ensureCurrent = () => {
        activeSignal.throwIfAborted();
        if (entry.closing || entry.view !== view || view.webContents.isDestroyed())
          throw new Error('Browser changed while applying its device configuration');
      };
      try {
        const scale = entry.bounds
          ? Math.min(1, entry.bounds.width / device.width, entry.bounds.height / device.height)
          : 1;
        await withDeadline(applyDevice(view.webContents, device, scale), 10_000, activeSignal);
        ensureCurrent();
        for (const popup of entry.children.values()) {
          await withDeadline(applyDevice(popup.webContents, device, scale), 10_000, activeSignal);
          ensureCurrent();
        }
        // Layout may have moved while CDP was applying the preset. Fit the new
        // metrics once, after suppressing concurrent fits using the old preset.
        if (entry.bounds) {
          await withDeadline(
            fitDevice(view.webContents, device, entry.bounds.width, entry.bounds.height),
            8000,
            activeSignal,
          );
          ensureCurrent();
        }
        entry.snapshot.device = { ...device };
        this.save(entry);
        this.log(
          entry,
          'info',
          'device',
          `${device.preset} device applied (${device.width} × ${device.height})`,
        );
      } catch (error) {
        // CDP work is not abortable. Closing this exact target prevents any late
        // completion from changing a replacement view or a newer Start intent.
        view.setVisible(false);
        if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
        this.closePopups(entry);
        throw error;
      } finally {
        entry.deviceChanging = false;
      }
    });
    const operationAbort = entry.abort!;
    const cancel = () => operationAbort.abort(signal.reason ?? new Error('Device change cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      await run;
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }

  async profile(id: number, action: ProfileAction): Promise<number | undefined> {
    const entry = this.entry(id);
    if (action === 'storage') {
      const directory = entry.session.storagePath;
      if (!directory) return withDeadline(entry.session.getCacheSize(), 8000);
      return withDeadline(directoryBytes(directory), 8000);
    }
    await this.stop(id);
    const previousUrl = entry.snapshot.url;
    if (action === 'cookies' || action === 'reset')
      await withDeadline(entry.view.webContents.loadURL('about:blank'), 8000);
    if (action === 'cache' || action === 'reset') await withDeadline(entry.session.clearCache(), 8000);
    if (action === 'cookies')
      await withDeadline(entry.session.clearStorageData({ storages: ['cookies'] }), 8000);
    if (action === 'history' || action === 'reset') {
      entry.snapshot.history = [];
      const history = entry.view.webContents.navigationHistory;
      history.clear();
      entry.snapshot.canGoBack = history.canGoBack();
      entry.snapshot.canGoForward = history.canGoForward();
    }
    if (action === 'permissions' || action === 'reset') {
      entry.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      entry.session.setPermissionCheckHandler(() => false);
    }
    if (action === 'reset') {
      await withDeadline(entry.session.clearStorageData(), 8000);
      await withDeadline(entry.session.clearAuthCache(), 8000);
      await applyDevice(entry.view.webContents, DEVICES.desktop);
      entry.snapshot.device = { ...DEVICES.desktop };
      entry.snapshot.url = '';
      entry.snapshot.title = 'Profile reset';
    } else if (action === 'cookies') entry.snapshot.url = previousUrl;
    entry.session.flushStorageData();
    await withDeadline(entry.session.cookies.flushStore(), 8000);
    this.save(entry);
    this.changed();
    this.log(entry, 'info', 'profile', `Profile action completed: ${action}`);
    return undefined;
  }

  popup(browserId: number, popupId: number, action: 'inspect' | 'close'): void {
    const entry = this.entry(browserId);
    const popup = entry.children.get(popupId);
    if (!popup) throw new Error('Popup is no longer available');
    if (action === 'close') {
      const contents = popup.webContents;
      entry.children.delete(popupId);
      if (entry.inspectedPopup === popupId) entry.inspectedPopup = undefined;
      this.options.window.contentView.removeChildView(popup);
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
    } else entry.inspectedPopup = entry.inspectedPopup === popupId ? undefined : popupId;
    if (entry.bounds)
      this.layout([...this.entries.values()].flatMap((item) => (item.bounds ? [item.bounds] : [])));
    this.syncPopups(entry);
  }

  private closePopups(entry: Entry): void {
    const popups = [...entry.children.values()];
    entry.children.clear();
    entry.inspectedPopup = undefined;
    for (const popup of popups) {
      this.options.window.contentView.removeChildView(popup);
      if (!popup.webContents.isDestroyed()) popup.webContents.close({ waitForBeforeUnload: false });
    }
    this.syncPopups(entry);
    if (entry.bounds && !entry.view.webContents.isDestroyed()) entry.view.setVisible(entry.bounds.visible);
  }

  async diagnostic(id: number): Promise<Record<string, unknown>> {
    const entry = this.entry(id);
    const data = await readDiagnostic(entry.view.webContents);
    return {
      ...data,
      partition: `persist:unicorn-browser-${String(id).padStart(2, '0')}`,
      proxyEnabled: entry.gate.isEnabled,
      proxyResolution: await withDeadline(entry.session.resolveProxy('https://unicorn.invalid/'), 8000),
      webRtcPolicy: entry.view.webContents.getWebRTCIPHandlingPolicy(),
    };
  }

  private async capture(entry: Entry, stage: string, signal: AbortSignal): Promise<void> {
    const directory = this.options.diagnosticsDir;
    if (!directory) {
      this.log(entry, 'info', 'qa', `${stage}: rendering inspection completed`);
      return;
    }
    await mkdir(directory, { recursive: true });
    const name = `${Date.now()}-browser-${entry.snapshot.id}-${stage.toLowerCase().replaceAll(' ', '-')}`;
    const image = await withDeadline(
      entry.view.webContents.capturePage(undefined, { stayHidden: true }),
      8000,
      signal,
    );
    if (image.isEmpty() || image.getSize().width < 2 || image.getSize().height < 2)
      throw new Error('The renderer did not provide a usable screenshot');
    await writeFile(path.join(directory, `${name}.png`), image.toPNG());
    const timing = (await withDeadline(
      entry.view.webContents.executeJavaScriptInIsolatedWorld(712, [
        {
          code: `({ navigation: performance.getEntriesByType('navigation').map(e => ({ duration:e.duration, domContentLoaded:e.domContentLoadedEventEnd, load:e.loadEventEnd, responseStart:e.responseStart })), failedResources: performance.getEntriesByType('resource').filter(e=>e.responseStatus>=400).length })`,
        },
      ]),
      8000,
      signal,
    )) as unknown;
    await writeFile(
      path.join(directory, `${name}.json`),
      JSON.stringify(
        {
          stage,
          browserId: entry.snapshot.id,
          at: Date.now(),
          timing,
          jsErrors: entry.snapshot.jsErrors,
          networkErrors: entry.snapshot.networkErrors,
        },
        null,
        2,
      ),
    );
    this.log(entry, 'info', 'qa', `${stage}: screenshot and page timings captured`);
    const names = (await readdir(directory))
      .filter((item) => /^(\d+)-browser-\d+-.+\.(png|json)$/.test(item))
      .sort();
    const cutoff = Date.now() - this.options.settings(entry.snapshot.id).logRetentionDays * 86400000;
    for (let index = 0; index < names.length; index++) {
      if (index < names.length - 400 || Number(names[index].split('-')[0]) < cutoff)
        await unlink(path.join(directory, names[index])).catch(() => undefined);
    }
  }

  private async close(id: number): Promise<void> {
    const entry = this.entry(id);
    let failure: unknown;
    await this.stop(id).catch((error: unknown) => {
      failure = error;
    });
    entry.closing = true;
    this.save(entry);
    entry.session.flushStorageData();
    await withDeadline(entry.session.cookies.flushStore(), 8000).catch((error: unknown) => {
      failure ??= error;
    });
    entry.gate.dispose();
    entry.session.removeAllListeners('will-download');
    this.options.window.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false });
    this.entries.delete(id);
    this.log(entry, 'info', 'browser', 'Browser closed; persistent profile retained');
    this.changed();
    if (failure) throw failure;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.creating.catch(() => undefined);
    const results = await Promise.allSettled([...this.entries.keys()].map((id) => this.close(id)));
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Browser shutdown cleanup failed',
      );
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(filename);
    else if (entry.isFile()) total += (await stat(filename).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
