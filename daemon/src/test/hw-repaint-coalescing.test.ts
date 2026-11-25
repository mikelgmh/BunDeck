/**
 * hw-repaint-coalescing.test.ts — anti-bloqueo del event loop por repaints HID.
 *
 * Culpable (daemon/src/hw-driver/streamdeck-driver.ts + ws.ts):
 *  - Cada `hello` del WS llamaba a `refreshHardwareToAssignment` →
 *    `applyProfileAssignment` → `setSessionView` → `updateFromPage`:
 *    repaint COMPLETO (15 writes HID síncronos, node-hid bloquea el hilo
 *    de Bun) aunque la página ya fuese la visible. Con el device fallando
 *    (`Cannot write to hid device`), cada write es lento → /health (trivial)
 *    tardaba 0.5–2.7 s a rachas → timeouts → reconexión → otro hello →
 *    otro repaint (espiral).
 *
 * Fix cubierto aquí (driver real, HW mockeado, sin HID):
 *  1. skip-if-same: `applyProfileAssignment` no repinta si la página asignada
 *     ya es la pintada en esta conexión (`lastPaintedPageId`).
 *  2. backoff: ante `Cannot write to hid device` se entra en cooldown
 *     (2 s → 4 s → … máx 30 s); los repaints en cooldown se omiten (contados)
 *     y queda UN retry programado, no N en caliente. El repintado aborta
 *     tras 2 fallos HID seguidos (no 15 timeouts en serie).
 *  3. coalescing: N `scheduleUpdateFromPage` seguidos colapsan en 1 repaint;
 *     concurrentes encolan como mucho 1 (ya existía, se regresa).
 *  4. instrumentación: writes >50 ms y repaints >500 ms → `console.warn`
 *     (único spam nuevo); contadores en `getRepaintStats()`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-hw-coalesce-test-'));
process.env.BUNDECK_DATA_DIR = TMP;
process.env.LIBREDECK_DATA_DIR = TMP;
fs.mkdirSync(path.join(TMP, 'plugins'), { recursive: true });

import { initDatabase, DatabaseService } from '../db';
import { streamDeckDriver } from '../hw-driver/streamdeck-driver';
import { WebSocketManager } from '../ws';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let db: DatabaseService;
let profId = '';
let pageId = '';

/** Fake StreamDeck de 5×3 (15 teclas, como el modelo real). */
function makeFakeDeck() {
  const keyCount = 15;
  const controls = Array.from({ length: keyCount }, (_, i) => ({
    type: 'button',
    column: i % 5,
    row: Math.floor(i / 5),
    pixelSize: { width: 72, height: 72 },
  }));
  return {
    CONTROLS: controls,
    writes: 0,
    failWith: null as Error | null,
    async fillKeyBuffer(_idx: number, _buf: Buffer, _opts?: unknown) {
      this.writes += 1;
      if (this.failWith) throw this.failWith;
    },
    async fillKeyColor(_idx: number, _r: number, _g: number, _b: number) {
      this.writes += 1;
      if (this.failWith) throw this.failWith;
    },
    removeAllListeners() {},
    async close() {},
  };
}

let fake: ReturnType<typeof makeFakeDeck>;
let prevStreamDeck: unknown;
let prevSession: { profileId: string | null; pageId: string | null };

beforeAll(async () => {
  await initDatabase();
  db = new DatabaseService();
  const prof = db.createProfile({ id: `prof-hw-${Date.now()}`, name: 'HW', data: {} });
  profId = prof.id;
  pageId = `page-hw-${Date.now()}`;
  db.createPage({ id: pageId, profile_id: profId, name: 'Deck', order_idx: 0, is_folder: 0, data: {} });
  db.createButton({
    id: `btn-hw-${Date.now()}`,
    page_id: pageId,
    position: 0,
    data: { label: 'A', backgroundColor: '#111111', textColor: '#ffffff' },
  } as any);

  prevStreamDeck = (streamDeckDriver as any).streamDeck;
  prevSession = streamDeckDriver.getSessionView();
  fake = makeFakeDeck();
  (streamDeckDriver as any).streamDeck = fake;
  (streamDeckDriver as any).connectedDevice = 'test-deck';
  streamDeckDriver.__resetHwPaintStateForTests();
});

afterAll(async () => {
  streamDeckDriver.__resetHwPaintStateForTests();
  (streamDeckDriver as any).streamDeck = prevStreamDeck ?? null;
  (streamDeckDriver as any).connectedDevice = prevStreamDeck ? 'test-deck' : null;
  // Devolver la sesión previa para no envenenar otros ficheros (proceso compartido).
  try {
    if (prevSession?.profileId && prevSession?.pageId) {
      (streamDeckDriver as any).sessionProfileId = prevSession.profileId;
      (streamDeckDriver as any).sessionPageId = prevSession.pageId;
    } else {
      (streamDeckDriver as any).sessionProfileId = null;
      (streamDeckDriver as any).sessionPageId = null;
    }
  } catch { /* noop */ }
  // Sin intervalos vivos: botones sin pc-vitals ni {{vars}} → no hay polling.
});

describe('HW repaint anti-bloqueo', () => {
  it('1. ráfaga de scheduleUpdateFromPage colapsa en UN repaint', async () => {
    streamDeckDriver.__resetHwPaintStateForTests();
    fake.writes = 0;
    fake.failWith = null;
    for (let i = 0; i < 5; i++) streamDeckDriver.scheduleUpdateFromPage(pageId, 20);
    await sleep(400);
    // 15 teclas × 1 repaint = 15 writes (no 5×15).
    expect(fake.writes).toBe(15);
    expect(streamDeckDriver.getRepaintStats().totalRepaints).toBe(1);
  });

  it('2. applyProfileAssignment no repinta si la página ya es la visible', async () => {
    streamDeckDriver.__resetHwPaintStateForTests();
    fake.writes = 0;
    fake.failWith = null;
    db.setCurrentProfile(profId);
    const first = await streamDeckDriver.applyProfileAssignment(profId, db);
    expect(first).toBe(pageId);
    expect(fake.writes).toBe(15); // pintó (conexión "nueva": lastPainted=null)
    const second = await streamDeckDriver.applyProfileAssignment(profId, db);
    expect(second).toBe(pageId);
    expect(fake.writes).toBe(15); // omitido: misma página ya pintada
    expect(streamDeckDriver.getRepaintStats().skippedSamePage).toBeGreaterThanOrEqual(1);
  });

  it('3. ante "Cannot write to hid device": backoff, aborta pronto y reintenta una vez', async () => {
    streamDeckDriver.__resetHwPaintStateForTests();
    fake.writes = 0;
    fake.failWith = new Error('Cannot write to hid device');
    // Repaint con device muerto: aborta tras 2 fallos (no 3 writes lentos)…
    await streamDeckDriver.updateFromPage(pageId, { force: true });
    expect(fake.writes).toBe(2);
    const stats = streamDeckDriver.getRepaintStats();
    expect(stats.coolingDown).toBe(true);
    expect(stats.lastPaintedPageId).toBeNull(); // no se da por pintado
    // …los siguientes repaints se omiten en caliente (rápidos, sin writes)…
    const writesAfterFail = fake.writes;
    await streamDeckDriver.updateFromPage(pageId);
    await streamDeckDriver.updateFromPage(pageId);
    expect(fake.writes).toBe(writesAfterFail);
    expect(streamDeckDriver.getRepaintStats().skippedCooldown).toBeGreaterThanOrEqual(2);
    // …y al recuperarse (fin del cooldown) vuelve a pintar.
    fake.failWith = null;
    streamDeckDriver.__resetHwPaintStateForTests(); // simula fin de cooldown
    await streamDeckDriver.updateFromPage(pageId, { force: true });
    expect(fake.writes).toBeGreaterThan(writesAfterFail);
    expect(streamDeckDriver.getRepaintStats().lastPaintedPageId).toBe(pageId);
  });

  it('4. refreshHardwareToAssignment limita hellos en ráfaga (throttle WS)', async () => {
    const mgr = Object.create(WebSocketManager.prototype) as WebSocketManager;
    (mgr as any).clients = new Map();
    (mgr as any).db = new DatabaseService();
    (mgr as any).lastHwRefreshAt = 0;
    (mgr as any).lastHwRefreshTarget = null;
    let calls = 0;
    const orig = (streamDeckDriver as any).applyProfileAssignment;
    (streamDeckDriver as any).applyProfileAssignment = async () => { calls += 1; return pageId; };
    try {
      db.setCurrentProfile(profId);
      mgr.refreshHardwareToAssignment(profId);
      mgr.refreshHardwareToAssignment(profId);
      mgr.refreshHardwareToAssignment(profId);
      await sleep(50);
      expect(calls).toBe(1); // 3 hellos seguidos → 1 sola asignación
    } finally {
      (streamDeckDriver as any).applyProfileAssignment = orig;
    }
  });
});
