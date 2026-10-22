import type { WebContents } from 'electron';
import type { AppSettings } from '../../shared/types';
import { assertApproved } from '../core/scope';
import { isExcludedLink } from '../core/link-exclusions';
import { RunControl } from './control';
import { withDeadline } from '../browser/deadline';

export interface QaHooks {
  contents: WebContents;
  settings: () => AppSettings;
  control: RunControl;
  navigate(url: string): Promise<void>;
  checkChallenge(): Promise<void>;
  stage(name: string): void;
  capture(stage: string): Promise<void>;
  log(message: string): void;
}

async function links(contents: WebContents, signal: AbortSignal): Promise<string[]> {
  return withDeadline(
    contents.executeJavaScriptInIsolatedWorld(711, [
      {
        code: `Array.from(document.querySelectorAll('a[href]')).filter(a => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !a.closest('[data-ad], [data-ad-slot], [data-sponsored], .advertisement, .adsbygoogle, [aria-label="Advertisement"]') && !/(^|\\s)(sponsored|nofollow)(\\s|$)/i.test(a.rel) && !a.hasAttribute('download'); }).map(a => a.href).slice(0, 500)`,
      },
    ]) as Promise<string[]>,
    8000,
    signal,
  );
}

async function scroll(hooks: QaHooks, durationMs: number): Promise<void> {
  const steps = Math.max(1, Math.ceil(durationMs / 200));
  const url = hooks.contents.getURL();
  for (let step = 0; step < steps && durationMs > 0; step++) {
    await hooks.control.checkpoint();
    if (step % 5 === 0) await hooks.checkChallenge();
    if (hooks.contents.isDestroyed() || hooks.contents.getURL() !== url)
      throw new Error('Page changed during scroll inspection');
    const progress = step / Math.max(1, steps - 1);
    const ratio = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
    const max = Math.max(0, hooks.settings().timings.maxScrollPx);
    await withDeadline(
      hooks.contents.executeJavaScriptInIsolatedWorld(711, [
        {
          code: `(() => { const candidates = [document.scrollingElement, ...document.querySelectorAll('main, article, [role="main"], div')].filter(e => e && e.scrollHeight > e.clientHeight + 100).slice(0, 150); const element = candidates.sort((a,b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] || document.scrollingElement; if (element) element.scrollTo({ top: Math.min(${max}, element.scrollHeight-element.clientHeight) * ${ratio}, behavior: 'smooth' }); })()`,
        },
      ]),
      8000,
      hooks.control.signal,
    );
    await hooks.control.wait(durationMs / steps);
  }
}

async function inspect(hooks: QaHooks, stage: string, waitMs: number, scrollMs: number): Promise<void> {
  hooks.stage(`${stage}: initialization`);
  await hooks.checkChallenge();
  for (let remaining = waitMs; remaining > 0; remaining -= 1000) {
    await hooks.control.wait(Math.min(remaining, 1000));
    await hooks.checkChallenge();
  }
  hooks.stage(`${stage}: scroll inspection`);
  await scroll(hooks, scrollMs);
  await hooks.checkChallenge();
  await hooks.capture(stage);
}

export async function runStages(initialUrl: string, hooks: QaHooks): Promise<void> {
  const settings = hooks.settings();
  if (!settings.stagingConfirmed)
    throw new Error('Confirm an authorized staging or test-ad environment before automated QA');
  const initial = assertApproved(initialUrl, settings);
  if (isExcludedLink(initial, settings.excludedLinkPatterns))
    throw new Error('The starting URL matches an excluded QA link pattern');
  const origin = new URL(initial).origin;
  hooks.stage('Landing page: navigation');
  await hooks.navigate(initial);
  await inspect(hooks, 'Landing page', settings.timings.landingWaitMs, settings.timings.landingScrollMs);
  const firstLinks = await links(hooks.contents, hooks.control.signal);
  const internal = firstLinks.find((candidate) => {
    try {
      const target = assertApproved(candidate, settings);
      if (isExcludedLink(target, settings.excludedLinkPatterns)) return false;
      return new URL(target).origin === origin && target.split('#')[0] !== initial.split('#')[0];
    } catch {
      return false;
    }
  });
  if (internal) {
    hooks.stage('Internal link: navigation');
    await hooks.navigate(internal);
    await inspect(hooks, 'Internal link', settings.timings.internalWaitMs, settings.timings.internalScrollMs);
  } else hooks.log('Internal-link stage skipped: no eligible link in the authorized origin');
  const current = new URL(hooks.contents.getURL()).origin;
  const candidates = await links(hooks.contents, hooks.control.signal);
  let external: string | undefined;
  for (const candidate of candidates) {
    try {
      if (new URL(candidate).origin === current) continue;
      const target = assertApproved(candidate, settings);
      if (isExcludedLink(target, settings.excludedLinkPatterns)) {
        hooks.log('External-link destination skipped because it matches an exclusion pattern');
        continue;
      }
      external = target;
      break;
    } catch {
      hooks.log('External-link destination skipped because it is outside the approved scope');
    }
  }
  if (external) {
    hooks.stage('External link: navigation');
    await hooks.navigate(external);
    await inspect(hooks, 'External link', settings.timings.externalWaitMs, settings.timings.externalScrollMs);
  } else hooks.log('External-link stage skipped: no explicitly approved external destination');
  hooks.stage('Complete');
}
