/** Main-process metadata keeps an access restriction tied to the destination that returned it. */
export class SiteRestrictionError extends Error {
  readonly restrictedHost: string;

  constructor(message: string, url: string) {
    super(message);
    this.name = 'SiteRestrictionError';
    this.restrictedHost = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  }
}
