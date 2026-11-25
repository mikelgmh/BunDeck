/**
 * tunnel-keepalive.test.ts — keepalive del WS daemon↔relay (~25 s) y
 * `resyncUiState` ligero (lecturas acotadas por prefijo).
 *
 * Sin red real: `send` stub (mock del socket) + intervalo corto inyectado.
 * - `sendPing()` emite `{kind:'tunnel-ping'}` y el `pong` del relay
 *   refresca `lastPongSeenAt()` (prueba de vida para el sweep).
 * - Un `ping` entrante se responde con `pong` y también refresca.
 * - El heartbeat sobrevive idle: tras barridos y espera, sigue pingeando
 *   sin reconectar ni re-emitir registros.
 * - `resyncUiState` usa `getSettingsByPrefix` (2 lecturas acotadas) y cae
 *   al volcado filtrado si la DB no lo expone.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { TunnelClient } from '../remote/tunnel';

const TOK_LIVE = 'cd'.repeat(32);
const TOK_DEAD = 'ef'.repeat(32);

function fakeDb(over: Record<string, any> = {}) {
  const store = new Map<string, string>(Object.entries(over.store ?? {}));
  return {
    calls: { prefix: [] as string[], all: 0, get: 0 },
    getSetting(key: string) {
      (this as any).calls.get++;
      return store.get(key) ?? null;
    },
    getAllSettings: over.noAll
      ? undefined
      : function (this: any) {
        this.calls.all++;
        return Object.fromEntries(store);
      },
    getSettingsByPrefix: over.noPrefix
      ? undefined
      : function (this: any, prefix: string) {
        this.calls.prefix.push(prefix);
        const out: Record<string, string> = {};
        for (const [k, v] of store) if (k.startsWith(prefix)) out[k] = v;
        return out;
      },
    setSetting(key: string, value: string) { store.set(key, value); },
    deleteSetting(key: string) { store.delete(key); },
    addLog() {},
    _store: store,
  } as any;
}

const mgr = { broadcast() {} } as any;
const clients: TunnelClient[] = [];
afterEach(() => {
  for (const t of clients.splice(0)) {
    try { t.stop(); } catch { /* noop */ }
  }
});

function makeClient(db: any, keepaliveMs = 0) {
  const t = new TunnelClient(db, mgr, {
    deviceId: 'dev-keepalive',
    relayUrl: 'ws://127.0.0.1:9/nada',
    keepaliveMs,
  });
  clients.push(t);
  return t;
}

describe('tunnel keepalive', () => {
  it('ping emite tunnel-ping y el pong refresca el registro', async () => {
    const db = fakeDb();
    const t = makeClient(db);
    const sent: any[] = [];
    (t as any).send = (o: unknown) => { sent.push(o); return true; };

    expect(t.lastPongSeenAt()).toBe(0);
    expect(t.sendPing()).toBe(true);
    expect(t.lastPingSentAt()).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ v: 1, kind: 'tunnel-ping' });

    // Pong del relay: refresca el registro de vida.
    await (t as any).handleRelayMessage({ kind: 'tunnel-pong', ts: Date.now() });
    expect(t.lastPongSeenAt()).toBeGreaterThan(0);

    // Ping entrante: se responde pong y también refresca.
    sent.length = 0;
    const before = t.lastPongSeenAt();
    await (t as any).handleRelayMessage({ kind: 'tunnel-ping', ts: Date.now() });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ v: 1, kind: 'tunnel-pong' });
    expect(t.lastPongSeenAt()).toBeGreaterThanOrEqual(before);
  });

  it('el heartbeat sobrevive idle (sigue pingeando sin reconectar)', async () => {
    const db = fakeDb();
    const t = makeClient(db, 30);
    const sent: any[] = [];
    (t as any).send = (o: unknown) => { sent.push(o); return true; };
    (t as any).startHeartbeat();
    // Idle con barridos de por medio (el sweep solo purga pendientes).
    (t as any).purgeExpired();
    await new Promise((r) => setTimeout(r, 120));
    (t as any).purgeExpired();
    await new Promise((r) => setTimeout(r, 120));
    const pings = sent.filter((m) => m?.kind === 'tunnel-ping');
    expect(pings.length).toBeGreaterThanOrEqual(2);
    // Sin reconexión ni re-registro: el enlace sigue vivo por keepalive.
    expect((t as any).reconnectTimer).toBeNull();
    (t as any).stopHeartbeat();
  });

  it('resyncUiState ligero: 2 lecturas acotadas, sin volcado total', () => {
    const now = Date.now();
    const db = fakeDb({
      store: {
        'remote.ui.code': JSON.stringify({ urlCode: 'CODE-LIGHT', expiresAt: now + 600_000 }),
        [`remote.ui.session.${TOK_LIVE}`]: JSON.stringify({ createdAt: now, exp: now + 3600_000, revoked: false }),
        [`remote.ui.session.${TOK_DEAD}`]: JSON.stringify({ createdAt: now, exp: now + 3600_000, revoked: true }),
        'other.unrelated': 'x'.repeat(1000),
      },
    });
    const t = makeClient(db);
    const sent: any[] = [];
    (t as any).send = (o: unknown) => { sent.push(o); return true; };

    const r = t.resyncUiState();
    expect(r).toMatchObject({ republishedCode: true, rebound: 1, unbound: 1 });
    // Acotado por prefijo (sesiones + tombstones), jamás volcado total.
    expect(db.calls.prefix).toEqual(['remote.ui.session.', 'remote.ui.unbind-pending.']);
    expect(db.calls.all).toBe(0);
    expect(sent.some((m) => m?.kind === 'ui-rebind' && m.sessionToken === TOK_LIVE)).toBe(true);
    expect(sent.some((m) => m?.kind === 'ui-unbind' && m.sessionToken === TOK_DEAD)).toBe(true);
  });

  it('resyncUiState cae al volcado filtrado si la DB no expone getSettingsByPrefix', () => {
    const now = Date.now();
    const db = fakeDb({
      noPrefix: true,
      store: {
        [`remote.ui.session.${TOK_LIVE}`]: JSON.stringify({ createdAt: now, exp: 0, revoked: false }),
      },
    });
    const t = makeClient(db);
    (t as any).send = () => true;
    const r = t.resyncUiState();
    expect(r.rebound).toBe(1);
    // Sin el método acotado: 2 volcados filtrados (sesiones + tombstones).
    expect(db.calls.all).toBe(2);
  });
});
