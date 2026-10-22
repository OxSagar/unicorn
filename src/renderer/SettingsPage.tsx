import { useState } from 'react';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { Badge, Button, Field, Icon, SectionTitle, Toggle } from './components';
import type { PageProps } from './ui-types';

export default function SettingsPage({ snapshot, run, confirm, busy }: PageProps) {
  const [settings, setSettings] = useState({ ...snapshot.settings });
  const [domains, setDomains] = useState(snapshot.settings.authorizedDomains.join('\n'));
  const save = () =>
    void run(
      {
        type: 'settings',
        settings: {
          ...settings,
          authorizedDomains: domains
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean),
          timings: snapshot.settings.timings,
          schedule: snapshot.settings.schedule,
        },
      },
      'Workspace settings saved.',
    );
  return (
    <div className="page-scroll">
      <SectionTitle
        eyebrow="WORKSPACE PREFERENCES"
        title="Settings"
        subtitle="Keep test authorization, network controls, and desktop behavior in one place."
        actions={
          <Button icon="check" variant="primary" disabled={busy} onClick={save}>
            Save settings
          </Button>
        }
      />
      <div className="settings-layout">
        <div>
          <section className="surface">
            <div className="surface-heading">
              <div className="inline-heading">
                <Icon name="shield" />
                <h2>Authorized test scope</h2>
              </div>
              <Badge>Required for automation</Badge>
            </div>
            <Field
              label="Approved domains"
              hint="One hostname per line. Include authorized CDN and asset hosts used by automated tests. Add external destinations explicitly. *.example.com covers its subdomains, not example.com itself."
            >
              <textarea
                rows={5}
                value={domains}
                onChange={(e) => setDomains(e.target.value)}
                placeholder={'staging.example.com\nqa.example.com'}
                spellCheck={false}
              />
            </Field>
            <Toggle
              label="I am authorized to test these websites"
              hint="Repeated runs use staging environments or test advertising placements and do not generate monetized ad engagement."
              checked={settings.stagingConfirmed}
              onChange={(stagingConfirmed) => setSettings({ ...settings, stagingConfirmed })}
            />
            <Toggle
              label="Allow local test fixtures"
              hint="Permit HTTP loopback addresses for your controlled local test pages."
              checked={settings.allowLocalhost}
              onChange={(allowLocalhost) => setSettings({ ...settings, allowLocalhost })}
            />
            <Field
              label="Daily navigation limit per domain"
              hint="Navigation attempts, including failures, count per host. The counter resets at 00:00 UTC."
            >
              <input
                type="number"
                min="1"
                max="10000"
                value={settings.dailyNavigationLimit}
                onChange={(e) => setSettings({ ...settings, dailyNavigationLimit: Number(e.target.value) })}
              />
            </Field>
          </section>
          <section className="surface">
            <div className="surface-heading">
              <div className="inline-heading">
                <Icon name="globe" />
                <h2>Proxy behavior</h2>
              </div>
              <Badge tone="good">Proxy required</Badge>
            </div>
            <div className="form-grid">
              <Field label="Validation timeout (seconds)">
                <input
                  type="number"
                  min="2"
                  max="60"
                  value={settings.proxyTimeoutMs / 1000}
                  onChange={(e) =>
                    setSettings({ ...settings, proxyTimeoutMs: Number(e.target.value) * 1000 })
                  }
                />
              </Field>
              <Field label="Provider refresh interval (minutes)">
                <input
                  type="number"
                  min="1"
                  max="1440"
                  value={settings.proxyRefreshMinutes}
                  onChange={(e) => setSettings({ ...settings, proxyRefreshMinutes: Number(e.target.value) })}
                />
              </Field>
              <Field label="Maximum transport retries">
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={settings.retryLimit}
                  onChange={(e) => setSettings({ ...settings, retryLimit: Number(e.target.value) })}
                />
              </Field>
            </div>
            <Toggle
              label="Require unique exit IPs"
              hint="Also prevent different proxy endpoints from sharing one verified public exit address."
              checked={settings.uniqueExitIps}
              onChange={(uniqueExitIps) => setSettings({ ...settings, uniqueExitIps })}
            />
            <p className="muted small-text">
              Automatic proxy source: ProxyScrape. Eligible countries: US, GB, CA, FR, DE, JP, IT. Direct
              networking is not an available fallback.
            </p>
          </section>
          <section className="surface">
            <div className="surface-heading">
              <div className="inline-heading">
                <Icon name="browser" />
                <h2>Desktop and profiles</h2>
              </div>
            </div>
            <div className="form-grid">
              <Field label="Default browser count">
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={settings.browserCount}
                  onChange={(e) => setSettings({ ...settings, browserCount: Number(e.target.value) })}
                />
              </Field>
              <Field label="Appearance">
                <select
                  value={settings.theme}
                  onChange={(e) => setSettings({ ...settings, theme: e.target.value as 'dark' | 'light' })}
                >
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </Field>
            </div>
            <Toggle
              label="Close to system tray"
              hint="Keep authorized monitoring running when the main window is closed."
              checked={settings.closeToTray}
              onChange={(closeToTray) => setSettings({ ...settings, closeToTray })}
            />
            <Toggle
              label="Start at Windows login"
              checked={settings.startAtLogin}
              onChange={(startAtLogin) => setSettings({ ...settings, startAtLogin })}
            />
            <Toggle
              label="Close test popups after a run"
              hint="Popups remain associated with the originating profile and proxy."
              checked={settings.closePopupsAfterRun}
              onChange={(closePopupsAfterRun) => setSettings({ ...settings, closePopupsAfterRun })}
            />
          </section>
        </div>
        <aside>
          <section className="surface">
            <div className="surface-heading">
              <h2>Resources and logs</h2>
              <Icon name="chart" />
            </div>
            <Field
              label="Memory warning threshold (MB)"
              hint="Optional work can be deferred when this limit is reached."
            >
              <input
                type="number"
                min="512"
                max="131072"
                step="256"
                value={settings.resourceLimitMb}
                onChange={(e) => setSettings({ ...settings, resourceLimitMb: Number(e.target.value) })}
              />
            </Field>
            <Field label="Log retention (days)">
              <input
                type="number"
                min="1"
                max="90"
                value={settings.logRetentionDays}
                onChange={(e) => setSettings({ ...settings, logRetentionDays: Number(e.target.value) })}
              />
            </Field>
            <p className="muted small-text">
              Keep an active Windows user session for interactive Chromium rendering. Practical browser
              concurrency depends on your hardware and the pages under test.
            </p>
          </section>
          <section className="surface about-card">
            <div className="about-logo">
              <Icon name="browser" size={29} />
            </div>
            <h2>Unicorn</h2>
            <Badge>v{snapshot.version}</Badge>
            <p>A focused workspace for independent Chromium sessions and authorized website QA.</p>
            <Button icon="arrow" onClick={() => void run({ type: 'open-release-page' })}>
              Releases and updates
            </Button>
            <p className="muted small-text">
              Powered by Electron and Chromium. This is not the separately installed Google Chrome
              application.
            </p>
          </section>
          <section className="surface">
            <h3>Reset preferences</h3>
            <p className="muted small-text">
              Restore application settings. Browser profile data remains available.
            </p>
            <Button
              variant="danger"
              onClick={() =>
                confirm(
                  'Restore default settings?',
                  'Your authorized domains, schedule, and app preferences will be reset. Browser profile data will be retained.',
                  () => {
                    const defaults = structuredClone(DEFAULT_SETTINGS);
                    setSettings(defaults);
                    setDomains('');
                    void run({ type: 'settings', settings: defaults }, 'Default preferences restored.');
                  },
                  true,
                )
              }
            >
              Restore defaults
            </Button>
          </section>
        </aside>
      </div>
    </div>
  );
}
