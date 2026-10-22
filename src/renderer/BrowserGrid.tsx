import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSnapshot, BrowserSnapshot, ViewBounds } from '../shared/types';
import { Badge, Button, duration, EmptyState, formatBytes, Icon, IconButton, Status } from './components';
import type { Actions } from './ui-types';

interface Props extends Actions {
  snapshot: AppSnapshot;
  selected: number[];
  setSelected: (ids: number[]) => void;
  blocked: boolean;
  compact: boolean;
}
export default function BrowserGrid({
  snapshot,
  selected,
  setSelected,
  blocked,
  compact,
  ...actions
}: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [columns, setColumns] = useState('auto');
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchors = useRef(new Map<number, HTMLDivElement>());
  const snapshotRef = useRef(snapshot);
  const layoutRef = useRef({ blocked, expanded });
  const layoutFrame = useRef<number | null>(null);
  snapshotRef.current = snapshot;
  layoutRef.current = { blocked, expanded };
  const emitLayout = useCallback(() => {
    if (!window.unicorn || !scrollRef.current) return;
    const clip = scrollRef.current.getBoundingClientRect();
    const bounds: ViewBounds[] = snapshotRef.current.browsers.map((browser) => {
      const node = anchors.current.get(browser.id);
      if (
        !node ||
        layoutRef.current.blocked ||
        (layoutRef.current.expanded !== null && layoutRef.current.expanded !== browser.id)
      )
        return { id: browser.id, x: 0, y: 0, width: 0, height: 0, visible: false };
      const rect = node.getBoundingClientRect();
      const x = Math.max(0, clip.left, rect.left),
        y = Math.max(0, clip.top, rect.top);
      const right = Math.min(window.innerWidth, clip.right, rect.right),
        bottom = Math.min(window.innerHeight, clip.bottom, rect.bottom);
      const width = Math.max(0, Math.floor(right - x)),
        height = Math.max(0, Math.floor(bottom - y));
      return {
        id: browser.id,
        x: Math.round(x),
        y: Math.round(y),
        width,
        height,
        visible: width > 24 && height > 24 && !!browser.url && browser.url !== 'about:blank',
      };
    });
    window.unicorn.layout(bounds);
  }, []);
  const scheduleLayout = useCallback(() => {
    if (layoutFrame.current !== null) cancelAnimationFrame(layoutFrame.current);
    layoutFrame.current = requestAnimationFrame(() => {
      layoutFrame.current = null;
      emitLayout();
    });
  }, [emitLayout]);
  useEffect(() => {
    const observer = new ResizeObserver(scheduleLayout);
    if (scrollRef.current) observer.observe(scrollRef.current);
    anchors.current.forEach((node) => observer.observe(node));
    window.addEventListener('resize', scheduleLayout);
    scheduleLayout();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleLayout);
    };
  }, [scheduleLayout, snapshot.browsers.length, expanded, columns, focusedId, compact]);
  useEffect(() => {
    emitLayout();
  }, [blocked, expanded, snapshot, emitLayout]);
  useEffect(
    () => () => {
      if (layoutFrame.current !== null) cancelAnimationFrame(layoutFrame.current);
      window.unicorn?.layout(
        snapshotRef.current.browsers.map((b) => ({
          id: b.id,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
          visible: false,
        })),
      );
    },
    [],
  );
  useEffect(() => {
    if (expanded !== null && !snapshot.browsers.some((b) => b.id === expanded)) setExpanded(null);
    if (focusedId !== null && !snapshot.browsers.some((b) => b.id === focusedId)) setFocusedId(null);
  }, [snapshot.browsers, expanded, focusedId]);
  const focused = snapshot.browsers.find((b) => b.id === focusedId);
  const visible = expanded === null ? snapshot.browsers : snapshot.browsers.filter((b) => b.id === expanded);
  const allSelected = snapshot.browsers.length > 0 && snapshot.browsers.every((b) => selected.includes(b.id));
  return (
    <section className="browser-workspace">
      <div className="workspace-toolbar">
        <div className="toolbar-leading">
          <h2>{expanded !== null ? `Browser ${String(expanded).padStart(2, '0')}` : 'Browser workspace'}</h2>
          <Badge>{snapshot.browsers.length} profiles</Badge>
          <label className="select-all">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? [] : snapshot.browsers.map((b) => b.id))}
            />
            Select all
          </label>
        </div>
        <div className="toolbar-actions">
          {expanded !== null && (
            <Button icon="grid" onClick={() => setExpanded(null)}>
              All browsers
            </Button>
          )}
          <label className="layout-picker">
            <Icon name="grid" size={15} />
            <select
              aria-label="Browser grid layout"
              value={columns}
              onChange={(e) => setColumns(e.target.value)}
            >
              <option value="auto">Auto layout</option>
              <option value="1">1 column</option>
              <option value="2">2 columns</option>
              <option value="3">3 columns</option>
              <option value="4">4 columns</option>
            </select>
          </label>
          <Button icon="link" variant="ghost" onClick={() => actions.setPage('links')}>
            Distribute links
          </Button>
        </div>
      </div>
      <div className={`workspace-body ${focused ? 'with-inspector' : ''}`}>
        <div ref={scrollRef} className="browser-scroll" onScroll={scheduleLayout}>
          {visible.length === 0 ? (
            <EmptyState
              title="Your workspace starts here"
              action={
                <Button
                  variant="primary"
                  onClick={() => void actions.run({ type: 'create', count: snapshot.settings.browserCount })}
                  icon="plus"
                >
                  Create browsers
                </Button>
              }
            >
              Choose up to 20 independent profiles. Every session keeps its own cookies, cache, and website
              storage.
            </EmptyState>
          ) : (
            <div
              className={`browser-grid ${expanded !== null ? 'expanded' : ''}`}
              style={
                columns === 'auto' || expanded !== null
                  ? undefined
                  : { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }
              }
            >
              {visible.map((browser) => (
                <BrowserCard
                  key={browser.id}
                  browser={browser}
                  selected={selected.includes(browser.id)}
                  focused={focusedId === browser.id}
                  expanded={expanded === browser.id}
                  setAnchor={(node) => {
                    if (node) anchors.current.set(browser.id, node);
                    else anchors.current.delete(browser.id);
                    scheduleLayout();
                  }}
                  onSelect={() =>
                    setSelected(
                      selected.includes(browser.id)
                        ? selected.filter((id) => id !== browser.id)
                        : [...selected, browser.id],
                    )
                  }
                  onFocus={() => setFocusedId(focusedId === browser.id ? null : browser.id)}
                  onExpand={() => setExpanded(expanded === browser.id ? null : browser.id)}
                  {...actions}
                />
              ))}
            </div>
          )}
        </div>
        {focused && <BrowserInspector browser={focused} close={() => setFocusedId(null)} {...actions} />}
      </div>
    </section>
  );
}

function BrowserCard({
  browser,
  selected,
  focused,
  expanded,
  setAnchor,
  onSelect,
  onFocus,
  onExpand,
  ...actions
}: Actions & {
  browser: BrowserSnapshot;
  selected: boolean;
  focused: boolean;
  expanded: boolean;
  setAnchor: (node: HTMLDivElement | null) => void;
  onSelect: () => void;
  onFocus: () => void;
  onExpand: () => void;
}) {
  const [address, setAddress] = useState(browser.url || '');
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setAddress(browser.url || '');
  }, [browser.url, editing]);
  const invoke = (
    action: 'back' | 'forward' | 'reload' | 'stop-loading' | 'start' | 'pause' | 'resume' | 'stop',
  ) => void actions.run({ type: 'browser', id: browser.id, action });
  return (
    <article
      className={`browser-card ${selected ? 'selected' : ''} ${focused ? 'focused' : ''}`}
      data-browser-id={browser.id}
    >
      <div className="browser-card-heading">
        <label className="browser-label">
          <input type="checkbox" checked={selected} onChange={onSelect} />
          <span className="browser-number">{String(browser.id).padStart(2, '0')}</span>
          <strong title={browser.name}>{browser.name}</strong>
        </label>
        <div className="card-heading-actions">
          <Status state={browser.state} />
          <IconButton icon="info" label={`Inspect browser ${browser.id}`} onClick={onFocus} />
          <IconButton
            icon="expand"
            label={expanded ? 'Exit expanded browser' : `Expand browser ${browser.id}`}
            onClick={onExpand}
          />
        </div>
      </div>
      <form
        className="address-bar"
        onSubmit={(e) => {
          e.preventDefault();
          setEditing(false);
          if (address.trim()) void actions.run({ type: 'navigate', id: browser.id, url: address.trim() });
        }}
      >
        <IconButton icon="back" label="Back" disabled={!browser.canGoBack} onClick={() => invoke('back')} />
        <IconButton
          icon="forward"
          label="Forward"
          disabled={!browser.canGoForward}
          onClick={() => invoke('forward')}
        />
        <IconButton
          icon={browser.loading ? 'close' : 'reload'}
          label={browser.loading ? 'Stop loading' : 'Reload'}
          onClick={() => invoke(browser.loading ? 'stop-loading' : 'reload')}
        />
        <div className="address-input">
          <Icon name="shield" size={13} />
          <input
            aria-label={`Address for browser ${browser.id}`}
            value={address}
            placeholder="https://your-authorized-site.com"
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
          />
          <button type="submit" aria-label="Navigate">
            <Icon name="arrow" size={14} />
          </button>
        </div>
      </form>
      <div className="browser-viewport" ref={setAnchor}>
        {(!browser.url || browser.url === 'about:blank') && (
          <div className="browser-placeholder">
            <div className="placeholder-orbit">
              <Icon name="browser" size={29} />
              <i />
            </div>
            <strong>
              {['WAITING_FOR_PROXY', 'VALIDATING_PROXY'].includes(browser.state)
                ? 'Preparing secure connection'
                : 'Ready for your next test'}
            </strong>
            <span>
              {['WAITING_FOR_PROXY', 'VALIDATING_PROXY'].includes(browser.state)
                ? 'Waiting for a verified, eligible proxy.'
                : 'Add an authorized URL to begin browsing.'}
            </span>
            <span className="placeholder-caption">
              <Icon name="shield" size={12} />
              Isolated profile · Proxy required
            </span>
          </div>
        )}
      </div>
      {browser.loading && <div className="loading-line" />}
      <div className="browser-card-footer">
        <div className="browser-tags">
          <span title={`Viewport ${browser.device.width} × ${browser.device.height}`}>
            <Icon name="device" size={13} />
            {browser.device.preset}
          </span>
          <span className={browser.proxy ? 'connected' : ''}>
            <Icon name="globe" size={13} />
            {browser.proxy
              ? `${browser.proxy.country} · ${browser.proxy.protocol.toUpperCase()}`
              : 'No proxy'}
          </span>
          {browser.elapsedMs > 0 && (
            <span title={browser.stage}>
              <Icon name="clock" size={13} />
              {duration(browser.elapsedMs)}
            </span>
          )}
        </div>
        <div className="inline-controls">
          <IconButton
            icon="play"
            label={`Start browser ${browser.id} test`}
            onClick={() => invoke(browser.state === 'PAUSED' ? 'resume' : 'start')}
          />
          <IconButton
            icon="pause"
            label={`Pause browser ${browser.id} test`}
            onClick={() => invoke('pause')}
            disabled={browser.state === 'PAUSED'}
          />
          <IconButton icon="stop" label={`Stop browser ${browser.id}`} onClick={() => invoke('stop')} />
        </div>
      </div>
      {browser.lastError && (
        <div className="browser-error" title={browser.lastError}>
          <Icon name="info" size={12} />
          {browser.lastError}
        </div>
      )}
    </article>
  );
}

function BrowserInspector({
  browser,
  close,
  ...actions
}: Actions & { browser: BrowserSnapshot; close: () => void }) {
  const profileAction = (action: 'cache' | 'cookies' | 'permissions' | 'history' | 'reset' | 'storage') => {
    if (action === 'storage') {
      void actions.run({ type: 'profile', id: browser.id, action }).then((result) => {
        if (result?.storageBytes !== undefined)
          actions.inspect(
            'Profile storage',
            <p>
              Browser {browser.id} currently uses <strong>{formatBytes(result.storageBytes)}</strong> on disk.
            </p>,
          );
      });
      return;
    }
    actions.confirm(
      action === 'reset' ? 'Reset this browser profile?' : `Clear ${action}?`,
      action === 'reset'
        ? `Cookies, cache, site data, permissions, and history for Browser ${browser.id} will be removed. This cannot be undone.`
        : `This removes stored ${action} from Browser ${browser.id}. Other profiles keep their data.`,
      () => {
        void actions.run(
          { type: 'profile', id: browser.id, action },
          `Browser ${browser.id} ${action} cleared.`,
        );
      },
      true,
    );
  };
  return (
    <aside className="browser-inspector">
      <header>
        <div>
          <p className="eyebrow">SESSION DETAILS</p>
          <h3>Browser {String(browser.id).padStart(2, '0')}</h3>
        </div>
        <IconButton icon="close" label="Close session inspector" onClick={close} />
      </header>
      <Status state={browser.state} />
      <dl>
        <dt>Page title</dt>
        <dd>{browser.title || 'No page loaded'}</dd>
        <dt>Current URL</dt>
        <dd className="break-word">{browser.url || '—'}</dd>
        <dt>Device</dt>
        <dd>
          {browser.device.preset} · {browser.device.width} × {browser.device.height}
        </dd>
        <dt>Pixel ratio / touch</dt>
        <dd>
          {browser.device.scaleFactor}× / {browser.device.touch ? 'Enabled' : 'Disabled'}
        </dd>
        <dt>Proxy</dt>
        <dd>
          {browser.proxy
            ? `${browser.proxy.country} · ${browser.proxy.ip}:${browser.proxy.port}`
            : 'Not assigned'}
        </dd>
        <dt>Verified exit IP</dt>
        <dd>{browser.proxy?.exitIp || 'Not verified'}</dd>
        <dt>JavaScript</dt>
        <dd>Enabled · {browser.jsErrors} errors</dd>
        <dt>Current stage</dt>
        <dd>{browser.stage || 'Idle'}</dd>
        <dt>Network errors</dt>
        <dd>{browser.networkErrors}</dd>
        <dt>Elapsed</dt>
        <dd>{duration(browser.elapsedMs)}</dd>
      </dl>
      <Button
        icon="terminal"
        onClick={() =>
          void actions.run({ type: 'diagnostic', id: browser.id }).then((result) => {
            if (result?.diagnostic)
              actions.inspect(
                `Browser ${browser.id} diagnostics`,
                <pre className="diagnostic-json">{JSON.stringify(result.diagnostic, null, 2)}</pre>,
              );
          })
        }
      >
        Check device behavior
      </Button>
      <Button
        icon="terminal"
        variant="ghost"
        onClick={() => void actions.run({ type: 'browser', id: browser.id, action: 'devtools' })}
      >
        Open developer tools
      </Button>
      {browser.popups.length > 0 && (
        <section className="inspector-section">
          <h4>
            Child windows <Badge>{browser.popups.length}</Badge>
          </h4>
          {browser.popups.map((p) => (
            <div className="popup-row" key={p.id}>
              <span title={p.url}>{p.title || p.url}</span>
              <IconButton
                icon="expand"
                label="Inspect popup"
                onClick={() =>
                  void actions.run({ type: 'popup', browserId: browser.id, popupId: p.id, action: 'inspect' })
                }
              />
              <IconButton
                icon="close"
                label="Close popup"
                onClick={() =>
                  void actions.run({ type: 'popup', browserId: browser.id, popupId: p.id, action: 'close' })
                }
              />
            </div>
          ))}
        </section>
      )}
      <section className="inspector-section">
        <h4>Profile controls</h4>
        <div className="profile-controls">
          {(['cache', 'cookies', 'permissions', 'history'] as const).map((action) => (
            <Button key={action} variant="ghost" onClick={() => profileAction(action)}>
              Clear {action}
            </Button>
          ))}
          <Button variant="ghost" onClick={() => profileAction('storage')}>
            Inspect storage
          </Button>
          <Button variant="danger" onClick={() => profileAction('reset')}>
            Reset complete profile
          </Button>
        </div>
      </section>
      <section className="inspector-section">
        <h4>Recent history</h4>
        {browser.history.length ? (
          browser.history
            .slice(-8)
            .reverse()
            .map((entry, i) => (
              <p className="history-entry" key={`${entry.at}-${i}`} title={entry.url}>
                {entry.title || entry.url}
                <small>{new Date(entry.at).toLocaleTimeString()}</small>
              </p>
            ))
        ) : (
          <p className="muted">No saved navigation yet.</p>
        )}
      </section>
      <Button
        variant="danger"
        onClick={() =>
          actions.confirm(
            'Close this browser?',
            'The session will stop. Its persistent profile remains available when reopened.',
            () => void actions.run({ type: 'browser', id: browser.id, action: 'close' }),
          )
        }
      >
        Close browser
      </Button>
    </aside>
  );
}
