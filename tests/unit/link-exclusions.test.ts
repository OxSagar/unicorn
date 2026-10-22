import { describe, expect, it } from 'vitest';
import { isExcludedLink } from '../../src/main/core/link-exclusions';

describe('user link exclusions', () => {
  it.each([
    ['https://staging.example.com/logout', ['*logout*'], true],
    ['https://staging.example.com/LOGOUT?source=qa', ['*logout*'], true],
    ['https://staging.example.com/account/delete', ['https://staging.example.com/account/*'], true],
    ['https://staging.example.com/page1', ['*/page?'], true],
    ['https://staging.example.com/page12', ['*/page?'], false],
    ['https://staging.example.com/', ['*logout*'], false],
    ['https://staging.example.com/search?q=(a+)+', ['*(a+)+'], true],
    ['https://staging.example.com/', [], false],
    ['https://staging.example.com/', ['*'], true],
    ['https://staging.example.com/a/b/c', ['*a*b*d', '*a*b*c'], true],
  ] as const)('matches %s against %j', (url, patterns, expected) => {
    expect(isExcludedLink(url, patterns)).toBe(expected);
  });
  it('handles long hostile-looking patterns as literal bounded text', () => {
    expect(isExcludedLink(`https://example.com/${'a'.repeat(8000)}`, ['*a*a*a*b'])).toBe(false);
    expect(isExcludedLink('https://example.com/a', ['(.*)+$'])).toBe(false);
  });
});
