import { useState } from 'react';
import type { TimingSettings } from '../shared/types';
import { Badge, Button, Field, Icon, SectionTitle, timeLabel, Toggle } from './components';
import type { PageProps } from './ui-types';

const stages: Array<{
  title: string;
  description: string;
  wait: keyof TimingSettings;
  scroll: keyof TimingSettings;
}> = [
  {
    title: 'Landing page',
    description: 'Open the assigned URL and observe initialization.',
    wait: 'landingWaitMs',
    scroll: 'landingScrollMs',
  },
  {
    title: 'Internal link',
    description: 'Follow an eligible link within the authorized site.',
    wait: 'internalWaitMs',
    scroll: 'internalScrollMs',
  },
  {
    title: 'Approved external link',
    description: 'Inspect a destination only when it is explicitly allowed.',
    wait: 'externalWaitMs',
    scroll: 'externalScrollMs',
  },
];
export default function SchedulesPage({ snapshot, run, busy }: PageProps) {
  const [schedule, setSchedule] = useState({ ...snapshot.settings.schedule });
  const [timings, setTimings] = useState({ ...snapshot.settings.timings });
  const [dailyLimit, setDailyLimit] = useState(snapshot.settings.dailyNavigationLimit);
  const totalSeconds =
    stages.reduce((total, stage) => total + timings[stage.wait] + timings[stage.scroll], 0) / 1000;
  const save = () =>
    void run(
      {
        type: 'settings',
        settings: { ...snapshot.settings, schedule, timings, dailyNavigationLimit: dailyLimit },
      },
      'Schedule and test timing settings saved.',
    );
  return (
    <div className="page-scroll">
      <SectionTitle
        eyebrow="CONTINUOUS QUALITY"
        title="Test schedules"
        subtitle="Set a deliberate monitoring cadence with clear operating limits."
        actions={
          <Button icon="check" variant="primary" disabled={busy} onClick={save}>
            Save schedule
          </Button>
        }
      />
      <div className="schedule-status">
        <div className="schedule-status-icon">
          <Icon name="clock" size={26} />
        </div>
        <div>
          <strong>
            {snapshot.scheduler.paused
              ? 'Monitoring paused'
              : snapshot.scheduler.running
                ? 'Test run in progress'
                : snapshot.settings.schedule.enabled
                  ? 'Scheduled monitoring enabled'
                  : 'One-time runs'}
          </strong>
          <p>
            {snapshot.scheduler.nextRunAt
              ? `Next eligible run: ${timeLabel(snapshot.scheduler.nextRunAt)}`
              : 'No upcoming run is currently scheduled.'}
          </p>
        </div>
        <Badge tone={snapshot.scheduler.running ? 'good' : 'neutral'}>
          {snapshot.scheduler.running ? 'Active' : 'Idle'}
        </Badge>
      </div>
      <div className="two-column">
        <section className="surface">
          <div className="surface-heading">
            <h2>Monitoring cadence</h2>
            <Icon name="clock" />
          </div>
          <Toggle
            label="Repeat authorized test runs"
            hint="Save this option, then Start a reviewed queue to choose the recurring URLs."
            checked={schedule.enabled}
            onChange={(enabled) => setSchedule({ ...schedule, enabled })}
          />
          <p className="muted small-text">
            New assignments wait for Start. Clear pending and Stop all disable saved recurrence, including
            recovery after restart.
          </p>
          <div className="form-grid">
            <Field label="Interval (minutes)" hint="Minimum 1 minute between cycles; the default is 30.">
              <input
                type="number"
                min="1"
                max="10080"
                value={schedule.intervalMinutes}
                onChange={(e) => setSchedule({ ...schedule, intervalMinutes: Number(e.target.value) })}
              />
            </Field>
            <Field label="Daily navigation limit" hint="Per host; attempts count and reset at 00:00 UTC.">
              <input
                type="number"
                min="1"
                max="10000"
                value={dailyLimit}
                onChange={(e) => setDailyLimit(Number(e.target.value))}
              />
            </Field>
            <Field label="Operating window starts">
              <select
                value={schedule.startHour}
                onChange={(e) => setSchedule({ ...schedule, startHour: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option value={hour} key={hour}>
                    {String(hour).padStart(2, '0')}:00
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Operating window ends">
              <select
                value={schedule.endHour}
                onChange={(e) => setSchedule({ ...schedule, endHour: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }, (_, i) => i + 1).map((hour) => (
                  <option value={hour} key={hour}>
                    {hour === 24 ? '24:00 (end of day)' : `${String(hour).padStart(2, '0')}:00`}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="muted small-text">
            Operating times use this computer’s local timezone:{' '}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}.
          </p>
          <Toggle
            label="Resume eligible work after restart"
            hint="Restores previously started recurring URLs after an interrupted app session."
            checked={schedule.resumeAfterRestart}
            onChange={(resumeAfterRestart) => setSchedule({ ...schedule, resumeAfterRestart })}
          />
          <div className="form-actions">
            <Button
              icon="play"
              onClick={() =>
                void run({ type: 'global', action: snapshot.scheduler.paused ? 'resume' : 'start' })
              }
            >
              {snapshot.scheduler.paused ? 'Resume monitoring' : 'Run queued tests now'}
            </Button>
            <Button icon="stop" variant="danger" onClick={() => void run({ type: 'global', action: 'stop' })}>
              Emergency stop
            </Button>
          </div>
        </section>
        <section className="surface">
          <div className="surface-heading">
            <h2>Test sequence</h2>
            <Badge tone="accent">{totalSeconds}s configured</Badge>
          </div>
          <div className="test-stages">
            {stages.map((stage, index) => (
              <div className="test-stage" key={stage.title}>
                <span className="stage-marker">{String.fromCharCode(65 + index)}</span>
                <div className="stage-content">
                  <h3>{stage.title}</h3>
                  <p>{stage.description}</p>
                  <div className="form-grid">
                    <Field label="Initial wait (seconds)">
                      <input
                        type="number"
                        min="0"
                        max="3600"
                        value={timings[stage.wait] / 1000}
                        onChange={(e) =>
                          setTimings({ ...timings, [stage.wait]: Number(e.target.value) * 1000 })
                        }
                      />
                    </Field>
                    <Field label="Scroll duration (seconds)">
                      <input
                        type="number"
                        min="0"
                        max="3600"
                        value={timings[stage.scroll] / 1000}
                        onChange={(e) =>
                          setTimings({ ...timings, [stage.scroll]: Number(e.target.value) * 1000 })
                        }
                      />
                    </Field>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="form-grid">
            <Field label="Navigation timeout (seconds)">
              <input
                type="number"
                min="1"
                max="180"
                value={timings.navigationTimeoutMs / 1000}
                onChange={(e) =>
                  setTimings({ ...timings, navigationTimeoutMs: Number(e.target.value) * 1000 })
                }
              />
            </Field>
            <Field label="Maximum scroll distance (px)">
              <input
                type="number"
                min="0"
                max="100000"
                value={timings.maxScrollPx}
                onChange={(e) => setTimings({ ...timings, maxScrollPx: Number(e.target.value) })}
              />
            </Field>
          </div>
          <p className="muted small-text">
            Configured time excludes navigation, retries, and queueing. Missing or unapproved links are
            skipped and logged.
          </p>
        </section>
      </div>
      <div className="footnote">
        <Icon name="shield" size={15} />
        <p>
          Repeated QA runs require your staging or test-ad confirmation and an approved domain scope.
          Restrictions, rate limits, and CAPTCHA challenges stop the affected test; proxy rotation does not
          bypass them.
        </p>
      </div>
    </div>
  );
}
