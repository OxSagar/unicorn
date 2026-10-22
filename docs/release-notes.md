# Unicorn 1.0.0-rc.1

Unicorn is a Windows desktop workspace for up to 20 independent Chromium sessions, device compatibility testing, verified proxy allocation, and authorized website QA.

## Included

Persistent profiles; native browser grid and focused inspection; desktop/mobile/tablet/custom device emulation; ProxyScrape HTTP CONNECT and SOCKS5 proxy ingestion; US/GB/CA/FR/DE/JP/IT filtering; live HTTPS exit verification; atomic endpoint and exit-IP allocation; URL import/distribution; scoped QA stages; scheduling and daily navigation budgets; pause/resume/emergency stop; managed popups; local logs/results; resource monitoring; tray and login controls.

## Installation

Download the x64 installer or portable ZIP and `SHA256SUMS.txt` from this release. Compare the downloaded file's SHA-256 hash before launching. The portable ZIP contains the full application directory; extract it before running `Unicorn.exe`.

Windows 10/11 x64 is targeted. Start with 16 GB RAM, an SSD, and a modern 8-core processor for larger grids, and measure your own workload. The app embeds Chromium; it is not the separately installed Google Chrome product.

## Verification boundary

Publication of these assets is gated by the exact commit's Windows Electron tests, installer/ZIP construction, packaged application launch, installed application launch, and asset checksums. Detailed logs and evidence are attached to the associated GitHub Actions run. Source-only checks do not count as Windows verification.

## Known limitations

- This is an evaluation release candidate, not a fully accepted production v1.0.0.
- A 24-hour soak test, Windows 10/11 consumer hardware comparison, and independent packet-level DNS/WebRTC audit have not been completed for this candidate.
- Public proxy availability and geography are not guaranteed. Sessions wait without connecting directly when validation cannot succeed.
- Proxy enforcement is application-level. It is not an OS firewall. HTTP/HTTPS/WebSocket behavior is tested through controlled proxies; UDP-related features are restricted.
- Browser site permissions are denied by default. Chrome account synchronization, Chrome extension-store integration, proprietary Chrome features, authenticated proxies, SOCKS4, automatic application updates, and a Windows background service are not provided.
- Scheduled screenshots contain page pixels and may contain sensitive test data. They remain local and are subject to bounded retention. Console message contents are not collected by default.
- The build is unsigned unless signing credentials were supplied separately. Windows may show SmartScreen or organizational policy warnings.

No public live advertising destinations are used for automated acceptance tests. Configure approved domains and staging/test-ad environments before running QA.
