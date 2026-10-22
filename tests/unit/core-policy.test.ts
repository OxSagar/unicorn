import { describe, expect, it } from 'vitest';
import {
  assertApproved,
  DomainBudget,
  isApproved,
  normalizeDomain,
  normalizeUrl,
} from '../../src/main/core/scope';
import { distribute, importUrls } from '../../src/main/core/distribution';
import { canTransition, transition } from '../../src/main/core/state';

describe('authorized navigation scope', () => {
  it('normalizes protocol and host without changing query order or SPA fragments', () =>
    expect(normalizeUrl(' HTTPS://EXAMPLE.COM:443/a?b=2&a=1#route ')).toBe(
      'https://example.com/a?b=2&a=1#route',
    ));
  it('bounds the canonical URL after Unicode percent-encoding expands the input', () => {
    expect(() => normalizeUrl(`https://example.com/${'\u4e00'.repeat(1000)}`)).toThrow(/normalized URL/);
    const accepted = normalizeUrl(`https://example.com/${'\u4e00'.repeat(100)}`);
    expect(normalizeUrl(accepted)).toBe(accepted);
  });
  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,a',
    'http://example.com',
    'https://user:secret@example.com',
    'https://10.0.0.1/',
    'https://example.com/\nother',
  ])('rejects unsafe destination %s', (value) => expect(() => normalizeUrl(value)).toThrow());
  it('requires an explicit localhost fixture option', () => {
    expect(() => normalizeUrl('http://127.0.0.1:5555')).toThrow();
    expect(normalizeUrl('http://127.0.0.1:5555', { allowLocalhost: true })).toBe('http://127.0.0.1:5555/');
    expect(() => normalizeUrl('http://example.com', { allowLocalhost: true })).toThrow();
  });
  it('uses exact domains unless subdomains are explicitly authorized', () => {
    expect(isApproved('https://example.com/a', ['example.com'])).toBe(true);
    expect(isApproved('https://example.com.evil.test/a', ['example.com'])).toBe(false);
    expect(isApproved('https://www.example.com/a', ['example.com'])).toBe(false);
    expect(isApproved('https://www.example.com/a', ['*.example.com'])).toBe(true);
    expect(isApproved('https://example.com/a', ['*.example.com'])).toBe(false);
  });
  it('normalizes an IDN and trailing dot consistently', () => {
    expect(normalizeDomain('EXAMPLE.COM.')).toBe('example.com');
    expect(normalizeDomain('bücher.example')).toBe('xn--bcher-kva.example');
    expect(isApproved('https://example.com./', ['example.com'])).toBe(true);
  });
  it.each([
    '*',
    '*.com',
    'example.com/path',
    'example.com:4433',
    'https://example.com',
    'x@example.com',
    '*.127.0.0.1',
  ])('rejects malformed scope %s', (value) => expect(() => normalizeDomain(value)).toThrow());
  it('enforces scope after URL normalization', () => {
    expect(
      assertApproved('https://EXAMPLE.COM', { authorizedDomains: ['example.com'], allowLocalhost: false }),
    ).toBe('https://example.com/');
    expect(() =>
      assertApproved('https://evil.example', { authorizedDomains: ['example.com'], allowLocalhost: false }),
    ).toThrow(/scope/);
  });
});

describe('daily navigation budgets', () => {
  it('persists counts and prevents an extra request before dispatch', () => {
    const now = () => Date.UTC(2026, 9, 22);
    const budget = new DomainBudget(undefined, now);
    expect(budget.consume('https://example.com/a', 2)).toBe(1);
    budget.consume('https://example.com/b', 2);
    const reopened = new DomainBudget(budget.snapshot(), now);
    expect(() => reopened.consume('https://example.com/c', 2)).toThrow(/limit/);
    expect(reopened.consume('https://other.example/', 2)).toBe(1);
  });
  it('resets at UTC day boundary', () => {
    let now = Date.UTC(2026, 9, 22, 23, 59);
    const budget = new DomainBudget(undefined, () => now);
    budget.consume('https://example.com', 1);
    now += 120000;
    expect(budget.consume('https://example.com', 1)).toBe(0);
  });
});

describe('URL imports and distribution', () => {
  it('preserves commas in plain URL query strings', () =>
    expect(importUrls('# tests\nhttps://example.com?q=a,b\nhttps://other.example/')).toEqual([
      'https://example.com?q=a,b',
      'https://other.example/',
    ]));
  it('imports a named CSV column with proper quoting', () =>
    expect(
      importUrls('name,url\r\n"a,b","https://example.com?q=a,b"\r\nsecond,https://other.example/'),
    ).toEqual(['https://example.com?q=a,b', 'https://other.example/']));
  it('reports malformed CSV', () =>
    expect(() => importUrls('url\n"https://example.com')).toThrow(/unterminated/));
  it('distributes the same URL to every selected browser', () =>
    expect(
      distribute({ urls: ['https://example.com'], ids: [1, 2, 3], mode: 'same' }).map((job) => job.browserId),
    ).toEqual([1, 2, 3]));
  it('requires only one URL in comparison mode', () =>
    expect(() =>
      distribute({ urls: ['https://a.example', 'https://b.example'], ids: [1], mode: 'same' }),
    ).toThrow());
  it('round-robins with stable order and removes duplicate input URLs', () => {
    const jobs = distribute({
      urls: ['https://a.example', 'https://b.example', 'https://c.example', 'https://a.example'],
      ids: [1, 2],
      mode: 'round-robin',
    });
    expect(jobs.map((job) => job.browserId)).toEqual([1, 2, 1]);
    expect(jobs).toHaveLength(3);
  });
  it('balances against existing outstanding queue depth', () => {
    const existing = distribute({ urls: ['https://old.example'], ids: [1], mode: 'same' });
    expect(
      distribute({
        urls: ['https://a.example', 'https://b.example'],
        ids: [1, 2],
        mode: 'balanced',
        existing,
      }).map((job) => job.browserId),
    ).toEqual([2, 1]);
  });
  it('uses measured renderer load alongside queue depth when balancing', () => {
    expect(
      distribute({
        urls: ['https://a.example', 'https://b.example'],
        ids: [1, 2],
        mode: 'balanced',
        resourceLoads: { 1: 3, 2: 0 },
      }).map((job) => job.browserId),
    ).toEqual([2, 2]);
    expect(
      distribute({
        urls: ['https://a.example'],
        ids: [1, 2],
        mode: 'balanced',
        resourceLoads: { 1: Number.NaN, 2: -1 },
      })[0]?.browserId,
    ).toBe(1);
  });
  it('requires explicit manual targets within selected browsers', () => {
    expect(
      distribute({ urls: ['https://a.example'], ids: [1, 2], mode: 'manual', manual: { '0': 2 } })[0]
        ?.browserId,
    ).toBe(2);
    expect(() =>
      distribute({ urls: ['https://a.example'], ids: [1], mode: 'manual', manual: { '0': 2 } }),
    ).toThrow();
  });
  it('prevents accidental repeat imports across browsers', () => {
    const existing = distribute({ urls: ['https://a.example'], ids: [1], mode: 'same' });
    expect(distribute({ urls: ['https://a.example'], ids: [2], mode: 'round-robin', existing })).toEqual([]);
    expect(
      distribute({
        urls: ['https://a.example'],
        ids: [2],
        mode: 'round-robin',
        existing,
        allowDuplicates: true,
      }),
    ).toHaveLength(1);
  });
  it('rejects invalid IDs and unsafe URLs before any job is returned', () => {
    expect(() => distribute({ urls: ['https://a.example'], ids: [21], mode: 'same' })).toThrow();
    expect(() =>
      distribute({ urls: ['https://a.example', 'file:///test'], ids: [1], mode: 'round-robin' }),
    ).toThrow();
  });
});

describe('browser state machine', () => {
  it('does not navigate before proxy preparation', () => {
    expect(canTransition('CREATED', 'NAVIGATING')).toBe(false);
    expect(canTransition('WAITING_FOR_PROXY', 'NAVIGATING')).toBe(false);
    expect(() => transition('ASSIGNING_PROXY', 'NAVIGATING')).toThrow();
  });
  it('allows prepared navigation and bounded recovery transitions', () => {
    expect(transition('ASSIGNING_PROXY', 'READY')).toBe('READY');
    expect(transition('READY', 'NAVIGATING')).toBe('NAVIGATING');
    expect(transition('RUNNING', 'PROXY_FAILED')).toBe('PROXY_FAILED');
    expect(transition('PROXY_FAILED', 'RETRY_WAIT')).toBe('RETRY_WAIT');
    expect(transition('RETRY_WAIT', 'WAITING_FOR_PROXY')).toBe('WAITING_FOR_PROXY');
  });
});
