import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AppCommand, AppSnapshot, CommandResult, PerformanceSnapshot } from '../shared/types';
import BrowserGrid from './BrowserGrid';
import DevicesPage from './DevicesPage';
import LinksPage from './LinksPage';
import LogsPage from './LogsPage';
import PerformancePage from './PerformancePage';
import ProxiesPage from './ProxiesPage';
import SchedulesPage from './SchedulesPage';
import SettingsPage from './SettingsPage';
import { Badge, Brand, Button, Icon, IconButton, Metric } from './components';
import type { IconName } from './components';
import type { Page, PageProps } from './ui-types';

const navigation: Array<{ id: Page; label: string; icon: IconName }> = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'browsers', label: 'Browsers', icon: 'browser' },
  { id: 'links', label: 'Link distribution', icon: 'link' },
  { id: 'proxies', label: 'Proxies', icon: 'shield' },
  { id: 'devices', label: 'Device profiles', icon: 'device' },
  { id: 'schedules', label: 'Test schedules', icon: 'clock' },
  { id: 'logs', label: 'Activity logs', icon: 'logs' },
  { id: 'performance', label: 'Performance', icon: 'chart' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
type Notice = { id: number; message: string; level: 'success' | 'error' };
type Dialog = { title: string; content: ReactNode; action?: () => void; destructive?: boolean };

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [page, setPage] = useState<Page>('dashboard');
  const [selected, setSelected] = useState<number[]>([]);
  const [browserCount, setBrowserCount] = useState(4);
  const [pendingCommands, setPendingCommands] = useState(0);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [history, setHistory] = useState<PerformanceSnapshot[]>([]);
  const initialized = useRef(false);
  const snapshotRef = useRef(snapshot);
  const noticeSequence = useRef(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  snapshotRef.current = snapshot;
  const addNotice = useCallback((message: string, level: Notice['level']) => {
    setNotices((previous) => [...previous, { id: ++noticeSequence.current, message, level }].slice(-2));
  }, []);
  const ingestSnapshot = useCallback((next: AppSnapshot) => {
    setSnapshot(next);
    setConnectionError('');
    if (!initialized.current) {
      initialized.current = true;
      setBrowserCount(next.settings.browserCount);
      setSelected(next.browsers.map((b) => b.id));
    } else
      setSelected((current) => current.filter((id) => next.browsers.some((browser) => browser.id === id)));
    if (next.performance.sampledAt)
      setHistory((previous) =>
        previous.at(-1)?.sampledAt === next.performance.sampledAt
          ? previous
          : [...previous, next.performance].slice(-90),
      );
  }, []);
  const run = useCallback(
    async (command: AppCommand, success?: string): Promise<CommandResult | undefined> => {
      if (!window.unicorn) {
        addNotice('Open Unicorn as the desktop application to use browser controls.', 'error');
        return;
      }
      setPendingCommands((value) => value + 1);
      try {
        const result = await window.unicorn.invoke(command);
        ingestSnapshot(result.snapshot);
        if (result.message || success) addNotice(result.message || success!, 'success');
        return result;
      } catch (error) {
        addNotice(
          error instanceof Error
            ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
            : String(error),
          'error',
        );
        return undefined;
      } finally {
        setPendingCommands((value) => Math.max(0, value - 1));
      }
    },
    [addNotice, ingestSnapshot],
  );
  useEffect(() => {
    if (!window.unicorn) {
      setConnectionError(
        'This interface runs inside the Unicorn Windows desktop application. Launch Unicorn to access the Chromium browser engine.',
      );
      return;
    }
    let cancelled = false;
    const unsubscribe = window.unicorn.subscribe((next) => {
      if (!cancelled) ingestSnapshot(next);
    });
    void window.unicorn
      .invoke({ type: 'snapshot' })
      .then((result) => {
        if (!cancelled) ingestSnapshot(result.snapshot);
      })
      .catch((error) => {
        if (!cancelled) setConnectionError(String(error));
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [ingestSnapshot]);
  useEffect(() => {
    document.documentElement.dataset.theme = snapshot?.settings.theme || 'dark';
  }, [snapshot?.settings.theme]);
  const hideViews = useCallback(() => {
    window.unicorn?.layout(
      (snapshotRef.current?.browsers || []).map((b) => ({
        id: b.id,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      })),
    );
  }, []);
  const navigatePage = useCallback(
    (next: Page) => {
      if (next !== 'dashboard' && next !== 'browsers') hideViews();
      setPage(next);
    },
    [hideViews],
  );
  const confirm = useCallback(
    (title: string, message: string, action: () => void, destructive = false) => {
      hideViews();
      setDialog({ title, content: <p>{message}</p>, action, destructive });
    },
    [hideViews],
  );
  const inspect = useCallback(
    (title: string, content: ReactNode) => {
      hideViews();
      setDialog({ title, content });
    },
    [hideViews],
  );
  useEffect(() => {
    if (dialog) dialogRef.current?.focus();
  }, [dialog]);
  useEffect(() => {
    const emergency = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyS') {
        event.preventDefault();
        void run({ type: 'global', action: 'stop' });
      }
    };
    window.addEventListener('keydown', emergency);
    return () => window.removeEventListener('keydown', emergency);
  }, [run]);
  if (!snapshot)
    return (
      <main className="startup-screen">
        <Brand />
        <div className="startup-card">
          {connectionError ? (
            <>
              <Icon name="info" size={32} />
              <h1>Desktop workspace unavailable</h1>
              <p>{connectionError}</p>
              {window.unicorn && (
                <Button
                  icon="reload"
                  onClick={() => {
                    setConnectionError('');
                    void run({ type: 'snapshot' });
                  }}
                >
                  Retry connection
                </Button>
              )}
            </>
          ) : (
            <>
              <div className="startup-spinner" />
              <h1>Opening your workspace</h1>
              <p>Loading persistent browser profiles and local settings…</p>
            </>
          )}
        </div>
        <span className="startup-caption">INDEPENDENT PROFILES. ONE WORKSPACE.</span>
      </main>
    );
  const active = snapshot.browsers.filter((b) => ['RUNNING', 'NAVIGATING'].includes(b.state)).length;
  const assigned = snapshot.proxies.filter((p) => p.status === 'assigned').length;
  const queued = snapshot.jobs.filter((j) => j.status === 'pending').length;
  const props: PageProps = {
    snapshot,
    selected,
    setSelected,
    run,
    confirm,
    inspect,
    setPage: navigatePage,
    busy: pendingCommands > 0,
  };
  const pageLabel = navigation.find((n) => n.id === page)?.label;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-tag">
          <span className="workspace-monogram">U</span>
          <div>
            <strong>Local workspace</strong>
            <small>Persistent profiles</small>
          </div>
          <Icon name="shield" size={15} />
        </div>
        <p className="nav-section-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {navigation.map((item, index) => (
            <div key={item.id}>
              {index === 6 && <p className="nav-section-label second">MONITORING</p>}
              {index === 8 && <div className="nav-divider" />}
              <button
                className={`nav-item ${page === item.id ? 'active' : ''}`}
                onClick={() => navigatePage(item.id)}
                aria-current={page === item.id ? 'page' : undefined}
              >
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
                {item.id === 'browsers' && <span className="nav-count">{snapshot.browsers.length}</span>}
                {item.id === 'links' && queued > 0 && <span className="nav-count">{queued}</span>}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="proxy-mode">
            <span className="status-dot" />
            <strong>Proxy-only mode</strong>
            <Icon name="shield" size={14} />
          </div>
          <p>Every connection starts with a verified proxy.</p>
          <div className="version-row">
            <span>Unicorn v{snapshot.version}</span>
            <span>CHROMIUM</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="app-header">
          <div className="breadcrumb">
            <span>Workspace</span>
            <Icon name="chevron" size={12} />
            <strong>{pageLabel}</strong>
          </div>
          <div className="global-controls">
            <label className="count-control">
              <Icon name="browser" size={15} />
              <span>Browsers</span>
              <select
                aria-label="Browser count"
                value={browserCount}
                onChange={(e) => setBrowserCount(Number(e.target.value))}
              >
                {Array.from({ length: 20 }, (_, i) => (
                  <option value={i + 1} key={i}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </label>
            <Button
              disabled={pendingCommands > 0}
              onClick={() => {
                if (browserCount < snapshot.browsers.length)
                  confirm(
                    'Resize browser workspace?',
                    `The workspace will retain ${browserCount} open browsers. Closed profiles keep their data.`,
                    () => void run({ type: 'create', count: browserCount }),
                  );
                else void run({ type: 'create', count: browserCount });
              }}
            >
              Apply
            </Button>
            <span className="control-separator" />
            <Button
              icon="play"
              variant="primary"
              disabled={!snapshot.browsers.length}
              onClick={() =>
                void run({ type: 'global', action: snapshot.scheduler.paused ? 'resume' : 'start' })
              }
            >
              {snapshot.scheduler.paused ? 'Resume all' : 'Start all'}
            </Button>
            <IconButton
              icon="pause"
              label="Pause all tests"
              onClick={() => void run({ type: 'global', action: 'pause' })}
            />
            <IconButton
              icon="stop"
              label="Emergency stop all (Ctrl+Shift+S)"
              onClick={() => void run({ type: 'global', action: 'stop' })}
            />
          </div>
        </header>
        {notices.length > 0 && (
          <div className="notice-region" aria-live="polite">
            {notices.map((notice) => (
              <div key={notice.id} className={`notice ${notice.level}`}>
                <Icon name={notice.level === 'error' ? 'info' : 'check'} size={17} />
                <span>{notice.message}</span>
                <IconButton
                  icon="close"
                  label="Dismiss notification"
                  onClick={() => setNotices((current) => current.filter((n) => n.id !== notice.id))}
                />
              </div>
            ))}
          </div>
        )}
        <main
          className={`main-content ${page === 'dashboard' || page === 'browsers' ? 'workspace-page' : ''}`}
        >
          {(page === 'dashboard' || page === 'browsers') && (
            <>
              <div className="dashboard-heading">
                <div>
                  <p className="eyebrow">
                    {page === 'dashboard' ? 'YOUR TEST ENVIRONMENT' : 'INDEPENDENT SESSIONS'}
                  </p>
                  <h1>{page === 'dashboard' ? 'Workspace overview' : 'Browser workspace'}</h1>
                  <p>
                    {page === 'dashboard'
                      ? 'A clear view of every session, connection, and test.'
                      : 'Persistent Chromium profiles, managed from one place.'}
                  </p>
                </div>
                <div className="workspace-health">
                  <span className={`status-dot ${snapshot.scheduler.running ? 'running' : ''}`} />
                  <span>
                    {snapshot.scheduler.paused
                      ? 'Tests paused'
                      : snapshot.scheduler.running
                        ? 'Tests running'
                        : 'Workspace ready'}
                  </span>
                  <Badge>{selected.length} selected</Badge>
                </div>
              </div>
              {page === 'dashboard' && (
                <div className="metrics-grid dashboard-metrics">
                  <Metric
                    icon="browser"
                    label="Active browsers"
                    value={`${active} / ${snapshot.browsers.length}`}
                    note={`${snapshot.browsers.length - active} idle or waiting`}
                  />
                  <Metric
                    icon="shield"
                    label="Proxy connections"
                    value={assigned}
                    note={`${snapshot.proxies.filter((p) => p.status === 'available').length} verified in reserve`}
                  />
                  <Metric
                    icon="check"
                    label="Completed tests"
                    value={snapshot.totals.completed}
                    note={`${queued} tests in queue`}
                  />
                  <Metric
                    icon="chart"
                    label="App memory"
                    value={`${Math.round(snapshot.performance.memoryMb).toLocaleString()} MB`}
                    note={`${snapshot.performance.cpuPercent.toFixed(1)}% CPU · ${snapshot.totals.jsErrors} JS errors`}
                  />
                </div>
              )}
              {(!snapshot.settings.authorizedDomains.length || !snapshot.settings.stagingConfirmed) && (
                <div className="scope-banner">
                  <div className="scope-icon">
                    <Icon name="shield" size={19} />
                  </div>
                  <div>
                    <strong>Set up your authorized testing scope</strong>
                    <span>
                      Add approved domains and confirm your staging or test-ad environment before starting
                      automated runs.
                    </span>
                  </div>
                  <Button icon="arrow" variant="ghost" onClick={() => navigatePage('settings')}>
                    Configure
                  </Button>
                </div>
              )}
              <BrowserGrid {...props} blocked={!!dialog} compact={page === 'browsers'} />
            </>
          )}
          {page === 'links' && <LinksPage {...props} />} {page === 'proxies' && <ProxiesPage {...props} />}{' '}
          {page === 'devices' && <DevicesPage {...props} />}{' '}
          {page === 'schedules' && <SchedulesPage {...props} />} {page === 'logs' && <LogsPage {...props} />}{' '}
          {page === 'performance' && <PerformancePage {...props} history={history} />}{' '}
          {page === 'settings' && <SettingsPage {...props} />}
        </main>
        <footer className="app-statusbar">
          <span>
            <i className={`status-dot ${pendingCommands ? 'working' : ''}`} />
            {pendingCommands ? 'Working…' : 'Local workspace connected'}
          </span>
          <span>
            {snapshot.browsers.length} profiles<span className="statusbar-separator">·</span>JavaScript
            enabled<span className="statusbar-separator">·</span>Proxy required
          </span>
        </footer>
      </div>
      {dialog && (
        <div
          className="dialog-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDialog(null);
          }}
        >
          <div
            className="dialog"
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="dialog-title"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDialog(null);
              if (e.key === 'Tab') {
                const items = dialogRef.current?.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), a[href], input, select, textarea, [tabindex="0"]',
                );
                if (!items?.length) return;
                const first = items[0],
                  last = items[items.length - 1];
                if (
                  e.shiftKey &&
                  (document.activeElement === first || document.activeElement === dialogRef.current)
                ) {
                  e.preventDefault();
                  last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
          >
            <header>
              <h2 id="dialog-title">{dialog.title}</h2>
              <IconButton icon="close" label="Close dialog" onClick={() => setDialog(null)} />
            </header>
            <div className="dialog-content">{dialog.content}</div>
            <footer>
              <Button onClick={() => setDialog(null)}>{dialog.action ? 'Cancel' : 'Close'}</Button>
              {dialog.action && (
                <Button
                  variant={dialog.destructive ? 'danger' : 'primary'}
                  onClick={() => {
                    const action = dialog.action;
                    setDialog(null);
                    action?.();
                  }}
                >
                  {dialog.destructive ? 'Confirm' : 'Continue'}
                </Button>
              )}
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
