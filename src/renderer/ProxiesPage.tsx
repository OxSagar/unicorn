import { useMemo, useState } from 'react';
import { COUNTRIES } from '../shared/types';
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Icon,
  Metric,
  SectionTitle,
  Status,
  timeLabel,
} from './components';
import type { PageProps } from './ui-types';

export default function ProxiesPage({ snapshot, run, busy }: PageProps) {
  const [query, setQuery] = useState(''),
    [status, setStatus] = useState('all'),
    [country, setCountry] = useState('all'),
    [page, setPage] = useState(0);
  const proxies = snapshot.proxies;
  const filtered = useMemo(
    () =>
      proxies.filter(
        (p) =>
          (status === 'all' || p.status === status) &&
          (country === 'all' || p.country === country) &&
          `${p.ip} ${p.country} ${p.countryName} ${p.exitIp || ''}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [proxies, status, country, query],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 50)),
    currentPage = Math.min(page, pages - 1);
  const verified = proxies.filter((p) => p.status === 'available' || p.status === 'assigned'),
    assigned = proxies.filter((p) => p.status === 'assigned');
  const latency = verified.filter((p) => p.latencyMs !== null);
  const average = latency.length
    ? `${Math.round(latency.reduce((sum, p) => sum + p.latencyMs!, 0) / latency.length)} ms`
    : '—';
  return (
    <div className="page-scroll">
      <SectionTitle
        eyebrow="NETWORK HEALTH"
        title="Proxy pool"
        subtitle="Country-filtered, verified connections with unique active assignments."
        actions={
          <>
            <Button
              icon="check"
              disabled={busy || !proxies.length}
              onClick={() => void run({ type: 'validate-proxies' })}
            >
              Validate reserve
            </Button>
            <Button
              icon="reload"
              variant="primary"
              disabled={snapshot.provider.fetching}
              onClick={() => void run({ type: 'refresh-proxies' })}
            >
              {snapshot.provider.fetching ? 'Fetching…' : 'Refresh pool'}
            </Button>
          </>
        }
      />
      <div className="metrics-grid proxy-metrics">
        <Metric
          icon="globe"
          label="Retrieved"
          value={snapshot.provider.retrieved}
          note="Latest provider response"
        />
        <Metric
          icon="shield"
          label="Eligible"
          value={snapshot.provider.eligible}
          note="7 approved countries"
        />
        <Metric
          icon="check"
          label="Verified"
          value={verified.length}
          note={`${assigned.length} active assignments`}
        />
        <Metric
          icon="clock"
          label="Average latency"
          value={average}
          note={`${proxies.filter((p) => p.status === 'available').length} available in reserve`}
        />
      </div>
      {snapshot.provider.error && (
        <div className="notice inline error">
          <Icon name="info" />
          <div>
            <strong>Provider connection needs attention</strong>
            <p>{snapshot.provider.error}</p>
          </div>
        </div>
      )}
      <div className="country-strip">
        {COUNTRIES.map((code) => (
          <div key={code}>
            <span>{code}</span>
            <strong>{proxies.filter((p) => p.country === code).length}</strong>
            <small>
              {proxies.filter((p) => p.country === code && p.status === 'assigned').length} assigned
            </small>
          </div>
        ))}
      </div>
      <section className="surface">
        <div className="surface-heading">
          <div>
            <h2>Available endpoints</h2>
            <p className="muted">ProxyScrape · Last refreshed {timeLabel(snapshot.provider.lastFetchedAt)}</p>
          </div>
          <Badge tone="good">
            <Icon name="shield" size={12} />
            No direct fallback
          </Badge>
        </div>
        <div className="filter-row">
          <Field label="Search endpoints">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(0);
              }}
              placeholder="IP, exit IP, or country"
            />
          </Field>
          <Field label="Country">
            <select
              value={country}
              onChange={(e) => {
                setCountry(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All eligible countries</option>
              {COUNTRIES.map((code) => (
                <option key={code}>{code}</option>
              ))}
            </select>
          </Field>
          <Field label="Status">
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(0);
              }}
            >
              <option value="all">All statuses</option>
              {['unverified', 'validating', 'available', 'assigned', 'failed'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </Field>
        </div>
        {!filtered.length ? (
          <EmptyState
            icon="shield"
            title={proxies.length ? 'No matching endpoints' : 'Your proxy pool is empty'}
            action={
              !proxies.length && (
                <Button icon="reload" onClick={() => void run({ type: 'refresh-proxies' })}>
                  Fetch public proxies
                </Button>
              )
            }
          >
            {proxies.length
              ? 'Try a different filter.'
              : 'Unicorn waits for a working, eligible proxy before opening a website. Free public proxy availability varies.'}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Country</th>
                  <th>Protocol</th>
                  <th>Status</th>
                  <th>Latency</th>
                  <th>Exit IP</th>
                  <th>Browser</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(currentPage * 50, currentPage * 50 + 50).map((proxy) => (
                  <tr key={proxy.id}>
                    <td className="monospace" title={proxy.error || proxy.id}>
                      {proxy.ip}:{proxy.port}
                      {proxy.error && <small className="text-danger">{proxy.error}</small>}
                    </td>
                    <td>{proxy.country}</td>
                    <td>
                      <Badge>{proxy.protocol.toUpperCase()}</Badge>
                    </td>
                    <td>
                      <Status state={proxy.status} />
                    </td>
                    <td>{proxy.latencyMs === null ? '—' : `${proxy.latencyMs} ms`}</td>
                    <td className="monospace">{proxy.exitIp || '—'}</td>
                    <td>{proxy.assignedTo ? `#${String(proxy.assignedTo).padStart(2, '0')}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="pagination">
          <span>
            {filtered.length} endpoints · {proxies.filter((p) => p.status === 'failed').length} failed
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
      <div className="footnote">
        <Icon name="info" size={15} />
        <p>
          Public proxies are untrusted. Keep sensitive passwords, payment details, and valuable authenticated
          sessions out of these profiles. A failed connection pauses work; it never switches to your direct
          connection.
        </p>
      </div>
    </div>
  );
}
