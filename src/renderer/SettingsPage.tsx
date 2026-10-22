import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../shared/types';
import { Badge, Button, Field, Icon, SectionTitle, timeLabel, Toggle } from './components';
import type { PageProps } from './ui-types';

function editable(settings: AppSettings) {
  return {
    domains: settings.authorizedDomains.join('\n'),
    stagingConfirmed: settings.stagingConfirmed,
    repeat: settings.schedule.enabled,
    intervalMinutes: settings.schedule.intervalMinutes,
    theme: settings.theme,
    closeToTray: settings.closeToTray,
    minimizeToTray: settings.minimizeToTray,
    startAtLogin: settings.startAtLogin,
    allowLocalhost: settings.allowLocalhost,
  };
}
type Preferences = ReturnType<typeof editable>;

export default function SettingsPage({ snapshot, run, busy }: PageProps) {
  const [preferences, setPreferences] = useState(() => editable(snapshot.settings));
  const dirty = useRef(new Set<keyof Preferences>());
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    dirty.current.add(key);
    setPreferences((current) => ({ ...current, [key]: value }));
  };
  useEffect(() => {
    const incoming = editable(snapshot.settings);
    setPreferences((current) => {
      const next: Preferences = {
        ...incoming,
        ...Object.fromEntries([...dirty.current].map((key) => [key, current[key]])),
      };
      return (Object.keys(next) as Array<keyof Preferences>).every((key) => next[key] === current[key])
        ? current
        : next;
    });
  }, [snapshot.settings]);
  const save = async () => {
    const values: Preferences = {
      ...editable(snapshot.settings),
      ...Object.fromEntries([...dirty.current].map((key) => [key, preferences[key]])),
    };
    const result = await run(
      {
        type: 'settings',
        settings: {
          ...snapshot.settings,
          authorizedDomains: values.domains
            .split(/[\n,]/)
            .map((host) => host.trim())
            .filter(Boolean),
          stagingConfirmed: values.stagingConfirmed,
          schedule: {
            ...snapshot.settings.schedule,
            enabled: values.repeat,
            intervalMinutes: values.intervalMinutes,
          },
          theme: values.theme,
          closeToTray: values.closeToTray,
          minimizeToTray: values.minimizeToTray,
          startAtLogin: values.startAtLogin,
          allowLocalhost: values.allowLocalhost,
        },
      },
      'Settings saved.',
    );
    if (result) {
      dirty.current.clear();
      setPreferences(editable(result.snapshot.settings));
    }
  };
  return (
    <div className="page-scroll simple-settings">
      <SectionTitle
        title="Settings"
        subtitle="Choose your websites and how Unicorn runs."
        actions={
          <Button icon="check" variant="primary" disabled={busy} onClick={() => void save()}>
            Save settings
          </Button>
        }
      />
      <fieldset className="settings-fields" disabled={busy}>
        <div className="simple-settings-grid">
          <section className="surface">
            <div className="surface-heading">
              <h2>Approved websites</h2>
              <Icon name="shield" />
            </div>
            <Field
              label="Approved domains"
              hint="One hostname per line. Include any authorized CDN or API hosts your pages need."
            >
              <textarea
                rows={5}
                value={preferences.domains}
                onChange={(event) => update('domains', event.target.value)}
                placeholder={'staging.example.com\ncdn.example.com'}
                spellCheck={false}
              />
            </Field>
            <Toggle
              label="I am authorized to test these websites"
              hint="Automated runs use staging or test-ad pages, without generating monetized ad engagement."
              checked={preferences.stagingConfirmed}
              onChange={(value) => update('stagingConfirmed', value)}
            />
          </section>
          <section className="surface">
            <div className="surface-heading">
              <h2>Repeat runs</h2>
              <Icon name="clock" />
            </div>
            <Toggle
              label="Repeat the reviewed queue"
              checked={preferences.repeat}
              onChange={(value) => update('repeat', value)}
            />
            {preferences.repeat && (
              <Field label="Repeat every (minutes)" hint="At least one minute between cycles.">
                <input
                  type="number"
                  min="1"
                  max="10080"
                  value={preferences.intervalMinutes}
                  onChange={(event) => update('intervalMinutes', Number(event.target.value))}
                />
              </Field>
            )}
            <p className="muted small-text">
              Save, then Start your reviewed queue. New links wait for Start. Stop all or Clear pending turns
              repetition off.
            </p>
            {snapshot.scheduler.nextRunAt && (
              <p className="schedule-next">Next run: {timeLabel(snapshot.scheduler.nextRunAt)}</p>
            )}
          </section>
          <section className="surface desktop-preferences">
            <div className="surface-heading">
              <h2>Appearance and startup</h2>
              <Icon name="settings" />
            </div>
            <Field label="Appearance">
              <select
                value={preferences.theme}
                onChange={(event) => update('theme', event.target.value as 'dark' | 'light')}
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </Field>
            <Toggle
              label="Close to system tray"
              hint="Keep Unicorn running when its window closes."
              checked={preferences.closeToTray}
              onChange={(value) => update('closeToTray', value)}
            />
            <Toggle
              label="Minimize to system tray"
              checked={preferences.minimizeToTray}
              onChange={(value) => update('minimizeToTray', value)}
            />
            <Toggle
              label="Start at Windows login"
              checked={preferences.startAtLogin}
              onChange={(value) => update('startAtLogin', value)}
            />
          </section>
        </div>
        <details className="surface troubleshooting-panel">
          <summary>
            <Icon name="logs" />
            <span>Troubleshooting</span>
            <Icon name="chevron" size={15} />
          </summary>
          <div className="troubleshooting-body">
            <div className="troubleshooting-actions">
              <Button icon="download" onClick={() => void run({ type: 'export-logs' })}>
                Export logs
              </Button>
              <Button icon="download" onClick={() => void run({ type: 'export-results' })}>
                Export results
              </Button>
              <Button icon="arrow" onClick={() => void run({ type: 'open-release-page' })}>
                Releases and updates
              </Button>
            </div>
            <Toggle
              label="Allow local test fixtures"
              hint="Permit approved HTTP loopback pages through the assigned proxy. Save settings to apply."
              checked={preferences.allowLocalhost}
              onChange={(value) => update('allowLocalhost', value)}
            />
            <dl className="troubleshooting-stats">
              <div>
                <dt>Version</dt>
                <dd>{snapshot.version}</dd>
              </div>
              <div>
                <dt>App memory</dt>
                <dd>{Math.round(snapshot.performance.memoryMb).toLocaleString()} MB</dd>
              </div>
              <div>
                <dt>App CPU</dt>
                <dd>{snapshot.performance.cpuPercent.toFixed(1)}%</dd>
              </div>
              <div>
                <dt>Last heartbeat</dt>
                <dd>{timeLabel(snapshot.performance.sampledAt)}</dd>
              </div>
            </dl>
            <h3>Recent activity</h3>
            {snapshot.logs.length ? (
              <ul className="recent-activity">
                {snapshot.logs
                  .slice(-8)
                  .reverse()
                  .map((log) => (
                    <li key={log.id}>
                      <Badge tone={log.level === 'error' ? 'bad' : log.level === 'warn' ? 'warn' : 'neutral'}>
                        {log.level}
                      </Badge>
                      <span>{log.message}</span>
                      <time>{new Date(log.at).toLocaleTimeString()}</time>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="muted small-text">Activity appears here as browsers and queues run.</p>
            )}
          </div>
        </details>
      </fieldset>
    </div>
  );
}
