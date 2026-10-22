/** Bound remote-renderer work even if an untrusted page stops its own event loop. */
export function withDeadline<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(signal?.reason ?? new Error('Browser operation cancelled'));
    const timer = setTimeout(
      () => finish(new Error(`Browser operation timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    signal?.addEventListener('abort', abort, { once: true });
    work.then(
      (value) => finish(undefined, value),
      (error) => finish(error),
    );
    if (signal?.aborted) abort();
  });
}
