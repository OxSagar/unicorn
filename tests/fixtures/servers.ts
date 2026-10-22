import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProxyRecord } from '../../src/shared/types';

type Server = http.Server | https.Server;
export interface FixtureProxy {
  record: ProxyRecord;
  stop(): Promise<void>;
  fail(): void;
  stall(): void;
  requests: number;
  tunnels: number;
}
export interface BrowserFixtures {
  httpOrigin: string;
  httpsOrigin?: string;
  diagnosticUrl: string;
  proxies: FixtureProxy[];
  requests: Array<{ path: string; host: string; proxied: boolean; at: number }>;
  directRequests(): number;
  close(): Promise<void>;
}
const listen = (server: Server) =>
  new Promise<number>((resolvePort, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolvePort((server.address() as net.AddressInfo).port);
    });
  });

export async function createFixtures(
  count = 20,
  options: { untrustedCertificate?: boolean; secureProxy?: boolean; certificateDirectory?: string } = {},
): Promise<BrowserFixtures> {
  const sockets = new Set<net.Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const proxiedPorts = new Set<number>();
  const servers: Server[] = [];
  const requests: BrowserFixtures['requests'] = [];
  const certificatePrefix = options.untrustedCertificate ? 'untrusted' : 'fixture';
  const certificateDirectory = options.certificateDirectory ?? 'tmp/test-certificates';
  const certificatePath = resolve(certificateDirectory, `${certificatePrefix}.pem`);
  const keyPath = resolve(certificateDirectory, `${certificatePrefix}.key`);
  const tls =
    existsSync(certificatePath) && existsSync(keyPath)
      ? { cert: readFileSync(certificatePath), key: readFileSync(keyPath) }
      : undefined;
  if (options.secureProxy && !tls)
    throw new Error('A TLS certificate is required for an HTTPS proxy fixture');
  const createProxyServer = (handler: http.RequestListener): Server =>
    options.secureProxy ? https.createServer(tls!, handler) : http.createServer(handler);
  const track = (server: Server) => {
    servers.push(server);
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    return server;
  };
  const diagnostic = (proxyNumber: number, response: http.ServerResponse) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(
      JSON.stringify({
        success: true,
        ip: `8.8.0.${proxyNumber}`,
        country_code: 'US',
        country: 'United States',
      }),
    );
  };
  const handler: http.RequestListener = (request, response) => {
    const requested = new URL(request.url ?? '/', 'http://localhost');
    const path = requested.pathname;
    const proxied =
      request.headers['x-unicorn-fixture-proxy'] !== undefined ||
      proxiedPorts.has(request.socket.remotePort ?? 0);
    requests.push({ path, host: request.headers.host ?? '', proxied, at: Date.now() });
    if (path === '/diagnostic') {
      diagnostic(Number(request.headers['x-unicorn-fixture-proxy'] ?? 1), response);
      return;
    }
    if (path === '/forbidden' || path === '/limited') {
      response.statusCode = path === '/forbidden' ? 403 : 429;
      response.end('Fixture access restriction');
      return;
    }
    if (path === '/redirect-outside') {
      response.writeHead(302, { Location: 'https://unapproved.invalid/' });
      response.end();
      return;
    }
    if (path === '/redirect-inside') {
      response.writeHead(302, { Location: '/internal' });
      response.end();
      return;
    }
    if (path === '/broken-resource') {
      request.socket.destroy();
      return;
    }
    if (path === '/slow') {
      const timer = setTimeout(() => {
        timers.delete(timer);
        response.end('Slow fixture');
      }, 30000);
      timers.add(timer);
      return;
    }
    if (path === '/api/check') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"javascript":true}');
      return;
    }
    if (path === '/service-worker.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.setHeader('Service-Worker-Allowed', '/');
      response.end(
        "self.addEventListener('install', event => event.waitUntil(self.skipWaiting())); self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));",
      );
      return;
    }
    if (['/challenge-title', '/challenge-widget', '/challenge-delayed', '/challenge-hidden'].includes(path)) {
      const title = path === '/challenge-title' ? 'Just a moment...' : 'Controlled challenge fixture';
      const widget =
        '<div class="cf-turnstile" data-sitekey="fixture" style="width:300px;height:70px">Controlled verification widget</div>';
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><head><title>${title}</title></head><body>
        <h1>Controlled access-control fixture</h1>
        ${path === '/challenge-widget' ? widget : ''}
        ${path === '/challenge-hidden' ? `<div style="display:none">${widget}</div>` : ''}
        <button id="challenge-action" onclick="window.challengeInteractions++">Verify</button>
        <script>window.challengeInteractions = 0;
          ${path === '/challenge-delayed' ? `setTimeout(() => document.body.insertAdjacentHTML('beforeend', ${JSON.stringify(widget)}), 300);` : ''}
        </script></body></html>`);
      return;
    }
    if (path.startsWith('/policy/')) {
      response.setHeader('Cache-Control', 'no-store');
      if (path.startsWith('/policy/burst/')) {
        response.setHeader('Content-Type', 'application/json');
        response.end('{"ok":true}');
        return;
      }
      const scheme = 'encrypted' in request.socket && request.socket.encrypted ? 'https:' : 'http:';
      const externalOrigin = new URL(`${scheme}//${request.headers.host}`);
      externalOrigin.hostname = externalOrigin.hostname === 'localhost' ? '127.0.0.1' : 'localhost';
      const mode = requested.searchParams.get('external') === 'forbidden' ? 'forbidden' : 'complete';
      let content = '<p id="policy-ready">Controlled page without links</p>';
      if (path === '/policy/landing')
        content = `<a id="policy-internal" href="/policy/internal?external=${mode}">Approved internal page</a>`;
      else if (path === '/policy/internal')
        content = `<a id="policy-external" href="${externalOrigin.origin}${mode === 'forbidden' ? '/forbidden' : '/policy/external'}">Approved external page</a>`;
      else if (path === '/policy/excluded')
        content = '<a id="excluded-link" href="/policy/must-not-load">Excluded internal destination</a>';
      const script =
        path === '/policy/fetch-burst'
          ? `window.burst = { started: 0, succeeded: 0, rejected: 0, done: false };
           setTimeout(async () => {
             for (let index = 1; index <= 8; index++) {
               window.burst.started++;
               try { await fetch('/policy/burst/' + index, { cache: 'no-store' }).then(response => response.text()); window.burst.succeeded++; }
               catch { window.burst.rejected++; }
             }
             window.burst.done = true;
           }, 200);`
          : '';
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
        <link rel="icon" href="data:,"><title>Controlled policy fixture ${path}</title></head>
        <body><h1>Authorized policy test</h1>${content}<script>window.policyReady = true;${script}</script></body></html>`);
      return;
    }
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unicorn fixture ${path}</title>
      <style>body{font:18px sans-serif;margin:24px} .long{height:4200px;background:linear-gradient(#eef,#cdc)}</style></head>
      <body><h1 id="heading">Real Chromium fixture</h1><p id="result">Waiting for JavaScript</p>
      <a id="internal" href="/internal">Internal page</a><a id="outside" href="https://unapproved.invalid/">Unapproved external</a>
      <a rel="sponsored" href="/sponsored">Sponsored fixture must not be selected</a>
      <button id="popup" onclick="window.open('/popup','fixture-popup')">Open fixture popup</button><div class="long">Scroll fixture</div>
      <script>
        window.fixtureReady = true; document.querySelector('#result').textContent = 'JavaScript executed';
        window.fetchReady = fetch('/api/check').then(r=>r.json());
        window.dbReady = new Promise((resolve,reject)=>{const r=indexedDB.open('unicorn-fixture',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onerror=()=>reject(r.error);r.onsuccess=()=>{r.result.close();resolve(true)}});
        if(location.search.includes('error=1')) setTimeout(()=>{throw new Error('Unicorn fixture error')},20);
      </script></body></html>`);
  };
  const plain = track(http.createServer(handler));
  const httpPort = await listen(plain);
  const httpOrigin = `http://127.0.0.1:${httpPort}`;
  const secure = tls ? track(https.createServer(tls, handler)) : undefined;
  const httpsPort = secure ? await listen(secure) : undefined;
  const httpsOrigin = httpsPort ? `https://127.0.0.1:${httpsPort}` : undefined;
  const diagnosticUrl = `${httpsOrigin ?? httpOrigin}/diagnostic`;
  // A real WebSocket handshake and data frame, requiring no websocket mock in Chromium.
  for (const target of [plain, secure].filter(Boolean) as Server[])
    target.on('upgrade', (request, socket) => {
      const key = request.headers['sec-websocket-key'];
      if (typeof key !== 'string') {
        socket.destroy();
        return;
      }
      const accept = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const message = Buffer.from('unicorn-websocket-ok');
      socket.write(Buffer.concat([Buffer.from([0x81, message.length]), message]));
      socket.on('data', () => undefined);
    });
  const proxies: FixtureProxy[] = [];
  for (let index = 1; index <= count; index++) {
    let failed = false;
    let stalled = false;
    const ownSockets = new Set<net.Socket>();
    const tlsDiagnostic = tls
      ? track(https.createServer(tls, (_req, response) => diagnostic(index, response)))
      : undefined;
    const diagnosticPort = tlsDiagnostic ? await listen(tlsDiagnostic) : undefined;
    const record: ProxyRecord = {
      id: '',
      ip: '127.0.0.1',
      port: 0,
      protocol: options.secureProxy ? 'https' : 'http',
      country: 'US',
      countryName: 'United States (controlled fixture)',
      status: 'unverified',
      lastChecked: null,
      latencyMs: null,
      failures: 0,
      source: 'fixture',
    };
    const proxy: FixtureProxy = {
      record,
      requests: 0,
      tunnels: 0,
      fail() {
        failed = true;
        for (const socket of ownSockets) socket.destroy();
      },
      stall() {
        stalled = true;
      },
      async stop() {
        proxy.fail();
        await new Promise<void>((done) => listener.close(() => done()));
      },
    };
    const listener = track(
      createProxyServer((request, response) => {
        if (failed) {
          request.socket.destroy();
          return;
        }
        if (stalled) return;
        proxy.requests++;
        let target: URL;
        try {
          target = new URL(request.url ?? '');
        } catch {
          response.writeHead(400);
          response.end();
          return;
        }
        if (target.hostname !== '127.0.0.1' && target.hostname !== 'localhost') {
          response.writeHead(403);
          response.end();
          return;
        }
        const outgoing = http.request(
          target,
          {
            method: request.method,
            headers: { ...request.headers, 'x-unicorn-fixture-proxy': String(index), connection: 'close' },
          },
          (incoming) => {
            response.writeHead(incoming.statusCode ?? 502, incoming.headers);
            incoming.pipe(response);
          },
        );
        outgoing.on('error', () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        request.pipe(outgoing);
      }),
    );
    listener.on('connection', (socket) => {
      ownSockets.add(socket);
      socket.on('close', () => ownSockets.delete(socket));
    });
    listener.on('connect', (request, client, head) => {
      if (failed) {
        client.destroy();
        return;
      }
      if (stalled) return;
      proxy.tunnels++;
      let target: URL;
      try {
        target = new URL(`http://${request.url}`);
      } catch {
        client.destroy();
        return;
      }
      if (!['localhost', '127.0.0.1'].includes(target.hostname)) {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const requestedPort = Number(target.port || 443);
      // Diagnostics share a local hostname but use a distinct authority to allow per-proxy observed exits.
      const isDiagnostic = diagnosticAuthority !== '' && request.url === diagnosticAuthority;
      let upstreamPort: number | undefined;
      const upstream = net.connect(
        isDiagnostic && diagnosticPort ? diagnosticPort : requestedPort,
        '127.0.0.1',
        () => {
          upstreamPort = upstream.localPort;
          if (upstreamPort) proxiedPorts.add(upstreamPort);
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          client.pipe(upstream);
          upstream.pipe(client);
        },
      );
      sockets.add(upstream);
      ownSockets.add(upstream);
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => {
        if (upstreamPort) proxiedPorts.delete(upstreamPort);
        sockets.delete(upstream);
        ownSockets.delete(upstream);
        client.destroy();
      });
    });
    const port = await listen(listener);
    record.port = port;
    record.id = `${record.protocol}://127.0.0.1:${port}`;
    proxies.push(proxy);
  }
  // Separate diagnostic authority: normal HTTPS pages still reach the shared fixture site.
  let diagnosticAuthority = '';
  let effectiveDiagnostic = diagnosticUrl;
  if (tls) {
    const diagnosticAnchor = track(https.createServer(tls, (_req, response) => diagnostic(1, response)));
    const port = await listen(diagnosticAnchor);
    diagnosticAuthority = `127.0.0.1:${port}`;
    effectiveDiagnostic = `https://${diagnosticAuthority}/diagnostic`;
  }
  return {
    httpOrigin,
    httpsOrigin,
    diagnosticUrl: effectiveDiagnostic,
    proxies,
    requests,
    directRequests: () => requests.filter((request) => !request.proxied).length,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((done) => {
              if (!server.listening) done();
              else server.close(() => done());
            }),
        ),
      );
    },
  };
}
