# Proxy source and allocation contract

Unicorn v1 uses only the ProxyScrape public API for automatically retrieved proxy endpoints. Metadata is a candidate filter, never proof that a proxy is currently working. An assigned proxy must additionally pass the Electron networking validator through its configured session.

## Verified provider schema

The provider's documentation describes `GET https://api.proxyscrape.com/v4/free-proxy-list/get`, comma-separated ISO country filtering, a maximum page size of 2,000, and `http`, `socks4`, and `socks5` protocol values. The documentation labels requests `getproxies` and `displayproxies`. The provider's own actively maintained mirror updater uses the underscored request `get_proxies`, `proxy_format=protocolipport`, and `format=json`; Unicorn uses that concrete JSON contract.

The live envelope has a `proxies` array and a `nextpage` flag. Each record has `ip`, `port`, `protocol`, and geographic metadata under `ip_data.countryCode`. The official flattened mirror instead exposes `country_code`. The parser supports both shapes so deterministic tests can use small fixtures. It rejects unexpected envelopes and unsupported records; it does not fall back to unverified plaintext lists.

Provider sources checked on 22 October 2026:

- [ProxyScrape public API documentation](https://docs.proxyscrape.com/api-reference/public-api/get-proxy-list)
- [Official provider mirror updater](https://github.com/ProxyScrape/free-proxy-list/blob/main/scripts/update.py)
- [Official mirror JSON schema and protocol explanation](https://github.com/ProxyScrape/free-proxy-list/blob/main/README.md)

The provider's `https` download category means an HTTP proxy that supports HTTPS tunnelling (`ssl: true`). It does **not** mean a TLS-encrypted connection to the proxy itself. Unicorn preserves the actual `http` transport and requires a certificate-verified HTTPS diagnostic request through the tunnel. SOCKS4 is excluded because it is not part of the validated v1 transport set.

## Filtering and validation

Only `US`, `GB`, `CA`, `FR`, `DE`, `JP`, and `IT` pass the metadata filter. Missing geography, `UK`, unsupported transports, invalid ports, nonnumeric endpoints, and private/local proxy addresses are rejected. `source: fixture` is reserved for controlled integration tests; it is never produced by the provider parser.

The allocation validator must return an observed numeric exit IP, ISO country code, and measured nonnegative latency after an HTTPS request through the candidate. The observed country must match the eligible metadata country. Invalid certificates are errors. Provider timestamps and advertised latency are not accepted as local validation evidence.

## Atomic leases

The main process reserves an IP/port endpoint synchronously before awaiting validation. It prevents duplicate endpoints even if different protocol labels advertise the same listener. Exit-IP uniqueness is checked atomically after validation and before assignment. Refreshes preserve active and validating leases; snapshots returned to the interface are copies.

Each browser has an allocation generation. Stop or destruction increments it and cancels outstanding validation. A late validator result cannot resurrect a lease. Transport failure releases the lease and quarantines the endpoint for a bounded interval. A single acquire call examines at most 12 available candidates by default. Missing proxies produce an empty result, which the browser controller must represent as waiting with networking closed.

The pool does not rotate on a website restriction. HTTP 403, 429, authentication errors, and CAPTCHA challenges must be handled by the browser controller as access or rate-limit stops. They are not proxy health signals.

## Provider requests and data bounds

Provider retrieval is control-plane traffic, separate from browser sessions. Each request must use a timeout, a capped response body, and the configured refresh interval. A page is capped at 2,000 records. Pagination must have a finite page count and avoid a tight loop. Overlapping refreshes should share one in-flight operation. An outage retains leased endpoints, reports the fetch error, and leaves sessions without a validated endpoint waiting. It must never trigger a direct browsing fallback.

The parser caps even an imported envelope at 60,000 records; the dashboard and controller should retain a much smaller practical pool and bound validation concurrency. Real free-proxy availability, country correctness, throughput, and latency vary and cannot be guaranteed by deterministic fixture tests.

## Navigation scope and budgets

HTTPS is required except for explicitly enabled localhost fixtures. Credentials in URLs, unsafe schemes, private literal addresses, and encoded variants of those addresses are rejected before dispatch. Scope entries are exact hostnames; an explicit `*.example.com` permits its subdomains and does not permit the apex or a suffix attack such as `example.com.evil.test`.

The daily budget counts top-level navigation attempts before dispatch, including failures. It is maintained per normalized hostname and resets at the UTC date boundary. It does not describe or limit every subresource request. Browser scheduling, native redirects and popup navigation must enforce the same scope and budget policy. DNS rebinding and total host egress containment require runtime/network-layer enforcement and are not proved by these pure policy functions.
