import { useState } from 'react';
import { DEVICES } from '../shared/defaults';
import type { DeviceConfig } from '../shared/types';
import { Badge, Button, Field, Icon, SectionTitle, Toggle } from './components';
import type { PageProps } from './ui-types';

export default function DevicesPage({ snapshot, selected, setSelected, run, busy }: PageProps) {
  const [device, setDevice] = useState<DeviceConfig>({ ...DEVICES.desktop });
  const custom = (update: Partial<DeviceConfig>) => setDevice({ ...device, ...update, preset: 'custom' });
  const apply = (ids: number[]) =>
    void run(
      { type: 'device', ids, device },
      `Device configuration applied to ${ids.length} browser${ids.length === 1 ? '' : 's'}.`,
    );
  return (
    <div className="page-scroll">
      <SectionTitle
        eyebrow="COMPATIBILITY TESTING"
        title="Device profiles"
        subtitle="Control viewport, pixel ratio, touch behavior, and browser identity together."
        actions={
          <Button icon="reload" onClick={() => setDevice({ ...DEVICES.desktop })}>
            Restore desktop defaults
          </Button>
        }
      />
      <div className="device-presets">
        {(['desktop', 'mobile', 'tablet'] as const).map((name) => (
          <button
            type="button"
            className={`device-preset ${device.preset === name ? 'active' : ''}`}
            onClick={() => setDevice({ ...DEVICES[name] })}
            key={name}
          >
            <div className={`device-illustration ${name}`}>
              <span />
              <i />
            </div>
            <div>
              <strong>{name[0].toUpperCase() + name.slice(1)}</strong>
              <span>
                {DEVICES[name].width} × {DEVICES[name].height}
              </span>
              <small>
                {DEVICES[name].scaleFactor}× pixel ratio ·{' '}
                {DEVICES[name].touch ? 'Touch enabled' : 'Mouse input'}
              </small>
            </div>
            <span className="radio-indicator">
              {device.preset === name && <Icon name="check" size={12} />}
            </span>
          </button>
        ))}
      </div>
      <div className="two-column">
        <section className="surface">
          <div className="surface-heading">
            <h2>Emulation settings</h2>
            <Badge tone="accent">{device.preset}</Badge>
          </div>
          <div className="form-grid">
            <Field label="Viewport width" hint="CSS pixels">
              <input
                type="number"
                min="240"
                max="7680"
                value={device.width}
                onChange={(e) => custom({ width: Number(e.target.value) })}
              />
            </Field>
            <Field label="Viewport height" hint="CSS pixels">
              <input
                type="number"
                min="240"
                max="4320"
                value={device.height}
                onChange={(e) => custom({ height: Number(e.target.value) })}
              />
            </Field>
            <Field label="Device pixel ratio">
              <input
                type="number"
                min="0.5"
                max="4"
                step="0.5"
                value={device.scaleFactor}
                onChange={(e) => custom({ scaleFactor: Number(e.target.value) })}
              />
            </Field>
            <Field label="Orientation">
              <select
                value={device.landscape ? 'landscape' : 'portrait'}
                onChange={(e) => custom({ landscape: e.target.value === 'landscape' })}
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </Field>
          </div>
          <Toggle
            label="Mobile viewport behavior"
            hint="Use Chromium’s mobile layout emulation."
            checked={device.mobile}
            onChange={(mobile) => custom({ mobile })}
          />
          <Toggle
            label="Touch input"
            hint="Expose touch capability for responsive interface testing."
            checked={device.touch}
            onChange={(touch) => custom({ touch })}
          />
          <p className="footnote compact">
            <Icon name="info" size={15} />
            Changing device settings keeps cookies and website storage. Use the session diagnostic tool to
            inspect the page’s observed settings.
          </p>
        </section>
        <section className="surface">
          <div className="surface-heading">
            <h2>Apply to browsers</h2>
            <Badge>{selected.length} selected</Badge>
          </div>
          <div className="device-targets">
            {snapshot.browsers.map((browser) => (
              <label key={browser.id} className={selected.includes(browser.id) ? 'selected' : ''}>
                <input
                  type="checkbox"
                  checked={selected.includes(browser.id)}
                  onChange={() =>
                    setSelected(
                      selected.includes(browser.id)
                        ? selected.filter((id) => id !== browser.id)
                        : [...selected, browser.id],
                    )
                  }
                />
                <span className="browser-number">{String(browser.id).padStart(2, '0')}</span>
                <div>
                  <strong>{browser.name}</strong>
                  <small>
                    {browser.device.preset} · {browser.device.width} × {browser.device.height}
                  </small>
                </div>
              </label>
            ))}
          </div>
          {!snapshot.browsers.length && (
            <p className="muted">Create browser profiles from the top bar to apply a device configuration.</p>
          )}
          <div className="form-actions">
            <Button
              disabled={busy || !snapshot.browsers.length}
              onClick={() => apply(snapshot.browsers.map((b) => b.id))}
            >
              Apply to all
            </Button>
            <Button
              variant="primary"
              icon="check"
              disabled={busy || !selected.length}
              onClick={() => apply(selected)}
            >
              Apply to selected
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
