import { describe, expect, test } from 'bun:test';
import { RtcManager, buildTurnCreds } from './rtc';

describe('rtc turn creds', () => {
  test('sin TURN_SECRET → null', () => {
    expect(buildTurnCreds('ab'.repeat(32), Date.now(), {} as NodeJS.ProcessEnv)).toBeNull();
  });

  test('con secreto genera username exp + hmac', () => {
    const creds = buildTurnCreds('ab'.repeat(32), 1_000_000, {
      TURN_SECRET: 's3cr3t',
      TURN_URLS: 'turn:a.example:3478, turn:b.example:3478',
    } as NodeJS.ProcessEnv);
    expect(creds).not.toBeNull();
    expect(creds!.urls).toEqual(['turn:a.example:3478', 'turn:b.example:3478']);
    expect(creds!.username).toMatch(/^\d+:/);
    expect(creds!.credential.length).toBeGreaterThan(10);
  });
});

describe('rtc p2p werift', () => {
  test('offer browser-mock → answer daemon + DataChannel hello/api', async () => {
    const { RTCPeerConnection } = await import('werift');

    const apiCalls: string[] = [];
    const mgr = new RtcManager({
      handleApi: async (req: Request) => {
        apiCalls.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({ ok: true, via: 'rtc' });
      },
      wsManager: null,
      db: { getSetting: (k: string) => (k.startsWith('remote.ui.session.') ? JSON.stringify({ exp: Date.now() + 3600_000 }) : null) },
    });

    // Browser mock (werift pc1)
    const browser = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
    const dcBrowser = browser.createDataChannel('libredeck-rpc', { ordered: true });
    const browserOpen = new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('browser dc open timeout')), 15000);
      const check = (s: unknown) => {
        const st = Array.isArray(s) ? (s[0] as string) : (s as string);
        if (st === 'open') {
          clearTimeout(to);
          resolve();
        }
      };
      try {
        (dcBrowser as unknown as { stateChange: { subscribe: (fn: (s: unknown) => void) => void } }).stateChange.subscribe(check);
      } catch {
        /* noop */
      }
    });
    const browserMsgs: string[] = [];
    (dcBrowser as unknown as { onMessage: { subscribe: (fn: (v: unknown) => void) => void } }).onMessage.subscribe((raw: unknown) => {
      const v = Array.isArray(raw) ? raw[0] : raw;
      browserMsgs.push(String(v));
    });

    const offer = await browser.createOffer();
    await browser.setLocalDescription(offer);
    const res = await mgr.handleOffer('bridge-test-1', offer.sdp);
    expect('sdp' in res).toBe(true);
    await browser.setRemoteDescription({ type: 'answer', sdp: (res as { sdp: string }).sdp } as never);

    await browserOpen;

    // hello → welcome
    dcBrowser.send(JSON.stringify({ t: 'hello', sessionToken: 'ab'.repeat(32) }));
    await new Promise((r) => setTimeout(r, 1500));
    expect(browserMsgs.some((m) => m.includes('"welcome"'))).toBe(true);

    // api-req → api-res
    dcBrowser.send(JSON.stringify({ t: 'api-req', id: 'req-1', method: 'GET', path: '/api/v1/profiles', headers: {} }));
    await new Promise((r) => setTimeout(r, 1500));
    expect(apiCalls).toContain('GET /api/v1/profiles');
    expect(browserMsgs.some((m) => m.includes('req-1') && m.includes('api-res'))).toBe(true);

    mgr.close('bridge-test-1');
    await browser.close();
  }, 30000);
});
