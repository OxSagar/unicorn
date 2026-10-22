import type { PerformanceSnapshot } from '../shared/types';
import { Badge, Button, duration, Icon, Metric, SectionTitle, timeLabel } from './components';
import type { PageProps } from './ui-types';

export default function PerformancePage({
  snapshot,
  history,
  run,
}: PageProps & { history: PerformanceSnapshot[] }) {
  const perf = snapshot.performance;
  const active = snapshot.browsers.filter((b) => ['RUNNING', 'NAVIGATING', 'READY'].includes(b.state)).length;
  const memoryRatio = perf.memoryMb / snapshot.settings.resourceLimitMb;
  return (
    <div className="page-scroll">
      <SectionTitle
        eyebrow="LIVE TELEMETRY"
        title="Performance"
        subtitle="Measured app resources and navigation outcomes from this session."
        actions={
          <Button icon="download" onClick={() => void run({ type: 'export-results' })}>
            Export results
          </Button>
        }
      />
      <div className="metrics-grid">
        <Metric
          icon="chart"
          label="App CPU"
          value={`${perf.cpuPercent.toFixed(1)}%`}
          note="Across tracked app processes"
        />
        <Metric
          icon="browser"
          label="App memory"
          value={`${Math.round(perf.memoryMb).toLocaleString()} MB`}
          note={`${perf.processes} tracked processes`}
        />
        <Metric
          icon="grid"
          label="Active browsers"
          value={`${active} / ${snapshot.browsers.length}`}
          note="Up to 20 independent sessions"
        />
        <Metric
          icon="clock"
          label="App uptime"
          value={duration(perf.uptimeSeconds * 1000)}
          note={`Sampled ${perf.sampledAt ? new Date(perf.sampledAt).toLocaleTimeString() : 'not yet'}`}
        />
      </div>
      <div className="two-column">
        <section className="surface">
          <div className="surface-heading">
            <div>
              <h2>CPU activity</h2>
              <p className="muted small-text">Recent observed samples</p>
            </div>
            <Badge>{perf.cpuPercent.toFixed(1)}%</Badge>
          </div>
          <Chart data={history.map((s) => s.cpuPercent)} label="App CPU percent" suffix="%" color="#9b8bfa" />
        </section>
        <section className="surface">
          <div className="surface-heading">
            <div>
              <h2>Memory footprint</h2>
              <p className="muted small-text">Recent observed samples</p>
            </div>
            <Badge>{Math.round(perf.memoryMb)} MB</Badge>
          </div>
          <Chart
            data={history.map((s) => s.memoryMb)}
            label="App memory in megabytes"
            suffix=" MB"
            color="#5bb9d4"
          />
        </section>
      </div>
      <div className="two-column">
        <section className="surface">
          <div className="surface-heading">
            <h2>Memory budget</h2>
            <Icon name="chart" />
          </div>
          <div className="budget-value">
            <strong>
              {Math.round(perf.memoryMb).toLocaleString()}
              <span> MB</span>
            </strong>
            <span>of {snapshot.settings.resourceLimitMb.toLocaleString()} MB threshold</span>
          </div>
          <div className={`progress-track ${memoryRatio >= 1 ? 'warning' : ''}`}>
            <div style={{ width: `${Math.min(100, memoryRatio * 100)}%` }} />
          </div>
          <p className={memoryRatio >= 1 ? 'text-warning small-text' : 'muted small-text'}>
            {memoryRatio >= 1
              ? 'The configured memory threshold has been reached. Reduce active work or increase the budget if your computer has capacity.'
              : 'The configured threshold helps keep the main interface responsive.'}
          </p>
          <dl className="key-values">
            <dt>System memory</dt>
            <dd>{Math.round(perf.totalMemoryMb).toLocaleString()} MB</dd>
            <dt>System memory available</dt>
            <dd>{Math.round(perf.freeMemoryMb).toLocaleString()} MB</dd>
            <dt>Last heartbeat</dt>
            <dd>{timeLabel(perf.sampledAt)}</dd>
            <dt>Current sampling delay</dt>
            <dd>{perf.eventLoopDelayMs.toFixed(1)} ms</dd>
            <dt>Peak sampling delay</dt>
            <dd>{perf.peakEventLoopDelayMs.toFixed(1)} ms</dd>
            <dt>Heartbeat count</dt>
            <dd>{perf.heartbeatCount.toLocaleString()}</dd>
            <dt>First visible sample</dt>
            <dd>{timeLabel(history[0]?.sampledAt)}</dd>
            <dt>Retained chart samples</dt>
            <dd>{history.length}</dd>
          </dl>
        </section>
        <section className="surface">
          <div className="surface-heading">
            <h2>Quality outcomes</h2>
            <Icon name="check" />
          </div>
          <div className="outcome-grid">
            <div>
              <strong className="text-success">{snapshot.totals.completed}</strong>
              <span>Completed test runs</span>
            </div>
            <div>
              <strong className="text-danger">{snapshot.totals.failed}</strong>
              <span>Failed test runs</span>
            </div>
            <div>
              <strong>{snapshot.totals.navigations}</strong>
              <span>Successful navigations</span>
            </div>
            <div>
              <strong>{snapshot.totals.networkErrors}</strong>
              <span>Network failures</span>
            </div>
            <div>
              <strong>{snapshot.totals.jsErrors}</strong>
              <span>JavaScript errors</span>
            </div>
            <div>
              <strong>{snapshot.jobs.filter((j) => j.status === 'pending').length}</strong>
              <span>Queued tests</span>
            </div>
          </div>
        </section>
      </div>
      <div className="footnote">
        <Icon name="info" size={15} />
        <p>
          These are live measurements from your current app session. They are not hardware benchmarks or a
          claim of 24-hour stability. Complex pages and public-proxy latency can reduce practical concurrency.
        </p>
      </div>
    </div>
  );
}

function Chart({
  data,
  label,
  suffix,
  color,
}: {
  data: number[];
  label: string;
  suffix: string;
  color: string;
}) {
  if (!data.length) return <div className="chart-empty">Waiting for the first resource sample…</div>;
  const max = Math.max(1, ...data) * 1.15;
  const points = data
    .map(
      (value, index) =>
        `${(index / Math.max(1, data.length - 1)) * 600},${160 - (Math.max(0, value) / max) * 145}`,
    )
    .join(' ');
  const polygon = `0,170 ${points} ${data.length === 1 ? '0' : '600'},170`;
  return (
    <div className="chart">
      <div className="chart-labels">
        <span>
          {Math.round(max)}
          {suffix}
        </span>
        <span>
          {Math.round(max / 2)}
          {suffix}
        </span>
        <span>0{suffix}</span>
      </div>
      <svg
        viewBox="0 0 600 180"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}. ${data.length} measured samples. Latest ${data.at(-1)?.toFixed(1)}${suffix}.`}
      >
        <path d="M0 15H600M0 90H600M0 165H600" className="chart-grid" />
        <polygon points={polygon} fill={color} opacity=".08" />
        <polyline
          points={points}
          fill="none"
          stroke={color}
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
        />
        {data.length === 1 && <circle cx="0" cy={160 - (data[0] / max) * 145} r="3" fill={color} />}
      </svg>
      <div className="chart-axis">
        <span>Oldest sample</span>
        <span>Now</span>
      </div>
    </div>
  );
}
