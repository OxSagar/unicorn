const RETRYABLE_TRANSPORT_CODES = new Set([
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',
  'ERR_SOCKS_CONNECTION_FAILED',
]);

/** Electron loadURL failures expose a Chromium code; policy and page failures never qualify. */
export function isRetryableTransportError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string')
    return RETRYABLE_TRANSPORT_CODES.has(error.code);
  const message = error instanceof Error ? error.message : String(error);
  const code = /^(?:net::)?(ERR_[A-Z_]+)(?=\s|\(|:|$)/.exec(message)?.[1];
  return code !== undefined && RETRYABLE_TRANSPORT_CODES.has(code);
}
