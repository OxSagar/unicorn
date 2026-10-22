# Proxy source and direct-assignment contract

Starting with 1.0.0-rc.2, Unicorn assigns eligible ProxyScrape endpoints directly from API metadata. It sends no preflight request, performs no exit-IP/country lookup, measures no validation latency, and maintains no validation queue. The first connection through an assigned endpoint is the requested browser traffic.

## Provider schema

The provider endpoint is `https://api.proxyscrape.com/v4/free-proxy-list/get`. Unicorn requests `get_proxies`, JSON output, HTTP/SOCKS5 transports, and the configured country list. The live envelope contains `proxies` and `nextpage`; geographic metadata is read from `ip_data.countryCode` or the official flattened `country_code` field.

Provider references checked during initial implementation on 22 October 2026:

- [ProxyScrape public API documentation](https://docs.proxyscrape.com/api-reference/public-api/get-proxy-list)
- [Official provider mirror updater](https://github.com/ProxyScrape/free-proxy-list/blob/main/scripts/update.py)
- [Official mirror schema](https://github.com/ProxyScrape/free-proxy-list/blob/main/README.md)

## Eligible countries

| Code | API-listed country |
| ---- | ------------------ |
| US   | United States      |
| GB   | United Kingdom     |
| CA   | Canada             |
| FR   | France             |
| DE   | Germany            |
| JP   | Japan              |
| IT   | Italy              |
| AT   | Austria            |

Country labels are supplied by the API. Unicorn does not independently establish the endpoint's current exit country. Provider health, latency and exit metadata are not local prerequisites for assignment.

The parser still requires a supported transport, a valid numeric public IP address, a valid port and an eligible country. Missing geography, `UK`, malformed/private endpoints and unsupported transports are rejected. Duplicate IP/port endpoints are removed. These are data-shape and eligibility checks, not network probes. Local `source: fixture` endpoints are restricted to the unpackaged integration-test mechanism.

The provider's HTTPS-capable HTTP proxies retain the `http` transport label and tunnel target HTTPS with CONNECT. TLS to the destination remains certificate-verified. SOCKS4 and authenticated proxies are not supported. The transport layer also has a controlled TLS-to-proxy fixture; no general manual proxy editor is exposed.

## Atomic leases and actual failures

An eligible endpoint enters the pool as `available`. The main process reserves its IP/port synchronously before delivering the assignment, so concurrent browsers cannot receive the same endpoint even if it appears under different protocol labels. A lease becomes `assigned` and returns to `available` on ordinary release. Provider refresh preserves active leases; interface snapshots are copies.

Cancellation or release before delivery invalidates the pending assignment. It cannot revive a stopped browser's lease. Native configuration still sets a fixed proxy, removes the implicit localhost bypass, verifies Chromium's selected route contains no DIRECT fallback, and keeps the request gate closed until configuration completes. Route inspection configures the browser; it does not contact a diagnostic server.

An actual recognized connection failure releases and temporarily quarantines the failed endpoint. QA may retry within its existing finite retry policy; a manual navigation reports its error. Missing eligible endpoints leave the browser waiting with networking closed. HTTP restrictions, challenges, certificate errors and cancellation are not reasons to rotate around a website's policy.

Only endpoints are unique. Different endpoints may share the same public exit IP. The application no longer advertises observed exits, verified countries or measured proxy latency.

## Provider requests and bounds

Provider retrieval is a Node control-plane request separate from browser sessions. It has a timeout, capped body, finite pagination, coalesced overlapping requests and a cooldown of at least one minute, including Retry-After handling. Pages are capped at 2,000 records and the parser caps an envelope at 60,000. Startup, low reserve, stale data, cycle boundaries and actual transport failures can request replenishment within those limits.

An outage retains active leases and reports the fetch error. Browsers without an endpoint remain blocked; they do not fall back to a direct connection. Public proxy availability, throughput and geographic accuracy remain provider-dependent.

## Navigation scope and budgets

HTTPS is required except for explicitly enabled localhost fixtures. Credentials in URLs, unsafe schemes and private literal destinations are rejected before dispatch. Exact-host and explicit wildcard authorization, daily navigation/request budgets, site restriction stops and emergency cancellation remain enforced. Provider list retrieval is separate control-plane traffic. No exit-diagnostic service is used by the application.

Application/session routing controls are not an operating-system firewall. Controlled HTTP/HTTPS/WebSocket and UDP observations do not establish a comprehensive systemwide egress audit.
