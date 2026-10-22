import net from 'node:net';
import type { BrowserFixtures, FixtureProxy } from './servers';

/** A real SOCKS5 handshake and byte tunnel, relayed through the controlled CONNECT fixture. */
export async function useSocks5Proxy(fixtures: BrowserFixtures, index = 0): Promise<void> {
  const original = fixtures.proxies[index];
  if (!original || original.record.protocol !== 'http')
    throw new Error('SOCKS fixture needs an HTTP CONNECT backend');
  const sockets = new Set<net.Socket>();
  let failed = false;
  let stalled = false;
  const listener = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    let buffer = Buffer.alloc(0);
    let stage: 'greeting' | 'connect' = 'greeting';
    const data = (chunk: Buffer) => {
      if (failed) {
        client.destroy();
        return;
      }
      if (stalled) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 8192) {
        client.destroy();
        return;
      }
      if (stage === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        if (buffer[0] !== 5 || !buffer.subarray(2, 2 + buffer[1]!).includes(0)) {
          client.end(Buffer.from([5, 255]));
          return;
        }
        buffer = buffer.subarray(2 + buffer[1]!);
        stage = 'connect';
        client.write(Buffer.from([5, 0]));
      }
      if (buffer.length < 4) return;
      if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0) {
        client.destroy();
        return;
      }
      let host: string;
      let length: number;
      if (buffer[3] === 1) {
        length = 10;
        if (buffer.length < length) return;
        host = [...buffer.subarray(4, 8)].join('.');
      } else if (buffer[3] === 3) {
        if (buffer.length < 5) return;
        length = 7 + buffer[4]!;
        if (buffer.length < length) return;
        host = buffer.subarray(5, 5 + buffer[4]!).toString('ascii');
      } else {
        client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const port = buffer.readUInt16BE(length - 2);
      if (!['127.0.0.1', 'localhost'].includes(host) || port < 1) {
        client.end(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const head = buffer.subarray(length);
      client.removeListener('data', data);
      const upstream = net.connect(original.record.port, '127.0.0.1', () => {
        upstream.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
      });
      sockets.add(upstream);
      client.on('close', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => {
        sockets.delete(upstream);
        client.destroy();
      });
      let response = Buffer.alloc(0);
      const readResponse = (bytes: Buffer) => {
        response = Buffer.concat([response, bytes]);
        const separator = response.indexOf('\r\n\r\n');
        if (separator < 0) {
          if (response.length > 8192) upstream.destroy();
          return;
        }
        upstream.removeListener('data', readResponse);
        if (!response.subarray(0, separator).toString().startsWith('HTTP/1.1 200')) {
          client.destroy();
          upstream.destroy();
          return;
        }
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
        const remaining = response.subarray(separator + 4);
        if (remaining.length) client.write(remaining);
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      };
      upstream.on('data', readResponse);
    };
    client.on('data', data);
  });
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      listener.removeListener('error', reject);
      resolve();
    });
  });
  const port = (listener.address() as net.AddressInfo).port;
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => (listener.listening ? listener.close(() => resolve()) : resolve()));
  };
  const replacement: FixtureProxy = {
    record: { ...original.record, id: `socks5://127.0.0.1:${port}`, protocol: 'socks5', port },
    get requests() {
      return original.requests;
    },
    get tunnels() {
      return original.tunnels;
    },
    get traffic() {
      return original.traffic;
    },
    fail() {
      failed = true;
      for (const socket of sockets) socket.destroy();
    },
    stall() {
      stalled = true;
    },
    async stop() {
      failed = true;
      await close();
    },
  };
  fixtures.proxies[index] = replacement;
  const closeFixtures = fixtures.close.bind(fixtures);
  fixtures.close = async () => {
    await close();
    await closeFixtures();
  };
}
