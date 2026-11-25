/**
 * remote-tunnel.test.ts — CLIENTE DEL TÚNEL (`remote/tunnel.ts`) contra un
 * relay FALSO (Bun.serve WS local que habla el protocolo `kind:`).
 *
 * Cubre (contrato):
 * - register reenviado al reconectar (+ republica códigos vigentes)
 * - ui-request encola (máx 20, TTL 120s) + broadcast `ui-approval-requested`
 * - http-req servido contra la API real (misma respuesta que el servidor local)
 * - 413 en body grande, path traversal denegado (403)
 * - WS bridge: subscribe + broadcast llega al relay; close limpia
 * - ui-publish/unpublish + ui-decision/ui-bind (token 32 bytes hex) + ui-unbind
 * - túnel caído o UI deshabilitada → 503 / deny
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-tunnel-test-'));
process.env.LIBREDECK_DATA_DIR = ROOT;

import { initDatabase, DatabaseService } from '../db';
import { getVersion } from '../version';
import { createDaemonFetch } from '../http/handler';
import { TunnelClient } from '../remote/tunnel';

function b64Text(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function unb64Text(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

async function waitFor(cond: () => boolean, timeoutMs = 8000, stepMs = 25): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

// ---- relay falso ----

let relay: any = null;
let relayPort = 0;
let serverWs: any = null;
let connectCount = 0;
const received: any[] = [];

function relaySend(obj: unknown): void {
  (serverWs as any)?.send(JSON.stringify(obj));
}

function receivedOf(kind: string): any[] {
  return received.filter((m) => m?.kind === kind);
}

beforeAll(async () => {
  await initDatabase();

  relay = Bun.serve({
    port: 0,
    fetch(req, server) {
      if (server.upgrade(req)) return;
      return new Response('relay-fake', { status: 200 });
    },
    websocket: {
      open(ws: any) {
        serverWs = ws;
        connectCount += 1;
      },
      message(_ws: any, raw: any) {
        try {
          received.push(JSON.parse(String(raw)));
        } catch { /* noop */ }
      },
      close() {
        if (serverWs) serverWs = null;
      },
    },
  });
  relayPort = relay.port;
});

afterAll(() => {
  try {
    relay?.stop?.(true);
  } catch { /* noop */ }
});

// ---- fixtures compartidos ----

let db: DatabaseService;
let mgr: any;
let tunnel: TunnelClient;
let httpHandler: (req: Request) => Promise<Response>;
let localServer: any;

function makeFakeWsManager() {
  const clients = new Map<string, { send: (t: string) => void; subs: Set<string> }>();
  const m: any = {
    events: [] as any[],
    broadcast(event: string, payload: any, topic?: string) {
      m.events.push({ event, payload, topic });
      for (const c of clients.values()) {
        if (topic && !c.subs.has(topic)) continue;
        try {
          c.send(JSON.stringify({ type: event, payload }));
        } catch { /* noop */ }
      }
    },
    createTunnelClient(tunnelId: string, send: (t: string) => void) {
      const cid = `tunnel:${tunnelId}`;
      clients.set(cid, { send, subs: new Set() });
      return cid;
    },
    removeTunnelClient(tunnelId: string) {
      clients.delete(`tunnel:${tunnelId}`);
    },
    handleTunnelMessage(tunnelId: string, text: string) {
      const c = clients.get(`tunnel:${tunnelId}`);
      if (!c) return;
      const msg = JSON.parse(text);
      if (msg?.type === 'subscribe') {
        const topics = msg?.payload?.topics ?? [];
        for (const t of topics) if (typeof t === 'string') c.subs.add(t);
        c.send(JSON.stringify({ type: 'subscribed', payload: { topics } }));
      } else if (msg?.type === 'unsubscribe') {
        const topics = msg?.payload?.topics ?? [];
        for (const t of topics) c.subs.delete(t);
      }
    },
    _clients: clients,
  };
  return m;
}

describe('remote-tunnel', () => {
  it('register al conectar y reenviado al reconectar (+ republica códigos)', async () => {
    db = new DatabaseService();
    db.setSetting('remote.relay.url', `ws://127.0.0.1:${relayPort}`);
    db.setSetting('remote.ui.enabled', '1');
    mgr = makeFakeWsManager();
    tunnel = new TunnelClient(db as any, mgr, {
      deviceId: 'dev-tunnel-1',
      relayUrl: `ws://127.0.0.1:${relayPort}`,
    });
    httpHandler = createDaemonFetch({
      wsManager: mgr,
      pluginLoader: {} as any,
      actionRunner: { executeAction: async () => ({ success: true }) } as any,
      windowWatcher: { on: () => {}, isActive: () => false } as any,
    });
    tunnel.setHttpHandler(httpHandler);
    localServer = Bun.serve({ port: 0, fetch: httpHandler });

    tunnel.start();
    await waitFor(() => receivedOf('tunnel-register').length >= 1);
    expect(receivedOf('tunnel-register')[0].deviceId).toBe('dev-tunnel-1');
    expect(receivedOf('tunnel-register')[0].v).toBe(1);

    // Publica un código y fuerza reconexión cerrando desde el relay.
    const exp = Date.now() + 3600_1000;
    tunnel.publishUiCode('CODE-ABC', exp);
    await waitFor(() => receivedOf('ui-publish').length >= 1);
    received.length = 0;
    const before = connectCount;
    // Acelera el backoff para el test y cierra la conexión del lado relay.
    (tunnel as any).backoffMs = 50;
    try {
      (serverWs as any)?.close();
    } catch { /* noop */ }
    await waitFor(() => connectCount > before, 10000);
    await waitFor(() => receivedOf('tunnel-register').length >= 1, 10000);
    expect(receivedOf('tunnel-register')[0].deviceId).toBe('dev-tunnel-1');
    // Al reconectar republica los códigos vigentes.
    await waitFor(() => receivedOf('ui-publish').some((m) => m.urlCode === 'CODE-ABC'), 10000);
  }, 20000);

  it('ui-request encola + broadcast local + log (no decide solo)', async () => {
    received.length = 0;
    mgr.events.length = 0;
    relaySend({ v: 1, kind: 'ui-request', reqId: 'req-1', urlCode: 'CODE-ABC', ua: 'TestUA/1', ip: '10.0.0.9' });
    await waitFor(() => tunnel.pendingCount() >= 1);
    const pend = tunnel.getPending();
    expect(pend.some((p) => p.reqId === 'req-1' && p.urlCode === 'CODE-ABC')).toBe(true);
    expect(mgr.events.some((e: any) => e.event === 'ui-approval-requested' && e.topic === 'remote' && e.payload?.reqId === 'req-1')).toBe(true);
    // TTL ≈ 120s
    const entry = pend.find((p) => p.reqId === 'req-1')!;
    expect(entry.expiresAt - entry.receivedAt).toBeLessThanOrEqual(120_000 + 1000);
    expect(entry.expiresAt - entry.receivedAt).toBeGreaterThan(110_000);
    // Log en DB
    const logs = db.getLogs(50);
    expect(logs.some((l) => String(l.message).includes('req-1'))).toBe(true);
    // No se envió ninguna decisión sola
    expect(receivedOf('ui-decision').length).toBe(0);
  });

  it('http-req servido contra la API real (igual que el servidor local)', async () => {
    db.setSetting('remote.ui.enabled', '1');
    received.length = 0;
    relaySend({ v: 1, kind: 'http-req', id: 'h-version', method: 'GET', path: '/api/v1/version', headers: {}, bodyB64: '' });
    await waitFor(() => receivedOf('http-res').some((m) => m.id === 'h-version'));
    const res = receivedOf('http-res').find((m) => m.id === 'h-version')!;
    expect(res.status).toBe(200);
    const body = JSON.parse(unb64Text(res.bodyB64));
    expect(body.version).toBe(getVersion());

    // Compara con el servidor local (mismo handler; buildDate varía por ms).
    const localRes = await fetch(`http://127.0.0.1:${localServer.port}/api/v1/version`);
    const localJson = await localRes.json();
    expect(body.version).toBe(localJson.version);
    expect(body.channel).toBe(localJson.channel);

    // /health también
    relaySend({ v: 1, kind: 'http-req', id: 'h-health', method: 'GET', path: '/health', headers: { connection: 'keep-alive', 'x-test': '1' }, bodyB64: '' });
    await waitFor(() => receivedOf('http-res').some((m) => m.id === 'h-health'));
    const h = receivedOf('http-res').find((m) => m.id === 'h-health')!;
    expect(h.status).toBe(200);
    // hop-by-hop saneadas en la respuesta
    const hkeys = Object.keys(h.headers ?? {}).map((k) => k.toLowerCase());
    expect(hkeys).not.toContain('transfer-encoding');
  });

  it('413 en body grande y 403 en path traversal', async () => {
    received.length = 0;
    const big = Buffer.alloc(5 * 1024 * 1024 + 16, 0x41).toString('base64');
    relaySend({ v: 1, kind: 'http-req', id: 'h-big', method: 'POST', path: '/api/v1/settings', headers: { 'content-type': 'application/json' }, bodyB64: big });
    await waitFor(() => receivedOf('http-res').some((m) => m.id === 'h-big'));
    expect(receivedOf('http-res').find((m) => m.id === 'h-big')!.status).toBe(413);

    relaySend({ v: 1, kind: 'http-req', id: 'h-trav', method: 'GET', path: '/api/../secret', headers: {}, bodyB64: '' });
    await waitFor(() => receivedOf('http-res').some((m) => m.id === 'h-trav'));
    expect(receivedOf('http-res').find((m) => m.id === 'h-trav')!.status).toBe(403);

    relaySend({ v: 1, kind: 'http-req', id: 'h-trav2', method: 'GET', path: '/..%2f..%2fetc/passwd', headers: {}, bodyB64: '' });
    await waitFor(() => receivedOf('http-res').some((m) => m.id === 'h-trav2'));
    expect(receivedOf('http-res').find((m) => m.id === 'h-trav2')!.status).toBe(403);
  });

  it('WS bridge: ws-open + subscribe, broadcast local llega al relay, ws-close limpia', async () => {
    received.length = 0;
    relaySend({ v: 1, kind: 'ws-open', id: 'w1' });
    await waitFor(() => tunnel.bridgeCount() === 1);
    relaySend({
      v: 1,
      kind: 'ws-msg',
      id: 'w1',
      dataB64: b64Text(JSON.stringify({ type: 'subscribe', payload: { topics: ['buttons'] } })),
      isBinary: false,
    });
    await new Promise((r) => setTimeout(r, 150));
    // El manager fake confirma suscripción → el relay debe recibir un ws-msg.
    await waitFor(() => receivedOf('ws-msg').some((m) => m.id === 'w1'));
    received.length = 0;

    mgr.broadcast('button.updated', { buttonId: 'b1' }, 'buttons');
    await waitFor(() => receivedOf('ws-msg').some((m) => m.id === 'w1'));
    const fwd = receivedOf('ws-msg').find((m) => m.id === 'w1')!;
    const inner = JSON.parse(unb64Text(fwd.dataB64));
    expect(inner.type).toBe('button.updated');
    expect(inner.payload?.buttonId).toBe('b1');

    relaySend({ v: 1, kind: 'ws-close', id: 'w1' });
    await waitFor(() => tunnel.bridgeCount() === 0);
  });

  it('ui-publish/unpublish + ui-decision/ui-bind (token 32B hex) + ui-unbind', async () => {
    received.length = 0;
    const exp = Date.now() + 3600_1000;
    tunnel.publishUiCode('CODE-XYZ', exp);
    await waitFor(() => receivedOf('ui-publish').some((m) => m.urlCode === 'CODE-XYZ'));
    expect(receivedOf('ui-publish').find((m) => m.urlCode === 'CODE-XYZ')!.exp).toBe(exp);

    relaySend({ v: 1, kind: 'ui-request', reqId: 'req-bind', urlCode: 'CODE-XYZ', ua: 'U', ip: '1.2.3.4' });
    await waitFor(() => tunnel.getPending().some((p) => p.reqId === 'req-bind'));
    received.length = 0;
    const d = tunnel.decideUiRequest('req-bind', true, exp);
    expect(d.ok).toBe(true);
    expect(d.allowed).toBe(true);
    expect(d.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    await waitFor(() => receivedOf('ui-decision').length >= 1);
    expect(receivedOf('ui-decision')[0]).toMatchObject({ reqId: 'req-bind', allow: true });
    await waitFor(() => receivedOf('ui-bind').length >= 1);
    expect(receivedOf('ui-bind')[0]).toMatchObject({ urlCode: 'CODE-XYZ', sessionToken: d.sessionToken });
    // REGRESIÓN BUG3: al decidir, el pendiente sale del mapa (el contador
    // `GET /ui-pending` baja a 0): no se sigue listando en getPending().
    expect(tunnel.getPending().some((p) => p.reqId === 'req-bind')).toBe(false);

    // revoke → ui-unbind
    received.length = 0;
    expect(tunnel.revokeUiSession(d.sessionToken!)).toBe(true);
    await waitFor(() => receivedOf('ui-unbind').length >= 1);
    expect(receivedOf('ui-unbind')[0].sessionToken).toBe(d.sessionToken);

    // unpublish
    received.length = 0;
    tunnel.unpublishUiCode('CODE-XYZ');
    await waitFor(() => receivedOf('ui-unpublish').length >= 1);
    expect(receivedOf('ui-unpublish')[0].urlCode).toBe('CODE-XYZ');
  });

  it('UI deshabilitada → http 503 y decisiones deny', async () => {
    db.setSetting('remote.ui.enabled', '0');
    received.length = 0;
    relaySend({ v: 1, kind: 'http-req', id: 'h-off', method: 'GET', path: '/api/v1/version', headers: {}, bodyB64: '' });
    await waitFor(() => receivedOf('http-res').some((m) => m.id === 'h-off'));
    expect(receivedOf('http-res').find((m) => m.id === 'h-off')!.status).toBe(503);

    relaySend({ v: 1, kind: 'ui-request', reqId: 'req-deny', urlCode: 'CODE-ABC', ua: 'U', ip: '9.9.9.9' });
    await waitFor(() => tunnel.getPending().some((p) => p.reqId === 'req-deny'));
    received.length = 0;
    const d = tunnel.decideUiRequest('req-deny', true);
    expect(d.ok).toBe(true);
    expect(d.allowed).toBe(false);
    await waitFor(() => receivedOf('ui-decision').length >= 1);
    expect(receivedOf('ui-decision')[0]).toMatchObject({ reqId: 'req-deny', allow: false });
    expect(receivedOf('ui-bind').length).toBe(0);
    // REGRESIÓN BUG3 (deny): el pendiente también desaparece de getPending().
    expect(tunnel.getPending().some((p) => p.reqId === 'req-deny')).toBe(false);
    db.setSetting('remote.ui.enabled', '1');
  });

  it('túnel caído → http-req responde 503', async () => {
    const mgr2 = makeFakeWsManager();
    const t2 = new TunnelClient(db as any, mgr2, {
      deviceId: 'dev-down',
      relayUrl: 'ws://127.0.0.1:9/nada',
    });
    t2.setHttpHandler(httpHandler);
    const sent: any[] = [];
    (t2 as any).send = (obj: unknown) => {
      sent.push(obj);
      return false;
    };
    // Sin conexión: isAvailable() es false → 503.
    expect(t2.isAvailable()).toBe(false);
    await (t2 as any).onHttpReq({ kind: 'http-req', id: 'h-down', method: 'GET', path: '/health', headers: {}, bodyB64: '' });
    expect(sent.length).toBe(1);
    expect((sent[0] as any).kind).toBe('http-res');
    expect((sent[0] as any).id).toBe('h-down');
    expect((sent[0] as any).status).toBe(503);
  });

  it('resyncUiState: sesiones y código persistidos se re-emiten al (re)conectar', async () => {
    // Sesión vigente + revocada + código en settings (como tras reiniciar el daemon).
    const liveTok = 'cd'.repeat(32);
    const deadTok = 'ef'.repeat(32);
    const liveExp = Date.now() + 3600_000;
    db.setSetting(`remote.ui.session.${liveTok}`, JSON.stringify({ createdAt: Date.now(), exp: liveExp, ua: 't', ip: '1', revoked: false }));
    db.setSetting(`remote.ui.session.${deadTok}`, JSON.stringify({ createdAt: Date.now(), exp: Date.now() + 3600_000, ua: 't', ip: '1', revoked: true }));
    db.setSetting('remote.ui.code', JSON.stringify({ code: '123456', urlCode: 'CODE-PERSIST-1', createdAt: Date.now(), expiresAt: Date.now() + 600_000 }));

    received.length = 0;
    const t2 = new TunnelClient(db as any, mgr, {
      deviceId: 'dev-resync-1',
      relayUrl: `ws://127.0.0.1:${relayPort}`,
    });
    t2.setHttpHandler(httpHandler);
    t2.start();
    // Al conectar: register + republica código persistido + rebind de la vigente + unbind de la revocada.
    await waitFor(() => receivedOf('tunnel-register').some((m) => m.deviceId === 'dev-resync-1'));
    await waitFor(() => receivedOf('ui-rebind').some((m) => m.sessionToken === liveTok), 10000);
    const rebind = receivedOf('ui-rebind').find((m) => m.sessionToken === liveTok)!;
    expect(rebind.exp).toBe(liveExp);
    expect(receivedOf('ui-publish').some((m) => m.urlCode === 'CODE-PERSIST-1')).toBe(true);
    expect(receivedOf('ui-rebind').some((m) => m.sessionToken === deadTok)).toBe(false);
    await waitFor(() => receivedOf('ui-unbind').some((m) => m.sessionToken === deadTok), 10000);

    // Llamada directa: idempotente y reporta conteos.
    const r = (t2 as any).resyncUiState();
    expect(r.rebound).toBe(1);
    expect(r.unbound).toBe(1);

    t2.stop();
    try { db.deleteSetting(`remote.ui.session.${liveTok}`); } catch { /* noop */ }
    try { db.deleteSetting(`remote.ui.session.${deadTok}`); } catch { /* noop */ }
    try { db.deleteSetting('remote.ui.code'); } catch { /* noop */ }
  });

  it('cleanup', async () => {
    tunnel.stop();
    try {
      localServer?.stop?.(true);
    } catch { /* noop */ }
  });
});
