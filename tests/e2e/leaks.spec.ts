import { test, expect } from '@playwright/test';
import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { createFixtures } from '../fixtures/servers';
import { browserEvaluate, closeHarness, invoke, snapshot, launchUnicorn, type Harness } from './helpers';

test('real Chromium ICE gathering sends no direct UDP to a controlled loopback STUN trap', async ({
  browserName: _browserName,
}, testInfo) => {
  const fixtures = await createFixtures(1);
  const trap = createSocket('udp4');
  const control = Buffer.from(`unicorn-loopback-control:${randomUUID()}`);
  const packets: Array<{ bytes: number; address: string; port: number; stun: boolean }> = [];
  const socketErrors: string[] = [];
  let controlReceived = false;
  let listening = false;
  let harness: Harness | undefined;
  trap.on('error', (error) => socketErrors.push(error.message));
  trap.on('message', (message, remote) => {
    if (message.equals(control)) {
      controlReceived = true;
      return;
    }
    packets.push({
      bytes: message.length,
      address: remote.address,
      port: remote.port,
      stun: message.length >= 20 && message.readUInt32BE(4) === 0x2112a442,
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      trap.once('error', reject);
      trap.bind(0, '127.0.0.1', () => {
        trap.removeListener('error', reject);
        listening = true;
        resolve();
      });
    });
    const port = trap.address().port;
    // A positive loopback datagram proves the observer is listening. It does not
    // change any Chromium setting or the application's enforced WebRTC policy.
    const sender = createSocket('udp4');
    try {
      await new Promise<void>((resolve, reject) => {
        sender.send(control, port, '127.0.0.1', (error) => (error ? reject(error) : resolve()));
      });
      await expect.poll(() => controlReceived, { timeout: 3000 }).toBe(true);
    } finally {
      sender.close();
    }

    harness = await launchUnicorn(fixtures);
    const origin = fixtures.httpsOrigin ?? fixtures.httpOrigin;
    await invoke(harness, { type: 'navigate', id: 1, url: `${origin}/policy/no-links` });
    const policy = await harness.app.evaluate(() => {
      const manager = (
        globalThis as unknown as {
          __unicornTest: { manager: { getWebContents(id: number): Electron.WebContents } };
        }
      ).__unicornTest.manager;
      return manager.getWebContents(1).getWebRTCIPHandlingPolicy();
    });
    expect(policy).toBe('disable_non_proxied_udp');
    expect((await snapshot(harness)).browsers[0]?.proxy?.id).toBe(fixtures.proxies[0]!.record.id);

    const observation = await browserEvaluate<{
      started: boolean;
      completed: boolean;
      state: string;
      offer: boolean;
      candidateProtocols: string[];
      elapsedMs: number;
    }>(
      harness,
      1,
      `(async () => {
        const startedAt = performance.now();
        const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${port}' }], iceCandidatePoolSize: 0 });
        const candidateProtocols = [];
        let started = false;
        let completed = false;
        let finish;
        const gathering = new Promise(resolve => { finish = resolve; });
        peer.onicecandidate = event => { if (event.candidate) candidateProtocols.push(event.candidate.protocol); };
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState === 'complete') { completed = true; finish(); }
        };
        let timer;
        const deadline = new Promise(resolve => { timer = setTimeout(resolve, 3000); });
        try {
          const setup = (async () => {
            peer.createDataChannel('unicorn-controlled-stun-test');
            await peer.setLocalDescription(await peer.createOffer());
            started = true;
            if (peer.iceGatheringState === 'complete') { completed = true; finish(); }
            await gathering;
          })();
          await Promise.race([setup, deadline]);
          // Observe the complete three-second window even when ICE completes early.
          await deadline;
          return { started, completed, state: peer.iceGatheringState,
            offer: peer.localDescription?.type === 'offer', candidateProtocols,
            elapsedMs: performance.now() - startedAt };
        } finally { clearTimeout(timer); peer.close(); }
      })()`,
    );
    await testInfo.attach('controlled-stun-udp-observation.json', {
      body: JSON.stringify(
        {
          scope: 'One controlled IPv4 loopback STUN destination; not a system-wide packet or DNS audit',
          policy,
          controlReceived,
          socketErrors,
          receivedDatagrams: packets,
          observation,
        },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    expect(socketErrors).toEqual([]);
    expect(observation.started).toBe(true);
    expect(observation.offer).toBe(true);
    expect(observation.completed).toBe(true);
    expect(observation.state).toBe('complete');
    expect(observation.elapsedMs).toBeGreaterThanOrEqual(2900);
    expect(observation.candidateProtocols).not.toContain('udp');
    expect(packets, 'Chromium must not send direct UDP to the controlled STUN destination').toEqual([]);
    expect(fixtures.directRequests()).toBe(0);
  } finally {
    try {
      await closeHarness(harness);
    } finally {
      try {
        await fixtures.close();
      } finally {
        if (listening) await new Promise<void>((resolve) => trap.close(() => resolve()));
      }
    }
  }
});
