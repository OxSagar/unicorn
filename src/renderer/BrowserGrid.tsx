import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { BrowserSnapshot, TestJob, ViewBounds } from '../shared/types';
import { Button, Icon } from './components';

interface Props {
  browsers: BrowserSnapshot[];
  allBrowserIds: number[];
  jobs: TestJob[];
  scrollRoot: RefObject<HTMLElement | null>;
  blocked: boolean;
}

const labels: Record<BrowserSnapshot['state'], string> = {
  CREATED: 'Ready',
  WAITING_FOR_PROXY: 'Waiting for proxy',
  ASSIGNING_PROXY: 'Assigning proxy',
  READY: 'Ready',
  NAVIGATING: 'Loading',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  PAUSED: 'Paused',
  PROXY_FAILED: 'Proxy unavailable',
  RETRY_WAIT: 'Retrying',
  STOPPED: 'Stopped',
  ERROR: 'Needs attention',
};

export default function BrowserGrid({ browsers, allBrowserIds, jobs, scrollRoot, blocked }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const anchors = useRef(new Map<number, HTMLDivElement>());
  const gridRef = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  const current = useRef({ browsers, allBrowserIds, blocked, expanded });
  current.current = { browsers, allBrowserIds, blocked, expanded };

  const emitLayout = useCallback(() => {
    if (!window.unicorn) return;
    const root = scrollRoot.current;
    const clip = root?.getBoundingClientRect();
    const {
      browsers: visibleBrowsers,
      allBrowserIds: ids,
      blocked: hidden,
      expanded: focused,
    } = current.current;
    const bounds: ViewBounds[] = ids.map((id) => {
      const browser = visibleBrowsers.find((item) => item.id === id);
      const node = anchors.current.get(id);
      const off = { id, x: 0, y: 0, width: 0, height: 0, visible: false };
      if (!clip || !node || !browser || hidden || (focused !== null && focused !== id)) return off;
      const rect = node.getBoundingClientRect();
      const x = Math.ceil(Math.max(0, clip.left, rect.left));
      const y = Math.ceil(Math.max(0, clip.top, rect.top));
      const right = Math.floor(Math.min(window.innerWidth, clip.right, rect.right));
      const bottom = Math.floor(Math.min(window.innerHeight, clip.bottom, rect.bottom));
      const width = Math.max(0, right - x);
      const height = Math.max(0, bottom - y);
      return {
        id,
        x,
        y,
        width,
        height,
        visible: width > 24 && height > 24 && Boolean(browser.url && browser.url !== 'about:blank'),
      };
    });
    window.unicorn.layout(bounds);
  }, [scrollRoot]);

  const scheduleLayout = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      emitLayout();
    });
  }, [emitLayout]);

  // The composer and previews share a scroller. Listen in capture phase so
  // ancestor scrolling cannot leave native views over the composer or header.
  useEffect(() => {
    const observer = new ResizeObserver(scheduleLayout);
    if (scrollRoot.current) observer.observe(scrollRoot.current);
    if (gridRef.current) observer.observe(gridRef.current);
    let ancestor = gridRef.current?.parentElement;
    while (ancestor && ancestor !== scrollRoot.current) {
      observer.observe(ancestor);
      ancestor = ancestor.parentElement;
    }
    anchors.current.forEach((node) => observer.observe(node));
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('scroll', scheduleLayout, true);
    scheduleLayout();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleLayout);
      window.removeEventListener('scroll', scheduleLayout, true);
    };
  }, [browsers.length, expanded, scheduleLayout, scrollRoot]);

  // Review/error messages and expansion can move an anchor
  // without changing its own size. Refresh positions after every layout commit.
  useLayoutEffect(() => {
    emitLayout();
  });

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      window.unicorn?.layout(
        current.current.allBrowserIds.map((id) => ({ id, x: 0, y: 0, width: 0, height: 0, visible: false })),
      );
    },
    [],
  );

  useEffect(() => {
    if (expanded !== null && !browsers.some((browser) => browser.id === expanded)) setExpanded(null);
  }, [browsers, expanded]);

  const visible = expanded === null ? browsers : browsers.filter((browser) => browser.id === expanded);
  if (!browsers.length)
    return (
      <section className="preview-empty" aria-label="Browser previews">
        <Icon name="browser" size={24} />
        <p>Your browsers will appear here after you distribute links.</p>
      </section>
    );

  return (
    <section className="browser-workspace" aria-label="Browser previews">
      <div className="previews-heading">
        <h2>Live browsers</h2>
        {expanded !== null && (
          <Button icon="grid" onClick={() => setExpanded(null)}>
            Show all browsers
          </Button>
        )}
      </div>
      <div ref={gridRef} className={`browser-grid${expanded !== null ? ' expanded' : ''}`}>
        {visible.map((browser) => {
          const assigned = jobs.filter((job) => job.browserId === browser.id);
          const completed = assigned.filter((job) => job.status === 'completed').length;
          const hasPage = Boolean(browser.url && browser.url !== 'about:blank');
          const failed = ['ERROR', 'PROXY_FAILED'].includes(browser.state);
          const waiting = ['WAITING_FOR_PROXY', 'ASSIGNING_PROXY', 'RETRY_WAIT'].includes(browser.state);
          return (
            <article className="browser-card" key={browser.id} data-browser-id={browser.id}>
              <header className="browser-card-heading">
                <div className="browser-identity">
                  <span className="browser-number">{String(browser.id).padStart(2, '0')}</span>
                  <h3>Browser {browser.id}</h3>
                </div>
                <div className="browser-card-actions">
                  <span
                    className={`browser-state ${!blocked && failed ? 'error' : !blocked && waiting ? 'waiting' : ''}`}
                  >
                    <i aria-hidden="true" />
                    {blocked ? 'Ready' : labels[browser.state]}
                  </span>
                  {expanded === null && (
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Expand browser ${browser.id}`}
                      title={`Expand browser ${browser.id}`}
                      onClick={() => setExpanded(browser.id)}
                    >
                      <Icon name="expand" size={17} />
                    </button>
                  )}
                </div>
              </header>
              <p
                className="browser-location"
                title={(blocked ? assigned[0]?.url : browser.url) || assigned[0]?.url || ''}
              >
                <Icon name="link" size={13} />
                <span>
                  {(blocked ? assigned[0]?.url : browser.url) || assigned[0]?.url || 'Ready for your links'}
                </span>
              </p>
              <div
                className="browser-viewport"
                ref={(node) => {
                  if (node) anchors.current.set(browser.id, node);
                  else anchors.current.delete(browser.id);
                  scheduleLayout();
                }}
              >
                {(!hasPage || blocked) && (
                  <div className="browser-placeholder">
                    <Icon
                      name={!blocked && waiting ? 'clock' : !blocked && failed ? 'info' : 'browser'}
                      size={27}
                    />
                    <strong>
                      {!blocked && waiting
                        ? labels[browser.state]
                        : !blocked && failed
                          ? 'Unable to load'
                          : 'Ready to start'}
                    </strong>
                    <p>
                      {!blocked && waiting
                        ? 'An eligible proxy is assigned automatically.'
                        : !blocked && failed
                          ? 'Review the error below, then distribute again to retry.'
                          : 'Your page opens when you select Start.'}
                    </p>
                  </div>
                )}
              </div>
              <footer className="browser-card-footer">
                <span>{blocked ? 'Waiting for Start' : browser.stage || labels[browser.state]}</span>
                {!blocked && assigned.length > 0 && <span>{completed} complete</span>}
              </footer>
              {!blocked && browser.lastError && <p className="browser-error">{browser.lastError}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
