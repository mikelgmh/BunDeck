/**
 * profile-switch-assignments.test.ts — al cambiar de perfil, cada
 * dispositivo debe saltar a SU página asignada en el perfil nuevo
 * (no todos a la primera página del perfil).
 *
 * Sin sockets reales: WebSocketManager sin Bun.serve (Object.create +
 * campos internos) y WS falsos que capturan envíos.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-profswitch-test-'));
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { WebSocketManager } from '../ws';

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
  const mk = (key: string, profileId: string, order: number) => {
    const id = uid(`page-${key}`);
    db.createPage({ id, profile_id: profileId, name: `Página ${key}`, order_idx: order, is_folder: 0, data: {} });
    PG[key] = id;
  };
  mk('a1', P.a, 0); mk('a2', P.a, 1);
  mk('b1', P.b, 0); mk('b2', P.b, 1);
  for (const d of ['dev-1', 'dev-2']) {
    try {
      db.createDevice({ id: d, name: d, kind: 'browser', model: null, cols: null, rows: null, hw_path: null });
    } catch { /* ya existe */ }
  }
  db.setAssignment(P.a, 'dev-1', PG.a1);
  db.setAssignment(P.a, 'dev-2', PG.a2);
  db.setAssignment(P.b, 'dev-1', PG.b1);
  db.setAssignment(P.b, 'dev-2', PG.b2);
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
  opts: { clientId: string; deviceId: string; profileId?: string | null; pageId?: string | null },
): { inbox: any[] } {
  const inbox: any[] = [];
  (mgr as any).clients.set(opts.clientId, {
    id: opts.clientId,
    ws: fakeWs(inbox),
    subscriptions: new Set(['profiles', 'pages', 'buttons']),
    deviceId: opts.deviceId,
    kind: 'browser',
    name: opts.deviceId,
    profileId: opts.profileId ?? P.a,
    pageId: opts.pageId ?? PG.a1,
    connectedAt: Date.now(),
    lastSeen: Date.now(),
    source: 'ws',
    ip: '127.0.0.1',
    lanAuthed: true,
  });
  db.upsertDeviceSession({
    device_id: opts.deviceId,
    name: opts.deviceId,
    kind: 'browser',
    profile_id: opts.profileId ?? P.a,
    page_id: opts.pageId ?? PG.a1,
  });
  return { inbox };
}

function lastOfType(inbox: any[], type: string): any {
  const found = inbox.filter((m) => m.type === type);
  return found.length > 0 ? found[found.length - 1] : null;
}

// ---------- tests ----------

describe('profile-switch: reasignación por dispositivo', () => {
  it('cambio global → cada dispositivo recibe SU página asignada del perfil nuevo', () => {
    const mgr = makeManager();
    const c1 = addClient(mgr, { clientId: 'c-1', deviceId: 'dev-1', profileId: P.a, pageId: PG.a1 });
    const c2 = addClient(mgr, { clientId: 'c-2', deviceId: 'dev-2', profileId: P.a, pageId: PG.a2 });

    const res = mgr.navigateProfileTo({ profileId: P.b, originDeviceId: null, targets: { kind: 'all' } });
    expect(res.ok).toBe(true);

    // Estado en memoria por dispositivo
    expect((mgr as any).clients.get('c-1').profileId).toBe(P.b);
    expect((mgr as any).clients.get('c-1').pageId).toBe(PG.b1);
    expect((mgr as any).clients.get('c-2').profileId).toBe(P.b);
    expect((mgr as any).clients.get('c-2').pageId).toBe(PG.b2);

    // Estado persistido (reconexión / sesiones)
    expect(db.getDeviceSession('dev-1')?.page_id).toBe(PG.b1);
    expect(db.getDeviceSession('dev-2')?.page_id).toBe(PG.b2);
    expect(db.getDeviceSession('dev-1')?.profile_id).toBe(P.b);
    expect(db.getDeviceSession('dev-2')?.profile_id).toBe(P.b);

    // Cada dispositivo recibe su propia navegación dirigida
    const n1 = lastOfType(c1.inbox, 'profile.navigate');
    const n2 = lastOfType(c2.inbox, 'profile.navigate');
    expect(n1?.payload.profileId).toBe(P.b);
    expect(n1?.payload.pageId).toBe(PG.b1);
    expect(n1?.payload.targetDeviceId).toBe('dev-1');
    expect(n2?.payload.profileId).toBe(P.b);
    expect(n2?.payload.pageId).toBe(PG.b2);
    expect(n2?.payload.targetDeviceId).toBe('dev-2');

    // El global avanza al perfil nuevo
    expect(db.getSetting('current.profile_id')).toBe(P.b);
  });

  it('sin asignación válida → fallback a la primera página del perfil', () => {
    db.clearAssignment(P.b, 'dev-2');
    try {
      const mgr = makeManager();
      const c1 = addClient(mgr, { clientId: 'c-f1', deviceId: 'dev-1', profileId: P.a, pageId: PG.a1 });
      const c2 = addClient(mgr, { clientId: 'c-f2', deviceId: 'dev-2', profileId: P.a, pageId: PG.a2 });

      // dev-1 asignado a b2 (no a la primera) para distinguir fallback de asignación
      db.setAssignment(P.b, 'dev-1', PG.b2);
      try {
        const res = mgr.navigateProfileTo({ profileId: P.b, originDeviceId: null, targets: { kind: 'all' } });
        expect(res.ok).toBe(true);
        expect((mgr as any).clients.get('c-f1').pageId).toBe(PG.b2);
        expect((mgr as any).clients.get('c-f2').pageId).toBe(PG.b1); // fallback: primera
        expect(lastOfType(c1.inbox, 'profile.navigate')?.payload.pageId).toBe(PG.b2);
        expect(lastOfType(c2.inbox, 'profile.navigate')?.payload.pageId).toBe(PG.b1);
        expect(db.getDeviceSession('dev-2')?.page_id).toBe(PG.b1);
      } finally {
        db.setAssignment(P.b, 'dev-1', PG.b1);
      }
    } finally {
      db.setAssignment(P.b, 'dev-2', PG.b2);
    }
  });

  it('navegación dirigida a un dispositivo no mueve al otro', () => {
    const mgr = makeManager();
    const c1 = addClient(mgr, { clientId: 'c-d1', deviceId: 'dev-1', profileId: P.a, pageId: PG.a1 });
    addClient(mgr, { clientId: 'c-d2', deviceId: 'dev-2', profileId: P.a, pageId: PG.a2 });

    const res = mgr.navigateProfileTo({
      profileId: P.b, originDeviceId: null, targets: { kind: 'devices', ids: ['dev-2'] },
    });
    expect(res.ok).toBe(true);
    expect((mgr as any).clients.get('c-d2').profileId).toBe(P.b);
    expect((mgr as any).clients.get('c-d2').pageId).toBe(PG.b2);
    expect((mgr as any).clients.get('c-d1').profileId).toBe(P.a);
    expect((mgr as any).clients.get('c-d1').pageId).toBe(PG.a1);
    expect(lastOfType(c1.inbox, 'profile.navigate')).toBeNull();
  });
});
