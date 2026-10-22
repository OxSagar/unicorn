import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebContents } from 'electron';
import { CHALLENGE_MESSAGE, detectChallenge, hasKnownChallenge } from '../../src/main/qa/challenge';
import { isRetryableTransportError } from '../../src/main/network/transport-error';
import { runStages, type QaHooks } from '../../src/main/qa/stages';
import { RunControl } from '../../src/main/qa/control';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

afterEach(() => vi.useRealTimers());

describe('known challenge detection', () => {
  it.each(['Just a moment...', 'Attention Required! | Cloudflare', 'Verify you are human', 'Access denied'])(
    'recognizes the challenge title %s',
    (title) => expect(hasKnownChallenge({ title, widget: false, frames: [] })).toBe(true),
  );

  it.each([
    'CAPTCHA integration guide',
    'A moment in time',
    'Access denied troubleshooting',
    'Cloudflare docs',
  ])('does not infer a challenge from general content title %s', (title) =>
    expect(hasKnownChallenge({ title, widget: false, frames: [] })).toBe(false),
  );

  it.each([
    'https://www.google.com/recaptcha/api2/anchor?k=fixture',
    'https://www.recaptcha.net/recaptcha/enterprise/bframe?k=fixture',
    'https://newassets.hcaptcha.com/captcha/v1/fixture/static/hcaptcha.html',
    'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/fixture',
    'https://challenges.cloudflare.com/turnstile/v0/widget',
  ])('recognizes a rendered provider challenge frame at %s', (source) => {
    expect(hasKnownChallenge({ title: 'Test page', widget: false, frames: [source] })).toBe(true);
  });

  it.each([
    'https://www.google.com/recaptcha/docs/display',
    'https://google.com.attacker.invalid/recaptcha/api2/anchor',
    'https://hcaptcha.com.attacker.invalid/captcha/v1/widget',
    'https://challenges.cloudflare.com.attacker.invalid/turnstile/widget',
    'https://authorized.test/?iframe=https://www.google.com/recaptcha/api2/anchor',
    'javascript:void(0)',
  ])('does not treat an unrelated or deceptive frame URL as a provider challenge: %s', (source) => {
    expect(hasKnownChallenge({ title: 'Test page', widget: false, frames: [source] })).toBe(false);
  });

  it('recognizes an explicit rendered widget without visiting its provider', () => {
    expect(hasKnownChallenge({ title: 'Test page', widget: true, frames: [] })).toBe(true);
  });

  it('uses an isolated world and times out a renderer that cannot answer', async () => {
    vi.useFakeTimers();
    const contents = {
      executeJavaScriptInIsolatedWorld: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const rejection = expect(
      detectChallenge(contents as unknown as WebContents, new AbortController().signal),
    ).rejects.toThrow('timed out after 8000 ms');
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(711, expect.any(Array));
    await vi.advanceTimersByTimeAsync(8000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks during dwell and stops before scrolling, capturing or following links', async () => {
    vi.useFakeTimers();
    const contents = { executeJavaScriptInIsolatedWorld: vi.fn() };
    let checks = 0;
    const hooks: QaHooks = {
      contents: contents as unknown as WebContents,
      settings: () => ({
        ...structuredClone(DEFAULT_SETTINGS),
        stagingConfirmed: true,
        authorizedDomains: ['authorized.test'],
        timings: { ...DEFAULT_SETTINGS.timings, landingWaitMs: 3000 },
      }),
      control: new RunControl(new AbortController().signal),
      navigate: vi.fn(async () => undefined),
      checkChallenge: vi.fn(async () => {
        if (++checks > 1) throw new Error(CHALLENGE_MESSAGE);
      }),
      stage: vi.fn(),
      capture: vi.fn(async () => undefined),
      log: vi.fn(),
    };
    const rejection = expect(runStages('https://authorized.test/', hooks)).rejects.toThrow(CHALLENGE_MESSAGE);
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(hooks.navigate).toHaveBeenCalledTimes(1);
    expect(hooks.capture).not.toHaveBeenCalled();
    expect(contents.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('transport retry boundary', () => {
  it.each([
    'ERR_PROXY_CONNECTION_FAILED',
    'ERR_CONNECTION_RESET',
    'ERR_TIMED_OUT',
    'ERR_SOCKS_CONNECTION_FAILED',
  ])('permits the recognized Chromium transport code %s', (code) => {
    expect(isRetryableTransportError(Object.assign(new Error('load failed'), { code }))).toBe(true);
    expect(isRetryableTransportError(new Error(`${code} (-1) loading 'https://authorized.test/'`))).toBe(
      true,
    );
  });

  it.each([
    CHALLENGE_MESSAGE,
    'HTTP 403: testing paused',
    'HTTP 429: rate limited',
    'ERR_CERT_AUTHORITY_INVALID (-202)',
    'ERR_SSL_PROTOCOL_ERROR (-107)',
    'ERR_PROXY_AUTH_REQUESTED (-127)',
    'ERR_ABORTED (-3)',
    'Navigation timed out after 6000 ms',
    "Navigation failed loading 'https://authorized.test/ERR_CONNECTION_RESET'",
    'ERR_CONNECTION_RESET_BY_POLICY',
  ])('does not retry access restrictions, certificate failures or unrecognized errors: %s', (message) => {
    expect(isRetryableTransportError(new Error(message))).toBe(false);
  });
});
