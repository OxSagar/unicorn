import { useMemo, useState } from 'react';
import type { DistributionMode } from '../shared/types';
import { Badge, Button, EmptyState, Field, Icon, SectionTitle, Status } from './components';
import type { PageProps } from './ui-types';

const methods: Array<{ id: DistributionMode; title: string; text: string }> = [
  { id: 'same', title: 'Same URL to all', text: 'Compare one page across every selected browser.' },
  { id: 'round-robin', title: 'Round-robin', text: 'Assign each URL to the next selected browser.' },
  { id: 'balanced', title: 'Balanced', text: 'Distribute URLs according to pending workload.' },
  { id: 'manual', title: 'Manual', text: 'Choose the destination browser for each URL.' },
];
export default function LinksPage({
  snapshot,
  selected,
  setSelected,
  run,
  confirm,
  setPage,
  busy,
}: PageProps) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<DistributionMode>('round-robin');
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [manual, setManual] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('all');
  const urls = useMemo(
    () =>
      text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    [text],
  );
  const duplicates = urls.length - new Set(urls).size;
  const invalid = urls.filter((raw) => {
    try {
      const url = new URL(raw);
      return !['http:', 'https:'].includes(url.protocol) || !!url.username || !!url.password;
    } catch {
      return true;
    }
  });
  const queue = snapshot.jobs.filter((job) => filter === 'all' || job.status === filter);
  const toggleBrowser = (id: number) =>
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const distribute = () =>
    void run(
      {
        type: 'distribute',
        urls,
        ids: selected,
        mode,
        allowDuplicates,
        ...(mode === 'manual'
          ? { manual: Object.fromEntries(urls.map((url) => [url, manual[url] ?? selected[0]])) }
          : {}),
      },
      'Links added to the test queue. Review the assignments before starting.',
    );
  return (
    <div className="page-scroll">
      <SectionTitle
        eyebrow="CENTRAL CONTROL"
        title="Link distribution"
        subtitle="Build a clear test queue, then send it to your browser profiles."
        actions={
          <Button
            icon="upload"
            onClick={() =>
              void run({ type: 'import-urls' }).then((result) => {
                if (result?.importedUrls)
                  setText((previous) => [previous, ...result.importedUrls!].filter(Boolean).join('\n'));
              })
            }
          >
            Import TXT / CSV
          </Button>
        }
      />
      {!snapshot.settings.authorizedDomains.length && (
        <div className="notice inline warn">
          <Icon name="shield" />
          <div>
            <strong>Set your authorized domains first</strong>
            <p>Navigation tests only run within the website scope you approve.</p>
          </div>
          <Button onClick={() => setPage('settings')}>Configure scope</Button>
        </div>
      )}
      <div className="two-column link-composer">
        <section className="surface">
          <div className="surface-heading">
            <h2>Test URLs</h2>
            <Badge>{urls.length} URLs</Badge>
          </div>
          <Field
            label="One URL per line"
            hint="Use full HTTPS addresses. Your original list stays here after distribution."
          >
            <textarea
              className="url-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                'https://staging.example.com/\nhttps://staging.example.com/products\nhttps://staging.example.com/contact'
              }
              spellCheck={false}
            />
          </Field>
          <div className="input-summary">
            <span>
              {invalid.length ? (
                <span className="text-danger">{invalid.length} invalid URLs</span>
              ) : (
                <span className="text-success">
                  <Icon name="check" size={13} />{' '}
                  {urls.length ? 'URL syntax looks valid' : 'Waiting for URLs'}
                </span>
              )}
            </span>
            <span>{duplicates} duplicates</span>
            <Button variant="ghost" onClick={() => setText('')} disabled={!text}>
              Clear input
            </Button>
          </div>
          {invalid.length > 0 && <p className="field-error">Check: {invalid.slice(0, 2).join(', ')}</p>}
          <label className="checkbox-line">
            <input
              type="checkbox"
              checked={allowDuplicates}
              onChange={(e) => setAllowDuplicates(e.target.checked)}
            />
            Allow duplicate pending test URLs
          </label>
          <h3 className="subheading">
            Choose browsers <span>{selected.length} selected</span>
          </h3>
          <div className="profile-picker">
            {snapshot.browsers.map((browser) => (
              <label className={selected.includes(browser.id) ? 'checked' : ''} key={browser.id}>
                <input
                  type="checkbox"
                  checked={selected.includes(browser.id)}
                  onChange={() => toggleBrowser(browser.id)}
                />
                <span>{String(browser.id).padStart(2, '0')}</span>
                <small>{browser.device.preset}</small>
              </label>
            ))}
          </div>
          {!snapshot.browsers.length && (
            <p className="muted">Create browser profiles from the top bar first.</p>
          )}
        </section>
        <section className="surface">
          <div className="surface-heading">
            <h2>Distribution method</h2>
            <Icon name="link" />
          </div>
          <div className="method-list">
            {methods.map((method) => (
              <label className={`method-option ${mode === method.id ? 'active' : ''}`} key={method.id}>
                <input
                  type="radio"
                  name="method"
                  value={method.id}
                  checked={mode === method.id}
                  onChange={() => setMode(method.id)}
                />
                <div>
                  <strong>{method.title}</strong>
                  <small>{method.text}</small>
                </div>
              </label>
            ))}
          </div>
          {mode === 'same' && urls.length > 1 && (
            <p className="field-error">Use exactly one URL for “Same URL to all”.</p>
          )}
          {mode === 'manual' && urls.length > 0 && (
            <div className="manual-assignments">
              {urls.slice(0, 100).map((url, index) => (
                <label key={`${url}-${index}`}>
                  <span title={url}>{url}</span>
                  <select
                    aria-label={`Assign URL ${index + 1}`}
                    value={manual[url] ?? selected[0] ?? ''}
                    onChange={(e) => setManual({ ...manual, [url]: Number(e.target.value) })}
                  >
                    {selected.map((id) => (
                      <option value={id} key={id}>
                        Browser {id}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {urls.length > 100 && (
                <p className="muted">
                  The first 100 assignments are shown. Remaining URLs use the first selected browser.
                </p>
              )}
            </div>
          )}
          <div className="distribution-footer">
            <p>
              <Icon name="info" size={15} />
              Distribution prepares the queue. Start the test run when you’re ready.
            </p>
            <Button
              icon="arrow"
              variant="primary"
              disabled={
                busy ||
                !urls.length ||
                !selected.length ||
                invalid.length > 0 ||
                (mode === 'same' && urls.length !== 1)
              }
              onClick={distribute}
            >
              Distribute {urls.length || ''} {urls.length === 1 ? 'URL' : 'URLs'}
            </Button>
          </div>
        </section>
      </div>
      <section className="surface queue-section">
        <div className="surface-heading">
          <div className="inline-heading">
            <h2>Queue preview</h2>
            <Badge>{snapshot.jobs.filter((j) => j.status === 'pending').length} pending</Badge>
          </div>
          <div className="toolbar-actions">
            <select
              aria-label="Filter queue status"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">All jobs</option>
              {['pending', 'running', 'completed', 'failed', 'cancelled'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <Button
              variant="ghost"
              onClick={() =>
                confirm(
                  'Clear pending queue?',
                  'Pending assignments will be removed. Completed test records remain available.',
                  () => void run({ type: 'clear-queue' }),
                )
              }
            >
              Clear pending
            </Button>
            <Button
              icon="play"
              variant="primary"
              disabled={!snapshot.jobs.some((j) => j.status === 'pending')}
              onClick={() => void run({ type: 'global', action: 'start' })}
            >
              Start tests
            </Button>
          </div>
        </div>
        {!queue.length ? (
          <EmptyState icon="link" title="No test jobs here">
            Add URLs and choose a distribution method to prepare your next run.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Destination URL</th>
                  <th>Browser</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {queue
                  .slice(-200)
                  .reverse()
                  .map((job) => (
                    <tr key={job.id}>
                      <td className="url-cell" title={job.error || job.url}>
                        {job.url}
                        {job.error && <small className="text-danger">{job.error}</small>}
                      </td>
                      <td>
                        <span className="table-browser">{String(job.browserId).padStart(2, '0')}</span>
                      </td>
                      <td>
                        <Status state={job.status} />
                      </td>
                      <td className="nowrap">{new Date(job.createdAt).toLocaleTimeString()}</td>
                      <td>
                        {job.status === 'pending' && (
                          <Button
                            variant="ghost"
                            onClick={() => void run({ type: 'job', id: job.id, action: 'remove' })}
                          >
                            Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
            {queue.length > 200 && (
              <p className="table-note">
                Showing the latest 200 matching records. Export results for the full retained history.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
