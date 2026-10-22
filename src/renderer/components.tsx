import { cloneElement, isValidElement, useId } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type IconName =
  | 'grid'
  | 'browser'
  | 'link'
  | 'shield'
  | 'device'
  | 'clock'
  | 'logs'
  | 'chart'
  | 'settings'
  | 'play'
  | 'pause'
  | 'stop'
  | 'back'
  | 'forward'
  | 'reload'
  | 'expand'
  | 'close'
  | 'check'
  | 'download'
  | 'upload'
  | 'plus'
  | 'arrow'
  | 'terminal'
  | 'globe'
  | 'chevron'
  | 'sun'
  | 'moon'
  | 'info';
const paths: Record<IconName, ReactNode> = {
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  browser: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  device: (
    <>
      <rect x="3" y="4" width="12" height="13" rx="2" />
      <path d="M6 21h6M9 17v4" />
      <rect x="16" y="9" width="6" height="12" rx="1.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  logs: (
    <>
      <path d="M8 4h12M8 9h12M8 14h12M8 19h12M3 4h.01M3 9h.01M3 14h.01M3 19h.01" />
    </>
  ),
  chart: (
    <>
      <path d="M3 3v18h18M7 16v-5M12 16V7M17 16V4" />
    </>
  ),
  settings: (
    <>
      <path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  play: <path d="m8 4 12 8-12 8z" />,
  pause: (
    <>
      <path d="M8 5v14M16 5v14" />
    </>
  ),
  stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
  back: <path d="m14 6-6 6 6 6M8 12h12" />,
  forward: <path d="m10 6 6 6-6 6M16 12H4" />,
  reload: (
    <>
      <path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5" />
    </>
  ),
  expand: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  check: <path d="m5 12 4 4L19 6" />,
  download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
  upload: <path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5" />,
  plus: <path d="M12 4v16M4 12h16" />,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  terminal: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 8 4 4-4 4M14 16h3" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  chevron: <path d="m7 10 5 5 5-5" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1" />
    </>
  ),
  moon: <path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
};
export function Icon({
  name,
  size = 18,
  className = '',
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
export function Brand({ small = false }: { small?: boolean }) {
  return (
    <div className={`brand ${small ? 'small' : ''}`}>
      <svg viewBox="0 0 40 40" width="38" height="38" aria-hidden="true">
        <defs>
          <linearGradient id="brand-gradient" x1="0" y1="0" x2="1" y2="1">
            <stop stopColor="#a793ff" />
            <stop offset="1" stopColor="#6156f5" />
          </linearGradient>
        </defs>
        <rect width="40" height="40" rx="12" fill="url(#brand-gradient)" />
        <path d="m25 8-4 10 8 5-4 9H13l-3-9 7-8 2 6 3-3z" fill="white" />
        <circle cx="23" cy="23" r="1.1" fill="#7460ef" />
      </svg>
      {!small && (
        <div>
          <strong>
            unicorn<span>●</span>
          </strong>
          <small>BROWSER WORKSPACE</small>
        </div>
      )}
    </div>
  );
}
export function Button({
  children,
  icon,
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: IconName;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  children?: ReactNode;
}) {
  return (
    <button type="button" className={`button ${variant} ${className}`} {...props}>
      {icon && <Icon name={icon} size={16} />} {children}
    </button>
  );
}
export function IconButton({
  icon,
  label,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: IconName; label: string }) {
  return (
    <button type="button" className="icon-button" title={label} aria-label={label} {...props}>
      <Icon name={icon} size={16} />
    </button>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'good' | 'warn' | 'bad' | 'accent' | 'neutral';
}) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
export function Status({ state }: { state: string }) {
  const tone = ['RUNNING', 'READY', 'COMPLETED', 'available', 'completed'].includes(state)
    ? 'good'
    : ['ERROR', 'PROXY_FAILED', 'failed'].includes(state)
      ? 'bad'
      : ['PAUSED', 'WAITING_FOR_PROXY', 'RETRY_WAIT', 'unverified'].includes(state)
        ? 'warn'
        : ['NAVIGATING', 'VALIDATING_PROXY', 'assigned', 'validating', 'running'].includes(state)
          ? 'accent'
          : 'neutral';
  return (
    <Badge tone={tone}>
      <i className="status-dot" />
      {state.replaceAll('_', ' ').toLowerCase()}
    </Badge>
  );
}
export function SectionTitle({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle: string;
  actions?: ReactNode;
}) {
  return (
    <header className="section-heading">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {actions && <div className="heading-actions">{actions}</div>}
    </header>
  );
}
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const labelId = useId();
  const hintId = useId();
  const control = isValidElement<{ 'aria-labelledby'?: string; 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { 'aria-labelledby': labelId, 'aria-describedby': hint ? hintId : undefined })
    : children;
  return (
    <label className="field">
      <span id={labelId}>{label}</span>
      {control}
      {hint && <small id={hintId}>{hint}</small>}
    </label>
  );
}
export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="toggle-row">
      <div>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </div>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true" />
    </label>
  );
}
export function EmptyState({
  icon = 'browser',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={27} />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Metric({
  label,
  value,
  note,
  icon,
  tone = '',
}: {
  label: string;
  value: string | number;
  note?: string;
  icon: IconName;
  tone?: string;
}) {
  return (
    <div className={`metric ${tone}`}>
      <div className="metric-heading">
        <span>{label}</span>
        <Icon name={icon} />
      </div>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}
export const formatBytes = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : bytes < 1024 ** 3
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
export const timeLabel = (value: number | null | undefined) =>
  value ? new Date(value).toLocaleString() : 'Not yet';
export const duration = (ms: number) => `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s`;
