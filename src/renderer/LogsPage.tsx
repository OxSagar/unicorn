import { useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Field, SectionTitle, timeLabel } from './components';
import type { PageProps } from './ui-types';

export default function LogsPage({ snapshot, run }: PageProps) {
  const [query, setQuery] = useState(''),
    [level, setLevel] = useState('all'),
    [browser, setBrowser] = useState('all'),
    [category, setCategory] = useState('all'),
    [since, setSince] = useState(''),
    [page, setPage] = useState(0);
  const categories = [...new Set(snapshot.logs.map((log) => log.category))].sort();
  const filtered = useMemo(
    () =>
      [...snapshot.logs]
        .reverse()
        .filter(
          (log) =>
            (level === 'all' || log.level === level) &&
            (browser === 'all' || log.browserId === Number(browser)) &&
            (category === 'all' || log.category === category) &&
            (!since || log.at >= new Date(since).getTime()) &&
            `${log.message} ${log.category}`.toLowerCase().includes(query.toLowerCase()),
        ),
    [snapshot.logs, level, browser, category, since, query],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 100)),
    currentPage = Math.min(page, pages - 1);
  return (
    <div className="page-scroll">
      <SectionTitle
        eyebrow="OBSERVABILITY"
        title="Activity logs"
        subtitle="Trace navigation, proxy changes, JavaScript errors, and test outcomes."
        actions={
          <>
            <Button icon="download" onClick={() => void run({ type: 'export-results' })}>
              Export test results
            </Button>
            <Button icon="download" variant="primary" onClick={() => void run({ type: 'export-logs' })}>
              Export logs
            </Button>
          </>
        }
      />
      <section className="surface">
        <div className="filter-row logs-filters">
          <Field label="Search">
            <input
              value={query}
              placeholder="Find a message or category"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
            />
          </Field>
          <Field label="Severity">
            <select
              value={level}
              onChange={(e) => {
                setLevel(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All levels</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </select>
          </Field>
          <Field label="Browser">
            <select
              value={browser}
              onChange={(e) => {
                setBrowser(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All browsers</option>
              {snapshot.browsers.map((b) => (
                <option key={b.id} value={b.id}>
                  Browser {b.id}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Category">
            <select
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All categories</option>
              {categories.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="From date">
            <input
              type="date"
              value={since}
              onChange={(e) => {
                setSince(e.target.value);
                setPage(0);
              }}
            />
          </Field>
        </div>
        {!filtered.length ? (
          <EmptyState icon="logs" title="No matching activity">
            Your workspace events appear here as browsers and tests run.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="log-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Browser</th>
                  <th>Category</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(currentPage * 100, currentPage * 100 + 100).map((log) => (
                  <tr key={log.id}>
                    <td className="nowrap" title={timeLabel(log.at)}>
                      {new Date(log.at).toLocaleTimeString()}
                    </td>
                    <td>
                      <Badge tone={log.level === 'error' ? 'bad' : log.level === 'warn' ? 'warn' : 'neutral'}>
                        {log.level}
                      </Badge>
                    </td>
                    <td>{log.browserId ? `#${String(log.browserId).padStart(2, '0')}` : 'App'}</td>
                    <td>
                      <Badge>{log.category}</Badge>
                    </td>
                    <td className="log-message">{log.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination">
          <span>
            {filtered.length} matching events · {snapshot.settings.logRetentionDays}-day retention
          </span>
          <div>
            <Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
              Previous
            </Button>
            <span>
              {currentPage + 1} / {pages}
            </span>
            <Button disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>
              Next
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
