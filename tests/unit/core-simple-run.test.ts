import { describe, expect, it } from 'vitest';
import { prepareSimpleDistribution, simpleRunSettings } from '../../src/main/core/simple-run';
import { validateCommand } from '../../src/main/core/validation';
import { assertApproved } from '../../src/main/core/scope';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

describe('minimal reviewed distribution', () => {
  it('assigns one normalized URL to every explicitly selected browser', () => {
    const plan = prepareSimpleDistribution('https://EXAMPLE.com:443/\nhttps://example.com/', 20);
    expect(plan.urls).toEqual(['https://example.com/']);
    expect(plan.domains).toEqual(['example.com']);
    expect(plan.jobs).toHaveLength(20);
    expect(new Set(plan.jobs.map((job) => job.browserId)).size).toBe(20);
    expect(new Set(plan.jobs.map((job) => job.id)).size).toBe(20);
  });

  it('cycles fewer links to fill the selected browsers and queues excess links once', () => {
    const links = ['https://example.com/a', 'https://example.com/b'];
    expect(
      prepareSimpleDistribution(links.join('\n'), 5).jobs.map(({ browserId, url }) => [browserId, url]),
    ).toEqual([
      [1, links[0]],
      [2, links[1]],
      [3, links[0]],
      [4, links[1]],
      [5, links[0]],
    ]);
    const more = [...links, 'https://example.com/c', 'https://example.com/d', 'https://example.com/e'];
    expect(
      prepareSimpleDistribution(more.join('\n'), 2).jobs.map(({ browserId, url }) => [browserId, url]),
    ).toEqual(more.map((url, index) => [(index % 2) + 1, url]));
  });

  it.each([
    '',
    'http://example.com/',
    'https://user:pass@example.com/',
    'https://127.0.0.1/',
    'https://2130706433/',
    'https://0x7f000001/',
    'https://[::ffff:127.0.0.1]/',
    'https://good.example/\nhttps://10.0.0.1/',
    'https://example.com/\u0000',
    'https://*.example.com/',
    'https://%2a.example.com/',
  ])('rejects the complete preparation if any pasted destination is unsafe: %s', (text) =>
    expect(() => prepareSimpleDistribution(text, 1)).toThrow(),
  );

  it('keeps loopback an explicit existing fixture policy and creates no wildcard permission', () => {
    const plan = prepareSimpleDistribution('http://localhost:9000/\nhttps://sub.example.com/', 2, true);
    expect(plan.domains).toEqual(['localhost', 'sub.example.com']);
    const settings = simpleRunSettings(DEFAULT_SETTINGS, plan.domains);
    expect(() => assertApproved('https://deep.sub.example.com/', settings)).toThrow();
    expect(() => assertApproved('https://example.com/', settings)).toThrow();
    expect(() => assertApproved('https://sub.example.com.evil.test/', settings)).toThrow();
    expect(() => assertApproved('https://sub.example.com/', settings)).not.toThrow();
  });

  it('bounds the text, selected count, exact hosts, and executable batch independently', () => {
    expect(() => prepareSimpleDistribution(' '.repeat(2_000_001), 1)).toThrow(/characters/);
    for (const count of [0, 21, 1.5, Infinity])
      expect(() => prepareSimpleDistribution('https://example.com/', count)).toThrow();
    expect(() =>
      prepareSimpleDistribution(
        Array.from({ length: 1001 }, (_, n) => `https://example.com/${n}`).join('\n'),
        20,
      ),
    ).toThrow(/1,000/);
    expect(() =>
      prepareSimpleDistribution(
        Array.from({ length: 201 }, (_, n) => `https://host${n}.example/`).join('\n'),
        20,
      ),
    ).toThrow(/200/);
    expect(
      prepareSimpleDistribution(
        Array.from({ length: 1000 }, (_, n) => `https://example.com/${n}`).join('\n'),
        20,
      ).jobs,
    ).toHaveLength(1000);
  });

  it('uses real fixed defaults while keeping stricter limits and saved preferences independent', () => {
    const saved = structuredClone(DEFAULT_SETTINGS);
    saved.timings.landingWaitMs = 3_600_000;
    saved.retryLimit = 5;
    saved.dailyNavigationLimit = 2;
    saved.dailyRequestLimit = 50_000;
    saved.resourceLimitMb = 1024;
    saved.excludedLinkPatterns = ['*/logout*'];
    saved.schedule = { ...saved.schedule, enabled: true, resumeAfterRestart: true };
    saved.authorizedDomains = ['*.old.example'];
    const before = structuredClone(saved);
    const actual = simpleRunSettings(saved, ['reviewed.example']);
    expect(actual).toMatchObject({
      authorizedDomains: ['reviewed.example'],
      stagingConfirmed: true,
      retryLimit: 2,
      dailyNavigationLimit: 2,
      dailyRequestLimit: 10000,
      resourceLimitMb: 1024,
      excludedLinkPatterns: ['*/logout*'],
      closePopupsAfterRun: true,
      schedule: { enabled: false, resumeAfterRestart: false },
    });
    expect(actual.timings).toEqual(DEFAULT_SETTINGS.timings);
    actual.excludedLinkPatterns.push('other');
    actual.timings.landingWaitMs = 1;
    expect(saved).toEqual(before);
    expect(DEFAULT_SETTINGS.timings.landingWaitMs).toBe(20000);
  });

  it('validates only the final minimal command contract and requires literal consent', () => {
    const distribute = {
      type: 'simple-distribute',
      text: 'https://example.com/a\nhttps://example.com/b',
      count: 3,
      device: 'mobile',
    };
    expect(validateCommand(distribute)).toEqual(distribute);
    expect(validateCommand({ type: 'simple-start', reviewId: 'review', confirmed: true })).toEqual({
      type: 'simple-start',
      reviewId: 'review',
      confirmed: true,
    });
    for (const override of [
      { count: 21 },
      { device: 'custom' },
      { count: undefined },
      { text: ' '.repeat(2_000_001) },
      { domains: ['*'] },
    ])
      expect(() => validateCommand({ ...distribute, ...override })).toThrow();
    for (const confirmed of [false, undefined, 'true', 1])
      expect(() => validateCommand({ type: 'simple-start', reviewId: 'review', confirmed })).toThrow();
    expect(() =>
      validateCommand({ type: 'simple-start', reviewId: 'review', confirmed: true, domains: ['*'] }),
    ).toThrow();
  });
});
