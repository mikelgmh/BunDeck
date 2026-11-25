/**
 * hello-resync-light.test.ts — hello/resync ligero del WS manager.
 *
 * La tormenta de hellos tras cada micro-corte hacía ~10 ops SQLite por
 * hello (getProfile/getPage/getPagesByProfile/getAssignments…). Ahora
 * perfil/páginas/asignaciones van cacheados (TTL corto + invalidación en
 * cada broadcast que los muta):
 * - El 2º hello seguido (reconexión) NO relee perfil/páginas/asignaciones.
 * - Un `page.updated` invalida la caché: el siguiente hello relee.
 * - `device.online` solo se emite si no había otra conexión viva del
 *   mismo dispositivo (2ª pestaña / re-hello no spamea presencia).
 */
import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-hello-test-'));
process.env.LIBREDECK_DATA_DIR = ROOT;

import { initDatabase, DatabaseService } from '../db';
import { WebSocketManager } from '../ws';

let db: DatabaseService;
let profileId: string;
let pageId: string;

beforeAll(async () => {
  process.env.LIBREDECK_DATA_DIR = ROOT;
  await initDatabase();
  const suffix = Math.random().toString(36).slice(2, 8);
  db = new DatabaseService();
  profileId = `prof-hello-${suffix}`;
  pageId = `page-hello-${suffix}`;
  db.createProfile({ id: profileId, name: 'P hello', data: {} });
  db.createPage({ id: pageId, profile_id: profileId, name: 'Pg', order_idx: 0, is_folder: 0, data: {} } as any);
  db.setSetting('current.profile_id', profileId);
  db.setSetting('current.page_id', pageId);
});

let mgr: WebSocketManager | null = null;
afterEach(() => {
  try { mgr?.close(); } catch { /* noop */ }
  mgr = null;
});

async function startMgr(): Promise<number> {
  mgr = new WebSocketManager(0);
  await new Promise((r) => setTimeout(r, 50));
  const port = (mgr as any)?.server?.port ?? 0;
  expect(port).toBeGreaterThan(0);
  // La caché es por instancia: empieza vacía en cada test.
  return port;
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', (e) => reject(e), { once: true });
  });
}

function nextMsg(ws: WebSocket): Promise<any> {
  return new Promise((resolve) => {
    ws.addEventListener('message', (ev: any) => {
      try { resolve(JSON.parse(String(ev.data))); } catch { resolve(null); }
    }, { once: true });
  });
}

async function hello(ws: WebSocket, deviceId: string): Promise<any> {
  await nextMsg(ws); // connected
  (ws as any).send(JSON.stringify({
    type: 'hello',
    // Vista explícita: ambos hellos recorren la misma ruta de validación
    // (perfil/página/asignaciones) para medir la caché en igualdad.
    payload: { deviceId, kind: 'browser', name: `n-${deviceId}`, profileId, pageId },
  }));
  for (let i = 0; i < 20; i++) {
    const m = await nextMsg(ws);
    if (m?.type === 'session.state') return m;
    if (m?.type === 'error') throw new Error(`hello error: ${JSON.stringify(m?.payload)}`);
  }
  throw new Error('sin session.state');
}

function countDbReads(): { counts: Record<string, number>; restore: () => void } {
  const inner = (mgr as any).db as DatabaseService;
  const counts: Record<string, number> = { getProfile: 0, getPage: 0, getPagesByProfile: 0, getAssignments: 0 };
  const origs: Record<string, any> = {};
  for (const k of Object.keys(counts)) {
    origs[k] = (inner as any)[k].bind(inner);
    (inner as any)[k] = (...a: any[]) => { counts[k]++; return origs[k](...a); };
  }
  return {
    counts,
    restore() {
      for (const k of Object.keys(origs)) (inner as any)[k] = origs[k];
    },
  };
}

describe('hello ligero', () => {
  it('el 2º hello seguido no relee perfil/páginas/asignaciones (caché)', async () => {
    const port = await startMgr();
    const { counts, restore } = countDbReads();
    try {
      const a = await connect(port);
      try {
        await hello(a, 'dev-cache-1');
        const first = { ...counts };
        expect(first.getProfile + first.getPagesByProfile + first.getAssignments).toBeGreaterThan(0);

        // Reconexión inmediata (tormenta tras micro-corte): todo cacheado.
        const b = await connect(port);
        try {
          await hello(b, 'dev-cache-1');
        } finally {
          try { b.close(); } catch { /* noop */ }
        }
        expect(counts.getProfile).toBe(first.getProfile);
        expect(counts.getPagesByProfile).toBe(first.getPagesByProfile);
        expect(counts.getAssignments).toBe(first.getAssignments);
        expect(counts.getPage).toBe(first.getPage);
      } finally {
        try { a.close(); } catch { /* noop */ }
      }
    } finally {
      restore();
    }
  });

  it('un broadcast page.updated invalida la caché (el hello relee)', async () => {
    const port = await startMgr();
    const { counts, restore } = countDbReads();
    try {
      const a = await connect(port);
      try {
        await hello(a, 'dev-cache-2');
        const first = { ...counts };
        (mgr as any).broadcastPageUpdate(pageId, { id: pageId, profile_id: profileId, name: 'Pg2' });
        const b = await connect(port);
        try {
          await hello(b, 'dev-cache-2');
        } finally {
          try { b.close(); } catch { /* noop */ }
        }
        // `page.updated` invalida páginas/asignaciones (no perfiles): el
        // hello relee la página.
        expect(counts.getPage).toBeGreaterThan(first.getPage);
      } finally {
        try { a.close(); } catch { /* noop */ }
      }
    } finally {
      restore();
    }
  });

  it('device.online solo si no había otra conexión viva del dispositivo', async () => {
    const port = await startMgr();
    const proto = WebSocketManager.prototype as any;
    const orig = proto.broadcast;
    let online = 0;
    (mgr as any).broadcast = function (ev: string, payload: any, topic?: string) {
      if (ev === 'device.online') online++;
      return orig.call(this, ev, payload, topic);
    };
    try {
      const a = await connect(port);
      try {
        await hello(a, 'dev-dup-1');
        expect(online).toBe(1);
        // Segunda pestaña / re-hello del mismo dispositivo: ya estaba online.
        const b = await connect(port);
        try {
          await hello(b, 'dev-dup-1');
          expect(online).toBe(1);
        } finally {
          try { b.close(); } catch { /* noop */ }
        }
        // Otro dispositivo sí avisa.
        const c = await connect(port);
        try {
          await hello(c, 'dev-dup-2');
          expect(online).toBe(2);
        } finally {
          try { c.close(); } catch { /* noop */ }
        }
      } finally {
        try { a.close(); } catch { /* noop */ }
      }
    } finally {
      (mgr as any).broadcast = orig;
    }
  });
});
