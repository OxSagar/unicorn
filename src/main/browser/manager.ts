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
import { CHALLENGE_MESSAGE, detectChallenge } from '../qa/challenge';
import { RunControl } from '../qa/control';
import { runStages } from '../qa/stages';
import { applyDevice, fitDevice, readDiagnostic } from './device';
import { withDeadline } from './deadline';

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
  settings: () => AppSettings;
  proxies: {
    acquire(id: number, signal?: AbortSignal): Promise<ProxyRecord | null | undefined>;
    release(id: number, reason?: string): void | Promise<void>;
  };
  log: (level: ActivityEvent['level'], category: string, message: string, browserId?: number) => void;
  changed: () => void;
  navigationAllowed?: (url: string) => void;
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
  control?: RunControl;
  active?: Promise<void>;
  bounds?: ViewBounds;
  inspectedPopup?: number;
  pausedState?: BrowserState;
  restricted?: Error;
  synthetic: boolean;
  closing: boolean;
  downloads: Set<Electron.DownloadItem>;
}
export class BrowserManager {
  private entries = new Map<number, Entry>();
  private creating: Promise<void> = Promise.resolve();
  private shuttingDown = false;
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
      approveNavigation: (url, mainFrame) => {
        assertApproved(url, this.options.settings());
        if (mainFrame) this.options.navigationAllowed?.(url);
      },
      onFailure: (message, mainFrame) => {
        const entry = holder.entry;
        if (!entry || entry.closing) return;
        entry.snapshot.networkErrors++;
        if (mainFrame) entry.snapshot.lastError = message;
        this.log(entry, 'warn', 'network', message);
        this.changed();
      },
      onRestricted: (status, _url) => {
        const entry = holder.entry;
        if (!entry || entry.closing) return;
        entry.restricted = new Error(
          `HTTP ${status}: testing paused; proxy rotation will not bypass this response`,
        );
        entry.snapshot.lastError = entry.restricted.message;
        entry.abort?.abort(entry.restricted);
        this.log(entry, 'warn', 'authorization', entry.restricted.message);
        void gate.block().catch((error: unknown) => this.log(entry, 'error', 'network', String(error)));
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
      downloads: new Set(),
    };
    holder.entry = entry;
    this.entries.set(id, entry);
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
      'Persistent isolated browser created; network locked until proxy validation',
    );
  }

  private newView(ses: Session): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
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
      },
    });
    view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    return view;
  }

  private wireContents(entry: Entry, contents: WebContents, child: boolean): void {
    contents.on('before-input-event', (event, input) => {
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
        if (!entry.gate.isEnabled) throw new Error('Browser networking is paused');
        assertApproved(url, this.options.settings());
      } catch (error) {
        event.preventDefault();
        this.log(entry, 'warn', 'navigation', String(error));
      }
    });
    contents.on('will-redirect', (event, url) => {
      try {
        assertApproved(url, this.options.settings());
      } catch (error) {
        event.preventDefault();
        this.log(entry, 'warn', 'navigation', `Redirect blocked: ${String(error)}`);
      }
    });
    contents.on('did-start-loading', () => {
      if (!child) {
        entry.snapshot.loading = true;
        this.changed();
      }
    });
    contents.on('did-stop-loading', () => {
      if (!child && !contents.isDestroyed()) {
        entry.snapshot.loading = false;
        entry.snapshot.canGoBack = contents.navigationHistory.canGoBack();
        entry.snapshot.canGoForward = contents.navigationHistory.canGoForward();
        this.changed();
      }
    });
    contents.on('did-navigate', (_event, url, httpResponseCode) => {
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
      if (!child && mainFrame) {
        entry.snapshot.url = url;
        this.changed();
      }
    });
    contents.on('page-title-updated', (_event, title) => {
      if (child) this.syncPopups(entry);
      else {
        entry.snapshot.title = title;
        this.changed();
      }
    });
    contents.on('console-message', (details) => {
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
      if (entry.closing) return;
      const error = new Error(`Browser renderer exited: ${details.reason}`);
      entry.snapshot.lastError = error.message;
      entry.abort?.abort(error);
      if (canTransition(entry.snapshot.state, 'ERROR')) this.move(entry, 'ERROR');
      void entry.gate
        .block()
        .then(() => this.options.proxies.release(entry.snapshot.id))
        .catch(() => undefined);
      this.log(
        entry,
        'error',
        'crash',
        `${error.message}; profile retained. Start the browser again to recover.`,
      );
    });
    contents.on('unresponsive', () => {
      this.log(entry, 'warn', 'watchdog', 'Renderer is unresponsive; operation timeout remains active');
    });
    contents.setWindowOpenHandler((details) => {
      try {
        if (!entry.gate.isEnabled || entry.children.size >= 8)
          throw new Error('Popup limit reached or networking is inactive');
        assertApproved(details.url, this.options.settings());
        this.log(entry, 'info', 'popup', 'Approved popup requested');
        return {
          action: 'allow',
          createWindow: () => {
            const popup = this.newView(entry.session);
            this.options.window.contentView.addChildView(popup);
            popup.setVisible(false);
            entry.children.set(popup.webContents.id, popup);
            this.wireContents(entry, popup.webContents, true);
            void applyDevice(popup.webContents, entry.snapshot.device).catch((error: unknown) =>
              this.log(entry, 'warn', 'device', String(error)),
            );
            popup.webContents.once('destroyed', () => {
              entry.children.delete(popup.webContents.id);
              this.syncPopups(entry);
            });
            this.syncPopups(entry);
            return popup.webContents;
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
      if (sizeChanged)
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
    entry.snapshot.stage = 'Waiting for a verified proxy';
    this.move(entry, 'VALIDATING_PROXY');
    const proxy = await this.options.proxies.acquire(entry.snapshot.id, signal);
    signal.throwIfAborted();
    if (!proxy) {
      this.move(entry, 'WAITING_FOR_PROXY');
      throw new Error('No validated, eligible, unassigned proxy is currently available');
    }
    await control?.checkpoint();
    entry.snapshot.proxy = proxy;
    try {
      await entry.gate.assign(proxy, signal, synthetic);
    } catch (error) {
      if (!control?.isPaused || signal.aborted) throw error;
      // A pause can supersede an in-flight Chromium proxy-configuration call.
      // Keep its reservation and complete the same assignment after resume.
      await control.checkpoint();
      await entry.gate.assign(proxy, signal, synthetic);
    }
    if (!entry.view.webContents.debugger.isAttached())
      await applyDevice(entry.view.webContents, entry.snapshot.device);
    this.move(entry, 'READY');
    this.log(
      entry,
      'info',
      'proxy',
      `Verified ${proxy.country} ${proxy.protocol.toUpperCase()} proxy assigned`,
    );
  }

  private async navigateReady(entry: Entry, url: string, control: RunControl): Promise<void> {
    const normalized = assertApproved(url, this.options.settings());
    await control.checkpoint();
    if (entry.restricted) throw entry.restricted;
    await this.ready(entry, control.signal, entry.synthetic, control);
    await control.checkpoint();
    this.move(entry, 'NAVIGATING');
    entry.snapshot.lastError = undefined;
    const timeoutMs = this.options.settings().timings.navigationTimeoutMs;
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
    entry.restricted = new Error(CHALLENGE_MESSAGE);
    entry.snapshot.lastError = CHALLENGE_MESSAGE;
    entry.snapshot.stage = 'Manual review required';
    this.log(entry, 'warn', 'authorization', CHALLENGE_MESSAGE);
    // block() disables requests synchronously, including background workers and popup traffic.
    void entry.gate.block().catch((error: unknown) => this.log(entry, 'error', 'network', String(error)));
    entry.abort?.abort(entry.restricted);
    this.changed();
    throw entry.restricted;
  }

  private operation(
    entry: Entry,
    synthetic: boolean,
    task: (control: RunControl) => Promise<void>,
  ): Promise<void> {
    entry.abort?.abort(new Error('Replaced by a new browser operation'));
    const previous = entry.active;
    const abort = new AbortController();
    entry.abort = abort;
    const run = (async () => {
      await previous?.catch(() => undefined);
      abort.signal.throwIfAborted();
      await this.lockNetwork(entry);
      if (entry.closing) throw new Error('Browser was closed');
      this.move(entry, 'STOPPED');
      entry.restricted = undefined;
      entry.synthetic = synthetic;
      entry.snapshot.startedAt = Date.now();
      const control = new RunControl(abort.signal);
      entry.control = control;
      try {
        await task(control);
        if (synthetic) {
          this.move(entry, 'COMPLETED');
          if (this.options.settings().closePopupsAfterRun) this.closePopups(entry);
          await this.lockNetwork(entry);
        }
      } catch (error) {
        entry.snapshot.lastError = error instanceof Error ? error.message : String(error);
        if (
          entry.snapshot.state !== 'WAITING_FOR_PROXY' &&
          !entry.closing &&
          canTransition(entry.snapshot.state, 'ERROR')
        )
          this.move(entry, abort.signal.aborted && !entry.restricted ? 'STOPPED' : 'ERROR');
        await this.lockNetwork(entry);
        throw error;
      } finally {
        entry.snapshot.elapsedMs = entry.snapshot.startedAt ? Date.now() - entry.snapshot.startedAt : 0;
        entry.snapshot.startedAt = undefined;
        entry.session.flushStorageData();
        await entry.session.cookies.flushStore().catch(() => undefined);
        this.save(entry);
        if (entry.abort === abort) {
          entry.control = undefined;
          entry.abort = undefined;
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

  async navigate(id: number, url: string): Promise<void> {
    const normalized = assertApproved(url, this.options.settings());
    const entry = this.entry(id);
    return this.operation(entry, false, async (control) => {
      entry.snapshot.stage = 'Manual browsing';
      await this.navigateReady(entry, normalized, control);
    });
  }

  async runQa(id: number, url: string): Promise<void> {
    const normalized = assertApproved(url, this.options.settings());
    const entry = this.entry(id);
    return this.operation(entry, true, async (control) => {
      await runStages(normalized, {
        contents: entry.view.webContents,
        settings: this.options.settings,
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
                attempt >= this.options.settings().retryLimit
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
    await entry.gate.block();
    for (const item of entry.downloads) item.cancel();
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.stop();
    for (const child of entry.children.values())
      if (!child.webContents.isDestroyed()) child.webContents.stop();
    await this.options.proxies.release(entry.snapshot.id, failure);
    entry.snapshot.proxy = undefined;
  }

  async pause(id: number): Promise<void> {
    const entry = this.entry(id);
    if (entry.snapshot.state === 'PAUSED' || !canTransition(entry.snapshot.state, 'PAUSED')) return;
    entry.pausedState = entry.snapshot.state;
    entry.control?.pause();
    // Pause test time and all session requests. The assignment remains reserved.
    await entry.gate.block();
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.stop();
    this.move(entry, 'PAUSED');
  }

  async resume(id: number): Promise<void> {
    const entry = this.entry(id);
    if (entry.snapshot.state !== 'PAUSED') return;
    const signal = entry.control?.signal ?? new AbortController().signal;
    if (entry.snapshot.proxy) await entry.gate.assign(entry.snapshot.proxy, signal, entry.synthetic);
    const previous = entry.pausedState ?? 'RUNNING';
    this.move(entry, previous);
    entry.control?.resume();
  }

  async stop(id: number): Promise<void> {
    const entry = this.entry(id);
    entry.abort?.abort(new Error('Stopped by user'));
    await entry.gate.block();
    await entry.active?.catch(() => undefined);
    await this.lockNetwork(entry);
    this.closePopups(entry);
    this.move(entry, 'STOPPED');
    entry.snapshot.stage = 'Stopped';
    entry.snapshot.loading = false;
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
    assertApproved(target.url, this.options.settings());
    if (entry.active) throw new Error('Pause or stop the active QA run before changing browser history');
    const controller = new AbortController();
    await this.ready(entry, controller.signal, false);
    history.goToIndex(index);
  }

  async applyDevice(ids: number[], device: DeviceConfig): Promise<void> {
    for (const id of ids) {
      const entry = this.entry(id);
      if (entry.active) throw new Error('Stop active testing before changing its device configuration');
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

  async profile(id: number, action: ProfileAction): Promise<number | undefined> {
    const entry = this.entry(id);
    if (action === 'storage') {
      const directory = entry.session.storagePath;
      if (!directory) return entry.session.getCacheSize();
      return directoryBytes(directory);
    }
    await this.stop(id);
    const previousUrl = entry.snapshot.url;
    if (action === 'cookies' || action === 'reset')
      await withDeadline(entry.view.webContents.loadURL('about:blank'), 8000);
    if (action === 'cache' || action === 'reset') await entry.session.clearCache();
    if (action === 'cookies') await entry.session.clearStorageData({ storages: ['cookies'] });
    if (action === 'history' || action === 'reset') {
      entry.snapshot.history = [];
      entry.view.webContents.navigationHistory.clear();
    }
    if (action === 'permissions' || action === 'reset') {
      entry.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      entry.session.setPermissionCheckHandler(() => false);
    }
    if (action === 'reset') {
      await entry.session.clearStorageData();
      await entry.session.clearAuthCache();
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
      this.options.window.contentView.removeChildView(popup);
      popup.webContents.close({ waitForBeforeUnload: false });
      entry.children.delete(popupId);
      if (entry.inspectedPopup === popupId) entry.inspectedPopup = undefined;
    } else entry.inspectedPopup = entry.inspectedPopup === popupId ? undefined : popupId;
    if (entry.bounds)
      this.layout([...this.entries.values()].flatMap((item) => (item.bounds ? [item.bounds] : [])));
    this.syncPopups(entry);
  }

  private closePopups(entry: Entry): void {
    for (const popup of entry.children.values()) {
      this.options.window.contentView.removeChildView(popup);
      if (!popup.webContents.isDestroyed()) popup.webContents.close({ waitForBeforeUnload: false });
    }
    entry.children.clear();
    entry.inspectedPopup = undefined;
    this.syncPopups(entry);
    if (entry.bounds) entry.view.setVisible(entry.bounds.visible);
  }

  async diagnostic(id: number): Promise<Record<string, unknown>> {
    const entry = this.entry(id);
    const data = await readDiagnostic(entry.view.webContents);
    return {
      ...data,
      partition: `persist:unicorn-browser-${String(id).padStart(2, '0')}`,
      proxyEnabled: entry.gate.isEnabled,
      proxyResolution: await entry.session.resolveProxy('https://unicorn.invalid/'),
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
    const cutoff = Date.now() - this.options.settings().logRetentionDays * 86400000;
    for (let index = 0; index < names.length; index++) {
      if (index < names.length - 400 || Number(names[index].split('-')[0]) < cutoff)
        await unlink(path.join(directory, names[index])).catch(() => undefined);
    }
  }

  private async close(id: number): Promise<void> {
    const entry = this.entry(id);
    await this.stop(id);
    entry.closing = true;
    this.save(entry);
    entry.session.flushStorageData();
    await entry.session.cookies.flushStore();
    entry.gate.dispose();
    entry.session.removeAllListeners('will-download');
    this.options.window.contentView.removeChildView(entry.view);
    entry.view.webContents.close({ waitForBeforeUnload: false });
    this.entries.delete(id);
    this.log(entry, 'info', 'browser', 'Browser closed; persistent profile retained');
    this.changed();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.creating.catch(() => undefined);
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
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
