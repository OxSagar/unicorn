import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { BrowserWindow, Session, WebContentsView } from 'electron';
import { BrowserManager } from '../../src/main/browser/manager';
import { RendererCrashError } from '../../src/main/browser/recovery';
import { SiteRestrictionError } from '../../src/main/network/site-restriction';
import type { GateHooks } from '../../src/main/network/session-gate';
import type { QaHooks } from '../../src/main/qa/stages';
import { DEFAULT_SETTINGS, DEVICES } from '../../src/shared/defaults';
import type { ProxyRecord } from '../../src/shared/types';

const native = vi.hoisted(() => ({
  newView: vi.fn(),
  fromPartition: vi.fn(),
  newGate: vi.fn(),
  applyDevice: vi.fn(),
  stages: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { getPath: () => '/unused-recovery-test' },
  dialog: { showSaveDialog: vi.fn() },
  session: { fromPartition: native.fromPartition },
  WebContentsView: native.newView,
}));
vi.mock('../../src/main/network/session-gate', () => ({ SessionGate: native.newGate }));
vi.mock('../../src/main/browser/device', () => ({
  applyDevice: native.applyDevice,
  fitDevice: vi.fn(async () => undefined),
  readDiagnostic: vi.fn(async () => ({})),
}));
vi.mock('../../src/main/qa/stages', () => ({ runStages: native.stages }));
vi.mock('../../src/main/qa/challenge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/qa/challenge')>()),
  detectChallenge: vi.fn(async () => false),
}));

const target = 'https://authorized.test/landing';
const replacement = 'https://authorized.test/replacement';
const proxy: ProxyRecord = {
  id: 'http://8.8.8.8:8080',
  ip: '8.8.8.8',
  port: 8080,
  protocol: 'http',
  country: 'US',
  countryName: 'United States',
  source: 'proxyscrape',
  status: 'assigned',
  failures: 0,
};
let nextId = 0;

class SessionDouble extends EventEmitter {
  poisoned = false;
  gate?: GateDouble;
  readonly cookies = { flushStore: vi.fn(async () => undefined) };
  readonly flushStorageData = vi.fn();
}
class GateDouble {
  isEnabled = false;
  constructor(
    readonly session: SessionDouble,
    readonly hooks: GateHooks,
  ) {
    session.gate = this;
  }
  readonly block = vi.fn(async () => {
    this.isEnabled = false;
    if (this.session.poisoned) throw new Error('Session is poisoned; restart Unicorn');
  });
  readonly assign = vi.fn(async (_proxy: ProxyRecord, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (this.session.poisoned) throw new Error('Session is poisoned; restart Unicorn');
    this.isEnabled = true;
  });
  readonly dispose = vi.fn(() => {
    this.isEnabled = false;
  });
}
class ContentsDouble extends EventEmitter {
  readonly id = ++nextId;
  destroyed = false;
  crashed = false;
  loading = false;
  url = '';
  readonly debugger = { isAttached: () => true };
  readonly navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  readonly setWebRTCIPHandlingPolicy = vi.fn();
  readonly setWindowOpenHandler = vi.fn();
  readonly stop = vi.fn(() => {
    this.loading = false;
  });
  readonly executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, _scripts: unknown[]) => 1);
  readonly close = vi.fn(() => {
    this.destroyed = true;
    this.emit('destroyed');
  });
  readonly loadURL = vi.fn(async (url: string) => {
    if (this.destroyed) throw new Error('View was destroyed');
    if (url !== 'about:blank' && !this.session.gate?.isEnabled) throw new Error('Networking is denied');
    this.url = url;
    this.emit('did-start-loading');
    this.emit('did-navigate', {}, url, 200);
    this.emit('did-stop-loading');
  });
  constructor(readonly session: SessionDouble) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isCrashed() {
    return this.crashed;
  }
  isLoading() {
    return this.loading;
  }
  getURL() {
    return this.url;
  }
  getTitle() {
    return 'Fixture';
  }
  crash(reason = 'crashed') {
    this.crashed = true;
    this.emit('render-process-gone', {}, { reason, exitCode: 1 });
  }
}
interface ViewDouble {
  webContents: ContentsDouble;
  setVisible: ReturnType<typeof vi.fn>;
  setBounds: ReturnType<typeof vi.fn>;
}
let views: ViewDouble[];
let sessions: Map<string, SessionDouble>;
const managers = new Set<BrowserManager>();

async function setup(retryLimit = 2) {
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.authorizedDomains = ['authorized.test'];
  settings.stagingConfirmed = true;
  settings.retryLimit = retryLimit;
  const acquire = vi.fn(async () => ({ ...proxy }));
  const release = vi.fn(async (_id: number, _reason?: string) => undefined);
  const log = vi.fn();
  const window = {
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ width: 1200, height: 800 }),
  } as unknown as BrowserWindow;
  const manager = new BrowserManager({
    window,
    settings: () => settings,
    proxies: { acquire, release },
    changed: vi.fn(),
    log,
    profileData: { load: () => ({ device: { ...DEVICES.mobile }, history: [] }), save: vi.fn() },
  });
  managers.add(manager);
  await manager.create(1);
  return {
    manager,
    acquire,
    release,
    log,
    settings,
    first: views[0].webContents,
    session: views[0].webContents.session,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  views = [];
  sessions = new Map();
  native.applyDevice.mockReset().mockResolvedValue(undefined);
  native.fromPartition.mockReset().mockImplementation((partition: string) => {
    if (!sessions.has(partition)) sessions.set(partition, new SessionDouble());
    return sessions.get(partition);
  });
  native.newGate.mockReset().mockImplementation(function (session: SessionDouble, hooks: GateHooks) {
    return new GateDouble(session, hooks);
  });
  native.newView.mockReset().mockImplementation(function (options: { webPreferences: { session: Session } }) {
    const view: ViewDouble = {
      webContents: new ContentsDouble(options.webPreferences.session as unknown as SessionDouble),
      setVisible: vi.fn(),
      setBounds: vi.fn(),
    };
    views.push(view);
    return view as unknown as WebContentsView;
  });
  native.stages.mockReset().mockImplementation(async (url: string, hooks: QaHooks) => {
    await hooks.navigate(url);
    await hooks.control.wait(60_000);
  });
});

afterEach(async () => {
  for (const manager of managers) await manager.shutdown().catch(() => undefined);
  managers.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('direct endpoint assignment failures', () => {
  it.each(['manual', 'QA'] as const)(
    'releases a terminal %s transport failure into endpoint cooldown with retries disabled',
    async (mode) => {
      const { manager, first, acquire, release, session } = await setup(0);
      const failure = Object.assign(new Error('ERR_PROXY_CONNECTION_FAILED while loading the page'), {
        code: 'ERR_PROXY_CONNECTION_FAILED',
      });
      first.loadURL.mockRejectedValueOnce(failure);
      const run = mode === 'manual' ? manager.navigate(1, target) : manager.runQa(1, target);
      await expect(run).rejects.toBe(failure);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(release.mock.calls.filter((call) => call[1] !== undefined)).toEqual([[1, failure.message]]);
      expect(session.gate?.isEnabled).toBe(false);
      expect(manager.snapshots()[0]).toMatchObject({ state: 'ERROR', lastError: failure.message });
      expect(manager.snapshots()[0].proxy).toBeUndefined();
    },
  );

  it.each(['ERR_CERT_AUTHORITY_INVALID', 'ERR_BLOCKED_BY_CLIENT', 'ERR_ABORTED'])(
    'does not quarantine an endpoint for a non-transport page failure: %s',
    async (code) => {
      const { manager, first, release } = await setup(0);
      const failure = Object.assign(new Error(`${code} while loading the page`), { code });
      first.loadURL.mockRejectedValueOnce(failure);
      await expect(manager.navigate(1, target)).rejects.toBe(failure);
      expect(release.mock.calls.every((call) => call[1] === undefined)).toBe(true);
      expect(manager.snapshots()[0].proxy).toBeUndefined();
    },
  );

  it('retires an idle manual main-frame transport failure once without allocating a replacement', async () => {
    const { manager, first, acquire, release, session } = await setup();
    await manager.navigate(1, target);
    release.mockClear();
    session.gate!.hooks.onFailure('net::ERR_PROXY_CONNECTION_FAILED', true, first.id);
    expect(session.gate?.isEnabled).toBe(false);
    expect(manager.snapshots()[0]).toMatchObject({ state: 'ERROR', stage: 'Navigation failed' });
    session.gate!.hooks.onFailure('net::ERR_PROXY_CONNECTION_FAILED', true, first.id);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(release.mock.calls).toEqual([[1, 'net::ERR_PROXY_CONNECTION_FAILED']]);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(manager.snapshots()[0].proxy).toBeUndefined();
  });

  it.each(['subresource', 'other view', 'certificate', 'abort'] as const)(
    'does not retire the parent lease for an idle %s error',
    async (kind) => {
      const { manager, first, release, session } = await setup();
      await manager.navigate(1, target);
      release.mockClear();
      const message =
        kind === 'certificate'
          ? 'net::ERR_CERT_AUTHORITY_INVALID'
          : kind === 'abort'
            ? 'net::ERR_ABORTED'
            : 'net::ERR_PROXY_CONNECTION_FAILED';
      session.gate!.hooks.onFailure(
        message,
        kind !== 'subresource',
        kind === 'other view' ? first.id + 1 : first.id,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(release).not.toHaveBeenCalled();
      expect(session.gate?.isEnabled).toBe(true);
      expect(manager.snapshots()[0].state).toBe('RUNNING');
    },
  );

  it.each(['replacement', 'stop'] as const)(
    'finishes idle failure cleanup before a concurrent %s can reuse its lease',
    async (action) => {
      const { manager, first, acquire, release, session } = await setup();
      await manager.navigate(1, target);
      release.mockClear();
      let cleanupFinished!: () => void;
      session.gate!.block.mockImplementationOnce(() => {
        session.gate!.isEnabled = false;
        return new Promise<void>((resolve) => {
          cleanupFinished = resolve;
        });
      });
      session.gate!.hooks.onFailure('net::ERR_PROXY_CONNECTION_FAILED', true, first.id);
      const next = action === 'replacement' ? manager.navigate(1, replacement) : manager.stop(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(first.loadURL).not.toHaveBeenCalledWith(replacement);
      cleanupFinished();
      await next;
      expect(release.mock.calls.filter((call) => call[1] !== undefined)).toEqual([
        [1, 'net::ERR_PROXY_CONNECTION_FAILED'],
      ]);
      expect(manager.snapshots()[0].state).toBe(action === 'replacement' ? 'RUNNING' : 'STOPPED');
      expect(session.gate?.isEnabled).toBe(action === 'replacement');
      expect(acquire).toHaveBeenCalledTimes(action === 'replacement' ? 2 : 1);
      expect(Boolean(manager.snapshots()[0].proxy)).toBe(action === 'replacement');
    },
  );
});

describe('manager renderer recovery lifetime', () => {
  it.each(['immediate', 'pending native cleanup'] as const)(
    'keeps a %s startup Pause resumable before acquiring any proxy',
    async (timing) => {
      const { manager, acquire, session } = await setup();
      native.stages.mockImplementationOnce(async (url: string, hooks: QaHooks) => {
        await hooks.navigate(url);
      });
      let cleanupFinished: (() => void) | undefined;
      if (timing === 'pending native cleanup')
        session.gate!.block.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              cleanupFinished = resolve;
            }),
        );
      const run = manager.runQa(1, target);
      if (timing === 'pending native cleanup') await vi.advanceTimersByTimeAsync(0);
      await manager.pause(1);
      cleanupFinished?.();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(manager.snapshots()[0].state).toBe('PAUSED');
      expect(acquire).not.toHaveBeenCalled();
      expect(session.gate?.isEnabled).toBe(false);
      await manager.resume(1);
      await run;
      expect(manager.snapshots()[0].state).toBe('COMPLETED');
      expect(acquire).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps one accepted QA promise alive while repairing only the view in its original session', async () => {
    const { manager, first, release, session } = await setup();
    native.stages
      .mockImplementationOnce(async (url: string, hooks: QaHooks) => {
        await hooks.navigate(url);
        await hooks.control.wait(60_000);
      })
      .mockImplementationOnce(async (url: string, hooks: QaHooks) => {
        await hooks.navigate(url);
      });
    let completed = false;
    const run = manager.runQa(1, target).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    first.crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(completed).toBe(false);
    expect(manager.snapshots()[0].state).toBe('RETRY_WAIT');
    await vi.advanceTimersByTimeAsync(1000);
    await run;
    expect(native.stages).toHaveBeenCalledTimes(2);
    expect(native.stages.mock.calls.map(([url]) => url)).toEqual([target, target]);
    expect(views).toHaveLength(2);
    expect(views[1].webContents.session).toBe(session);
    expect(native.newGate).toHaveBeenCalledTimes(1);
    expect(native.fromPartition).toHaveBeenCalledTimes(1);
    expect(views[1].webContents.loadURL.mock.calls.map(([url]) => url)).toEqual(['about:blank', target]);
    expect(native.applyDevice).toHaveBeenLastCalledWith(views[1].webContents, DEVICES.mobile);
    expect(manager.snapshots()[0]).toMatchObject({ state: 'COMPLETED', device: DEVICES.mobile });
    expect(release.mock.calls.every((call) => call[1] === undefined)).toBe(true);
    expect(session.gate?.isEnabled).toBe(false);
  });

  it('does not recover when retryLimit is zero', async () => {
    const { manager, first, session } = await setup(0);
    const outcome = manager.runQa(1, target).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    first.crash();
    expect(await outcome).toBeInstanceOf(RendererCrashError);
    expect(views).toHaveLength(1);
    expect(manager.snapshots()[0].state).toBe('ERROR');
    expect(session.gate?.isEnabled).toBe(false);
  });

  it('does not replay an interactive browsing operation automatically', async () => {
    const { manager, first } = await setup();
    await manager.navigate(1, target);
    first.crash();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(views).toHaveLength(1);
    expect(manager.snapshots()[0].state).toBe('ERROR');
  });

  it('preserves a paused recovery until Resume and excludes paused time from backoff', async () => {
    const { manager, first, session } = await setup();
    native.stages
      .mockImplementationOnce(async (url: string, hooks: QaHooks) => {
        await hooks.navigate(url);
        await hooks.control.wait(60_000);
      })
      .mockImplementationOnce(async (url: string, hooks: QaHooks) => {
        await hooks.navigate(url);
      });
    const run = manager.runQa(1, target);
    await vi.advanceTimersByTimeAsync(0);
    first.crash();
    await vi.advanceTimersByTimeAsync(250);
    await manager.pause(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(views).toHaveLength(1);
    expect(session.gate?.isEnabled).toBe(false);
    expect(manager.snapshots()[0].state).toBe('PAUSED');
    await manager.resume(1);
    await vi.advanceTimersByTimeAsync(750);
    await run;
    expect(views).toHaveLength(2);
    expect(manager.snapshots()[0].state).toBe('COMPLETED');
  });

  it.each(['stop', 'close', 'replacement'] as const)(
    'cancels queued recovery on %s and ignores the old view afterwards',
    async (action) => {
      const { manager, first, acquire } = await setup();
      const outcome = manager.runQa(1, target).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      first.crash();
      await vi.advanceTimersByTimeAsync(0);
      if (action === 'replacement') await manager.navigate(1, replacement);
      else await manager.action(1, action);
      await outcome;
      await vi.advanceTimersByTimeAsync(10_000);
      if (action === 'replacement') {
        expect(views).toHaveLength(2);
        const before = manager.snapshots()[0];
        first.crash();
        first.emit('did-navigate', {}, 'https://old.invalid/stale', 200);
        first.emit('page-title-updated', {}, 'Stale title');
        expect(manager.snapshots()[0]).toEqual(before);
        expect(views[1].webContents.loadURL.mock.calls.map(([url]) => url)).toEqual([
          'about:blank',
          replacement,
        ]);
        expect(acquire).toHaveBeenCalledTimes(2);
      } else {
        expect(views).toHaveLength(1);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(manager.snapshots()[0]?.state ?? 'closed').toBe(action === 'close' ? 'closed' : 'STOPPED');
      }
    },
  );

  it('lets an access restriction outrank a crash delivered in the same event turn', async () => {
    const { manager, first, acquire, session } = await setup();
    const outcome = manager.runQa(1, target).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    session.gate!.hooks.onRestricted(429, target);
    first.crash();
    const error = await outcome;
    expect(error).toBeInstanceOf(SiteRestrictionError);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(views).toHaveLength(1);
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(manager.snapshots()[0].lastError).toContain('HTTP 429');
    expect(session.gate?.isEnabled).toBe(false);
  });

  it('releases an idle manual-page lease after a background request exceeds policy', async () => {
    const { manager, acquire, release, session } = await setup();
    await manager.navigate(1, target);
    expect(manager.snapshots()[0].proxy).toBeDefined();
    release.mockClear();
    session.gate!.hooks.onPolicyRestricted!(new SiteRestrictionError('Daily request limit reached', target));
    expect(session.gate?.isEnabled).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledWith(1, undefined);
    expect(manager.snapshots()[0]).toMatchObject({
      state: 'ERROR',
      lastError: 'Daily request limit reached',
    });
    expect(manager.snapshots()[0].proxy).toBeUndefined();
    expect(acquire).toHaveBeenCalledTimes(1);
  });

  it('cannot recover a profile whose native session became poisoned', async () => {
    const { manager, first, session } = await setup();
    const outcome = manager.runQa(1, target).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    session.poisoned = true;
    first.crash();
    expect(String(await outcome)).toMatch(/poisoned/);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(views).toHaveLength(1);
    expect(native.newGate).toHaveBeenCalledTimes(1);
    expect(session.gate?.isEnabled).toBe(false);
  });

  it('stops after the configured number of automatic retries', async () => {
    const { manager } = await setup(2);
    const outcome = manager.runQa(1, target).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    for (const delay of [1000, 2000]) {
      views.at(-1)!.webContents.crash();
      await vi.advanceTimersByTimeAsync(delay);
    }
    views.at(-1)!.webContents.crash();
    expect(await outcome).toBeInstanceOf(RendererCrashError);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(native.stages).toHaveBeenCalledTimes(3);
    expect(views).toHaveLength(3);
    expect(manager.snapshots()[0].state).toBe('ERROR');
  });
});

describe('bounded renderer health probes', () => {
  it('coalesces probes and stops after two misses without inferring a retryable renderer exit', async () => {
    const { manager, first, session } = await setup();
    await manager.navigate(1, target);
    first.executeJavaScriptInIsolatedWorld.mockImplementation(() => new Promise<number>(() => undefined));
    await vi.advanceTimersByTimeAsync(10_000);
    for (let index = 0; index < 50; index++) manager.checkHealth();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.gate?.isEnabled).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    manager.checkHealth();
    await vi.advanceTimersByTimeAsync(5000);
    expect(first.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
    expect(session.gate?.isEnabled).toBe(false);
    expect(manager.snapshots()[0]).toMatchObject({
      state: 'ERROR',
      lastError: expect.stringMatching(/two health checks/),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    manager.checkHealth();
    expect(views).toHaveLength(1);
    expect(first.executeJavaScriptInIsolatedWorld).toHaveBeenCalledTimes(2);
  });

  it('skips loading, paused, stopped, and restricted views', async () => {
    const { manager, first, session } = await setup();
    await manager.navigate(1, target);
    await vi.advanceTimersByTimeAsync(10_000);
    first.loading = true;
    manager.checkHealth();
    first.loading = false;
    await manager.pause(1);
    manager.checkHealth();
    await manager.resume(1);
    session.gate!.hooks.onRestricted(403, target);
    manager.checkHealth();
    await manager.stop(1);
    manager.checkHealth();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it('does not count an aborted probe after Stop and leaves no watchdog timer', async () => {
    const { manager, first, log } = await setup();
    await manager.navigate(1, target);
    first.executeJavaScriptInIsolatedWorld.mockImplementation(() => new Promise<number>(() => undefined));
    await vi.advanceTimersByTimeAsync(10_000);
    manager.checkHealth();
    await vi.advanceTimersByTimeAsync(0);
    await manager.stop(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      log.mock.calls.filter(
        ([, category, message]) => category === 'watchdog' && String(message).includes('failed'),
      ),
    ).toHaveLength(0);
    expect(manager.snapshots()[0].state).toBe('STOPPED');
    expect(vi.getTimerCount()).toBe(0);
  });
});
