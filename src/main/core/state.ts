import type { BrowserState } from '../../shared/types';
const transitions: Record<BrowserState, readonly BrowserState[]> = {
  CREATED: ['WAITING_FOR_PROXY', 'STOPPED', 'ERROR'],
  WAITING_FOR_PROXY: ['VALIDATING_PROXY', 'RETRY_WAIT', 'PAUSED', 'PROXY_FAILED', 'STOPPED', 'ERROR'],
  VALIDATING_PROXY: ['READY', 'WAITING_FOR_PROXY', 'PROXY_FAILED', 'PAUSED', 'STOPPED', 'ERROR'],
  READY: [
    'NAVIGATING',
    'RUNNING',
    'COMPLETED',
    'WAITING_FOR_PROXY',
    'PAUSED',
    'PROXY_FAILED',
    'STOPPED',
    'ERROR',
  ],
  NAVIGATING: ['RUNNING', 'READY', 'COMPLETED', 'PAUSED', 'PROXY_FAILED', 'RETRY_WAIT', 'STOPPED', 'ERROR'],
  RUNNING: [
    'NAVIGATING',
    'READY',
    'WAITING_FOR_PROXY',
    'COMPLETED',
    'PAUSED',
    'PROXY_FAILED',
    'RETRY_WAIT',
    'STOPPED',
    'ERROR',
  ],
  COMPLETED: ['WAITING_FOR_PROXY', 'NAVIGATING', 'READY', 'PAUSED', 'STOPPED', 'ERROR'],
  PAUSED: [
    'WAITING_FOR_PROXY',
    'VALIDATING_PROXY',
    'READY',
    'NAVIGATING',
    'RUNNING',
    'COMPLETED',
    'PROXY_FAILED',
    'RETRY_WAIT',
    'STOPPED',
    'ERROR',
  ],
  PROXY_FAILED: ['RETRY_WAIT', 'WAITING_FOR_PROXY', 'PAUSED', 'STOPPED', 'ERROR'],
  RETRY_WAIT: ['WAITING_FOR_PROXY', 'VALIDATING_PROXY', 'PAUSED', 'PROXY_FAILED', 'STOPPED', 'ERROR'],
  STOPPED: ['WAITING_FOR_PROXY', 'CREATED', 'ERROR'],
  ERROR: ['WAITING_FOR_PROXY', 'CREATED', 'STOPPED'],
};
export function canTransition(from: BrowserState, to: BrowserState): boolean {
  return from === to || transitions[from]?.includes(to) === true;
}
export function transition(from: BrowserState, to: BrowserState): BrowserState {
  if (!canTransition(from, to)) throw new Error(`Invalid browser state transition: ${from} → ${to}`);
  return to;
}
