import { useMemo, useState } from 'react';
import { COUNTRIES } from '../shared/types';
import { Badge, Button, EmptyState, Field, Icon, SectionTitle, Status, timeLabel } from './components';
import type { PageProps } from './ui-types';

const countryNames: Record<string, string> = {
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  FR: 'France',
  DE: 'Germany',
  JP: 'Japan',
  IT: 'Italy',
  AT: 'Austria',
};

export default function ProxiesPage({ snapshot, run }: PageProps) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const proxies = snapshot.proxies;
  const filtered = useMemo(
    () =>
      proxies.filter((proxy) =>
        `${proxy.ip} ${proxy.country} ${countryNames[proxy.country]} ${proxy.protocol}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    [proxies, query],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 50));
  const currentPage = Math.min(page, pages - 1);
  const counts = [
    ['Eligible', snapshot.provider.eligible],
    ['Available', proxies.filter((proxy) => proxy.status === 'available').length],
    ['Assigned', proxies.filter((proxy) => proxy.status === 'assigned').length],
    ['Failed', proxies.filter((proxy) => proxy.status === 'failed').length],
  ] as const;
  return (
    <div className="page-scroll">
      <SectionTitle
        title="Proxies"
        subtitle="Eligible API-listed endpoints are assigned directly when a browser needs one."
        actions={
          <Button
            icon="reload"
            variant="primary"
            disabled={snapshot.provider.fetching}
            onClick={() => void run({ type: 'refresh-proxies' })}
          >
            {snapshot.provider.fetching ? 'Refreshing…' : 'Refresh'}
          </Button>
        }
      />
      <section className="surface proxy-overview">
        <div className="proxy-counts">
          {counts.map(([label, value]) => (
            <div key={label}>
              <strong>{value}</strong>
              <span>{label}</span>
            </div>
          ))}
        </div>
        <div className="eligible-countries" aria-label="Eligible countries">
          <span>Countries</span>
          {COUNTRIES.map((code) => (
            <Badge key={code}>{countryNames[code]}</Badge>
          ))}
        </div>
        <p className="muted small-text">
          Countries come from ProxyScrape. Connectivity and public exit locations are not checked.
        </p>
      </section>
      {snapshot.provider.error && (
        <div className="notice inline error">
          <Icon name="info" />
          <div>
            <strong>Could not refresh proxies</strong>
            <p>{snapshot.provider.error}</p>
          </div>
        </div>
      )}
      <section className="surface">
        <div className="surface-heading">
          <div>
            <h2>Proxy list</h2>
            <p className="muted small-text">Updated {timeLabel(snapshot.provider.lastFetchedAt)}</p>
          </div>
          <Field label="Search proxies">
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(0);
              }}
              placeholder="Address or country"
            />
          </Field>
        </div>
        {!filtered.length ? (
          <EmptyState
            icon="shield"
            title={proxies.length ? 'No matching proxies' : 'No proxies available'}
            action={
              !proxies.length && (
                <Button
                  icon="reload"
                  disabled={snapshot.provider.fetching}
                  onClick={() => void run({ type: 'refresh-proxies' })}
                >
                  Refresh proxies
                </Button>
              )
            }
          >
            {proxies.length
              ? 'Try another address or country.'
              : 'Refresh the API list to get eligible endpoints. Browsers wait when none are available.'}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>API-reported country</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Browser</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(currentPage * 50, currentPage * 50 + 50).map((proxy) => (
                  <tr key={proxy.id}>
                    <td className="monospace">
                      {proxy.ip}:{proxy.port}
                      {proxy.error && <small className="text-danger">{proxy.error}</small>}
                    </td>
                    <td>{countryNames[proxy.country] || proxy.country}</td>
                    <td>
                      <Badge>{proxy.protocol.toUpperCase()}</Badge>
                    </td>
                    <td>
                      <Status state={proxy.status} />
                    </td>
                    <td>{proxy.assignedTo ? `Browser ${proxy.assignedTo}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <div className="pagination">
            <span>{filtered.length} proxies</span>
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
        )}
      </section>
      <div className="footnote">
        <Icon name="info" size={15} />
        <p>
          Public proxies can be unreliable or untrusted. Avoid sensitive accounts. Each active browser uses a
          unique endpoint; failures never enable a direct connection.
        </p>
      </div>
    </div>
  );
}
