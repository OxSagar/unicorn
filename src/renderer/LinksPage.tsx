import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DistributionMode } from '../shared/types';
import { Badge, Button, EmptyState, Field, Icon, SectionTitle, Status } from './components';
import type { PageProps } from './ui-types';

const DRAFT_KEY = 'unicorn.link-draft.v1';
const DRAFT_LIMIT = 2_000_000;

function readDraft(): { text: string; error?: string } {
  try {
    const text = window.localStorage.getItem(DRAFT_KEY) ?? '';
    if (text.length > DRAFT_LIMIT)
      return {
        text: '',
        error: 'The saved draft exceeds the 2 million character limit. Clear input to remove it.',
      };
    return { text };
  } catch {
    return { text: '', error: 'The saved draft could not be read. Local storage may be unavailable.' };
  }
}

function hasValidUrlSyntax(raw: string): boolean {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const methods: Array<{ id: DistributionMode; title: string; text: string }> = [
  { id: 'same', title: 'Same URL to all', text: 'Compare one page across every selected browser.' },
  { id: 'round-robin', title: 'Round-robin', text: 'Assign each URL to the next selected browser.' },
  {
    id: 'balanced',
    title: 'Balanced',
    text: 'Use pending workload and current CPU/memory samples to distribute URLs.',
  },
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
  const [initialDraft] = useState(readDraft);
  const [text, setText] = useState(initialDraft.text);
  const [draftError, setDraftError] = useState(initialDraft.error);
  const [draftInputError, setDraftInputError] = useState<string>();
  const [draftSaved, setDraftSaved] = useState(!initialDraft.error);
  const draft = useRef(text);
  const draftDirty = useRef(false);
  const [mode, setMode] = useState<DistributionMode>('round-robin');
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [manual, setManual] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState('all');
  const [editing, setEditing] = useState<{ id: string; url: string; browserId: number } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string>();
  const persistDraft = useCallback((report = true) => {
    if (!draftDirty.current) return;
    try {
      if (draft.current) window.localStorage.setItem(DRAFT_KEY, draft.current);
      else window.localStorage.removeItem(DRAFT_KEY);
      draftDirty.current = false;
      if (report) {
        setDraftSaved(true);
        setDraftError(undefined);
      }
    } catch {
      if (report) {
        setDraftSaved(false);
        setDraftError(
          'Draft could not be saved locally. Copy your URLs before leaving this page or closing Unicorn.',
        );
      }
    }
  }, []);
  const updateText = (next: string) => {
    if (next.length > DRAFT_LIMIT) {
      setDraftInputError(
        'The draft is limited to 2 million characters. Your previous text was kept; split the list into smaller batches.',
      );
      return;
    }
    draft.current = next;
    draftDirty.current = true;
    setText(next);
    setDraftSaved(false);
    setDraftInputError(undefined);
  };
  useEffect(() => {
    const timer = window.setTimeout(() => persistDraft(), 250);
    return () => window.clearTimeout(timer);
  }, [text, persistDraft]);
  useEffect(() => {
    const flush = () => persistDraft(false);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [persistDraft]);
  useEffect(() => {
    if (!editing || savingEdit) return;
    if (snapshot.jobs.find((job) => job.id === editing.id)?.status !== 'pending') {
      setEditing(null);
      setEditError('This job is no longer pending. Its unsaved changes were not applied.');
    }
  }, [editing, savingEdit, snapshot.jobs]);
  const urls = useMemo(
    () =>
      text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    [text],
  );
  const duplicates = urls.length - new Set(urls).size;
  const invalid = urls.filter((raw) => !hasValidUrlSyntax(raw));
  const queue = snapshot.jobs.filter((job) => filter === 'all' || job.status === filter);
  const canSaveEdit =
    editing &&
    hasValidUrlSyntax(editing.url.trim()) &&
    snapshot.browsers.some((browser) => browser.id === editing.browserId);
  const saveEdit = async () => {
    if (!editing || !canSaveEdit || savingEdit || busy) return;
    setSavingEdit(true);
    setEditError(undefined);
    try {
      const result = await run(
        { type: 'edit-job', id: editing.id, url: editing.url.trim(), browserId: editing.browserId },
        'Assignment updated. Review the pending job, then Start when ready.',
      );
      if (result) setEditing(null);
      else
        setEditError(
          'The edit was not saved. Check the error above, correct the URL or browser, and try again.',
        );
    } finally {
      setSavingEdit(false);
    }
  };
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
            disabled={busy}
            onClick={() =>
              void run({ type: 'import-urls' }).then((result) => {
                if (result?.importedUrls?.length) {
                  const separator = draft.current && !draft.current.endsWith('\n') ? '\n' : '';
                  updateText(`${draft.current}${separator}${result.importedUrls.join('\n')}`);
                }
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
            hint="Use full HTTPS addresses. Your original text is saved on this computer until you clear it."
          >
            <textarea
              className="url-textarea"
              value={text}
              onChange={(e) => updateText(e.target.value)}
              onBlur={() => persistDraft()}
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
            <Button
              variant="ghost"
              onClick={() => {
                updateText('');
                persistDraft();
              }}
              disabled={!text && !draftError && !draftInputError}
            >
              Clear input
            </Button>
          </div>
          <div className="draft-status" role="status" aria-live="polite">
            <span>
              {draftSaved ? (text ? 'Draft saved locally' : 'No saved draft') : 'Draft not yet saved'}
            </span>
            <span>
              {text.length.toLocaleString()} / {DRAFT_LIMIT.toLocaleString()} characters
            </span>
          </div>
          {(draftError || draftInputError) && (
            <p className="field-error" role="alert">
              {draftInputError || draftError}
            </p>
          )}
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
              disabled={busy || !!editing}
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
              disabled={busy || !!editing}
              onClick={() =>
                confirm(
                  'Clear pending queue?',
                  'Pending assignments will be removed and saved recurrence disabled. Completed test records remain available.',
                  () => void run({ type: 'clear-queue' }),
                )
              }
            >
              Clear pending
            </Button>
            <Button
              icon="play"
              variant="primary"
              disabled={busy || !!editing || !snapshot.jobs.some((j) => j.status === 'pending')}
              onClick={() => void run({ type: 'global', action: 'start' })}
            >
              Start tests
            </Button>
          </div>
        </div>
        <p className="queue-help muted small-text">
          Edit a pending URL or browser assignment before starting. Saved edits wait for another Start.
        </p>
        {editError && (
          <p className="field-error queue-edit-error" role="alert">
            {editError}
          </p>
        )}
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
                    <tr key={job.id} className={editing?.id === job.id ? 'queue-editing-row' : undefined}>
                      <td
                        className={editing?.id === job.id ? 'queue-edit-url' : 'url-cell'}
                        title={job.error || job.url}
                      >
                        {editing?.id === job.id ? (
                          <input
                            aria-label="Edit destination URL"
                            type="url"
                            value={editing.url}
                            onChange={(event) => setEditing({ ...editing, url: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void saveEdit();
                              }
                              if (event.key === 'Escape' && !savingEdit) {
                                setEditing(null);
                                setEditError(undefined);
                              }
                            }}
                            disabled={savingEdit}
                            spellCheck={false}
                            autoFocus
                          />
                        ) : (
                          <>
                            {job.url}
                            {job.error && <small className="text-danger">{job.error}</small>}
                          </>
                        )}
                      </td>
                      <td>
                        {editing?.id === job.id ? (
                          <select
                            aria-label="Edit assigned browser"
                            value={editing.browserId}
                            onChange={(event) =>
                              setEditing({ ...editing, browserId: Number(event.target.value) })
                            }
                            disabled={savingEdit}
                          >
                            {!snapshot.browsers.some((browser) => browser.id === editing.browserId) && (
                              <option value={editing.browserId} disabled>
                                Browser {editing.browserId} (closed)
                              </option>
                            )}
                            {snapshot.browsers.map((browser) => (
                              <option value={browser.id} key={browser.id}>
                                Browser {browser.id}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="table-browser">{String(job.browserId).padStart(2, '0')}</span>
                        )}
                      </td>
                      <td>
                        <Status state={job.status} />
                      </td>
                      <td className="nowrap">{new Date(job.createdAt).toLocaleTimeString()}</td>
                      <td>
                        {job.status === 'pending' && (
                          <div className="queue-row-actions">
                            {editing?.id === job.id ? (
                              <>
                                <Button
                                  variant="primary"
                                  disabled={busy || savingEdit || !canSaveEdit}
                                  onClick={() => void saveEdit()}
                                >
                                  {savingEdit ? 'Saving…' : 'Save'}
                                </Button>
                                <Button
                                  variant="ghost"
                                  disabled={savingEdit}
                                  onClick={() => {
                                    setEditing(null);
                                    setEditError(undefined);
                                  }}
                                >
                                  Cancel
                                </Button>
                              </>
                            ) : (
                              <>
                                <Button
                                  disabled={busy || !!editing}
                                  onClick={() => {
                                    setEditError(undefined);
                                    setEditing({ id: job.id, url: job.url, browserId: job.browserId });
                                  }}
                                >
                                  Edit
                                </Button>
                                <Button
                                  variant="ghost"
                                  disabled={busy || !!editing}
                                  onClick={() => void run({ type: 'job', id: job.id, action: 'remove' })}
                                >
                                  Remove
                                </Button>
                              </>
                            )}
                          </div>
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
