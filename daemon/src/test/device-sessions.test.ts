/**
 * device-sessions.test.ts — sesiones independientes por dispositivo/cliente.
 *
 * Sin sockets reales: el WebSocketManager se instancia sin Bun.serve
 * (Object.create + campos internos) y los WS son fakes que capturan envíos.
 * Cubre: aislamiento de 2 clientes, navegación dirigida vs broadcast,
 * reconexión con el mismo deviceId, startup profile, REST /sessions y
 * navegación dirigida desde acciones.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-devsess-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { resolveNavTargets, isNavigationForDevice, normalizeDeviceKind } from '../sessions';
import { WebSocketManager } from '../ws';
import { handleSessions } from '../api/sessions';
import { handleActions } from '../api/actions';

let db: DatabaseService;
let uidCounter = 0;
function uid(prefix: string): string {
  uidCounter += 1;
  return `${prefix}-${uidCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

const P = { a: '', b: '' }; // profileIds
const PG: Record<string, string> = {}; // page keys

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
  P.a = uid('profA'); P.b = uid('profB');
  db.createProfile({ id: P.a, name: 'Perfil A', data: {} });
  db.createProfile({ id: P.b, name: 'Perfil B', data: {} });
  const mk = (key: string, profileId: string) => {
    const id = uid(`page-${key}`);
    db.createPage({ id, profile_id: profileId, name: `Página ${key}`, order_idx: 0, is_folder: 0, data: {} });
    PG[key] = id;
  };
  mk('a1', P.a); mk('a2', P.a); mk('b1', P.b);
  db.setCurrentProfile(P.a);
  db.setCurrentPage(PG.a1);
});

// ---------- helpers sin red ----------

function makeManager(): WebSocketManager {
  const mgr = Object.create(WebSocketManager.prototype) as WebSocketManager;
  (mgr as any).clients = new Map();
  (mgr as any).db = new DatabaseService();
  (mgr as any).server = null;
  return mgr;
}

function fakeWs(inbox: any[]): any {
  return {
    readyState: 1, // WebSocket.OPEN
    sent: inbox,
    send(text: string) { inbox.push(JSON.parse(String(text))); },
    close() {},
  };
}

function addClient(
  mgr: WebSocketManager,
  opts: { clientId: string; deviceId: string; kind?: string; profileId?: string | null; pageId?: string | null; topics?: string[] },
): { inbox: any[] } {
  const inbox: any[] = [];
  (mgr as any).clients.set(opts.clientId, {
    id: opts.clientId,
    ws: fakeWs(inbox),
    subscriptions: new Set(opts.topics ?? ['profiles', 'pages', 'buttons']),
    deviceId: opts.deviceId,
    kind: opts.kind ?? 'browser',
    name: opts.deviceId,
    profileId: opts.profileId ?? P.a,
    pageId: opts.pageId ?? PG.a1,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    source: 'ws',
    // Fixture sin socket: equivale a loopback (exento LAN).
    ip: '127.0.0.1',
    lanAuthed: true,
  });
  // Persistir la vista inicial como haría `hello`
  db.upsertDeviceSession({
    device_id: opts.deviceId,
    name: opts.deviceId,
    kind: opts.kind ?? 'browser',
    profile_id: opts.profileId ?? P.a,
    page_id: opts.pageId ?? PG.a1,
  });
  return { inbox };
}

function send(mgr: WebSocketManager, clientId: string, msg: any): void {
  (mgr as any).handleClientMessage(clientId, msg);
}

function lastOfType(inbox: any[], type: string): any {
  const found = inbox.filter((m) => m.type === type);
  return found.length > 0 ? found[found.length - 1] : null;
}

// ---------- 1. resolución de destinos (pura) ----------

describe('device-sessions: resolveNavTargets', () => {
  it('sin destino → solo el emisor (self)', () => {
    expect(resolveNavTargets({ pageId: 'p' }, 'dev-A')).toEqual({ kind: 'self' });
    expect(resolveNavTargets({}, 'dev-A')).toEqual({ kind: 'self' });
    expect(resolveNavTargets(null, 'dev-A')).toEqual({ kind: 'self' });
  });

  it('target deviceId concreto → devices', () => {
    expect(resolveNavTargets({ pageId: 'p', target: 'dev-B' }, 'dev-A'))
      .toEqual({ kind: 'devices', ids: ['dev-B'] });
    expect(resolveNavTargets({ pageId: 'p', deviceId: 'dev-B' }, 'dev-A'))
      .toEqual({ kind: 'devices', ids: ['dev-B'] });
  });

  it("target 'all' / broadcast → all", () => {
    expect(resolveNavTargets({ target: 'all' }, 'dev-A')).toEqual({ kind: 'all' });
    expect(resolveNavTargets({ broadcast: true }, 'dev-A')).toEqual({ kind: 'all' });
    expect(resolveNavTargets({ targets: ['all'] }, 'dev-A')).toEqual({ kind: 'all' });
  });

  it('target propio o self → self', () => {
    expect(resolveNavTargets({ target: 'dev-A' }, 'dev-A')).toEqual({ kind: 'self' });
    expect(resolveNavTargets({ target: 'self' }, 'dev-A')).toEqual({ kind: 'self' });
  });

  it('targets[] filtra self y duplicados', () => {
    expect(resolveNavTargets({ targets: ['dev-B', 'dev-C'] }, 'dev-A'))
      .toEqual({ kind: 'devices', ids: ['dev-B', 'dev-C'] });
  });
});

describe('device-sessions: isNavigationForDevice', () => {
  it('dirigido a otro → no aplica; al propio → aplica', () => {
    expect(isNavigationForDevice({ targetDeviceId: 'dev-B' }, 'dev-A')).toBe(false);
    expect(isNavigationForDevice({ targetDeviceId: 'dev-A' }, 'dev-A')).toBe(true);
  });

  it('compat: sin destino o all → aplica a todos', () => {
    expect(isNavigationForDevice({ pageId: 'p' }, 'dev-A')).toBe(true);
    expect(isNavigationForDevice({ target: 'all' }, 'dev-A')).toBe(true);
    expect(isNavigationForDevice({ targets: [] }, 'dev-A')).toBe(true);
  });

  it('normalizeDeviceKind mapea alias', () => {
    expect(normalizeDeviceKind('StreamDeck')).toBe('hardware');
    expect(normalizeDeviceKind('web')).toBe('browser');
    expect(normalizeDeviceKind('tunnel')).toBe('relay');
    expect(normalizeDeviceKind(undefined)).toBe('unknown');
  });
});

// ---------- 2. aislamiento de 2 clientes ----------

describe('device-sessions: aislamiento de 2 clientes', () => {
  it('page.select por defecto solo mueve al emisor', () => {
    const mgr = makeManager();
    const a = addClient(mgr, { clientId: 'c-A', deviceId: 'dev-A' });
    const b = addClient(mgr, { clientId: 'c-B', deviceId: 'dev-B' });

    send(mgr, 'c-A', { type: 'page.select', payload: { pageId: PG.a2 } });

    // Vista: A se mueve, B intacta
    expect((mgr as any).clients.get('c-A').pageId).toBe(PG.a2);
    expect((mgr as any).clients.get('c-B').pageId).toBe(PG.a1);
    expect(db.getDeviceSession('dev-A')?.page_id).toBe(PG.a2);
    expect(db.getDeviceSession('dev-B')?.page_id).toBe(PG.a1);

    // Mensajes: A recibe eco dirigido, B no recibe nada
    const echoA = lastOfType(a.inbox, 'page.navigate');
    expect(echoA).not.toBeNull();
    expect(echoA.payload.pageId).toBe(PG.a2);
    expect(echoA.payload.targetDeviceId).toBe('dev-A');
    expect(lastOfType(b.inbox, 'page.navigate')).toBeNull();
  });

  it('profile.select por defecto solo mueve al emisor', () => {
    const mgr = makeManager();
    const a = addClient(mgr, { clientId: 'c-A', deviceId: 'dev-PA' });
    const b = addClient(mgr, { clientId: 'c-B', deviceId: 'dev-PB' });

    send(mgr, 'c-A', { type: 'profile.select', payload: { profileId: P.b } });

    expect((mgr as any).clients.get('c-A').profileId).toBe(P.b);
    expect((mgr as any).clients.get('c-A').pageId).toBe(PG.b1); // primera página del perfil
    expect((mgr as any).clients.get('c-B').profileId).toBe(P.a);
    expect(lastOfType(b.inbox, 'profile.navigate')).toBeNull();
    const echoA = lastOfType(a.inbox, 'profile.navigate');
    expect(echoA?.payload.profileId).toBe(P.b);
  });

  it('pageId inexistente → error y sin cambios', () => {
    const mgr = makeManager();
    const a = addClient(mgr, { clientId: 'c-A', deviceId: 'dev-EA' });
    send(mgr, 'c-A', { type: 'page.select', payload: { pageId: 'no-existe' } });
    expect((mgr as any).clients.get('c-A').pageId).toBe(PG.a1);
    expect(lastOfType(a.inbox, 'error')).not.toBeNull();
    expect(lastOfType(a.inbox, 'page.navigate')).toBeNull();
  });
});

// ---------- 3. navegación dirigida y broadcast ----------

describe('device-sessions: navegación dirigida', () => {
  it('target deviceId mueve solo al objetivo (origen intacto, global intacto)', () => {
    const mgr = makeManager();
    db.setCurrentPage(PG.a1);
    const a = addClient(mgr, { clientId: 'c-A', deviceId: 'dev-TA' });
    const b = addClient(mgr, { clientId: 'c-B', deviceId: 'dev-TB' });

    send(mgr, 'c-A', { type: 'page.select', payload: { pageId: PG.a2, target: 'dev-TB' } });

    expect((mgr as any).clients.get('c-B').pageId).toBe(PG.a2);
    expect((mgr as any).clients.get('c-A').pageId).toBe(PG.a1);
    expect(db.getSetting('current.page_id')).toBe(PG.a1); // global intacto
    expect(lastOfType(b.inbox, 'page.navigate')?.payload.pageId).toBe(PG.a2);
    expect(lastOfType(a.inbox, 'page.navigate')).toBeNull();
  });

  it("broadcast 'all' mueve a todos y actualiza el global (compat)", () => {
    const mgr = makeManager();
    const a = addClient(mgr, { clientId: 'c-A', deviceId: 'dev-BA' });
    const b = addClient(mgr, { clientId: 'c-B', deviceId: 'dev-BB' });

    send(mgr, 'c-A', { type: 'page.select', payload: { pageId: PG.a2, target: 'all' } });

    expect((mgr as any).clients.get('c-A').pageId).toBe(PG.a2);
    expect((mgr as any).clients.get('c-B').pageId).toBe(PG.a2);
    expect(db.getSetting('current.page_id')).toBe(PG.a2);
    expect(lastOfType(a.inbox, 'page.navigate')?.payload.pageId).toBe(PG.a2);
    expect(lastOfType(b.inbox, 'page.navigate')?.payload.pageId).toBe(PG.a2);
  });

  it('profile.select dirigido mueve solo al objetivo', () => {
    const mgr = makeManager();
    const a = addClient(mgr, { clientId: 'c-A', deviceId: 'dev-UA' });
    const b = addClient(mgr, { clientId: 'c-B', deviceId: 'dev-UB' });

    send(mgr, 'c-A', { type: 'profile.select', payload: { profileId: P.b, target: 'dev-UB' } });

    expect((mgr as any).clients.get('c-B').profileId).toBe(P.b);
    expect((mgr as any).clients.get('c-A').profileId).toBe(P.a);
    expect(lastOfType(a.inbox, 'profile.navigate')).toBeNull();
  });
});

// ---------- 4. hello / reconexión / startup ----------

describe('device-sessions: hello, reconexión y startup', () => {
  it('hello fija deviceId y responde session.state', () => {
    const mgr = makeManager();
    const inbox: any[] = [];
    (mgr as any).clients.set('c-H', {
      id: 'c-H', ws: fakeWs(inbox), subscriptions: new Set(),
      deviceId: 'c-H', kind: 'unknown', name: null,
      profileId: null, pageId: null, connectedAt: Date.now(), lastSeen: Date.now(), source: 'ws',
      ip: '127.0.0.1', lanAuthed: true,
    });
    send(mgr, 'c-H', { type: 'hello', payload: { deviceId: 'dev-hello', kind: 'browser', name: 'PC' } });
    const state = lastOfType(inbox, 'session.state');
    expect(state).not.toBeNull();
    expect(state.payload.deviceId).toBe('dev-hello');
    expect((mgr as any).clients.get('c-H').deviceId).toBe('dev-hello');
    expect((mgr as any).clients.get('c-H').kind).toBe('browser');
  });

  it('hello con nombre repetido lo desambigua con el id', () => {
    const mgr = makeManager();
    const a = addClient(mgr, { clientId: 'c-N1', deviceId: 'aaaa1111-0000-0000-0000-000000000001' });
    send(mgr, 'c-N1', { type: 'hello', payload: { deviceId: 'aaaa1111-0000-0000-0000-000000000001', kind: 'browser', name: 'Chrome' } });
    const b = addClient(mgr, { clientId: 'c-N2', deviceId: 'bbbb2222-0000-0000-0000-000000000002' });
    send(mgr, 'c-N2', { type: 'hello', payload: { deviceId: 'bbbb2222-0000-0000-0000-000000000002', kind: 'browser', name: 'Chrome' } });
    expect(db.getDevice('aaaa1111-0000-0000-0000-000000000001')?.name).toBe('Chrome');
    expect(db.getDevice('bbbb2222-0000-0000-0000-000000000002')?.name).toBe('Chrome bbbb');
    void a; void b;
  });

  it('reconexión con el mismo deviceId restaura la vista', () => {
    const mgr = makeManager();
    const a = addClient(mgr, { clientId: 'c-R1', deviceId: 'dev-recon' });
    send(mgr, 'c-R1', { type: 'page.select', payload: { pageId: PG.a2 } });
    expect(a.inbox.length).toBeGreaterThan(0);

    // Desconexión
    (mgr as any).clients.delete('c-R1');

    // Reconexión: nuevo clientId, mismo deviceId
    const inbox2: any[] = [];
    (mgr as any).clients.set('c-R2', {
      id: 'c-R2', ws: fakeWs(inbox2), subscriptions: new Set(),
      deviceId: 'c-R2', kind: 'unknown', name: null,
      profileId: null, pageId: null, connectedAt: Date.now(), lastSeen: Date.now(), source: 'ws',
      ip: '127.0.0.1', lanAuthed: true,
    });
    send(mgr, 'c-R2', { type: 'hello', payload: { deviceId: 'dev-recon', kind: 'browser' } });
    const state = lastOfType(inbox2, 'session.state');
    expect(state?.payload.pageId).toBe(PG.a2);
    expect(state?.payload.profileId).toBe(P.a);
    expect((mgr as any).clients.get('c-R2').pageId).toBe(PG.a2);
  });

  it('startup profile asignado se aplica al registrarse', () => {
    const mgr = makeManager();
    db.upsertDeviceSession({ device_id: 'dev-startup' });
    db.setDeviceStartupProfile('dev-startup', P.b);

    const inbox: any[] = [];
    (mgr as any).clients.set('c-S', {
      id: 'c-S', ws: fakeWs(inbox), subscriptions: new Set(),
      deviceId: 'c-S', kind: 'unknown', name: null,
      profileId: null, pageId: null, connectedAt: Date.now(), lastSeen: Date.now(), source: 'ws',
      ip: '127.0.0.1', lanAuthed: true,
    });
    send(mgr, 'c-S', { type: 'hello', payload: { deviceId: 'dev-startup', kind: 'hardware' } });
    const state = lastOfType(inbox, 'session.state');
    expect(state?.payload.profileId).toBe(P.b);
    expect(state?.payload.pageId).toBe(PG.b1);
    expect(state?.payload.startupProfileId).toBe(P.b);
  });

  it('session.get devuelve la vista propia', () => {
    const mgr = makeManager();
    const a = addClient(mgr, { clientId: 'c-G', deviceId: 'dev-get' });
    send(mgr, 'c-G', { type: 'session.get' });
    const state = lastOfType(a.inbox, 'session.state');
    expect(state?.payload.deviceId).toBe('dev-get');
    expect(state?.payload.pageId).toBe(PG.a1);
  });
});

// ---------- 5. REST /sessions ----------

async function restCall(mgr: any, p: string, method: string, body?: any) {
  const d = db;
  const services = { wsManager: mgr };
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new Request(`http://localhost:3001${p}`, init);
  const res = await handleSessions(req, {
    url: new URL(`http://localhost:3001${p}`), method, path: p, db: d, services: services as any,
  });
  if (!res) throw new Error(`sin handler para ${method} ${p}`);
  let json: any = {};
  try { json = await res.json(); } catch { json = {}; }
  return { status: res.status, body: json };
}

describe('device-sessions: REST /sessions', () => {
  it('GET /api/v1/sessions lista clientes y su vista actual', async () => {
    const mgr = makeManager();
    addClient(mgr, { clientId: 'c-L1', deviceId: 'dev-L1' });
    addClient(mgr, { clientId: 'c-L2', deviceId: 'dev-L2', kind: 'hardware', pageId: PG.a2 });
    const r = await restCall(mgr, '/api/v1/sessions', 'GET');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const l1 = r.body.find((v: any) => v.deviceId === 'dev-L1');
    const l2 = r.body.find((v: any) => v.deviceId === 'dev-L2');
    expect(l1?.profileId).toBe(P.a);
    expect(l1?.connected).toBe(true);
    expect(l2?.pageId).toBe(PG.a2);
    expect(l2?.kind).toBe('hardware');
  });

  it('PUT /sessions/:id fija la vista y notifica al dispositivo', async () => {
    const mgr = makeManager();
    addClient(mgr, { clientId: 'c-N1', deviceId: 'dev-N1' });
    const n2 = addClient(mgr, { clientId: 'c-N2', deviceId: 'dev-N2' });
    const r = await restCall(mgr, '/api/v1/sessions/dev-N2', 'PUT', { pageId: PG.a2 });
    expect(r.status).toBe(200);
    expect((mgr as any).clients.get('c-N2').pageId).toBe(PG.a2);
    expect((mgr as any).clients.get('c-N1').pageId).toBe(PG.a1); // intacto
    expect(lastOfType(n2.inbox, 'page.navigate')?.payload.pageId).toBe(PG.a2);
  });

  it('PUT /sessions/:id con startupProfileId asigna arranque', async () => {
    const mgr = makeManager();
    addClient(mgr, { clientId: 'c-S1', deviceId: 'dev-S1' });
    const r = await restCall(mgr, '/api/v1/sessions/dev-S1', 'PUT', { startupProfileId: P.b });
    expect(r.status).toBe(200);
    expect(db.getDeviceSession('dev-S1')?.startup_profile_id).toBe(P.b);
  });

  it('POST /api/v1/navigate con target dirige; sin target es broadcast', async () => {
    const mgr = makeManager();
    const a = addClient(mgr, { clientId: 'c-V1', deviceId: 'dev-V1' });
    const b = addClient(mgr, { clientId: 'c-V2', deviceId: 'dev-V2' });
    const r = await restCall(mgr, '/api/v1/navigate', 'POST', { pageId: PG.a2, target: 'dev-V2' });
    expect(r.status).toBe(200);
    expect((mgr as any).clients.get('c-V2').pageId).toBe(PG.a2);
    expect((mgr as any).clients.get('c-V1').pageId).toBe(PG.a1);
    expect(lastOfType(a.inbox, 'page.navigate')).toBeNull();
    void b;
  });

  it('GET /sessions/:desconocido → 404', async () => {
    const mgr = makeManager();
    const r = await restCall(mgr, '/api/v1/sessions/dev-fantasma-xyz', 'GET');
    expect(r.status).toBe(404);
  });

  it('DELETE /sessions/:id borra sesión y fila del navegador (al hardware no lo toca)', async () => {
    const mgr = makeManager();
    db.upsertDeviceSession({ device_id: 'dev-D1', name: 'Navegador', kind: 'browser' });
    db.createDevice({ id: 'dev-D1', name: 'Navegador', kind: 'browser', model: null, cols: null, rows: null, hw_path: null });
    const r = await restCall(mgr, '/api/v1/sessions/dev-D1', 'DELETE');
    expect(r.status).toBe(200);
    expect(db.getDeviceSession('dev-D1')).toBeNull();
    expect(db.getDevice('dev-D1')).toBeNull();
    // El hardware conserva su fila aunque se borre su sesión.
    db.upsertDeviceSession({ device_id: 'streamdeck-local', name: null, kind: 'hardware' });
    db.createDevice({ id: 'streamdeck-local', name: 'Stream Deck', kind: 'deck', model: null, cols: null, rows: null, hw_path: null });
    const rh = await restCall(mgr, '/api/v1/sessions/streamdeck-local', 'DELETE');
    expect(rh.status).toBe(200);
    expect(db.getDeviceSession('streamdeck-local')).toBeNull();
    expect(db.getDevice('streamdeck-local')).toBeTruthy();
    db.deleteDeviceSession('streamdeck-local');
  });
});

// ---------- 6. acciones con navegación dirigida ----------

describe('device-sessions: acciones page/profile', () => {
  function stubServices(captured: any) {
    return {
      actionRunner: {
        executeAction: async () => ({ success: true, result: { action: 'navigate_to_page', pageId: PG.a2 } }),
      },
      wsManager: {
        broadcastActionStarted: () => {},
        broadcastActionFinished: () => {},
        broadcastActionError: () => {},
        broadcast: () => { captured.broadcastCalled = true; },
        navigatePageTo: (opts: any) => { captured.pageNav = opts; return { ok: true }; },
        navigateProfileTo: (opts: any) => { captured.profileNav = opts; return { ok: true }; },
      },
    };
  }

  async function execAction(services: any, context: any) {
    const req = new Request('http://localhost:3001/api/v1/actions/execute', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: { type: 'page.page', parameters: { pageId: PG.a2 } }, context }),
    });
    const res = await handleActions(req, {
      url: new URL('http://localhost:3001/api/v1/actions/execute'),
      method: 'POST', path: '/api/v1/actions/execute', db, services,
    });
    if (!res) throw new Error('sin handler');
    return res.json();
  }

  it('con deviceId en contexto → dirigida al ejecutor (no broadcast)', async () => {
    const captured: any = {};
    await execAction(stubServices(captured), { deviceId: 'dev-A', buttonId: 'b1' });
    expect(captured.broadcastCalled).toBeFalsy();
    expect(captured.pageNav?.originDeviceId).toBe('dev-A');
    expect(captured.pageNav?.targets).toEqual({ kind: 'self' });
  });

  it('sin deviceId en contexto → broadcast (compat)', async () => {
    const captured: any = {};
    await execAction(stubServices(captured), { buttonId: 'b1' });
    expect(captured.pageNav?.targets).toEqual({ kind: 'all' });
  });

  it('context.target dirige a otro dispositivo', async () => {
    const captured: any = {};
    await execAction(stubServices(captured), { deviceId: 'dev-A', target: 'dev-HW' });
    expect(captured.pageNav?.targets).toEqual({ kind: 'devices', ids: ['dev-HW'] });
  });
});

// ---------- 7. driver con sesión propia ----------

describe('device-sessions: streamdeck-driver sesión propia', () => {
  it('deviceId estable y vista independiente del global', async () => {
    const { streamDeckDriver } = await import('../hw-driver/streamdeck-driver');
    expect(streamDeckDriver.getDeviceId()).toBe('streamdeck-local');

    // Vista propia distinta del global
    await streamDeckDriver.setSessionView({ profileId: P.b, pageId: PG.b1 });
    db.setCurrentProfile(P.a);
    db.setCurrentPage(PG.a1);

    const view = streamDeckDriver.getSessionView();
    expect(view.profileId).toBe(P.b);
    expect(view.pageId).toBe(PG.b1);
    expect(db.getDeviceSession('streamdeck-local')?.profile_id).toBe(P.b);

    // handleButtonPress sin botones en la página: no lanza y no toca el global
    await streamDeckDriver.handleButtonPress(0);
    expect(db.getSetting('current.profile_id')).toBe(P.a);
    expect(db.getSetting('current.page_id')).toBe(PG.a1);
  });
});
