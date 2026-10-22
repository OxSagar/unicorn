/** Bounded wildcard matching without regex backtracking or executable patterns. */
export function isExcludedLink(url: string, patterns: readonly string[]): boolean {
  const text = url.toLowerCase();
  return patterns.some((raw) => {
    const pattern = raw.toLowerCase();
    let input = 0;
    let token = 0;
    let star = -1;
    let retry = 0;
    while (input < text.length) {
      if (pattern[token] === '?' || pattern[token] === text[input]) {
        input++;
        token++;
      } else if (pattern[token] === '*') {
        star = token++;
        retry = input;
      } else if (star >= 0) {
        token = star + 1;
        input = ++retry;
      } else return false;
    }
    while (pattern[token] === '*') token++;
    return token === pattern.length;
  });
}
