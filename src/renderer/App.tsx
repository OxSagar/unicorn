import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppCommand, AppSnapshot, CommandResult } from '../shared/types';
import BrowserGrid from './BrowserGrid';
import { Brand, Button, Icon } from './components';
import { useLinkDraft } from './use-link-draft';

type Device = 'desktop' | 'mobile' | 'tablet';
type ReviewBinding = { id: string; text: string; count: number; device: Device };
type Operation = 'distributing' | 'starting' | 'stopping' | null;

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [connectionError, setConnectionError] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const [operation, setOperation] = useState<Operation>(null);
  const [reviewed, setReviewed] = useState<ReviewBinding | null>(null);
  const [count, setCount] = useState(1);
  const [device, setDevice] = useState<Device>('desktop');
  const initialized = useRef(false);
  const choiceRevision = useRef(0);
  const choices = useRef({ count, device });
  choices.current = { count, device };
  const generation = useRef(0);
  const scrollRoot = useRef<HTMLElement>(null);
  const draft = useLinkDraft();

  const ingest = useCallback((next: AppSnapshot) => {
    setSnapshot(next);
    setConnectionError('');
    if (!initialized.current) {
      initialized.current = true;
      setCount(next.settings.browserCount);
      const saved = next.browsers.filter((browser) => browser.id <= next.settings.browserCount);
      const preset = saved[0]?.device.preset;
      if (
        preset &&
        ['desktop', 'mobile', 'tablet'].includes(preset) &&
        saved.every((browser) => browser.device.preset === preset)
      )
        setDevice(preset as Device);
    }
  }, []);

  const request = useCallback(
    async (command: AppCommand, epoch = generation.current): Promise<CommandResult | undefined> => {
      if (!window.unicorn) {
        setConnectionError('Open the Unicorn desktop application to run your links.');
        return;
      }
      setPending((count) => count + 1);
      try {
        const result = await window.unicorn.invoke(command);
        if (epoch !== generation.current) return;
        ingest(result.snapshot);
        return result;
      } catch (cause) {
        if (epoch === generation.current)
          setError(
            cause instanceof Error
              ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
              : String(cause),
          );
      } finally {
        setPending((count) => Math.max(0, count - 1));
      }
    },
    [ingest],
  );

  useEffect(() => {
    if (!window.unicorn) {
      setConnectionError('Open the Unicorn desktop application to run your links and see live browsers.');
      return;
    }
    let mounted = true;
    const unsubscribe = window.unicorn.subscribe((next) => {
      if (mounted) ingest(next);
    });
    void window.unicorn.invoke({ type: 'snapshot' }).then(
      (result) => {
        if (mounted) ingest(result.snapshot);
      },
      (cause) => {
        if (mounted) setConnectionError(String(cause));
      },
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [ingest]);

  useEffect(() => {
    document.documentElement.dataset.theme = snapshot?.settings.theme || 'dark';
  }, [snapshot?.settings.theme]);

  const stop = useCallback(async () => {
    const epoch = ++generation.current;
    setReviewed(null);
    setError('');
    setOperation('stopping');
    await request({ type: 'global', action: 'stop' }, epoch);
    if (epoch === generation.current) setOperation(null);
  }, [request]);

  useEffect(() => {
    const emergency = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyS') {
        event.preventDefault();
        void stop();
      }
    };
    window.addEventListener('keydown', emergency);
    return () => window.removeEventListener('keydown', emergency);
  }, [stop]);

  const plan = snapshot?.preparedRun ?? null;
  const jobs = useMemo(() => {
    const ids = new Set(plan?.jobIds ?? []);
    return snapshot?.jobs.filter((job) => ids.has(job.id)) ?? [];
  }, [plan, snapshot?.jobs]);
  const browserIds = useMemo(() => new Set(plan?.browserIds ?? []), [plan]);
  const browsers = snapshot?.browsers.filter((browser) => browserIds.has(browser.id)) ?? [];
  const busy = pending > 0;
  const active = Boolean(
    plan?.status === 'running' ||
    snapshot?.scheduler.running ||
    snapshot?.scheduler.paused ||
    operation === 'starting',
  );
  const sameDraft = Boolean(
    reviewed &&
    reviewed.id === plan?.id &&
    reviewed.text === draft.text &&
    reviewed.count === count &&
    reviewed.device === device,
  );
  const canStart = Boolean(
    !busy &&
    sameDraft &&
    plan &&
    (plan.status === 'ready' || (plan.status === 'running' && snapshot?.scheduler.paused)),
  );
  const canDistribute = Boolean(draft.text.trim() && !draft.tooLarge && !busy && !active);
  const completed = jobs.filter((job) => job.status === 'completed').length;
  const failed = jobs.filter((job) => job.status === 'failed').length;
  const cancelled = jobs.filter((job) => job.status === 'cancelled').length;
  const waiting = browsers.some((browser) =>
    ['WAITING_FOR_PROXY', 'ASSIGNING_PROXY', 'RETRY_WAIT'].includes(browser.state),
  );
  const knownJobs = plan && jobs.length === plan.jobIds.length;
  const status =
    operation === 'distributing'
      ? 'Distributing links'
      : operation === 'stopping'
        ? 'Stopping'
        : snapshot?.scheduler.paused
          ? 'Paused'
          : active
            ? waiting
              ? 'Waiting for a proxy'
              : 'Running'
            : plan?.status === 'finished'
              ? failed || cancelled
                ? 'Finished with issues'
                : 'Finished'
              : canStart
                ? 'Ready to start'
                : 'Ready';

  const distribute = async () => {
    if (!canDistribute) return;
    const epoch = generation.current;
    const submitted = draft.current.current;
    const submittedCount = count;
    const submittedDevice = device;
    const submittedRevision = choiceRevision.current;
    setReviewed(null);
    setError('');
    setOperation('distributing');
    draft.persist();
    const result = await request(
      { type: 'simple-distribute', text: submitted, count: submittedCount, device: submittedDevice },
      epoch,
    );
    if (epoch !== generation.current) return;
    setOperation(null);
    const prepared = result?.snapshot.preparedRun;
    if (
      prepared?.status === 'ready' &&
      choiceRevision.current === submittedRevision &&
      draft.current.current === submitted &&
      choices.current.count === submittedCount &&
      choices.current.device === submittedDevice &&
      prepared.count === submittedCount &&
      prepared.device === submittedDevice
    )
      setReviewed({ id: prepared.id, text: submitted, count: submittedCount, device: submittedDevice });
  };

  const start = async () => {
    if (!canStart || !plan) return;
    const epoch = generation.current;
    setError('');
    setOperation('starting');
    await request({ type: 'simple-start', reviewId: plan.id, confirmed: true }, epoch);
    if (epoch === generation.current) setOperation(null);
  };

  if (!snapshot)
    return (
      <main className="startup-screen">
        <Brand />
        <section className="startup-card">
          <Icon name={connectionError ? 'info' : 'browser'} size={30} />
          <h1>{connectionError ? 'Desktop application required' : 'Opening Unicorn'}</h1>
          <p>{connectionError || 'Loading your saved workspace…'}</p>
          {connectionError && window.unicorn && (
            <Button onClick={() => void request({ type: 'snapshot' })}>Retry connection</Button>
          )}
        </section>
      </main>
    );

  return (
    <div className="simple-app">
      <header className="app-header">
        <Brand />
        <div className="app-run-status" role="status" aria-live="polite">
          <i className={active || busy ? 'active' : ''} aria-hidden="true" />
          {status}
        </div>
      </header>
      <main className="workspace-scroll browser-scroll" ref={scrollRoot}>
        <div className="workspace-content">
          <section className="link-composer" aria-labelledby="workspace-title">
            <div className="composer-heading">
              <h1 id="workspace-title">Paste. Distribute. Start.</h1>
            </div>
            <div className="browser-choices">
              <label>
                <span>Browser count</span>
                <select
                  aria-label="Browser count"
                  value={count}
                  disabled={active}
                  onChange={(event) => {
                    choiceRevision.current += 1;
                    setCount(Number(event.target.value));
                    setReviewed(null);
                  }}
                >
                  {Array.from({ length: 20 }, (_, index) => (
                    <option key={index + 1} value={index + 1}>
                      {index + 1}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Device type</span>
                <select
                  aria-label="Device type"
                  value={device}
                  disabled={active}
                  onChange={(event) => {
                    choiceRevision.current += 1;
                    setDevice(event.target.value as Device);
                    setReviewed(null);
                  }}
                >
                  <option value="desktop">Desktop</option>
                  <option value="mobile">Mobile</option>
                  <option value="tablet">Tablet</option>
                </select>
              </label>
            </div>
            <label className="paste-field">
              <span>Paste links</span>
              <textarea
                aria-label="Paste links"
                value={draft.text}
                disabled={active}
                onChange={(event) => {
                  if (draft.update(event.target.value)) {
                    choiceRevision.current += 1;
                    setReviewed(null);
                  }
                }}
                onBlur={() => draft.persist()}
                placeholder={'https://staging.example.com/\nhttps://staging.example.com/products'}
                spellCheck={false}
                aria-describedby="link-input-help"
              />
            </label>
            <div className="input-help" id="link-input-help">
              <span>One complete HTTPS link per line.</span>
              <span>
                {draft.error
                  ? 'Review your draft below'
                  : draft.saved
                    ? 'Saved on this computer'
                    : 'Saving draft…'}
              </span>
            </div>
            {draft.error && (
              <p className="inline-error" role="alert">
                {draft.error}
              </p>
            )}
            {error && (
              <div className="error-message" role="alert">
                <Icon name="info" size={18} />
                <p>{error}</p>
              </div>
            )}
            {plan && (
              <div className="assignment-summary" aria-label="Assigned links" data-review-id={plan.id}>
                <div className="assignment-heading">
                  <strong>
                    {plan.urls.length} link{plan.urls.length === 1 ? '' : 's'} assigned to{' '}
                    {plan.browserIds.length} browser{plan.browserIds.length === 1 ? '' : 's'}
                    {' · '}
                    {plan.device[0].toUpperCase() + plan.device.slice(1)}
                  </strong>
                  <span>
                    {status}
                    {knownJobs && active ? ` · ${completed} complete` : ''}
                    {failed > 0 ? ` · ${failed} failed` : ''}
                    {cancelled > 0 ? ` · ${cancelled} cancelled` : ''}
                  </span>
                </div>
                <p className="review-domains">
                  <span>Listed sites:</span> {plan.domains.join(', ')}
                </p>
              </div>
            )}
            <div className="composer-actions">
              <div className="primary-actions">
                <Button icon="arrow" disabled={!canDistribute} onClick={() => void distribute()}>
                  Distribute
                </Button>
                <Button icon="play" variant="primary" disabled={!canStart} onClick={() => void start()}>
                  Start
                </Button>
                {(active || busy) && (
                  <Button
                    icon="stop"
                    variant="danger"
                    title="Stop (Ctrl+Shift+S)"
                    onClick={() => void stop()}
                  >
                    Stop
                  </Button>
                )}
              </div>
              <p className="run-help">
                {operation === 'distributing'
                  ? 'Preparing assignments. No pages open yet.'
                  : snapshot.scheduler.paused && sameDraft
                    ? 'Select Start to continue these reviewed links.'
                    : plan?.status === 'ready' && !sameDraft
                      ? 'Your choices changed or review ended. Select Distribute again.'
                      : plan?.status === 'finished'
                        ? 'Distribute again to prepare another run.'
                        : active
                          ? waiting
                            ? 'Your run continues when an eligible proxy is available.'
                            : 'You can stop this run at any time.'
                          : canStart
                            ? 'Assignments are ready. Select Start when you are ready.'
                            : 'Distribute prepares your links without opening pages.'}
              </p>
            </div>
            <p className="start-consent">
              By selecting Start, you confirm you are authorized to run QA on only the listed sites in staging
              or test-ad environments.
            </p>
            {active && snapshot.provider.error && waiting && (
              <p className="inline-error" role="alert">
                {snapshot.provider.error}
              </p>
            )}
          </section>
          <BrowserGrid
            browsers={browsers}
            allBrowserIds={snapshot.browsers.map((browser) => browser.id)}
            jobs={jobs}
            scrollRoot={scrollRoot}
            blocked={plan?.status === 'ready'}
          />
          <footer className="app-footer">
            <span>Unicorn {snapshot.version}</span>
            <span>Automatic proxies · Separate browser profiles</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
