/**
 * E2E WebRTC en ventanas distintas (Chrome real ↔ daemon werift).
 *
 * - Arranca RelayServer en 127.0.0.1:0 (ephemeral) con límites nuevos.
 * - Fake daemon: tunnel-register + ui-publish + RtcManager + httpHandler mínimo
 *   (sirve test page con handshake WebRTC nativo + API /api/v1/ping).
 * - Playwright: abre DOS ventanas (contexts) a la waiting room, aprueba,
 *   navega a /t/<token>/ y verifica DataChannel P2P + api-res + sin 429.
 *
 * Ejecutar: cd relay && bun tests/e2e-webrtc-windows.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceStore } from '../../relay/src/store';
import { PairingStore } from '../../relay/src/pairing';
import { RelayServer } from '../../relay/src/relay';
import { setUiPageHandler } from '../../relay/src/tunnel';
import { renderWaitingPage, waitingLang } from '../../relay/src/waiting';

const TOKEN = 'e2e-webrtc-token';
const dir = mkdtempSync(join(tmpdir(), 'relay-e2e-webrtc-'));
const store = new DeviceStore(dir);
const relay = new RelayServer({
  token: TOKEN,
  store,
  pairing: new PairingStore(),
  rateLimitT: 600,
  rateLimitUi: 120,
  rateLimitWs: 120,
  rateLimitPair: 30,
  trustProxy: false,
});
const server = relay.listen(0, '127.0.0.1');
const port = server.port;
console.log(`[e2e] relay en 127.0.0.1:${port}`);

setUiPageHandler((urlCode: string, req: Request) => {
  const url = new URL(req.url);
  if (url.pathname.endsWith('/status')) {
    return Response.json(relay.tunnel.status(urlCode));
  }
  return new Response(renderWaitingPage(urlCode, waitingLang(req)), {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
});

// ---- Fake daemon con RtcManager real ----
const { RtcManager } = await import('../../daemon/src/remote/rtc');
const daemonWs = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
await new Promise<void>((res, rej) => {
  daemonWs.addEventListener('open', () => res(), { once: true } as object);
  daemonWs.addEventListener('error', () => rej(new Error('daemon ws open failed')), { once: true } as object);
});
const dbuf: unknown[] = [];
daemonWs.addEventListener('message', (e) => {
  try {
    dbuf.push(JSON.parse(String((e as MessageEvent).data)));
  } catch { /* noop */ }
});
function dsend(o: unknown) {
  daemonWs.send(JSON.stringify(o));
}
async function dnext(pred: (m: { kind?: string }) => boolean, timeout = 5000): Promise<{ kind?: string; [k: string]: unknown }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const i = dbuf.findIndex((m) => pred(m as { kind?: string }));
    if (i >= 0) return dbuf.splice(i, 1)[0] as { kind?: string };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('timeout daemon msg');
}

const rtc = new RtcManager({
  handleApi: async (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === '/api/v1/ping') return Response.json({ ok: true, via: 'rtc', at: Date.now() });
    if (path === '/' || path.startsWith('/t/')) {
      return new Response('<html><body>rtc-e2e</body></html>', { headers: { 'content-type': 'text/html' } });
    }
    return Response.json({ ok: true, path });
  },
  wsManager: null,
  db: {
    getSetting: (k: string) => {
      if (k === `remote.ui.session.${'e'.repeat(64)}`) return JSON.stringify({ exp: Date.now() + 3600_000 });
      return null;
    },
  },
});

dsend({ v: 1, kind: 'tunnel-register', deviceId: 'e2e-daemon-1' });
await dnext((m) => m.kind === 'tunnel-registered');
const urlCode = 'e2ecode123456';
dsend({ v: 1, kind: 'ui-publish', urlCode, exp: Date.now() + 600_000 });
await dnext((m) => m.kind === 'ui-published');
console.log('[e2e] daemon registrado y código publicado:', urlCode);

// Daemon loop: responde ui-request con approve+bind, http-req mínimo, ws signaling rtc.
const approvedTokens = new Map<string, string>(); // bridgeId -> token (para debug)
daemonWs.addEventListener('message', async (e) => {
  let m: { kind?: string; [k: string]: unknown };
  try {
    m = JSON.parse(String((e as MessageEvent).data));
  } catch { return; }
  if (m.kind === 'ui-request') {
    const reqId = String(m.reqId);
    const sessionToken = 'e'.repeat(64);
    dsend({ v: 1, kind: 'ui-decision', reqId, allow: true });
    dsend({ v: 1, kind: 'ui-bind', urlCode, sessionToken, exp: Date.now() + 3600_000 });
  }
  if (m.kind === 'http-req') {
    const id = String(m.id);
    const path = String((m as Record<string, unknown>).path ?? '/');
    let status = 200;
    let body = '';
    let ctype = 'application/json';
    if (path === '/' || path.startsWith('/t/')) {
      // Test page mínima con handshake WebRTC nativo (se sirve bajo /t/<tok>/).
      ctype = 'text/html';
      body = `<!doctype html><html><head><meta charset="utf8"></head><body><div id="st">boot</div><script>
window.__rtcResult = null;
async function runRtc(signalSend, onEvent) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
  const dc = pc.createDataChannel('libredeck-rpc', { ordered: true });
  const open = new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('dc timeout')), 15000); dc.onopen = () => { clearTimeout(to); res(true); }; });
  const msgs = [];
  dc.onmessage = (ev) => { msgs.push(String(ev.data)); onEvent && onEvent(String(ev.data)); };
  pc.onicecandidate = (ev) => {};
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  signalSend({ type: 'rtc-offer', payload: { sdp: offer.sdp } });
  const answerSdp = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('answer timeout')), 15000);
    window.__rtcAnswerResolve = (sdp) => { clearTimeout(to); res(sdp); };
  });
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  await open;
  dc.send(JSON.stringify({ t: 'hello', sessionToken: window.__token }));
  const welcome = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('welcome timeout')), 10000);
    window.__rtcWelcomeResolve = () => { clearTimeout(to); res(true); };
  });
  dc.send(JSON.stringify({ t: 'api-req', id: 'ping-1', method: 'GET', path: '/api/v1/ping', headers: {} }));
  const apiRes = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('api timeout')), 10000);
    window.__rtcApiResolve = (m) => { clearTimeout(to); res(m); };
  });
  window.__rtcResult = { welcome, apiRes };
  document.getElementById('st').textContent = 'p2p-ok';
  return window.__rtcResult;
}
</script></body></html>`;
    } else if (path.endsWith('/api/v1/ping')) {
      body = JSON.stringify({ ok: true, via: 'http-relay' });
    } else if (path.endsWith('/config')) {
      body = JSON.stringify({ wsPort: 0, apiPort: 0 });
    } else {
      status = 404;
      body = JSON.stringify({ error: 'not-found' });
    }
    dsend({ v: 1, kind: 'http-res', id, status, headers: { 'content-type': ctype }, bodyB64: Buffer.from(body).toString('base64') });
  }
  if (m.kind === 'ws-open') {
    // El navegador abre WS de señalización; el daemon no necesita hacer nada
    // (el RtcManager responde cuando llegue ws-msg con rtc-offer).
  }
  if (m.kind === 'ws-msg') {
    const id = String(m.id);
    let text = '';
    try {
      text = Buffer.from(String(m.dataB64), 'base64').toString('utf8');
      const inner = JSON.parse(text) as { type?: string; payload?: { sdp?: string; candidate?: unknown } };
      if (inner.type === 'rtc-offer' && inner.payload?.sdp) {
        const res = await rtc.handleOffer(id, inner.payload.sdp);
        const payload = 'sdp' in res ? { sdp: (res as { sdp: string }).sdp } : { error: (res as { error: string }).error };
        dsend({ v: 1, kind: 'ws-msg', id, dataB64: Buffer.from(JSON.stringify({ type: 'rtc-answer', payload })).toString('base64'), isBinary: false });
      } else if (inner.type === 'rtc-ice') {
        await rtc.handleIce(id, inner.payload?.candidate);
      }
    } catch { /* frames del protocolo WS normal: ignorar en este e2e mínimo */ }
  }
});

// ---- Playwright: dos ventanas ----
const { chromium } = await import('playwright');
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const results: Array<{ win: string; p2p: boolean; apiVia: string; status429: number }> = [];

for (const win of ['win-A', 'win-B']) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // 1. Waiting room SIN ejecutar su JS (request crudo crea ui-request;
  // el daemon auto-aprueba). Si usáramos page.goto, el poll inline de la
  // propia waiting room consumiría el sessionToken antes que nosotros.
  await page.request.get(`http://127.0.0.1:${port}/ui/${urlCode}`);
  // 2. Poll status hasta approved (el daemon ya hizo bind).
  let sessionToken = '';
  for (let i = 0; i < 40; i++) {
    const r = await page.request.get(`http://127.0.0.1:${port}/ui/${urlCode}/status`, { headers: { Accept: 'application/json' } });
    const jt = await r.text();
    let j: { status?: string; sessionToken?: string } = {};
    try { j = JSON.parse(jt); } catch { /* noop */ }
    if (i < 3 || j.status !== 'pending') console.log(`[e2e] ${win} poll ${i}:`, r.status(), jt.slice(0, 200));
    if (j.status === 'approved' && j.sessionToken) {
      sessionToken = j.sessionToken;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!sessionToken) throw new Error(`${win}: sin sessionToken tras polls`);
  // 3. Navega a /t/<token>/ (sirve test page mínima).
  // Nota: el primer poll consume el token (bind consumed), pero la sesión
  // sigue válida para /t/*. La segunda ventana necesita OTRO código porque
  // urlCode es single-use: republicamos para win-B.
  const apiBurst: number[] = [];
  for (let i = 0; i < 20; i++) {
    const r = await page.request.get(`http://127.0.0.1:${port}/t/${sessionToken}/api/v1/ping`);
    apiBurst.push(r.status());
  }
  const status429 = apiBurst.filter((s) => s === 429).length;
  await page.goto(`http://127.0.0.1:${port}/t/${sessionToken}/`);
  await page.evaluate((tok) => {
    (window as unknown as { __token: string }).__token = tok;
  }, sessionToken);
  // 4. Abre WS de señalización y corre handshake WebRTC nativo en la página.
  const p2p = await page.evaluate(async () => {
    const w = window as unknown as {
      __token: string;
      __rtcAnswerResolve?: (sdp: string) => void;
      __rtcWelcomeResolve?: () => void;
      __rtcApiResolve?: (m: string) => void;
    };
    const wsUrl = `ws://127.0.0.1:${(window as unknown as { __port: number }).__port ?? location.port}/t/${encodeURIComponent(w.__token)}/ws`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error('signal ws timeout')), 10000);
      ws.onopen = () => { clearTimeout(to); res(); };
      ws.onerror = () => { clearTimeout(to); rej(new Error('signal ws error')); };
    });
    const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
    const dc = pc.createDataChannel('libredeck-rpc', { ordered: true });
    const open = new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error('dc timeout')), 20000);
      dc.onopen = () => { clearTimeout(to); res(); };
    });
    dc.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { t?: string };
        if (msg.t === 'welcome') w.__rtcWelcomeResolve?.();
        if (msg.t === 'api-res') w.__rtcApiResolve?.(String(ev.data));
      } catch { /* noop */ }
    };
    pc.onicecandidate = () => {};
    ws.onmessage = async (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string; payload?: { sdp?: string } };
        if (msg.type === 'rtc-answer' && msg.payload?.sdp) w.__rtcAnswerResolve?.(msg.payload.sdp);
      } catch { /* noop */ }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({ type: 'rtc-offer', payload: { sdp: offer.sdp } }));
    const answerSdp: string = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('answer timeout')), 20000);
      w.__rtcAnswerResolve = (sdp: string) => { clearTimeout(to); res(sdp); };
    });
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await open;
    dc.send(JSON.stringify({ t: 'hello', sessionToken: w.__token }));
    await new Promise<void>((res, rej) => {
      const to = setTimeout(() => rej(new Error('welcome timeout')), 10000);
      w.__rtcWelcomeResolve = () => { clearTimeout(to); res(); };
    });
    dc.send(JSON.stringify({ t: 'api-req', id: 'ping-1', method: 'GET', path: '/api/v1/ping', headers: {} }));
    const apiRes: string = await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error('api timeout')), 10000);
      w.__rtcApiResolve = (m: string) => { clearTimeout(to); res(m); };
    });
    const parsed = JSON.parse(apiRes) as { status?: number; bodyB64?: string };
    const bodyText = parsed.bodyB64 ? atob(parsed.bodyB64) : '{}';
    const body = JSON.parse(bodyText) as { via?: string };
    if (parsed.status !== 200 || body.via !== 'rtc') throw new Error('api no vino por rtc: ' + apiRes.slice(0, 200));
    ws.close();
    return true;
  });
  // 5. Para win-B: republica un código nuevo (single-use) ANTES de salir del loop.
  // (win-A ya consumió el actual; win-B necesita el suyo.)
  results.push({ win, p2p, apiVia: 'rtc', status429 });
  console.log(`[e2e] ${win}: p2p=${p2p} 429en20=${status429}`);
  await ctx.close();
  if (win === 'win-A') {
    // Republicar para la segunda ventana (el código anterior quedó consumido).
    dsend({ v: 1, kind: 'ui-publish', urlCode, exp: Date.now() + 600_000 });
    await dnext((m) => m.kind === 'ui-published');
    // Limpia el pending anterior consumido: el relay ya lo borró en bind,
    // la próxima visita a /ui/<code> crea un ui-request nuevo.
  }
}

await browser.close();
daemonWs.close();
rtc.closeAll();
relay.stop();
store.close();

const allP2p = results.every((r) => r.p2p);
const any429 = results.some((r) => r.status429 > 0);
console.log('[e2e] resultados:', JSON.stringify(results));
if (!allP2p) {
  console.error('[e2e] FAIL: alguna ventana no conectó por WebRTC');
  process.exit(1);
}
if (any429) {
  console.error('[e2e] FAIL: hubo 429 en ráfaga de 20');
  process.exit(1);
}
console.log('[e2e] OK: 2 ventanas P2P webrtc + 0x429');
process.exit(0);
