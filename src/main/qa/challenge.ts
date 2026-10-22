import type { WebContents } from 'electron';
import { withDeadline } from '../browser/deadline';

export const CHALLENGE_MESSAGE = 'Challenge detected; testing requires manual review';

export interface ChallengeSignals {
  title: string;
  widget: boolean;
  frames: string[];
}

/** Recognize explicit access controls, without interpreting general page text or interacting with them. */
export function hasKnownChallenge(signals: ChallengeSignals): boolean {
  const title = signals.title.trim().replace(/\s+/g, ' ');
  if (
    /^(?:just a moment[.!…]*|attention required[.!…]*(?:\s*\|\s*cloudflare)?|verify (?:that )?you are human[.!…]*|checking your browser[.!…]*|security (?:check|verification)[.!…]*|captcha(?: challenge| verification)?[.!…]*|access denied[.!…]*|robot check[.!…]*|sorry, you have been blocked[.!…]*)$/i.test(
      title,
    )
  )
    return true;
  if (signals.widget) return true;
  return signals.frames.some((source) => {
    try {
      const url = new URL(source);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
      const host = url.hostname.toLowerCase();
      const onHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
      return (
        ((onHost('google.com') || onHost('recaptcha.net')) &&
          /^\/recaptcha\/(?:api2|enterprise)\/(?:anchor|bframe)(?:\/|$)/.test(url.pathname)) ||
        (onHost('hcaptcha.com') && /^\/captcha\//.test(url.pathname)) ||
        (host === 'challenges.cloudflare.com' && /^\/cdn-cgi\/challenge-platform\//.test(url.pathname)) ||
        (host === 'challenges.cloudflare.com' && /^\/turnstile\//.test(url.pathname))
      );
    } catch {
      return false;
    }
  });
}

export async function detectChallenge(contents: WebContents, signal: AbortSignal): Promise<boolean> {
  signal.throwIfAborted();
  const signals = await withDeadline(
    contents.executeJavaScriptInIsolatedWorld(711, [
      {
        code: `(() => {
          const visible = element => {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            for (let current = element; current; current = current.parentElement) {
              const style = getComputedStyle(current);
              if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
            }
            return true;
          };
          const widgets = document.querySelectorAll('.g-recaptcha[data-sitekey], .h-captcha[data-sitekey], .cf-turnstile[data-sitekey]');
          return {
            title: document.title.slice(0, 500),
            widget: Array.from(widgets).slice(0, 200).some(visible),
            frames: Array.from(document.querySelectorAll('iframe[src]')).slice(0, 200).filter(visible).map(frame => frame.src.slice(0, 4096))
          };
        })()`,
      },
    ]) as Promise<ChallengeSignals>,
    8000,
    signal,
  );
  signal.throwIfAborted();
  return hasKnownChallenge(signals);
}
